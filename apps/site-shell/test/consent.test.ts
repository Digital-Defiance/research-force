import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  allAnswered,
  answerBody,
  changeBody,
  fetchView,
  labelApplies,
  optionsFor,
  snapshotHeading,
  snapshotLines,
  submitAnswer,
  submitChange,
  tokenFromHash,
  wantsGenericLabel,
  type ConsentSnapshot,
  type ConsentState,
  type ConsentViewItem,
} from '../src/consent';
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
const ITEM_A = '0000000000000000000000ITMA';
const ITEM_B = '0000000000000000000000ITMB';

const pubSnapshot = (key: string): ConsentSnapshot => ({
  kind: 'publication',
  key: `u:${key}`,
  view: { tag: 'research_item', kind: 'correspondence', title: 'A letter', publicSummary: { text: 'A short summary.' } },
  partyName: 'A correspondent',
});
const rightsSnapshot = (key: string): ConsentSnapshot => ({
  kind: 'rights',
  key: `u:${key}`,
  view: { tag: 'attachment', title: 'A scan' },
  document: { identifier: 'AT-00001', title: 'A scan', fileName: 'scan.pdf', sizeBytes: 1234, sha256: 'a'.repeat(64) },
});

function items(...snapshots: { itemId: string; snapshot: ConsentSnapshot }[]): ConsentViewItem[] {
  return snapshots;
}

function state(overrides: Partial<ConsentState> = {}): ConsentState {
  return { answers: [], comment: '', genericLabel: '', ...overrides };
}

describe('the token from the URL fragment (R51.4, R51.12)', () => {
  it('reads the token after the leading #, trimming whitespace', () => {
    expect(tokenFromHash(`#${TOKEN}`)).toBe(TOKEN);
    expect(tokenFromHash(`#  ${TOKEN}  `)).toBe(TOKEN);
  });
  it('is empty when no fragment is present', () => {
    expect(tokenFromHash('')).toBe('');
  });
});

describe('the answer options by kind (R51.6)', () => {
  it('offers name/no-name/no for a publication request and permission/no for a rights request', () => {
    expect(optionsFor('publication')).toEqual(['named', 'unnamed', 'refused']);
    expect(optionsFor('rights')).toEqual(['granted', 'refused']);
  });
  it('offers the Generic_Label only when a publication kind can be answered "do not name me"', () => {
    expect(labelApplies('publication', ['named', 'unnamed', 'refused'])).toBe(true);
    expect(labelApplies('rights', ['granted', 'refused'])).toBe(false);
  });
});

describe('every element must be answered before submitting (R51.6)', () => {
  const two = items({ itemId: ITEM_A, snapshot: pubSnapshot('A') }, { itemId: ITEM_B, snapshot: pubSnapshot('B') });
  it('is not ready while any element is unanswered, or when there are no elements', () => {
    expect(allAnswered(two, state({ answers: [{ itemId: ITEM_A, choice: 'named' }] }))).toBe(false);
    expect(allAnswered([], state())).toBe(false);
  });
  it('is ready when every element has a chosen answer', () => {
    expect(allAnswered(two, state({ answers: [{ itemId: ITEM_A, choice: 'named' }, { itemId: ITEM_B, choice: 'refused' }] }))).toBe(true);
  });
});

describe('the answer body (R51.6, R51.7)', () => {
  it('carries the token, the Turnstile token, and one answer per element', () => {
    const body = answerBody(TOKEN, 'ts', state({ answers: [{ itemId: ITEM_A, choice: 'named' }] }));
    expect(body).toMatchObject({ token: TOKEN, turnstileToken: 'ts' });
    expect(body['answers']).toEqual([{ itemId: ITEM_A, choice: 'named' }]);
  });
  it('includes the comment only when non-blank', () => {
    expect(answerBody(TOKEN, 'ts', state({ comment: '  ' }))['comment']).toBeUndefined();
    expect(answerBody(TOKEN, 'ts', state({ comment: 'Please do.' }))['comment']).toBe('Please do.');
  });
  it('includes the Generic_Label only when a "do not name me" answer is chosen (R51.7)', () => {
    const named = answerBody(TOKEN, 'ts', state({ answers: [{ itemId: ITEM_A, choice: 'named' }], genericLabel: 'a wartime correspondent' }));
    expect(named['genericLabel']).toBeUndefined();
    const unnamed = answerBody(TOKEN, 'ts', state({ answers: [{ itemId: ITEM_A, choice: 'unnamed' }], genericLabel: 'a wartime correspondent' }));
    expect(unnamed['genericLabel']).toBe('a wartime correspondent');
    expect(wantsGenericLabel(state({ answers: [{ itemId: ITEM_A, choice: 'unnamed' }] }))).toBe(true);
  });
});

