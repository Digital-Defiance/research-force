import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { AI_MODEL, AI_MODEL_VERSION, draftTextHash } from '@researchforce/domain/ai';
import type { RichText } from '@researchforce/domain/richtext';
import { AiDraftControl, NO_DRAFT_NOTICE, QUOTATION_NOTICE } from '../src/editor/ai-draft';
import type { PlacedProvenance } from '../src/editor/ai-draft';
import { failure, fakeApi, json, renderScreen } from './helpers';
import type { Call } from './helpers';

const ITEM_ID = '01J00000000000000000000009';

/** A deferred promise, so a handler's answer can be resolved by the test at the moment it chooses. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Render the control over a tiny host that owns the field text and records each placement and provenance. */
function Harness({ saved = true, initial = '' }: { saved?: boolean; initial?: string }) {
  const [field, setField] = useState<RichText>({ text: initial, spans: [] });
  const [provenance, setProvenance] = useState<PlacedProvenance | undefined>(undefined);
  return (
    <>
      <output data-testid="field">{field.text}</output>
      <output data-testid="provenance">{provenance === undefined ? 'none' : JSON.stringify(provenance)}</output>
      <AiDraftControl field="logSummary" label="Log Summary" {...(saved ? { itemId: ITEM_ID } : {})} editorText={field.text === '' ? {} : { logSummary: field.text }} fieldText={field.text}
        onPlace={(text) => setField({ text, spans: [] })} onPlaced={setProvenance} />
    </>
  );
}

const summaryResult = (draft: string, extra: Partial<{ truncatedInput: boolean; quotationNotice: boolean }> = {}) =>
  json({ draft, model: AI_MODEL, truncatedInput: extra.truncatedInput ?? false, quotationNotice: extra.quotationNotice ?? false });

