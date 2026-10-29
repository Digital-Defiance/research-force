import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { CreateItemForm } from '../src/items/forms/ItemForm';
import { ReplyComposer } from '../src/discussion/thread';
import { UNSENT_PREFIX } from '../src/persist';
import { failure, fakeApi, json, renderScreen } from './helpers';
import { FORM_DATA, PROJECT } from './fixtures';

/** Whole-form regressions for the reopened file workflows: what a Member sees across a reload, a stalled or failed upload, and a lost save response. */
class HashWorker {
  onmessage?: (event: { data: { sha256: string; parts: string[] } }) => void;
  onerror?: () => void;
  postMessage() { queueMicrotask(() => this.onmessage?.({ data: { sha256: 'a'.repeat(64), parts: ['a'.repeat(64)] } })); }
  terminate() { /* nothing to stop */ }
}
/** An XMLHttpRequest that answers each send with the next status, or never answers when the status is 0. */
function fakeXhr(statuses: number[]) {
  class Xhr {
    upload: { onprogress?: (event: { loaded: number }) => void } = {};
    status = 0;
    onload?: () => void; onerror?: () => void; onabort?: () => void;
    open() { /* the URL does not matter here */ }
    setRequestHeader() { /* nor the headers */ }
    getResponseHeader() { return 'etag'; }
    send(bytes: Blob) { this.status = statuses.shift() ?? 200; if (this.status) queueMicrotask(() => { this.upload.onprogress?.({ loaded: bytes.size }); this.onload?.(); }); }
    abort() { this.onabort?.(); }
  }
  vi.stubGlobal('XMLHttpRequest', Xhr);
}
afterEach(() => { vi.unstubAllGlobals(); sessionStorage.clear(); });

