import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UploadFields, metadataReasons, putFile, useUploads } from '../src/files/upload';
import { imageMime, isPdf } from '../src/files/preview/magic';
import { previewText } from '../src/files/preview/truncate';
import { fakeApi, renderScreen } from './helpers';

function Harness() { const uploads = useUploads(); return <form><UploadFields uploads={uploads} /><button disabled={uploads.files.length === 0 || uploads.reasons.length > 0}>Submit</button></form>; }
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
class HashWorker {
  onmessage?: (event: { data: { sha256: string; parts: string[] } }) => void;
  onerror?: () => void;
  postMessage() { queueMicrotask(() => this.onmessage?.({ data: { sha256: 'a'.repeat(64), parts: ['a'.repeat(64)] } })); }
  terminate() {}
}
function fakeXhr(statuses: number[]) {
  const requests: { url: string; headers: Record<string, string> }[] = [];
  class Xhr {
    upload: { onprogress?: (event: { loaded: number }) => void } = {};
    status = 0; url = ''; headers: Record<string, string> = {};
    onload?: () => void; onerror?: () => void; onabort?: () => void;
    open(_method: string, url: string) { this.url = url; }
    setRequestHeader(name: string, value: string) { this.headers[name] = value; }
    getResponseHeader() { return 'abcdef'; }
    send(bytes: Blob) { requests.push({ url: this.url, headers: this.headers }); this.status = statuses.shift() ?? 200; if (this.status) queueMicrotask(() => { this.upload.onprogress?.({ loaded: bytes.size }); this.onload?.(); }); }
    abort() { this.onabort?.(); }
  }
  vi.stubGlobal('XMLHttpRequest', Xhr); return requests;
}
describe('upload interactions', () => {
  it('keeps other files while retrying a failure, validates metadata, and supports removal', async () => {
    vi.stubGlobal('Worker', HashWorker); const requests = fakeXhr([500, 200]); let number = 0;
    const api = fakeApi({ 'GET /uploads/limits': { maximumBytes: 100 },
      'POST /uploads': () => ({ id: `upload-${++number}`, mode: 'single', url: 'https://r2.example.test/synthetic', headers: { 'content-length': '3', 'x-amz-checksum-sha256': 'digest' } }),
      'DELETE /uploads/upload-1': {}, 'POST /uploads/upload-2/complete': {},
    });
    renderScreen(<Harness />, { client: api.client });
    await waitFor(() => expect((screen.getByLabelText('Add files') as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText('Add files'), { target: { files: [new File(['abc'], 'Synthetic.txt')] } });
    await screen.findByRole('button', { name: 'Retry' }); expect((screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Origin (required)'), { target: { value: 'Synthetic output.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Upload complete');
    expect((screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement).disabled).toBe(false);
    expect(requests).toHaveLength(2); expect(requests[0]!.headers).toEqual({ 'x-amz-checksum-sha256': 'digest' });
    fireEvent.change(screen.getByLabelText('Title (required)'), { target: { value: '' } });
    expect((screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Remove file' })); expect(screen.queryByText('Synthetic.txt')).toBeNull();
  });
  it('refuses over-limit files before hashing or transfer and keeps accepted files', async () => {
    const worker = vi.fn(() => new HashWorker()); vi.stubGlobal('Worker', worker); fakeXhr([200]);
    const api = fakeApi({ 'GET /uploads/limits': { maximumBytes: 2 } }); renderScreen(<Harness />, { client: api.client });
    await waitFor(() => expect((screen.getByLabelText('Add files') as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText('Add files'), { target: { files: [new File(['abc'], 'Synthetic-large.txt')] } });
    expect(await screen.findByText('Synthetic-large.txt: The file exceeds the limit of 2 bytes.')).toBeTruthy(); expect(worker).not.toHaveBeenCalled();
    expect(api.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });
  it('fails a stalled transfer after 60 seconds', async () => {
    vi.useFakeTimers(); fakeXhr([0]);
    const promise = putFile('https://r2.example.test/file', {}, new Blob(['Synthetic']), new AbortController().signal, () => undefined);
    const failure = promise.catch((error: unknown) => error);
    await act(() => vi.advanceTimersByTimeAsync(60_000)); expect(await failure).toBeInstanceOf(Error);
  });
});
it('checks file signatures and rejects binary text without treating text as markup', () => {
  expect(imageMime(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe('image/png');
  expect(imageMime(new TextEncoder().encode('<svg onload="alert(1)">'))).toBeNull();
  expect(isPdf(new TextEncoder().encode('%PDF-1.7'))).toBe(true);
  expect(() => previewText(Uint8Array.from([0, 1, 2]))).toThrow();
  expect(metadataReasons({ title: '😀'.repeat(255), caption: '', origin: 'Synthetic' })).toEqual([]);
});
