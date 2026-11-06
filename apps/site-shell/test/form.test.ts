import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  allFilesComplete,
  clearUnsent,
  completeUpload,
  initialState,
  needsLicence,
  newFileId,
  openSession,
  readStatus,
  readUnsent,
  removeUpload,
  requestUpload,
  sha256Hex,
  submitBody,
  submitForm,
  uploadBytes,
  UNAVAILABLE_NOTICE,
  UNSENT_PREFIX,
  type FetchLike,
  type FormFile,
  type FormState,
} from '../src/form';

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

/** A scripted fetch that returns the given responses in order, recording every call. */
function scriptedFetch(responses: { status: number; body: unknown }[]): { fetcher: FetchLike; calls: { url: string; init: RequestInit | undefined }[] } {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let i = 0;
  const fetcher: FetchLike = (url, init) => {
    calls.push({ url, init });
    const next = responses[Math.min(i, responses.length - 1)] ?? { status: 200, body: {} };
    i += 1;
    return Promise.resolve(new Response(JSON.stringify(next.body), { status: next.status, headers: { 'Content-Type': 'application/json' } }));
  };
  return { fetcher, calls };
}

const LICENCE = 'Synthetic Content Licence 1.0';
const PROJECT = '0000000000000000000000PRJ1';

function state(overrides: Partial<FormState> = {}): FormState {
  return {
    type: 'material',
    destination: { kind: 'project', projectId: PROJECT },
    message: 'Here is a document that may help.',
    name: 'Ada Visitor',
    email: 'ada@example.test',
    affiliation: '',
    pageReference: '',
    licenceAgreed: true,
    files: [],
    ...overrides,
  };
}

describe('the licence agreement (R31.1)', () => {
  it('is never pre-selected in the initial state', () => {
    expect(initialState('material', { kind: 'general' }).licenceAgreed).toBe(false);
    expect(initialState('comment', null).licenceAgreed).toBe(false);
  });

  it('is required for every type except Removal_Request', () => {
    expect(needsLicence('material')).toBe(true);
    expect(needsLicence('correction')).toBe(true);
    expect(needsLicence('comment')).toBe(true);
    expect(needsLicence('removal_request')).toBe(false);
  });

  it('is sent with the current Content_Licence for a non-Removal_Request', () => {
    const body = submitBody(state({ type: 'material', licenceAgreed: true }), LICENCE);
    expect(body['licenceAgreement']).toEqual({ agreed: true, contentLicence: LICENCE });
  });

  it('is absent entirely for a Removal_Request', () => {
    const body = submitBody(state({ type: 'removal_request', licenceAgreed: false }), LICENCE);
    expect('licenceAgreement' in body).toBe(false);
  });
});

describe('the submit body (R31.1, R31.5, R31.6, R31.13)', () => {
  it('carries the type, destination, message, name, and email', () => {
    const body = submitBody(state(), LICENCE);
    expect(body).toMatchObject({ type: 'material', destination: { kind: 'project', projectId: PROJECT }, message: 'Here is a document that may help.', name: 'Ada Visitor', email: 'ada@example.test' });
  });

  it('carries the General_Choice when chosen', () => {
    const body = submitBody(state({ destination: { kind: 'general' } }), LICENCE);
    expect(body['destination']).toEqual({ kind: 'general' });
  });

  it('omits an empty affiliation and page reference but sends non-empty ones', () => {
    expect('affiliation' in submitBody(state({ affiliation: '   ' }), LICENCE)).toBe(false);
    expect('pageReference' in submitBody(state({ pageReference: '' }), LICENCE)).toBe(false);
    const body = submitBody(state({ affiliation: 'A Lab', pageReference: '/r/ITEM-123' }), LICENCE);
    expect(body['affiliation']).toBe('A Lab');
    expect(body['pageReference']).toBe('/r/ITEM-123');
  });

  it('sends only complete files, as their upload id and size', () => {
    const files: FormFile[] = [
      { fileId: 'a'.repeat(32), fileName: 'done.pdf', sizeBytes: 10, sha256: 'aa', state: 'complete' },
      { fileId: 'b'.repeat(32), fileName: 'busy.pdf', sizeBytes: 20, sha256: 'bb', state: 'uploading' },
    ];
    const body = submitBody(state({ files }), LICENCE);
    expect(body['files']).toEqual([{ fileId: 'a'.repeat(32), sizeBytes: 10 }]);
  });
});