const choice = { projects: [PROJECT], preselected: PROJECT.id };
const start = (id: string) => ({ id, mode: 'single', url: 'https://r2.example.test/synthetic', headers: { 'x-amz-checksum-sha256': 'digest' } });
const choose = async (file: File) => {
  await waitFor(() => expect((screen.getByLabelText('Add files') as HTMLInputElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText('Add files'), { target: { files: [file] } });
};
const itemTitle = () => screen.getAllByLabelText(/^Title/u)[0] as HTMLInputElement;
const submit = () => screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement;
const writes = (api: ReturnType<typeof fakeApi>, path: string) => api.writes().filter((call) => call.method === 'POST' && call.path === path);

describe('files in a new Item across a reload', () => {
  it('restores a finished upload and its metadata, submits it once, and then forgets it', async () => {
    vi.stubGlobal('Worker', HashWorker); fakeXhr([200]);
    const first = fakeApi({ 'GET /uploads/limits': { maximumBytes: 100 }, 'POST /uploads': () => start('upload-1'), 'POST /uploads/upload-1/complete': {} });
    renderScreen(<CreateItemForm kind="topic" choice={choice} data={FORM_DATA} />, { client: first.client });
    await choose(new File(['abc'], 'Synthetic.txt')); await screen.findByText('Upload complete');
    fireEvent.change(screen.getByLabelText('Origin (required)'), { target: { value: 'Found in the synthetic box.' } });
    fireEvent.change(itemTitle(), { target: { value: 'A topic' } });
    cleanup();

    const second = fakeApi({ 'GET /uploads/limits': { maximumBytes: 100 }, 'GET /uploads/upload-1': { id: 'upload-1', state: 'complete' }, 'POST /topics': json({ item: { id: 'NEW' } }, 201) });
    renderScreen(<CreateItemForm kind="topic" choice={choice} data={FORM_DATA} />, { client: second.client });
    await screen.findByText('Upload complete');
    expect((screen.getByLabelText('Origin (required)') as HTMLTextAreaElement).value).toBe('Found in the synthetic box.');
    await waitFor(() => expect(second.calls.some((call) => call.path === '/uploads/upload-1')).toBe(true));
    expect(submit().disabled).toBe(false);
    fireEvent.click(submit());
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/items/NEW'));
    expect(writes(second, '/topics')).toHaveLength(1);
    expect(writes(second, '/topics')[0]!.body).toMatchObject({ files: [{ uploadId: 'upload-1', metadata: { title: 'Synthetic.txt', origin: 'Found in the synthetic box.' } }] });
    expect(Object.keys(sessionStorage).filter((name) => name.startsWith(UNSENT_PREFIX))).toEqual([]);
  });

  it('asks for the file again after a reload mid-transfer, keeps the metadata, and submits once it is chosen and uploaded', async () => {
    vi.stubGlobal('Worker', HashWorker); fakeXhr([0]); // the transfer never finishes
    const first = fakeApi({ 'GET /uploads/limits': { maximumBytes: 100 }, 'POST /uploads': () => start('upload-1') });
    renderScreen(<CreateItemForm kind="topic" choice={choice} data={FORM_DATA} />, { client: first.client });
    await choose(new File(['abc'], 'Synthetic.txt')); await screen.findByText('0% uploaded');
    fireEvent.change(screen.getByLabelText('Origin (required)'), { target: { value: 'Origin kept.' } });
    cleanup(); vi.unstubAllGlobals(); vi.stubGlobal('Worker', HashWorker); fakeXhr([200]);

    const second = fakeApi({ 'GET /uploads/limits': { maximumBytes: 100 }, 'GET /uploads/upload-1': { id: 'upload-1', state: 'uploading' }, 'DELETE /uploads/upload-1': {},
      'POST /uploads': () => start('upload-2'), 'POST /uploads/upload-2/complete': {}, 'POST /topics': json({ item: { id: 'NEW' } }, 201) });
    renderScreen(<CreateItemForm kind="topic" choice={choice} data={FORM_DATA} />, { client: second.client });
    expect((await screen.findAllByText(/before this file finished uploading/u)).length).toBeGreaterThan(0);
    expect(submit().disabled).toBe(true);
    fireEvent.change(itemTitle(), { target: { value: 'A topic' } });
    fireEvent.submit(submit().closest('form')!);
    expect(writes(second, '/topics')).toHaveLength(0);
    expect(within(screen.getByText('Files are not ready to submit').parentElement!).getByText(/Synthetic\.txt: The page was reloaded/u)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Select Synthetic.txt again'), { target: { files: [new File(['abc'], 'Synthetic.txt')] } });
    await screen.findByText('Upload complete');
    expect((screen.getByLabelText('Origin (required)') as HTMLTextAreaElement).value).toBe('Origin kept.');
    expect(second.calls.some((call) => call.method === 'DELETE' && call.path === '/uploads/upload-1')).toBe(true);
    fireEvent.click(submit());
    await waitFor(() => expect(writes(second, '/topics')).toHaveLength(1));
    expect(writes(second, '/topics')[0]!.body).toMatchObject({ files: [{ uploadId: 'upload-2' }] });
  });

  it('blocks a keyboard submit while a file is uploading and moves focus to the reasons', async () => {
    vi.stubGlobal('Worker', HashWorker); fakeXhr([0]);
    const api = fakeApi({ 'GET /uploads/limits': { maximumBytes: 100 }, 'POST /uploads': () => start('upload-1'), 'POST /topics': json({ item: { id: 'NEW' } }, 201) });
    renderScreen(<CreateItemForm kind="topic" choice={choice} data={FORM_DATA} />, { client: api.client });
    await choose(new File(['abc'], 'Synthetic.txt')); await screen.findByText('0% uploaded');
    const title = itemTitle();
    fireEvent.change(title, { target: { value: 'A topic' } });
    fireEvent.submit(title.closest('form')!);
    expect(writes(api, '/topics')).toHaveLength(0);
    expect(document.activeElement).toBe(screen.getByText('Files are not ready to submit').parentElement!.parentElement);
    expect(within(document.activeElement as HTMLElement).getByText(/Synthetic\.txt: The file is still uploading\./u)).toBeTruthy();
  });

  it('reconciles a lost save response: the Item is found by its operation key and opened, with the uploads forgotten', async () => {
    vi.stubGlobal('Worker', HashWorker); fakeXhr([200]);
    const api = fakeApi({ 'GET /uploads/limits': { maximumBytes: 100 }, 'POST /uploads': () => start('upload-1'), 'POST /uploads/upload-1/complete': {},
      'POST /topics': () => { throw new TypeError('connection reset'); },
      'GET /operations/*': (call) => ({ operation: { key: call.path.split('/').pop(), state: 'committed', status: 201, resource: { 'item.id': '01J0000000000000000000IT09' } } }),
      'GET /items/01J0000000000000000000IT09': { item: { id: '01J0000000000000000000IT09' } } });
    renderScreen(<CreateItemForm kind="topic" choice={choice} data={FORM_DATA} />, { client: api.client });
    await choose(new File(['abc'], 'Synthetic.txt')); await screen.findByText('Upload complete');
    fireEvent.change(screen.getByLabelText('Origin (required)'), { target: { value: 'Origin.' } });
    fireEvent.change(itemTitle(), { target: { value: 'A topic' } });
    fireEvent.click(submit());
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/items/01J0000000000000000000IT09'));
    expect(writes(api, '/topics')).toHaveLength(1);
    expect(api.calls.filter((call) => call.path.startsWith('/operations/'))).toHaveLength(1);
    expect(Object.keys(sessionStorage).filter((name) => name.startsWith(UNSENT_PREFIX))).toEqual([]);
  });

  it('keeps a Reply’s files across a reload and removes unused uploads when the Reply is discarded', async () => {
    vi.stubGlobal('Worker', HashWorker); fakeXhr([200]);
    const mentions = { members: [], specialties: [] } as never;
    const first = fakeApi({ 'GET /uploads/limits': { maximumBytes: 100 }, 'POST /uploads': () => start('upload-1'), 'POST /uploads/upload-1/complete': {} });
    renderScreen(<ReplyComposer parentId="PARENT" label="Reply" mentions={mentions} onPosted={() => undefined} />, { client: first.client });
    await choose(new File(['abc'], 'Synthetic.txt')); await screen.findByText('Upload complete');
    cleanup();
    const second = fakeApi({ 'GET /uploads/limits': { maximumBytes: 100 }, 'GET /uploads/upload-1': { id: 'upload-1', state: 'complete' }, 'DELETE /uploads/upload-1': {} });
    renderScreen(<ReplyComposer parentId="PARENT" label="Reply" mentions={mentions} onPosted={() => undefined} />, { client: second.client });
    await screen.findByText('Upload complete');
    expect(screen.getAllByText('Synthetic.txt').length).toBeGreaterThan(0);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove file' })); });
    expect(second.calls.some((call) => call.method === 'DELETE' && call.path === '/uploads/upload-1')).toBe(true);
    expect(sessionStorage.getItem(`${UNSENT_PREFIX}uploads:reply:PARENT`)).toBeNull();
    void failure;
  });
});

describe('a very large Entry_Section', () => {
  const editorFor = (label: string): EditorView => EditorView.findFromDOM(screen.getAllByText(label).find((element) => element.classList.contains('rf-field__label'))!.closest('.rf-field')!.querySelector('.cm-editor') as HTMLElement)!;

  it('is saved as bounded fragments under a stage, and a lost commit response is reconciled without a second save', async () => {
    const text = 'Zweiundzwanzig, naïve — ☃ '.repeat(24_000);
    let commits = 0; let token = '';
    const api = fakeApi({
      'POST /stages': (call) => { token = (call.body as { token: string }).token; return { token, partBytes: 200_000, fragmentBytes: 128_000, maxParts: 256 }; },
      'PUT /stages/*': {},
      'POST /stages/*': () => { commits++; throw new TypeError('connection reset'); },
      'GET /operations/*': (call) => ({ operation: { key: call.path.split('/').pop(), state: 'committed', status: 201, resource: { 'item.id': '01J0000000000000000000IT10' } } }),
      'GET /items/01J0000000000000000000IT10': { item: { id: '01J0000000000000000000IT10' } },
    });
    renderScreen(<CreateItemForm kind="journal_entry" choice={choice} data={FORM_DATA} />, { client: api.client });
    fireEvent.change(itemTitle(), { target: { value: 'A long entry' } });
    const editor = editorFor('Entry Section 1');
    act(() => { editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } }); });
    fireEvent.click(submit());
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/items/01J0000000000000000000IT10'), { timeout: 20_000 });
    const fragments = api.writes().filter((call) => call.path.endsWith('/fragments'));
    expect(fragments.length).toBeGreaterThan(2);
    for (const fragment of fragments) expect(new TextEncoder().encode(fragment.raw ?? '').length).toBeLessThanOrEqual(128_000);
    expect(commits).toBe(1);
    expect(api.calls.find((call) => call.path.endsWith('/commit'))!.headers.get('Idempotency-Key')).toBe(`commit-${token}`);
    expect(api.calls.filter((call) => call.path.startsWith('/operations/'))).toHaveLength(1);
    expect(Object.keys(sessionStorage).filter((name) => name.startsWith(UNSENT_PREFIX))).toEqual([]);
  }, 60_000);
});
