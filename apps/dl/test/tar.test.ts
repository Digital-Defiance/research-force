// Feature: research-collab-cms, Task 38.3 — POSIX tar volume encoder (R28.8, R35.9, R36.2).
import { describe, expect, it } from 'vitest';
import { OPERATIONS } from '@researchforce/domain/settings';
import { endOfArchive, memberHeaderBlocks, paxPathRecord, tarByteLength, tarHeader, tarStream, tarVolumes } from '../src/tar';
import type { TarMember } from '../src/tar';

const td = new TextDecoder();
const te = new TextEncoder();

/** The bytes of a NUL/space-terminated tar field at [offset, offset+length). */
function field(block: Uint8Array, offset: number, length: number): string {
  return td.decode(block.subarray(offset, offset + length)).replace(/[\0 ]+$/, '');
}

/** Concatenate the chunks a ReadableStream emits into one Uint8Array. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0; for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** A member whose body is a single in-memory chunk. */
function member(name: string, text: string): TarMember {
  const bytes = te.encode(text);
  return { name, size: bytes.length, body: () => new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }) };
}

/** A minimal pure ustar+pax reader: returns the decoded members {name, data} of one tar archive. */
function readTar(bytes: Uint8Array): { name: string; data: Uint8Array }[] {
  const members: { name: string; data: Uint8Array }[] = [];
  let offset = 0;
  let paxPath: string | null = null;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive zero block
    const typeflag = String.fromCharCode(header[156]!);
    const size = parseInt(field(header, 124, 12) || '0', 8);
    const data = bytes.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (typeflag === 'x') { // PAX extended header: parse the single "path=" record
      const record = td.decode(data);
      const m = /^\d+ path=(.*)\n$/s.exec(record);
      paxPath = m ? m[1]! : null;
      continue;
    }
    members.push({ name: paxPath ?? field(header, 0, 100), data });
    paxPath = null;
  }
  return members;
}

describe('ustar header', () => {
  it('writes correct octal fields and a valid checksum', () => {
    const block = tarHeader({ name: 'data/a.txt', size: 9, mtime: 0 });
    expect(block.length).toBe(512);
    expect(field(block, 0, 100)).toBe('data/a.txt');
    expect(field(block, 100, 8)).toBe('0000644'); // mode 0644
    expect(field(block, 108, 8)).toBe('0000000'); // uid 0
    expect(field(block, 116, 8)).toBe('0000000'); // gid 0
    expect(field(block, 124, 12)).toBe('00000000011'); // size 9 octal
    expect(field(block, 257, 6)).toBe('ustar'); // magic (NUL-terminated)
    expect(block[263]).toBe(0x30); expect(block[264]).toBe(0x30); // version "00"
    expect(String.fromCharCode(block[156]!)).toBe('0'); // typeflag regular file
    // The checksum is the unsigned sum of all header bytes with the checksum field spaces-filled.
    const withSpaces = block.slice();
    for (let i = 148; i < 156; i++) withSpaces[i] = 0x20;
    let sum = 0; for (const b of withSpaces) sum += b;
    expect(parseInt(field(block, 148, 8), 8)).toBe(sum);
    expect(block[155]).toBe(0x20); // the checksum field ends with a space
  });
});

describe('PAX path records for UTF-8 / long names', () => {
  it('emits a self-describing "%d path=<name>\\n" record with the right length prefix', () => {
    const name = 'файлы/протокол.txt'; // UTF-8, non-ASCII
    const record = paxPathRecord(name);
    const text = td.decode(record);
    expect(text).toMatch(/^\d+ path=файлы\/протокол\.txt\n$/);
    const declared = Number(text.split(' ', 1)[0]);
    expect(declared).toBe(record.length); // the leading decimal counts the whole record including itself
  });
  it('precedes a UTF-8 member with an "x" header and an ASCII-safe ustar fallback name', () => {
    const name = 'файл.txt';
    const blocks = memberHeaderBlocks({ name, size: 3 });
    expect(String.fromCharCode(blocks[156]!)).toBe('x'); // first block is the PAX extended header
    const paxLen = parseInt(field(blocks, 124, 12), 8);
    const pax = blocks.subarray(512, 512 + paxLen);
    expect(td.decode(pax)).toBe(`${paxPathRecord(name).length} path=${name}\n`);
    // The ustar member header follows the PAX block (padded to 512) and carries an ASCII fallback.
    const fileHeader = blocks.subarray(512 + Math.ceil(paxLen / 512) * 512);
    expect(String.fromCharCode(fileHeader[156]!)).toBe('0');
    const fallback = field(fileHeader, 0, 100);
    expect([...fallback].every((ch) => ch.charCodeAt(0) <= 0x7f)).toBe(true); // ASCII only
    expect(fallback).not.toContain('й');
  });
  it('keeps a plain ASCII short name in the ustar name field with no PAX block', () => {
    const blocks = memberHeaderBlocks({ name: 'r/SYN0-TEST.html', size: 5 });
    expect(blocks.length).toBe(512); // just the one ustar block, no PAX
    expect(String.fromCharCode(blocks[156]!)).toBe('0');
    expect(field(blocks, 0, 100)).toBe('r/SYN0-TEST.html');
  });
  it('routes a name longer than 100 bytes through a PAX record', () => {
    const name = `data/${'a'.repeat(200)}.txt`;
    const blocks = memberHeaderBlocks({ name, size: 0 });
    expect(String.fromCharCode(blocks[156]!)).toBe('x');
  });
});

