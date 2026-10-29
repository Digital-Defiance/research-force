import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UploadFields, metadataReasons, putFile, useUploads } from '../src/files/upload';
import { imageMime, isPdf } from '../src/files/preview/magic';
import { previewText } from '../src/files/preview/truncate';
import { failure, fakeApi, renderScreen } from './helpers';

function Harness() { const uploads = useUploads(); return <form><UploadFields uploads={uploads} /><button disabled={uploads.files.length === 0 || uploads.reasons.length > 0}>Submit</button></form>; }
function ScopedHarness({ scope = 'test:form' }: { readonly scope?: string }) {
  const uploads = useUploads(scope);
  return <form onSubmit={(event) => { event.preventDefault(); uploads.guard(); }}><UploadFields uploads={uploads} /><button>Submit</button></form>;
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); sessionStorage.clear(); });
let digestOf = (_file: File) => 'a'.repeat(64);
class HashWorker {
  onmessage?: (event: { data: { sha256: string; parts: string[] } }) => void;
  onerror?: () => void;
  postMessage(file: File) { queueMicrotask(() => this.onmessage?.({ data: { sha256: digestOf(file), parts: [digestOf(file)] } })); }
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
describe('uploads that survive a reload', () => {
  const start = (id: string) => ({ id, mode: 'single', url: 'https://r2.example.test/synthetic', headers: { 'x-amz-checksum-sha256': 'digest' } });
  const choose = async (name: string, content = 'abc') => {
    await waitFor(() => expect((screen.getByLabelText('Add files') as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText('Add files'), { target: { files: [new File([content], name)] } });
  };
  const stored = () => JSON.parse(sessionStorage.getItem('rf:unsent:uploads:test:form')!) as { groupId: string; files: Record<string, unknown>[] };

  it('restores metadata after a reload, revalidates a completed upload without the local file, and keeps Submit available', async () => {
    vi.stubGlobal('Worker', HashWorker); fakeXhr([200]);
    const first = fakeApi({ 'GET /uploads/limits': { maximumBytes: 100 }, 'POST /uploads': () => start('upload-1'), 'POST /uploads/upload-1/complete': {} });
    renderScreen(<ScopedHarness />, { client: first.client });
    await choose('Synthetic.txt'); await screen.findByText('Upload complete');
    fireEvent.change(screen.getByLabelText('Origin (required)'), { target: { value: 'Synthetic origin.' } });
    fireEvent.change(screen.getByLabelText('Caption'), { target: { value: 'Synthetic caption.' } });
    const saved = stored(); expect(saved.files[0]).toMatchObject({ name: 'Synthetic.txt', size: 3, uploadId: 'upload-1', state: 'complete', origin: 'Synthetic origin.', caption: 'Synthetic caption.' });
    expect(JSON.stringify(saved)).not.toContain('abc');
    cleanup();
    const second = fakeApi({ 'GET /uploads/limits': { maximumBytes: 100 }, 'GET /uploads/upload-1': { id: 'upload-1', state: 'complete' } });
    renderScreen(<ScopedHarness />, { client: second.client });
    await screen.findByText('Upload complete');
    expect((screen.getByLabelText('Origin (required)') as HTMLTextAreaElement).value).toBe('Synthetic origin.');
    expect((screen.getByLabelText('Caption') as HTMLTextAreaElement).value).toBe('Synthetic caption.');
    await waitFor(() => expect(second.calls.some((call) => call.path === '/uploads/upload-1')).toBe(true));
    expect(screen.queryByText('Files are not ready to submit')).toBeNull(); expect(stored().groupId).toBe(saved.groupId);
  });

  it('fails a restored upload that the sweeper removed and lets the Member select the file again', async () => {
    vi.stubGlobal('Worker', HashWorker); fakeXhr([200]);
    sessionStorage.setItem('rf:unsent:uploads:test:form', JSON.stringify({ groupId: '01J00000000000000000000009', files: [{ key: 'k1', name: 'Synthetic.txt', size: 3, sha256: 'a'.repeat(64), uploadId: 'upload-old', attempt: 0, state: 'complete', percent: 100, title: 'Kept title', caption: '', origin: 'Kept origin' }] }));
    let number = 0;
    const api = fakeApi({ 'GET /uploads/limits': { maximumBytes: 100 }, 'GET /uploads/upload-old': failure(404, 'not_found'), 'DELETE /uploads/upload-old': {},
      'POST /uploads': () => start(`upload-new-${++number}`), 'POST /uploads/upload-new-1/complete': {} });
    renderScreen(<ScopedHarness />, { client: api.client });
    expect((await screen.findAllByText(/The unfinished Submission expired/u)).length).toBeGreaterThan(0);
    expect((screen.getByLabelText('Title (required)') as HTMLInputElement).value).toBe('Kept title');
    const again = screen.getByLabelText('Select Synthetic.txt again') as HTMLInputElement;
    fireEvent.change(again, { target: { files: [new File(['abc'], 'Other.txt')] } });
    expect((await screen.findAllByText(/That is not the same file/u)).length).toBeGreaterThan(0);
    digestOf = () => 'b'.repeat(64);
    fireEvent.change(screen.getByLabelText('Select Synthetic.txt again'), { target: { files: [new File(['abc'], 'Synthetic.txt')] } });
    expect((await screen.findAllByText(/contents differ/u)).length).toBeGreaterThan(0); expect(api.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    digestOf = () => 'a'.repeat(64);
    fireEvent.change(screen.getByLabelText('Select Synthetic.txt again'), { target: { files: [new File(['abc'], 'Synthetic.txt')] } });
    await screen.findByText('Upload complete');
    expect((screen.getByLabelText('Origin (required)') as HTMLTextAreaElement).value).toBe('Kept origin');
    const starts = api.calls.filter((call) => call.method === 'POST' && call.path === '/uploads');
    expect(starts).toHaveLength(1); expect(starts[0]!.headers.get('Idempotency-Key')).toBe('upload-start-k1-1');
  });

  it('treats a reload during a transfer as an interruption, or as finished when the server completed it', async () => {
    vi.stubGlobal('Worker', HashWorker);
    const entry = (key: string, name: string, uploadId: string) => ({ key, name, size: 3, uploadId, attempt: 0, state: 'uploading', percent: 40, title: name, caption: '', origin: `Origin of ${name}` });
    sessionStorage.setItem('rf:unsent:uploads:test:form', JSON.stringify({ groupId: '01J00000000000000000000009', files: [entry('k1', 'Finished.txt', 'upload-1'), entry('k2', 'Cut-off.txt', 'upload-2')] }));
    const api = fakeApi({ 'GET /uploads/limits': { maximumBytes: 100 }, 'GET /uploads/upload-1': { id: 'upload-1', state: 'complete' }, 'GET /uploads/upload-2': { id: 'upload-2', state: 'uploading' } });
    renderScreen(<ScopedHarness />, { client: api.client });
    await screen.findByText('Upload complete');
    expect((await screen.findAllByText(/before this file finished uploading/u)).length).toBeGreaterThan(0);
    const reasons = within(screen.getByText('Files are not ready to submit').parentElement!);
    expect(reasons.getByText(/Cut-off\.txt: The page was reloaded/u)).toBeTruthy(); expect(reasons.queryByText(/Finished\.txt/u)).toBeNull();
  });

  it('retries or removes one file while the others keep their uploads and metadata', async () => {
    vi.stubGlobal('Worker', HashWorker); const requests = fakeXhr([200, 500, 200]); let number = 0;
    const api = fakeApi({ 'GET /uploads/limits': { maximumBytes: 100 }, 'POST /uploads': () => start(`upload-${++number}`), 'DELETE /uploads/*': {}, 'POST /uploads/*': {} });
    renderScreen(<ScopedHarness />, { client: api.client });
    await choose('First.txt'); await screen.findByText('Upload complete');
    fireEvent.change(screen.getByLabelText('Origin (required)'), { target: { value: 'First origin.' } });
    await choose('Second.txt'); await screen.findByRole('button', { name: 'Retry' });
    expect(stored().files).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await waitFor(() => expect(screen.getAllByText('Upload complete')).toHaveLength(2));
    expect(requests).toHaveLength(3); expect((screen.getAllByLabelText('Origin (required)')[0] as HTMLTextAreaElement).value).toBe('First origin.');
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove file' })[1]!);
    expect(screen.queryByText('Second.txt')).toBeNull(); expect(screen.getByText('First.txt')).toBeTruthy(); expect(stored().files).toHaveLength(1);
    expect(api.calls.some((call) => call.method === 'DELETE' && call.path === '/uploads/upload-2')).toBe(true);
    expect(api.calls.some((call) => call.method === 'DELETE' && call.path === '/uploads/upload-1')).toBe(false);
  });

  it('reconciles a lost completion response from the Worker record and moves focus to the reasons on a blocked keyboard submit', async () => {
    vi.stubGlobal('Worker', HashWorker); fakeXhr([200]); let lost = true;
    const api = fakeApi({ 'GET /uploads/limits': { maximumBytes: 100 }, 'POST /uploads': () => start('upload-1'),
      'POST /uploads/upload-1/complete': () => { if (lost) { lost = false; throw new Error('connection reset'); } return {}; },
      'GET /operations/upload-complete-upload-1': { operation: { key: 'upload-complete-upload-1', state: 'committed', status: 200, resource: { id: 'upload-1' } } },
      'GET /uploads/upload-1': { id: 'upload-1', state: 'complete' } });
    renderScreen(<ScopedHarness />, { client: api.client });
    await choose('Synthetic.txt'); await screen.findByText('Upload complete');
    expect(api.calls.filter((call) => call.path === '/uploads/upload-1/complete')).toHaveLength(1);
    expect(api.calls.some((call) => call.path === '/operations/upload-complete-upload-1')).toBe(true);
    fireEvent.submit(screen.getByRole('button', { name: 'Submit' }).closest('form')!);
    const notice = screen.getByText('Files are not ready to submit').parentElement!.parentElement!;
    expect(document.activeElement).toBe(notice); expect(within(notice).getByText('Synthetic.txt: Origin must contain 1 to 5,000 characters.')).toBeTruthy();
  });
});
it('checks file signatures and rejects binary text without treating text as markup', () => {
  expect(imageMime(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe('image/png');
  expect(imageMime(new TextEncoder().encode('<svg onload="alert(1)">'))).toBeNull();
  expect(isPdf(new TextEncoder().encode('%PDF-1.7'))).toBe(true);
  expect(() => previewText(Uint8Array.from([0, 1, 2]))).toThrow();
  expect(metadataReasons({ title: '😀'.repeat(255), caption: '', origin: 'Synthetic' })).toEqual([]);
});