describe('the change (withdrawal) body (R51.10)', () => {
  it('carries only the token, the Turnstile token, and an optional comment', () => {
    expect(changeBody(TOKEN, 'ts', '')).toEqual({ token: TOKEN, turnstileToken: 'ts' });
    expect(changeBody(TOKEN, 'ts', 'I withdraw.')).toEqual({ token: TOKEN, turnstileToken: 'ts', comment: 'I withdraw.' });
  });
});

describe('rendering a snapshot (R51.5, R51.16)', () => {
  it('titles a publication snapshot by its kind and title, and says how the Party would be named', () => {
    const snapshot = pubSnapshot('A');
    expect(snapshotHeading(snapshot)).toBe('correspondence: A letter');
    expect(snapshotLines(snapshot)).toEqual(['A short summary.', 'You would be named as: A correspondent']);
  });
  it('titles a rights snapshot by its identifier and shows the file identity, never the bytes', () => {
    const snapshot = rightsSnapshot('B');
    expect(snapshotHeading(snapshot)).toBe('AT-00001: A scan');
    expect(snapshotLines(snapshot)).toEqual(['File: scan.pdf', 'Size: 1234 bytes', `SHA-256: ${'a'.repeat(64)}`]);
  });
});

describe('the API client against the rf-submit consent contract', () => {
  it('fetches the Consent_Page content from the view endpoint', async () => {
    const view = { kind: 'publication', options: ['named', 'unnamed', 'refused'], items: [{ itemId: ITEM_A, snapshot: pubSnapshot('A') }] };
    const { fetcher, calls } = scriptedFetch([{ status: 200, body: view }]);
    const result = await fetchView(fetcher, 'consent', TOKEN);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.items).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://submit.researchforce.org/v1/consent/view');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ token: TOKEN });
  });

  it('fetches the Change_Link content from the change view endpoint', async () => {
    const { fetcher, calls } = scriptedFetch([{ status: 200, body: { kind: 'publication', options: [], items: [] } }]);
    await fetchView(fetcher, 'change', TOKEN);
    expect(calls[0]?.url).toBe('https://submit.researchforce.org/v1/consent/change/view');
  });

  it('turns the fixed "no longer valid" refusal into a refusal result that reveals nothing (R51.12)', async () => {
    const { fetcher } = scriptedFetch([{ status: 400, body: { error: 'invalid_link', message: 'This link is no longer valid.' } }]);
    const result = await fetchView(fetcher, 'consent', TOKEN);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toEqual({ error: 'invalid_link', message: 'This link is no longer valid.' });
  });

  it('records an answer and returns the confirmation time', async () => {
    const { fetcher, calls } = scriptedFetch([{ status: 201, body: { recordedAt: '2026-10-29T12:00:00.000Z' } }]);
    const result = await submitAnswer(fetcher, answerBody(TOKEN, 'ts', state({ answers: [{ itemId: ITEM_A, choice: 'named' }] })));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.recordedAt).toBe('2026-10-29T12:00:00.000Z');
    expect(calls[0]?.url).toBe('https://submit.researchforce.org/v1/consent/answer');
  });

  it('records a withdrawal through the change endpoint', async () => {
    const { fetcher, calls } = scriptedFetch([{ status: 201, body: { recordedAt: '2026-10-29T12:00:00.000Z' } }]);
    const result = await submitChange(fetcher, changeBody(TOKEN, 'ts', ''));
    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe('https://submit.researchforce.org/v1/consent/change');
  });

  it('reports a network failure as a refusal rather than throwing', async () => {
    const failing: FetchLike = () => Promise.reject(new Error('offline'));
    const result = await submitAnswer(failing, answerBody(TOKEN, 'ts', state({ answers: [{ itemId: ITEM_A, choice: 'named' }] })));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.error).toBe('network');
  });
});
