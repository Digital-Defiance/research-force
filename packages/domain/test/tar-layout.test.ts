// Feature: research-collab-cms, Task 38.3 — the byte layout of a package tar (R35.9, R36.2).
import { describe, expect, it } from 'vitest';
import { endOfArchive, memberHeaderBlocks, padding, tarByteLength, tarLayout, tarRangeSegments } from '../src/tar-layout';
import type { TarLayout } from '../src/tar-layout';

const te = new TextEncoder();
const members = [
  { name: 'header.json', data: te.encode('{"a":1}') },
  { name: 'files/ABCD-EFGH-JKLM', data: new Uint8Array(1500).map((_v, i) => (i * 31) & 0xff) }, // spans three blocks
  { name: 'body/aligned.jsonl', data: new Uint8Array(1024).fill(7) }, // exactly block aligned: no padding
  { name: 'files/протокол-данные.txt', data: te.encode('данные') }, // UTF-8: PAX path record
  { name: `files/${'long-name-'.repeat(14)}.bin`, data: te.encode('long') }, // ASCII but over 100 bytes: PAX
  { name: 'body/empty.jsonl', data: new Uint8Array(0) }, // zero size
];

/** The straightforward reference: header blocks, body, padding per member, then the end marker. */
function reference(): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const member of members) parts.push(memberHeaderBlocks({ name: member.name, size: member.data.length }), member.data, padding(member.data.length));
  parts.push(endOfArchive());
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/** Materialize the window [start, end) from its segments, reading member bytes from the in-memory data. */
function render(layout: TarLayout, start: number, end: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const segment of tarRangeSegments(layout, start, end)) {
    chunks.push(segment.kind === 'bytes' ? segment.bytes : members[segment.index]!.data.subarray(segment.offset, segment.offset + segment.length));
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}

describe('tar layout', () => {
  const layout = tarLayout(members.map((m) => ({ name: m.name, size: m.data.length })));
  const whole = reference();

  it('reports the same total as tarByteLength and the reference archive', () => {
    expect(layout.total).toBe(whole.length);
    expect(layout.total).toBe(tarByteLength(members.map((m) => ({ name: m.name, size: m.data.length }))));
    expect(layout.total % 512).toBe(0);
  });

  it('concatenated segments over [0, total) equal the archive byte for byte', () => {
    expect(render(layout, 0, layout.total)).toEqual(whole);
  });

  it('any window equals the matching slice, including windows that start and end inside headers and padding', () => {
    const edges = [0, 1, 100, 511, 512, 513, 1000, 1024, 1536, 2047, 2048, 2500, 3071, 3072, 3584, layout.total - 1025, layout.total - 1024, layout.total - 1, layout.total];
    for (const start of edges) for (const end of edges) {
      if (start > end) continue;
      expect(render(layout, start, end), `${start}-${end}`).toEqual(whole.subarray(start, end));
    }
    // Part-sized windows tile the archive exactly.
    const part = 700;
    const tiled: Uint8Array[] = [];
    for (let at = 0; at < layout.total; at += part) tiled.push(render(layout, at, at + part));
    const joined = new Uint8Array(tiled.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const chunk of tiled) { joined.set(chunk, at); at += chunk.length; }
    expect(joined).toEqual(whole);
  });

  it('yields no segments for an empty or out-of-range window, and clamps an end past the total', () => {
    expect([...tarRangeSegments(layout, 10, 10)]).toEqual([]);
    expect([...tarRangeSegments(layout, layout.total, layout.total + 5)]).toEqual([]);
    expect(render(layout, layout.total - 10, layout.total + 500)).toEqual(whole.subarray(layout.total - 10));
  });

  it('lays out an empty archive as just the end marker', () => {
    const empty = tarLayout([]);
    expect(empty.total).toBe(1024);
    expect(render(empty, 0, 1024)).toEqual(endOfArchive());
  });
});
