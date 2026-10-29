import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/api';
import { previewCsvStream } from '../src/files/preview/csv-stream';
import type { CsvLimits } from '../src/files/preview/csv-stream';
import { imageDimensions, imageMime } from '../src/files/preview/magic';
import { rangeReader } from '../src/files/preview/ranges';
import { DownloadSource, PreviewError, readBounded } from '../src/files/preview/transport';
import { pageScale } from '../src/files/preview/pdf';
import { FilePreview } from '../src/files/preview';
import { failure, fakeApi, renderScreen } from './helpers';

const pdfjs = vi.hoisted(() => ({ options: [] as { range: { requestDataRange(begin: number, end: number): void; onDataRange: (begin: number, chunk: Uint8Array) => void } }[], password: false, destroyed: 0, pages: 3 }));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'worker.js' }));
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  PDFDataRangeTransport: class { onDataRange = vi.fn(); constructor(readonly length: number, readonly initialData: Uint8Array) {} requestDataRange(_begin: number, _end: number): void { /* replaced by the preview */ } },
  getDocument: (options: (typeof pdfjs.options)[number]) => {
    pdfjs.options.push(options);
    const promise = pdfjs.password ? Promise.reject(Object.assign(new Error('password'), { name: 'PasswordException' }))
      : Promise.resolve({ numPages: pdfjs.pages, getPage: () => Promise.resolve({ getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }), render: () => ({ cancel() { /* nothing to cancel */ }, promise: Promise.resolve() }) }) });
    return { promise, destroy: () => { pdfjs.destroyed += 1; return Promise.resolve(); } };
  },
}));

const LIMITS: CsvLimits = { rows: 1000, scanBytes: 32 * 1024 * 1024, recordBytes: 256 * 1024, bufferBytes: 2 * 1024 * 1024 };
const encode = (text: string) => new TextEncoder().encode(text);
/** A body in chunks that records how far the reader got and whether it was cancelled. */
function source(chunks: Uint8Array[]) {
  const seen = { pulled: 0, finished: false };
  async function* generate(): AsyncGenerator<Uint8Array> { try { for (const chunk of chunks) { seen.pulled += 1; yield chunk; } } finally { seen.finished = true; } }
  return { seen, chunks: generate() };
}
function* rowsOf(count: number): Generator<string> { for (let i = 0; i < count; i++) yield `${i},value ${i}\n`; }
const split = (text: string, size: number) => { const bytes = encode(text); const out: Uint8Array[] = []; for (let at = 0; at < bytes.length; at += size) out.push(bytes.subarray(at, at + size)); return out; };

