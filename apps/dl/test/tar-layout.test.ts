// Feature: research-collab-cms, Task 38.3 — the pre-built tar layout equals rf-dl's streaming encoder (R35.9, R36.2).
import { expect, it } from 'vitest';
import { tarLayout, tarRangeSegments } from '@researchforce/domain/tar-layout';
import { tarStream } from '../src/tar';

const te = new TextEncoder();

it('lays out the same bytes tarStream produces for ASCII, UTF-8 PAX, and zero-size members', async () => {
  const members = [
    { name: 'header.json', data: te.encode('{"a":1}') },
    { name: 'files/ABCD-EFGH-JKLM', data: new Uint8Array(1500).map((_v, i) => (i * 7) & 0xff) },
    { name: 'files/протокол.txt', data: te.encode('данные') },
    { name: 'body/empty.jsonl', data: new Uint8Array(0) },
  ];
  const streamed = new Uint8Array(await new Response(tarStream(members.map((m) => ({
    name: m.name, size: m.data.length, body: () => new Response(m.data).body!,
  })))).arrayBuffer());
  const layout = tarLayout(members.map((m) => ({ name: m.name, size: m.data.length })));
  expect(layout.total).toBe(streamed.length);
  const chunks: Uint8Array[] = [];
  for (const segment of tarRangeSegments(layout, 0, layout.total)) {
    chunks.push(segment.kind === 'bytes' ? segment.bytes : members[segment.index]!.data.subarray(segment.offset, segment.offset + segment.length));
  }
  expect(new Uint8Array(await new Blob(chunks as BlobPart[]).arrayBuffer())).toEqual(streamed);
});
