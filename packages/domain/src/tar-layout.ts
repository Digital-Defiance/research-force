// Feature: research-collab-cms, Task 38.3 — package volume tar layout (R28.8, R35.9, R36.2).
// Pure POSIX (ustar) encoders with PAX extended headers for UTF-8 names, plus a byte-exact LAYOUT of a tar built from
// sized members. The layout lets a packer produce any byte window of the archive (header bytes, a member's byte range,
// zero padding, the end marker) without holding the archive, so a backup volume can be pre-built into one R2 object
// in resumable slices (R36.2) and rf-dl's on-the-fly stream (public exports) shares the same encoders.

export const BLOCK = 512; // ustar block size; every header and member payload is padded to this boundary.
// The domain package compiles without DOM/Workers typings; the runtime (Workers, Node) always provides TextEncoder.
declare const TextEncoder: new () => { encode(input?: string): Uint8Array };
const encoder = new TextEncoder();

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
export function padding(size: number): Uint8Array {
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

/** Round `size` up to the next 512-byte boundary. */
export function roundUp(size: number): number { return size % BLOCK === 0 ? size : size + (BLOCK - size % BLOCK); }

/**
 * The exact byte length of the tar stream these members produce, without reading any body: per member its header
 * blocks (a PAX block + record padding + the ustar block for a UTF-8 / long name, else one ustar block) and its padded
 * data, plus the two zero end blocks. rf-dl uses this for a volume's Content-Length and HEAD, since tar is
 * size-prefixed and the sizes come from R2 `head`.
 */
export function tarByteLength(members: Iterable<{ name: string; size: number }>): number {
  let total = 0;
  for (const member of members) {
    total += memberHeaderBlocks(member).length + roundUp(member.size);
  }
  return total + endOfArchive().length;
}

/** One member's place in the archive: its header bytes at `headerStart`, then `size` data bytes from `dataStart`. */
export interface TarLayoutMember {
  readonly headerStart: number;
  readonly header: Uint8Array;
  readonly dataStart: number;
  readonly size: number;
}
/** The byte layout of a whole archive: every member's place and the total length (including the end marker). */
export interface TarLayout { readonly members: readonly TarLayoutMember[]; readonly total: number }

/** Lay out a tar of `members` (sizes known up front) so any byte window of it can be produced independently. */
export function tarLayout(members: Iterable<{ name: string; size: number }>): TarLayout {
  const placed: TarLayoutMember[] = [];
  let at = 0;
  for (const member of members) {
    const header = memberHeaderBlocks(member);
    placed.push({ headerStart: at, header, dataStart: at + header.length, size: member.size });
    at += header.length + roundUp(member.size);
  }
  return { members: placed, total: at + endOfArchive().length };
}

/** A piece of an archive window: literal bytes (header, padding, end marker) or a byte range of member `index`'s body. */
export type TarSegment =
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array }
  | { readonly kind: 'member'; readonly index: number; readonly offset: number; readonly length: number };

/**
 * The segments, in order, that make up the archive bytes `[start, endExclusive)`. Concatenating every segment over
 * `[0, layout.total)` equals the archive byte for byte; any window equals the matching slice. Member segments carry
 * only an offset and length, so the caller streams the body without buffering it.
 */
export function* tarRangeSegments(layout: TarLayout, start: number, endExclusive: number): Generator<TarSegment> {
  const end = Math.min(endExclusive, layout.total);
  if (start >= end) return;
  // Emit the part of [from, to) that falls inside the requested window, using `make` to build it from window-relative offsets.
  function* window(from: number, to: number, make: (offset: number, length: number) => TarSegment): Generator<TarSegment> {
    const lo = Math.max(from, start);
    const hi = Math.min(to, end);
    if (lo < hi) yield make(lo - from, hi - lo);
  }
  for (const [index, member] of layout.members.entries()) {
    const padded = member.dataStart + roundUp(member.size);
    if (padded <= start) continue;
    if (member.headerStart >= end) return;
    yield* window(member.headerStart, member.dataStart, (offset, length) => ({ kind: 'bytes', bytes: member.header.subarray(offset, offset + length) }));
    yield* window(member.dataStart, member.dataStart + member.size, (offset, length) => ({ kind: 'member', index, offset, length }));
    yield* window(member.dataStart + member.size, padded, (_offset, length) => ({ kind: 'bytes', bytes: new Uint8Array(length) }));
  }
  const endStart = layout.total - BLOCK * 2;
  yield* window(endStart, layout.total, (offset, length) => ({ kind: 'bytes', bytes: endOfArchive().subarray(offset, offset + length) }));
}
