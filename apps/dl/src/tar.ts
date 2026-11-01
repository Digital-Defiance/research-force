// Feature: research-collab-cms, Task 38.3 — package volume streaming (R28.8, R35.9, R36.2).
// A streaming POSIX (ustar) tar encoder with PAX extended headers for UTF-8 names. rf-dl
// assembles a package volume as a tar stream on the fly from the volume's member R2 objects
// (design "Export_Service" Delivery: "rf-dl streams the package as POSIX tar volumes (pax
// headers for UTF-8 names), each with at most 900 objects"), so no whole volume is ever buffered.
import { OPERATIONS } from '@researchforce/domain/settings';

const BLOCK = 512; // ustar block size; every header and member payload is padded to this boundary.
const encoder = new TextEncoder();

/** One archive member. `size` must be known up front because the ustar header is size-prefixed (R2 `head` gives it). */
export interface TarMember {
  name: string;
  size: number;
  body: ReadableStream<Uint8Array> | (() => ReadableStream<Uint8Array>);
}

/** An even block of zero bytes used for header fields, padding, and the end-of-archive marker. */
function zeroBlock(): Uint8Array { return new Uint8Array(BLOCK); }

/** Left-pad an octal count into a NUL-terminated tar numeric field of `width` bytes (value then NUL). */
function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

/** Write an ASCII/NUL-terminated string into `block` at `offset`, truncated to `length` bytes. */
function writeField(block: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = encoder.encode(value);
  block.set(bytes.subarray(0, length), offset);
}

/** A name is representable in the plain ustar `name` field only when ASCII and at most 100 bytes. */
function plainName(name: string): boolean {
  if (name.length > 100) return false;
  for (let i = 0; i < name.length; i++) if (name.charCodeAt(i) > 0x7f) return false;
  return encoder.encode(name).length <= 100;
}

/** An ASCII-safe fallback for the ustar `name` field when the real name goes through a PAX `path` record. */
function fallbackName(name: string): string {
  let ascii = '';
  for (const ch of name) ascii += ch.charCodeAt(0) <= 0x7f && ch !== '\0' ? ch : '_';
  return ascii.slice(0, 100);
}

/**
 * The 512-byte ustar header block for one regular-file member. mode 0644, uid/gid 0, size in octal,
 * typeflag '0', `ustar\0` magic + `00` version; the checksum is computed over the header with its own
 * field spaces-filled, then written back as octal + NUL + space (the historical ustar checksum form).
 */
export function tarHeader(entry: { name: string; size: number; mtime?: number; typeflag?: string }): Uint8Array {
  const block = zeroBlock();
  writeField(block, 0, 100, entry.name); // name (ASCII fallback when a PAX path record precedes this member)
  writeField(block, 100, 8, octal(0o644, 8)); // mode
  writeField(block, 108, 8, octal(0, 8)); // uid
  writeField(block, 116, 8, octal(0, 8)); // gid
  writeField(block, 124, 12, octal(entry.size, 12)); // size
  writeField(block, 136, 12, octal(Math.floor(entry.mtime ?? 0), 12)); // mtime (epoch seconds)
  block[156] = (entry.typeflag ?? '0').charCodeAt(0); // typeflag: '0' regular file, 'x' PAX extended header
  writeField(block, 257, 6, 'ustar\0'); // magic
  block[263] = 0x30; block[264] = 0x30; // version "00"
  for (let i = 148; i < 156; i++) block[i] = 0x20; // checksum field spaces-filled before summing
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += block[i]!;
  writeField(block, 148, 8, octal(sum, 7)); // six octal digits + NUL; byte 155 stays a space
  block[155] = 0x20;
  return block;
}

/** The padding needed to round `size` bytes up to the next 512-byte boundary (empty when already aligned). */
function padding(size: number): Uint8Array {
  const rem = size % BLOCK;
  return rem === 0 ? new Uint8Array(0) : new Uint8Array(BLOCK - rem);
}

/**
 * A PAX extended-header member (typeflag 'x') carrying a single `path=<utf-8 name>` record. Each PAX
 * record is the self-describing form `"%d %s=%s\n"` whose leading decimal is the total record length
 * in bytes including that decimal and its following space (POSIX pax). UTF-8 / long names always go
 * through this record (the task: "pax headers for UTF-8 names").
 */