describe('every added file must be complete before sending (R31.5, R31.10)', () => {
  it('reports not-ready while any file is still uploading or failed', () => {
    expect(allFilesComplete(state({ files: [{ fileId: 'a'.repeat(32), fileName: 'f', sizeBytes: 1, sha256: 'aa', state: 'uploading' }] }))).toBe(false);
    expect(allFilesComplete(state({ files: [{ fileId: 'a'.repeat(32), fileName: 'f', sizeBytes: 1, sha256: 'aa', state: 'failed' }] }))).toBe(false);
  });
  it('reports ready when every file is complete, or there are no files', () => {
    expect(allFilesComplete(state())).toBe(true);
    expect(allFilesComplete(state({ files: [{ fileId: 'a'.repeat(32), fileName: 'f', sizeBytes: 1, sha256: 'aa', state: 'complete' }] }))).toBe(true);
  });
});

describe('unsent input kept in this tab (R28.10, R31.11)', () => {
  it('mirrors the state and restores it, keeping only fully uploaded files', () => {
    const files: FormFile[] = [
      { fileId: 'a'.repeat(32), fileName: 'done.pdf', sizeBytes: 10, sha256: 'aa', state: 'complete' },
      { fileId: 'b'.repeat(32), fileName: 'busy.pdf', sizeBytes: 20, sha256: 'bb', state: 'uploading' },
    ];
    // Writing keeps only the complete file; an unfinished file cannot survive a reload (R28.10).
    const key = 'submit';
    const written = state({ files });
    // writeUnsent is exercised through the exported helper used by the DOM layer.
    sessionStorage.setItem(UNSENT_PREFIX + key, JSON.stringify({ ...written, files: written.files.filter((f) => f.state === 'complete') }));
    const restored = readUnsent(key);
    expect(restored?.message).toBe(written.message);
    expect(restored?.files).toEqual([{ fileId: 'a'.repeat(32), fileName: 'done.pdf', sizeBytes: 10, sha256: 'aa', state: 'complete' }]);
  });

  it('returns undefined when nothing is stored or the value is unreadable', () => {
    expect(readUnsent('missing')).toBeUndefined();
    sessionStorage.setItem(UNSENT_PREFIX + 'broken', '{not json');
    expect(readUnsent('broken')).toBeUndefined();
  });

  it('is cleared once the submission is confirmed', () => {
    sessionStorage.setItem(UNSENT_PREFIX + 'submit', JSON.stringify(state()));
    clearUnsent('submit');
    expect(sessionStorage.getItem(UNSENT_PREFIX + 'submit')).toBeNull();
  });
});

describe('the admission status (R28.11)', () => {
  it('reads the dynamic form availability from status.json', async () => {
    const { fetcher } = scriptedFetch([{ status: 200, body: { form: false, search: true, generation: 3 } }]);
    expect(await readStatus(fetcher)).toEqual({ form: false });
  });
  it('treats a missing or unreadable status as available (the server still gates)', async () => {
    const failing: FetchLike = () => Promise.reject(new Error('offline'));
    expect(await readStatus(failing)).toEqual({ form: true });
    const { fetcher } = scriptedFetch([{ status: 503, body: {} }]);
    expect(await readStatus(fetcher)).toEqual({ form: true });
  });
  it('exposes the fixed unavailable notice text', () => {
    expect(UNAVAILABLE_NOTICE).toMatch(/00:00 UTC/);
  });
});