describe('the AI draft control', () => {
  it('offers the request only while GET /ai/status is available (R44.10, R44.11, R44.17)', async () => {
    const turnedOff = renderScreen(<Harness />, { client: fakeApi({ 'GET /ai/status': { available: false, reason: 'turned_off' } }).client });
    expect(await screen.findByText('AI drafting is turned off.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Request an AI draft' })).toBeNull();
    turnedOff.unmount();

    const exhausted = renderScreen(<Harness />, { client: fakeApi({ 'GET /ai/status': { available: false, reason: 'resumes_at_utc_midnight' } }).client });
    expect(await screen.findByText('AI drafting resumes at 00:00 UTC.')).toBeTruthy();
    exhausted.unmount();

    renderScreen(<Harness />, { client: fakeApi({ 'GET /ai/status': { available: true } }).client });
    expect(await screen.findByRole('button', { name: 'Request an AI draft' })).toBeTruthy();
  });

  it('holds the draft apart from the field, and accepting an empty field places it unsaved with its provenance (R44.4, R44.5, R44.6)', async () => {
    const api = fakeApi({ 'GET /ai/status': { available: true }, 'POST /ai/drafts': summaryResult('A neutral synthetic draft.') });
    renderScreen(<Harness />, { client: api.client });
    fireEvent.click(await screen.findByRole('button', { name: 'Request an AI draft' }));
    // The draft is shown apart from the field; the field is not written to on request (R44.4).
    expect(await screen.findByText('A neutral synthetic draft.')).toBeTruthy();
    expect(screen.getByTestId('field').textContent).toBe('');
    // The request sent the field, item, and the editor's current text (R44.1).
    const post = api.writes().find((call) => call.path === '/ai/drafts')!;
    expect(post.body).toEqual({ field: 'logSummary', itemId: ITEM_ID, editor: {} });

    fireEvent.click(screen.getByRole('button', { name: 'Accept the draft' }));
    // Placing leaves the draft text in the field, and records the provenance for the save (R44.5, R44.6).
    expect(screen.getByTestId('field').textContent).toBe('A neutral synthetic draft.');
    expect(JSON.parse(screen.getByTestId('provenance').textContent!)).toEqual({ model: AI_MODEL, version: AI_MODEL_VERSION, draftSha256: draftTextHash('A neutral synthetic draft.') });
    // Nothing was saved: only the status read and the draft request were sent.
    expect(api.writes().map((call) => call.path)).toEqual(['/ai/drafts']);
    // The held draft is gone once placed.
    expect(screen.queryByRole('button', { name: 'Accept the draft' })).toBeNull();
  });

  it('asks before replacing a non-empty field, and keeps the text when the Member declines (R44.5)', async () => {
    const api = fakeApi({ 'GET /ai/status': { available: true }, 'POST /ai/drafts': summaryResult('Replacement draft text.') });
    renderScreen(<Harness initial="The Member already wrote this." />, { client: api.client });
    fireEvent.click(await screen.findByRole('button', { name: 'Request an AI draft' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Accept the draft' }));
    // The field is non-empty, so a confirmation is asked before replacing; the field is unchanged so far.
    expect(screen.getByTestId('field').textContent).toBe('The Member already wrote this.');
    fireEvent.click(screen.getByRole('button', { name: 'Keep the current text' }));
    expect(screen.getByTestId('field').textContent).toBe('The Member already wrote this.');
    expect(screen.getByTestId('provenance').textContent).toBe('none');

    fireEvent.click(screen.getByRole('button', { name: 'Accept the draft' }));
    fireEvent.click(screen.getByRole('button', { name: 'Replace and place the draft' }));
    expect(screen.getByTestId('field').textContent).toBe('Replacement draft text.');
    expect(JSON.parse(screen.getByTestId('provenance').textContent!).draftSha256).toBe(draftTextHash('Replacement draft text.'));
  });

  it('removes the held draft on discard and when a new draft is requested (R44.4, R44.16)', async () => {
    const api = fakeApi({ 'GET /ai/status': { available: true }, 'POST /ai/drafts': summaryResult('First draft.') });
    renderScreen(<Harness />, { client: api.client });
    fireEvent.click(await screen.findByRole('button', { name: 'Request an AI draft' }));
    expect(await screen.findByText('First draft.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Discard the draft' }));
    expect(screen.queryByText('First draft.')).toBeNull();
    expect(screen.getByTestId('field').textContent).toBe('');
    // Requesting again (with none held) reads as a fresh request and the new draft is shown.
    fireEvent.click(screen.getByRole('button', { name: 'Request an AI draft' }));
    expect(await screen.findByText('First draft.')).toBeTruthy();
  });

  it('replaces a held, unaccepted draft when a new one is requested (R44.16)', async () => {
    let call = 0;
    const api = fakeApi({ 'GET /ai/status': { available: true }, 'POST /ai/drafts': () => summaryResult(++call === 1 ? 'First held draft.' : 'Second held draft.') });
    renderScreen(<Harness />, { client: api.client });
    fireEvent.click(await screen.findByRole('button', { name: 'Request an AI draft' }));
    expect(await screen.findByText('First held draft.')).toBeTruthy();
    // A new request while one is still held and unaccepted removes the old one and leaves the field unchanged.
    fireEvent.click(screen.getByRole('button', { name: 'Request a new AI draft' }));
    expect(await screen.findByText('Second held draft.')).toBeTruthy();
    expect(screen.queryByText('First held draft.')).toBeNull();
    expect(screen.getByTestId('field').textContent).toBe('');
  });

  it('shows the quotation-mark notice next to the draft and then next to the field until it is saved (R44.8)', async () => {
    const api = fakeApi({ 'GET /ai/status': { available: true }, 'POST /ai/drafts': summaryResult('"Quoted" opening.', { quotationNotice: true }) });
    renderScreen(<Harness />, { client: api.client });
    fireEvent.click(await screen.findByRole('button', { name: 'Request an AI draft' }));
    expect(await screen.findAllByText(QUOTATION_NOTICE)).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Accept the draft' }));
    // After acceptance the notice follows the field; the held-draft notice is gone and the field-side one remains.
    expect(screen.getAllByText(QUOTATION_NOTICE)).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Accept the draft' })).toBeNull();
  });

  it('shows "No AI draft was produced" on empty output, errors, and the off/exhausted refusal (R44.12, R44.17)', async () => {
    const empty = renderScreen(<Harness />, { client: fakeApi({ 'GET /ai/status': { available: true }, 'POST /ai/drafts': { draft: null, reason: 'empty_input' } }).client });
    fireEvent.click(await screen.findByRole('button', { name: 'Request an AI draft' }));
    expect(await screen.findByText(NO_DRAFT_NOTICE)).toBeTruthy();
    empty.unmount();

    const errored = renderScreen(<Harness />, { client: fakeApi({ 'GET /ai/status': { available: true }, 'POST /ai/drafts': failure(500, 'internal') }).client });
    fireEvent.click(await screen.findByRole('button', { name: 'Request an AI draft' }));
    expect(await screen.findByText(NO_DRAFT_NOTICE)).toBeTruthy();
    errored.unmount();

    // A 503 refusal after the editor opened hides the request control and shows the fixed notice (R44.17).
    renderScreen(<Harness />, { client: fakeApi({ 'GET /ai/status': { available: true }, 'POST /ai/drafts': failure(503, 'unavailable', { details: { reason: 'resumes_at_utc_midnight', message: 'AI drafting resumes at 00:00 UTC.' } }) }).client });
    fireEvent.click(await screen.findByRole('button', { name: 'Request an AI draft' }));
    expect(await screen.findByText('AI drafting resumes at 00:00 UTC.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: /Request a/u })).toBeNull());
  });

  it('discards a late answer to a superseded request so a stale draft never lands (R44.12)', async () => {
    const first = deferred<Response>();
    let call = 0;
    const api = fakeApi({
      'GET /ai/status': { available: true },
      'POST /ai/drafts': (_call: Call) => (++call === 1 ? first.promise : summaryResult('Second, current draft.')),
    });
    renderScreen(<Harness />, { client: api.client });
    // Fire the first request, then a second before the first answers.
    fireEvent.click(await screen.findByRole('button', { name: 'Request an AI draft' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Request a new AI draft' }));
    expect(await screen.findByText('Second, current draft.')).toBeTruthy();
    // Now the first (superseded) request answers late; its draft must be discarded.
    await act(async () => { first.resolve(summaryResult('First, stale draft.')); await first.promise; });
    expect(screen.queryByText('First, stale draft.')).toBeNull();
    expect(screen.getByText('Second, current draft.')).toBeTruthy();
  });

  it('does not offer a request for an unsaved item, where no draft can be produced (R44.1)', () => {
    const api = fakeApi({ 'GET /ai/status': { available: true } });
    renderScreen(<Harness saved={false} />, { client: api.client });
    expect(screen.queryByText(/AI draft for/u)).toBeNull();
    // No status read is made without a saved item.
    expect(api.calls).toEqual([]);
  });
});