export function paxPathRecord(name: string): Uint8Array {
  const tail = ` path=${name}\n`;
  const tailBytes = encoder.encode(tail).length;
  // The leading decimal counts itself, so grow the digit count until it is self-consistent.
  let len = tailBytes + String(tailBytes).length;
  while (String(len).length + tailBytes !== len) len = String(len).length + tailBytes;
  return encoder.encode(`${len} path=${name}\n`);
}

/** Concatenate byte chunks into one Uint8Array. */
function concat(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** The header blocks for one member: a PAX `path` block + its data block for UTF-8/long names, else just the ustar block. */
export function memberHeaderBlocks(member: { name: string; size: number }): Uint8Array {
  if (plainName(member.name)) return tarHeader({ name: member.name, size: member.size });
  const pax = paxPathRecord(member.name);
  return concat(
    tarHeader({ name: `PaxHeader/${fallbackName(member.name)}`.slice(0, 100), size: pax.length, typeflag: 'x' }),
    pax, padding(pax.length),
    tarHeader({ name: fallbackName(member.name), size: member.size }),
  );
}

/** The end-of-archive marker: two zero blocks (the POSIX minimum). The stream is already 512-aligned, so no further padding is needed. */
export function endOfArchive(): Uint8Array { return new Uint8Array(BLOCK * 2); }

/** Resolve a member body to a fresh ReadableStream (a thunk is called each time so a volume can be streamed more than once). */
function memberBody(member: TarMember): ReadableStream<Uint8Array> {
  return typeof member.body === 'function' ? member.body() : member.body;
}

/**
 * Stream one self-contained tar archive over `members`: for each, its PAX+ustar header, then its body
 * bytes piped straight through, then padding to a 512 boundary; the archive ends with two zero blocks.
 * Neither the whole archive nor any member body is buffered in memory.
 */
export function tarStream(members: Iterable<TarMember>): ReadableStream<Uint8Array> {
  const iterator = members[Symbol.iterator]();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let memberSize = 0; // declared size of the member currently being piped
  let remaining = 0; // bytes still expected from that member's declared size
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (reader) {
          const { done, value } = await reader.read();
          if (!done) {
            remaining -= value.length;
            if (remaining < 0) throw new Error('tar member body longer than its declared size');
            controller.enqueue(value);
            return;
          }
          reader = null;
          if (remaining !== 0) throw new Error(`tar member body ${remaining} bytes short of its declared size`);
          const pad = padding(memberSize); // pad the member's data to a 512 boundary once the body ends
          if (pad.length) controller.enqueue(pad);
          return; // the next pull emits the following member's header or the end marker
        }
        const next = iterator.next();
        if (next.done) { controller.enqueue(endOfArchive()); controller.close(); return; }
        const member = next.value;
        controller.enqueue(memberHeaderBlocks(member));
        if (member.size > 0) { reader = memberBody(member).getReader(); memberSize = member.size; remaining = member.size; }
      } catch (error) { controller.error(error); }
    },
    async cancel() { await reader?.cancel(); },
  });
}

/**
 * Split a package's members into volumes of at most `OPERATIONS.exportObjectsPerVolume` (900) objects,
 * so each volume stays within the per-invocation limit on calls to Cloudflare services (R35.9). Yields
 * one `TarMember[]` per volume; the caller streams each with `tarStream` as its own self-contained tar
 * (its own end-of-archive marker) for one Download_Link request. A generator keeps all volumes lazy.
 */
export function* tarVolumes<T extends { name: string; size: number }>(
  members: Iterable<T>,
  perVolume = OPERATIONS.exportObjectsPerVolume,
): Generator<T[]> {
  let batch: T[] = [];
  for (const member of members) {
    batch.push(member);
    if (batch.length === perVolume) { yield batch; batch = []; }
  }
  if (batch.length) yield batch;
}

/** Round `size` up to the next 512-byte boundary. */
function roundUp(size: number): number { return size % BLOCK === 0 ? size : size + (BLOCK - size % BLOCK); }

/**
 * The exact byte length of the tar stream `tarStream` would produce for these members, without reading
 * any body: per member its header blocks (a PAX block + record padding + the ustar block for a UTF-8 /
 * long name, else one ustar block) and its padded data, plus the two zero end blocks. rf-dl uses this
 * for a volume's Content-Length and HEAD, since tar is size-prefixed and the sizes come from R2 `head`.
 */
export function tarByteLength(members: Iterable<{ name: string; size: number }>): number {
  let total = 0;
  for (const member of members) {
    total += memberHeaderBlocks(member).length + roundUp(member.size);
  }
  return total + endOfArchive().length;
}