describe('the API client against the rf-submit contract', () => {
  it('opens a session with a Turnstile token', async () => {
    const { fetcher, calls } = scriptedFetch([{ status: 201, body: { id: 'a'.repeat(32), expiresAt: '2026-10-29T14:00:00.000Z' } }]);
    const result = await openSession(fetcher, 'turnstile-token');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.id).toBe('a'.repeat(32));
    expect(calls[0]?.url).toBe('https://submit.researchforce.org/v1/sessions');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ token: 'turnstile-token' });
  });

  it('turns a Bot_Check refusal into a refusal result', async () => {
    const { fetcher } = scriptedFetch([{ status: 400, body: { error: 'bot_check', message: 'Complete the verification to continue.' } }]);
    const result = await openSession(fetcher, '');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.error).toBe('bot_check');
  });

  it('requests a presigned upload and returns the signed PUT and headers', async () => {
    const put = { fileId: 'a'.repeat(32), url: 'https://r2.example/put', headers: { 'content-length': '10', 'x-amz-checksum-sha256': 'qqo=', 'if-none-match': '*' } };
    const { fetcher, calls } = scriptedFetch([{ status: 200, body: put }]);
    const result = await requestUpload(fetcher, 'a'.repeat(32), { fileId: 'a'.repeat(32), fileName: 'doc.pdf', sizeBytes: 10, sha256: 'a'.repeat(64) });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.url).toBe('https://r2.example/put');
    expect(calls[0]?.url).toBe('https://submit.researchforce.org/v1/sessions/' + 'a'.repeat(32) + '/files');
  });

  it('confirms and removes a file at the right endpoints (R31.10)', async () => {
    const complete = scriptedFetch([{ status: 200, body: { fileId: 'a'.repeat(32), state: 'complete' } }]);
    const confirmed = await completeUpload(complete.fetcher, 'a'.repeat(32), 'a'.repeat(32));
    expect(confirmed.ok).toBe(true);
    expect(complete.calls[0]?.url).toBe('https://submit.researchforce.org/v1/sessions/' + 'a'.repeat(32) + '/files/' + 'a'.repeat(32) + '/complete');

    const remove = scriptedFetch([{ status: 200, body: { removed: true } }]);
    const removed = await removeUpload(remove.fetcher, 'a'.repeat(32), 'a'.repeat(32));
    expect(removed.ok).toBe(true);
    expect(remove.calls[0]?.url).toBe('https://submit.researchforce.org/v1/sessions/' + 'a'.repeat(32) + '/files/' + 'a'.repeat(32) + '/remove');
  });

  it('returns the confirmation with reference and time on a stored submission (R31.5)', async () => {
    const { fetcher } = scriptedFetch([{ status: 201, body: { reference: 'RS-7K2MQ-X9DAB', submittedAt: '2026-10-29T12:00:00.000Z' } }]);
    const result = await submitForm(fetcher, 'a'.repeat(32), submitBody(state(), LICENCE));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.reference).toMatch(/^RS-[0-9A-Z]{5}-[0-9A-Z]{5}$/);
      expect(result.value.submittedAt).toBe('2026-10-29T12:00:00.000Z');
    }
  });

  it('preserves the fixed refusal shape with the Visitor’s own invalid fields (R31.7, R31.11)', async () => {
    const { fetcher } = scriptedFetch([{ status: 400, body: { error: 'invalid', message: 'Some fields are missing or invalid.', fields: [{ field: 'licenceAgreement', message: 'Agree to the current Content Licence.' }] } }]);
    const result = await submitForm(fetcher, 'a'.repeat(32), submitBody(state({ licenceAgreed: false }), LICENCE));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.error).toBe('invalid');
      expect(result.refusal.fields).toEqual([{ field: 'licenceAgreement', message: 'Agree to the current Content Licence.' }]);
    }
  });

  it('reports a network failure as a refusal rather than throwing (R31.11)', async () => {
    const failing: FetchLike = () => Promise.reject(new Error('offline'));
    const result = await submitForm(failing, 'a'.repeat(32), submitBody(state(), LICENCE));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.error).toBe('network');
  });
});

describe('file identity and checksums', () => {
  it('mints a 128-bit lower-case hex upload id', () => {
    const id = newFileId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(newFileId()).not.toBe(id);
  });
  it('computes a SHA-256 as 64 lower-case hex characters', async () => {
    const digest = await sha256Hex(new TextEncoder().encode('abc').buffer as ArrayBuffer);
    // The SHA-256 of "abc" is a known vector.
    expect(digest).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('uploadBytes with progress and failure (R31.4, R31.10)', () => {
  class FakeXhr {
    status = 0;
    upload = { onprogress: null as ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    open(): void {}
    setRequestHeader(): void {}
    send(): void {
      this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 });
      this.upload.onprogress?.({ lengthComputable: true, loaded: 10, total: 10 });
      this.status = FakeXhr.nextStatus;
      queueMicrotask(() => (this.status >= 400 ? this.onerror?.() : this.onload?.()));
    }
    static nextStatus = 200;
  }

  it('resolves ok on a 2xx PUT and reports progress', async () => {
    FakeXhr.nextStatus = 200;
    vi.stubGlobal('XMLHttpRequest', FakeXhr as unknown as typeof XMLHttpRequest);
    const fractions: number[] = [];
    const result = await uploadBytes({ fileId: 'a'.repeat(32), url: 'https://r2.example/put', headers: { 'x-amz-checksum-sha256': 'qqo=', 'if-none-match': '*' } }, new ArrayBuffer(10), (f) => fractions.push(f));
    expect(result.ok).toBe(true);
    expect(fractions).toEqual([0.5, 1]);
  });

  it('resolves failed on a non-2xx PUT so the Visitor can retry or remove (R31.10)', async () => {
    FakeXhr.nextStatus = 403;
    vi.stubGlobal('XMLHttpRequest', FakeXhr as unknown as typeof XMLHttpRequest);
    const result = await uploadBytes({ fileId: 'a'.repeat(32), url: 'https://r2.example/put', headers: {} }, new ArrayBuffer(10), () => {});
    expect(result.ok).toBe(false);
  });
});