describe('streamed CSV preview', () => {
  it('stops reading as soon as the lookahead row proves that more rows exist', async () => {
    const { seen, chunks } = source(split(`id,value\n${[...rowsOf(50_000)].join('')}`, 4096));
    const csv = await previewCsvStream(chunks, LIMITS);
    expect(csv.rows).toHaveLength(1000); expect(csv.remainder).toBe('more'); expect(csv.rows[999]).toEqual(['999', 'value 999']);
    expect(seen.finished).toBe(true); expect(seen.pulled).toBeLessThan(40);
  });
  it('reports the end of the file when the last row has no line break, and does not count a lookahead that is not there', async () => {
    const csv = await previewCsvStream(source(split('a,b\r\n1,2\r\n3,4', 3)).chunks, LIMITS);
    expect(csv).toMatchObject({ headers: ['a', 'b'], rows: [['1', '2'], ['3', '4']], remainder: 'end' });
    expect(await previewCsvStream(source(split(`h\n${[...rowsOf(1000)].map((row) => row.split(',')[0]).join('\n')}\n`, 7)).chunks, LIMITS)).toMatchObject({ remainder: 'end' });
    expect((await previewCsvStream(source([]).chunks, LIMITS))).toMatchObject({ headers: [], rows: [], remainder: 'end' });
  });
  it('keeps a quoted cell with line breaks and quotes whole, whatever the chunk boundaries', async () => {
    const text = 'a,b\n"line one\nline ""two""\r\nline three",x\n"y",""\n';
    for (const size of [1, 2, 3, 5, 64]) expect(await previewCsvStream(source(split(text, size)).chunks, LIMITS)).toMatchObject({ rows: [['line one\nline "two"\r\nline three', 'x'], ['y', '']], remainder: 'end' });
  });
  it('treats a quote inside an unquoted field as text and handles semicolon files', async () => {
    expect((await previewCsvStream(source(split('a;b\n5" tape;"x;y"\nnext;row\n', 4)).chunks, LIMITS)).rows).toEqual([['5" tape', 'x;y'], ['next', 'row']]);
  });
  it('never shows a quoted cell that the input ends inside', async () => {
    await expect(previewCsvStream(source(split('a,b\n1,"never closed\nstill open', 5)).chunks, LIMITS)).rejects.toMatchObject({ kind: 'damaged' });
  });
  it('stops at the scan budget and says the remainder is unknown, showing only complete rows', async () => {
    const limits = { ...LIMITS, scanBytes: 1000 };
    const csv = await previewCsvStream(source(split(`id,value\n${[...rowsOf(5000)].join('')}`, 300)).chunks, limits);
    expect(csv.remainder).toBe('unknown'); expect(csv.stoppedBy).toBe('scan'); expect(csv.scannedBytes).toBeLessThanOrEqual(1000);
    expect(csv.rows.length).toBeGreaterThan(10); expect(csv.rows.length).toBeLessThan(200);
    for (const [number, value] of csv.rows) expect(value).toBe(`value ${number}`);
    expect(await previewCsvStream(source(split('a\n1\n', 1)).chunks, { ...LIMITS, scanBytes: 4 })).toMatchObject({ remainder: 'end' });
  });
  it('stops at the record limit with the rows before it, or refuses a first record that is too large', async () => {
    const huge = `"${'x'.repeat(5000)}",1\n`;
    const csv = await previewCsvStream(source(split(`a,b\n1,2\n${huge}3,4\n`, 100)).chunks, { ...LIMITS, recordBytes: 1000 });
    expect(csv).toMatchObject({ rows: [['1', '2']], remainder: 'unknown', stoppedBy: 'record' });
    const open = await previewCsvStream(source(split(`a,b\n1,2\n"${'y'.repeat(5000)}`, 100)).chunks, { ...LIMITS, recordBytes: 1000 });
    expect(open).toMatchObject({ rows: [['1', '2']], remainder: 'unknown', stoppedBy: 'record' });
    await expect(previewCsvStream(source(split(`${'h'.repeat(3000)},b\n1,2\n`, 100)).chunks, { ...LIMITS, recordBytes: 1000 })).rejects.toMatchObject({ kind: 'limit' });
  });
  it('stops at the buffering budget', async () => {
    const csv = await previewCsvStream(source(split(`id,value\n${[...rowsOf(5000)].join('')}`, 500)).chunks, { ...LIMITS, bufferBytes: 2000 });
    expect(csv).toMatchObject({ remainder: 'unknown', stoppedBy: 'buffer' }); expect(csv.rows.length).toBeLessThan(200);
  });
  it('names a binary file and invalid UTF-8', async () => {
    await expect(previewCsvStream(source([Uint8Array.from([97, 44, 0, 10])]).chunks, LIMITS)).rejects.toMatchObject({ kind: 'mismatch' });
    await expect(previewCsvStream(source([Uint8Array.from([97, 44, 0xff, 10])]).chunks, LIMITS)).rejects.toMatchObject({ kind: 'damaged' });
  });
});

