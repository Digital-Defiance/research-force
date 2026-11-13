// Feature: research-collab-cms, Task 38.3 — package volume streaming (R28.8, R35.9, R36.2).
// A streaming POSIX (ustar) tar encoder with PAX extended headers for UTF-8 names. rf-dl
// assembles a package volume as a tar stream on the fly from the volume's member R2 objects
// (design "Export_Service" Delivery: "rf-dl streams the package as POSIX tar volumes (pax
// headers for UTF-8 names), each with at most 900 objects"), so no whole volume is ever buffered.
import { OPERATIONS } from '@researchforce/domain/settings';

import { endOfArchive, memberHeaderBlocks, padding } from '@researchforce/domain/tar-layout';

// The pure ustar/PAX encoders and the byte layout live in the domain package so the backup packer (apps/app) shares
// them; the names rf-dl and its tests already use are re-exported unchanged.
export { endOfArchive, memberHeaderBlocks, paxPathRecord, tarByteLength, tarHeader } from '@researchforce/domain/tar-layout';

/** One archive member. `size` must be known up front because the ustar header is size-prefixed (R2 `head` gives it). */
export interface TarMember {
  name: string;
  size: number;
  body: ReadableStream<Uint8Array> | (() => ReadableStream<Uint8Array>);
}

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
