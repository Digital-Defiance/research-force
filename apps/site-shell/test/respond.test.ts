import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  allFilesComplete,
  checkLink,
  completeUpload,
  openSession,
  removeUpload,
  requestUpload,
  respondBody,
  submitResponse,
  tokenFromHash,
  type ResponseFile,
  type RespondState,
} from '../src/respond';
import type { FetchLike } from '../src/form';

afterEach(() => {
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

const TOKEN = 'ABCDEFGHJKMNPQRSTVWXYZ0123';
const SESSION = 'a'.repeat(32);

function state(overrides: Partial<RespondState> = {}): RespondState {
  return { message: 'Here is the extra detail you asked for.', files: [], ...overrides };
}

describe('the Response_Link token from the URL fragment (R32.14)', () => {
  it('reads the token after the leading #, trimming whitespace', () => {
    expect(tokenFromHash(`#${TOKEN}`)).toBe(TOKEN);
    expect(tokenFromHash(`#  ${TOKEN}  `)).toBe(TOKEN);
  });
  it('is empty when no fragment is present', () => {
    expect(tokenFromHash('')).toBe('');
  });
});

describe('the respond body (R32.7)', () => {
  it('carries the link token, the message, and only complete files as their upload id', () => {
    const files: ResponseFile[] = [
      { fileId: 'a'.repeat(32), fileName: 'done.pdf', sizeBytes: 10, sha256: 'aa', state: 'complete' },
      { fileId: 'b'.repeat(32), fileName: 'busy.pdf', sizeBytes: 20, sha256: 'bb', state: 'uploading' },
    ];
    const body = respondBody(TOKEN, state({ files }));
    expect(body).toMatchObject({ token: TOKEN, message: 'Here is the extra detail you asked for.' });
    expect(body['files']).toEqual([{ fileId: 'a'.repeat(32) }]);
  });
});

describe('every added file must be complete before sending (R31.10)', () => {
  it('reports not-ready while any file is still uploading or failed', () => {
    expect(allFilesComplete(state({ files: [{ fileId: 'a'.repeat(32), fileName: 'f', sizeBytes: 1, sha256: 'aa', state: 'uploading' }] }))).toBe(false);
    expect(allFilesComplete(state({ files: [{ fileId: 'a'.repeat(32), fileName: 'f', sizeBytes: 1, sha256: 'aa', state: 'failed' }] }))).toBe(false);
  });
  it('reports ready when every file is complete, or there are no files', () => {
    expect(allFilesComplete(state())).toBe(true);
    expect(allFilesComplete(state({ files: [{ fileId: 'a'.repeat(32), fileName: 'f', sizeBytes: 1, sha256: 'aa', state: 'complete' }] }))).toBe(true);
  });
});

describe('the API client against the rf-submit respond contract', () => {
  it('checks a link usability and parses the boolean', async () => {
    const { fetcher, calls } = scriptedFetch([{ status: 200, body: { usable: true } }]);
    const result = await checkLink(fetcher, TOKEN);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.usable).toBe(true);
    expect(calls[0]?.url).toBe('https://submit.researchforce.org/v1/respond/check');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ token: TOKEN });
  });

  it('turns an unusable-link refusal into a refusal result that names only the reason (R32.14)', async () => {
    const { fetcher } = scriptedFetch([{ status: 400, body: { error: 'expired', message: 'This response link has expired. Links are valid for 30 days.' } }]);
    const result = await checkLink(fetcher, TOKEN);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.error).toBe('expired');
  });

  it('opens a session with the link token and a Turnstile token', async () => {
    const { fetcher, calls } = scriptedFetch([{ status: 201, body: { id: SESSION, expiresAt: '2026-10-29T14:00:00.000Z' } }]);
    const result = await openSession(fetcher, TOKEN, 'turnstile-token');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.id).toBe(SESSION);
    expect(calls[0]?.url).toBe('https://submit.researchforce.org/v1/respond/sessions');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ token: TOKEN, turnstileToken: 'turnstile-token' });
  });

  it('requests, confirms, and removes a file at the respond endpoints (R31.10)', async () => {
    const put = { fileId: 'a'.repeat(32), url: 'https://r2.example/put', headers: {} };
    const request = scriptedFetch([{ status: 200, body: put }]);
    const got = await requestUpload(request.fetcher, SESSION, { fileId: 'a'.repeat(32), fileName: 'doc.pdf', sizeBytes: 10, sha256: 'a'.repeat(64) });
    expect(got.ok).toBe(true);
    expect(request.calls[0]?.url).toBe(`https://submit.researchforce.org/v1/respond/sessions/${SESSION}/files`);

    const complete = scriptedFetch([{ status: 200, body: { fileId: 'a'.repeat(32), state: 'complete' } }]);
    const confirmed = await completeUpload(complete.fetcher, SESSION, 'a'.repeat(32));
    expect(confirmed.ok).toBe(true);
    expect(complete.calls[0]?.url).toBe(`https://submit.researchforce.org/v1/respond/sessions/${SESSION}/files/${'a'.repeat(32)}/complete`);

    const remove = scriptedFetch([{ status: 200, body: { removed: true } }]);
    const removed = await removeUpload(remove.fetcher, SESSION, 'a'.repeat(32));
    expect(removed.ok).toBe(true);
    expect(remove.calls[0]?.url).toBe(`https://submit.researchforce.org/v1/respond/sessions/${SESSION}/files/${'a'.repeat(32)}/remove`);
  });

  it('returns the confirmation with the receipt time on a stored response (R32.7)', async () => {
    const { fetcher, calls } = scriptedFetch([{ status: 201, body: { receivedAt: '2026-10-29T12:00:00.000Z' } }]);
    const result = await submitResponse(fetcher, SESSION, respondBody(TOKEN, state()));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.receivedAt).toBe('2026-10-29T12:00:00.000Z');
    expect(calls[0]?.url).toBe(`https://submit.researchforce.org/v1/respond/sessions/${SESSION}/submit`);
  });

  it('reports a network failure as a refusal rather than throwing', async () => {
    const failing: FetchLike = () => Promise.reject(new Error('offline'));
    const result = await submitResponse(failing, SESSION, respondBody(TOKEN, state()));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.error).toBe('network');
  });
});