describe('Download_Link transport', () => {
  const link = (urls: string[]) => ({ post: vi.fn(() => Promise.resolve({ url: urls.shift() ?? 'https://dl.example.test/t/last' })) }) as unknown as Pick<ApiClient, 'post'> & { post: ReturnType<typeof vi.fn> };
  it('fetches a new link once when storage refuses a read, then fails as unavailable', async () => {
    const client = link(['https://dl.example.test/t/old', 'https://dl.example.test/t/new']);
    const fetcher = vi.fn((url: RequestInfo | URL) => Promise.resolve(String(url).endsWith('/old') ? new Response('Not found', { status: 404 }) : new Response('ok')));
    const download = new DownloadSource(client, 'f1', fetcher as typeof fetch);
    expect(await (await download.fetch(new AbortController().signal)).text()).toBe('ok'); expect(client.post).toHaveBeenCalledTimes(2); expect(fetcher).toHaveBeenCalledWith('https://dl.example.test/t/new', expect.objectContaining({ credentials: 'omit' }));
    const gone = new DownloadSource(link([]), 'f1', (() => Promise.resolve(new Response('Not found', { status: 404 }))) as typeof fetch);
    await expect(gone.fetch(new AbortController().signal)).rejects.toMatchObject({ kind: 'unavailable' });
  });
  it('renews a link before it expires and shares one request between concurrent reads', async () => {
    let clock = 0; const client = link(['https://dl.example.test/t/1', 'https://dl.example.test/t/2']);
    const download = new DownloadSource(client, 'f1', (() => Promise.resolve(new Response('ok'))) as typeof fetch, () => clock);
    await Promise.all([download.url(), download.url(), download.url()]); expect(client.post).toHaveBeenCalledTimes(1);
    clock = 13 * 60_000; await download.url(); expect(client.post).toHaveBeenCalledTimes(1);
    clock = 14.5 * 60_000; expect(await download.url()).toBe('https://dl.example.test/t/2');
  });
  it('reads at most the limit from a response and cancels the rest', async () => {
    let cancelled = false; let sent = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { sent += 1000; controller.enqueue(new Uint8Array(1000).fill(65)); }, cancel() { cancelled = true; } });
    const result = await readBounded(new Response(body), 2500);
    expect(result.bytes.byteLength).toBe(2500); expect(result.truncated).toBe(true); expect(cancelled).toBe(true); expect(sent).toBeLessThanOrEqual(5000);
    expect(await readBounded(new Response(new Uint8Array(100)), 100)).toMatchObject({ truncated: false });
    expect((await readBounded(new Response(new Uint8Array(101)), 100)).truncated).toBe(true);
  });
  it('counts every transferred byte against the cache budget and keeps only the range asked for', async () => {
    const file = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);
    const fetcher = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => { const range = /bytes=(\d+)-(\d+)/u.exec(new Headers(init?.headers).get('Range') ?? ''); return Promise.resolve(range ? new Response(file.slice(Number(range[1]), Number(range[2]) + 1), { status: 206 }) : new Response(file)); });
    const reader = rangeReader(new DownloadSource(link([]), 'f1', fetcher as typeof fetch), 1000, 600, new AbortController().signal);
    expect(Array.from(await reader.read(100, 110))).toEqual(Array.from(file.slice(100, 110)));
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ headers: { Range: 'bytes=100-109' } });
    await reader.read(0, 500); expect(reader.transferred).toBe(510);
    await expect(reader.read(500, 700)).rejects.toMatchObject({ kind: 'limit' });
    const ignoring = rangeReader(new DownloadSource(link([]), 'f1', (() => Promise.resolve(new Response(file))) as typeof fetch), 1000, 5000, new AbortController().signal);
    expect(Array.from(await ignoring.read(10, 20))).toEqual(Array.from(file.slice(10, 20)));
  });
});

describe('raster images', () => {
  const png = (width: number, height: number) => { const bytes = new Uint8Array(33); bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]); new DataView(bytes.buffer).setUint32(16, width); new DataView(bytes.buffer).setUint32(20, height); return bytes; };
  it('reads pixel sizes from PNG, GIF, JPEG and WebP headers', () => {
    expect(imageDimensions(png(640, 480))).toEqual({ width: 640, height: 480 });
    const gif = new Uint8Array(13); gif.set(encode('GIF89a')); new DataView(gif.buffer).setUint16(6, 30, true); new DataView(gif.buffer).setUint16(8, 20, true);
    expect(imageDimensions(gif)).toEqual({ width: 30, height: 20 });
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0x01, 0xe0, 0x02, 0x80, 3, 0, 0, 0]);
    expect(imageDimensions(jpeg)).toEqual({ width: 640, height: 480 });
    const webp = new Uint8Array(30); webp.set(encode('RIFF')); webp.set(encode('WEBP'), 8); webp.set(encode('VP8X'), 12); webp.set([143, 1, 0], 24); webp.set([199, 0, 0], 27);
    expect(imageDimensions(webp)).toEqual({ width: 400, height: 200 });
    expect(imageDimensions(Uint8Array.from([0xff, 0xd8, 0xff, 0, 0]))).toBeNull();
  });
  it('rejects SVG and HTML whatever the file name says', () => { expect(imageMime(encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull(); expect(imageMime(encode('<html>'))).toBeNull(); });
});