describe('end-of-archive', () => {
  it('is two zero blocks (the POSIX minimum)', () => {
    const marker = endOfArchive();
    expect(marker.length).toBe(1024);
    expect(marker.every((b) => b === 0)).toBe(true);
  });
});

describe('tarStream framing', () => {
  it('pads member data to a 512 boundary and ends with two zero blocks', async () => {
    const bytes = await drain(tarStream([member('a.txt', 'hello')])); // 5 bytes of data
    expect(bytes.length).toBe(512 /*header*/ + 512 /*padded data*/ + 1024 /*end*/);
    // Data occupies bytes [512, 517); the rest of that 512 block is zero padding.
    expect(td.decode(bytes.subarray(512, 517))).toBe('hello');
    expect(bytes.subarray(517, 1024).every((b) => b === 0)).toBe(true);
    expect(bytes.subarray(1024).every((b) => b === 0)).toBe(true); // end marker
  });
  it('reports the exact byte length without reading any body', async () => {
    const members = [member('a.txt', 'hello'), member('файл.txt', 'x'.repeat(513))];
    const sized = [{ name: 'a.txt', size: 5 }, { name: 'файл.txt', size: 513 }];
    expect((await drain(tarStream(members))).length).toBe(tarByteLength(sized));
  });
  it('round-trips a small archive through a standard-shape tar reader', async () => {
    const members = [member('r/a.html', '<h1>A</h1>'), member('файлы/б.txt', 'данные'), member('data/empty', '')];
    const decoded = readTar(await drain(tarStream(members)));
    expect(decoded.map((m) => m.name)).toEqual(['r/a.html', 'файлы/б.txt', 'data/empty']);
    expect(td.decode(decoded[0]!.data)).toBe('<h1>A</h1>');
    expect(td.decode(decoded[1]!.data)).toBe('данные');
    expect(decoded[2]!.data.length).toBe(0);
  });
  it('matches a known fixed byte layout for a single small ASCII file', async () => {
    const bytes = await drain(tarStream([member('a', 'hi')]));
    // ustar: name 'a', mode 0000644, size 2 (octal "00000000002"), magic ustar, version 00, data "hi" padded.
    expect(field(bytes.subarray(0, 512), 0, 100)).toBe('a');
    expect(field(bytes.subarray(0, 512), 124, 12)).toBe('00000000002');
    expect(field(bytes.subarray(0, 512), 257, 6)).toBe('ustar');
    expect(td.decode(bytes.subarray(512, 514))).toBe('hi');
    expect(bytes.length).toBe(512 + 512 + 1024);
  });
});

describe('tarVolumes splitting at 900 objects', () => {
  it('splits 901 members into two volumes (900 + 1)', () => {
    const members = Array.from({ length: 901 }, (_, i) => ({ name: `f${i}`, size: 0 }));
    const volumes = [...tarVolumes(members)];
    expect(volumes.length).toBe(2);
    expect(volumes[0]!.length).toBe(OPERATIONS.exportObjectsPerVolume);
    expect(volumes[1]!.length).toBe(1);
  });
  it('keeps exactly 900 members in a single volume', () => {
    const members = Array.from({ length: 900 }, (_, i) => ({ name: `f${i}`, size: 0 }));
    expect([...tarVolumes(members)].length).toBe(1);
  });
  it('yields no volume for an empty package and each volume is a self-contained tar', async () => {
    expect([...tarVolumes([])].length).toBe(0);
    const [volume] = [...tarVolumes([member('a.txt', 'x'), member('b.txt', 'y')])] as TarMember[][];
    const decoded = readTar(await drain(tarStream(volume!)));
    expect(decoded.map((m) => m.name)).toEqual(['a.txt', 'b.txt']); // its own end-of-archive marker
  });
});