describe('FilePreview', () => {
  const CSV_TEXT = `id,value\n${[...rowsOf(3000)].join('')}`;
  let store: Record<string, { body: Uint8Array; ranged: boolean }>; let requests: { url: string; range: string | null }[]; let links: number;
  beforeEach(() => {
    store = {}; requests = []; links = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); const range = new Headers(init?.headers).get('Range'); requests.push({ url, range });
      const entry = store[url.split('/').pop()!];
      if (!entry) return Promise.resolve(new Response('Not found', { status: 404 }));
      const match = /bytes=(\d+)-(\d+)/u.exec(range ?? '');
      return Promise.resolve(match && entry.ranged ? new Response(entry.body.slice(Number(match[1]), Number(match[2]) + 1), { status: 206 }) : new Response(entry.body.slice()));
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); pdfjs.options.length = 0; pdfjs.password = false; pdfjs.destroyed = 0; });
  const api = (id: string, extra: Parameters<typeof fakeApi>[0] = {}) => fakeApi({ 'GET /resource-profile': failure(404, 'not_found'), [`POST /files/${id}/link`]: () => ({ url: `https://dl.example.test/t/${id}-${++links}` }), ...extra }).client;
  const show = (file: { id: string; fileKind: string; originalName: string; sizeBytes: number }) => renderScreen(<FilePreview file={file} />, { client: api(file.id) });
  const put = (id: string, body: Uint8Array, ranged = true) => { for (let i = 1; i <= 5; i++) store[`${id}-${i}`] = { body, ranged }; };

  it('previews only the first decimal megabyte of a log with a range, and still bounds a server that ignores the range', async () => {
    put('log', new Uint8Array(3_000_000).fill(65), false);
    show({ id: 'log', fileKind: 'text_log', originalName: 'run.log', sizeBytes: 3_000_000 });
    expect(await screen.findByText('Showing 1000000 of 3000000 bytes')).toBeTruthy(); expect(requests[0]!.range).toBe('bytes=0-999999');
  });
  it('shows 1,000 CSV rows from a stream, cancelling the transfer, and says more rows exist', async () => {
    put('table', encode(CSV_TEXT));
    show({ id: 'table', fileKind: 'csv', originalName: 'table.csv', sizeBytes: CSV_TEXT.length });
    expect(await screen.findByText('1000 rows shown. More rows exist.')).toBeTruthy(); expect(screen.getAllByRole('row')).toHaveLength(1001);
  });
  it('names a CSV that is damaged and a file that is not the recorded type', async () => {
    put('bad', Uint8Array.from([97, 44, 0xff, 10])); show({ id: 'bad', fileKind: 'csv', originalName: 'bad.csv', sizeBytes: 4 });
    expect(await screen.findByText('Preview unavailable: The file does not contain valid UTF-8 text.')).toBeTruthy();
  });
  it('refuses an SVG renamed to .png and a PNG whose decoded size passes the budget', async () => {
    put('svg', encode('<svg onload="alert(1)"></svg>')); show({ id: 'svg', fileKind: 'image', originalName: 'x.png', sizeBytes: 29 });
    expect(await screen.findByText('Preview unavailable: The file does not match its recorded image format.')).toBeTruthy();
  });
  it('refuses a huge image by its header before decoding it', async () => {
    const header = new Uint8Array(33); header.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]); new DataView(header.buffer).setUint32(16, 20_000); new DataView(header.buffer).setUint32(20, 20_000);
    const createObjectURL = vi.fn(() => 'blob:x'); vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    put('big', header); show({ id: 'big', fileKind: 'image', originalName: 'big.png', sizeBytes: 33 });
    expect(await screen.findByText(/Preview unavailable: The image exceeds the preview limits/u)).toBeTruthy(); expect(createObjectURL).not.toHaveBeenCalled();
  });
  it('turns a polyglot PNG into an image blob of type image/png only', async () => {
    const polyglot = new Uint8Array(100); polyglot.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]); new DataView(polyglot.buffer).setUint32(16, 10); new DataView(polyglot.buffer).setUint32(20, 10); polyglot.set(encode('<script>alert(1)</script>'), 40);
    let blob: Blob | undefined; vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: (value: Blob) => { blob = value; return 'blob:poly'; }, revokeObjectURL: vi.fn() }));
    put('poly', polyglot); show({ id: 'poly', fileKind: 'image', originalName: 'p.png', sizeBytes: 100 });
    expect(await screen.findByAltText('Attachment preview')).toBeTruthy(); expect(blob?.type).toBe('image/png');
  });
  it('reads a PDF by range through PDF.js, with navigation, refreshing the link when storage refuses it', async () => {
    const pdf = new Uint8Array(200_000).fill(32); pdf.set(encode('%PDF-1.7'));
    put('doc', pdf); delete store['doc-1']; // the first link is refused, the second works
    show({ id: 'doc', fileKind: 'pdf', originalName: 'doc.pdf', sizeBytes: 200_000 });
    expect(await screen.findByText('Page 1 of 3')).toBeTruthy(); expect(links).toBe(2);
    fireEvent.click(screen.getByRole('button', { name: 'Next page' })); expect(await screen.findByText('Page 2 of 3')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Go to page'), { target: { value: '3' } }); expect(await screen.findByText('Page 3 of 3')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next page' }).hasAttribute('disabled')).toBe(true);
    const range = pdfjs.options[0]!.range; const onData = vi.fn(); range.onDataRange = onData;
    await act(async () => { range.requestDataRange(65_536, 131_072); await waitFor(() => expect(onData).toHaveBeenCalled()); });
    expect(requests.at(-1)!.range).toBe('bytes=65536-131071'); expect(onData.mock.calls[0]![0]).toBe(65_536); expect(onData.mock.calls[0]![1]).toHaveLength(65_536);
    expect(pdfjs.options[0]).toMatchObject({ disableAutoFetch: true, disableStream: true, enableXfa: false });
  });
  it('names a password-protected PDF, a file that is not a PDF, and a PDF past the cache budget', async () => {
    pdfjs.password = true; const pdf = new Uint8Array(1000); pdf.set(encode('%PDF-1.7')); put('locked', pdf);
    show({ id: 'locked', fileKind: 'pdf', originalName: 'locked.pdf', sizeBytes: 1000 });
    expect(await screen.findByText('Preview unavailable: The PDF is password-protected.')).toBeTruthy();
  });
  it('rejects bytes that are not a PDF', async () => {
    put('fake', encode('<html>not a pdf</html>')); show({ id: 'fake', fileKind: 'pdf', originalName: 'fake.pdf', sizeBytes: 22 });
    expect(await screen.findByText('Preview unavailable: The file does not match its recorded PDF format.')).toBeTruthy();
  });
  it('says the file is unavailable when storage never serves it', async () => {
    show({ id: 'nothing', fileKind: 'text_log', originalName: 'x.log', sizeBytes: 5 });
    expect(await screen.findByText('Preview unavailable: The file is unavailable from storage.')).toBeTruthy();
  });
});

it('draws a page smaller when its canvas would pass the decoded-image budget', () => {
  expect(pageScale(600, 800, 32 * 1024 * 1024)).toBe(1.25);
  const scale = pageScale(20_000, 20_000, 32 * 1024 * 1024);
  expect(20_000 * 20_000 * scale * scale * 4).toBeLessThanOrEqual(32 * 1024 * 1024 + 1);
});
it('describes preview failures with their kind', () => { expect(new PreviewError('limit', 'x').kind).toBe('limit'); });
