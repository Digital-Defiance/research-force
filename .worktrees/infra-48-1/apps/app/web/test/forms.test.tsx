import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EditorView } from '@codemirror/view';
import { BUILT_IN_VALUE_IDS, LOCKED_VALUE_IDS } from '@researchforce/domain/value-sets';
import { CreateItemForm, EditItemForm, NewItemPage } from '../src/items/forms/ItemForm';
import { createBody, editBody, emptyValue, fieldsFor, initialValues, KIND_FIELDS, needsMark, toApi, valuesFromItem } from '../src/items/forms/model';
import { valueOptions } from '../src/items/forms/inputs';
import { UNSENT_PREFIX } from '../src/persist';
import { failure, fakeApi, json, MEMBER_ID, OTHER_ID, renderScreen } from './helpers';
import { FORM_DATA, HIDDEN_PARTY, makeItem, PARTY, PROJECT, RELIABILITY_HIGH, RETIRED_RELIABILITY, rich, RUN_PARTIAL, VALUE_SETS } from './fixtures';

const editorFor = (label: string): EditorView => {
  const name = screen.getAllByText(label).find((element) => element.classList.contains('rf-field__label'))!;
  return EditorView.findFromDOM(name.closest('.rf-field')!.querySelector('.cm-editor') as HTMLElement)!;
};
const typeInto = (label: string, text: string) => {
  const editor = editorFor(label);
  act(() => { editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } }); });
};
const field = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement;

describe('the form model', () => {
  it('builds a new item’s body from the Project and the filled fields only', () => {
    const values = {
      ...initialValues('source'), title: 'A register', sourceKind: 'primary', reliabilityId: RELIABILITY_HIGH, logSummary: rich('Adds the register.'), groupNote: rich('Please check.'),
      documentDate: { start: { value: '1943-05', approx: true }, end: { value: '', approx: false } }, recoverer: { kind: 'external', id: PARTY.id },
    };
    expect(createBody('source', PROJECT.id, values)).toEqual({
      projectId: PROJECT.id, title: 'A register', sourceKind: 'primary', reliabilityId: RELIABILITY_HIGH, documentDate: { value: '1943-05', approx: true },
      recoverer: { kind: 'external', id: PARTY.id }, logSummary: rich('Adds the register.'), groupNote: rich('Please check.'),
    });
    expect(createBody('source', '', initialValues('source'))).toEqual({});
    const ranged = { ...initialValues('source'), documentDate: { start: { value: '1943', approx: false }, end: { value: '1944-02', approx: true } } };
    expect(createBody('source', '', ranged)['documentDate']).toEqual({ start: { value: '1943', approx: false }, end: { value: '1944-02', approx: true } });
    const endOnly = { ...initialValues('source'), documentDate: { start: { value: '', approx: false }, end: { value: '1944', approx: false } } };
    expect(createBody('source', '', endOnly)['documentDate']).toEqual({ start: { value: '', approx: false }, end: { value: '1944', approx: false } });
  });

  it('builds Correspondence parties with consent, Run counts, and Journal_Entry sections', () => {
    const correspondence = { ...initialValues('correspondence'), parties: [{ kind: 'member', id: MEMBER_ID }, { kind: 'external', id: PARTY.id }, { kind: 'member', id: '' }] };
    expect(createBody('correspondence', '', correspondence)['parties']).toEqual([{ kind: 'member', id: MEMBER_ID }, { kind: 'external', id: PARTY.id, consent: 'not_asked' }]);
    const run = { ...initialValues('run'), counts: [{ name: 'tiles', value: '12' }, { name: '', value: '' }] };
    expect(createBody('run', '', run)['counts']).toEqual([{ name: 'tiles', value: '12' }]);
    expect(createBody('journal_entry', '', initialValues('journal_entry'))).toEqual({ sections: [{ content: rich('') }] });
    expect(createBody('journal_entry', '', { ...initialValues('journal_entry'), relatedMemberIds: [OTHER_ID], startDate: { value: '1944', approx: true } }))
      .toEqual({ relatedMemberIds: [OTHER_ID], startDate: { value: '1944', approx: true }, sections: [{ content: rich('') }] });
  });

  it('sends only the changed fields of an edit, a cleared field as null, with the opened revision and the mark', () => {
    const item = makeItem({ kind: 'finding', claim: rich('The claim.'), scopeCaveat: rich('Only here.'), statusValueId: BUILT_IN_VALUE_IDS.findingOpen, logSummary: rich('A summary.'), withdrawalReason: 'old' });
    const before = valuesFromItem(item);
    expect(editBody('finding', item.rev, before, before, { mark: '', reason: '' })).toEqual({ rev: 3 });
    const values = { ...before, title: 'A new title', withdrawalReason: '' };
    expect(editBody('finding', item.rev, before, values, { mark: 'minor_edit', reason: '' })).toEqual({ rev: 3, title: 'A new title', withdrawalReason: null, mark: { mark: 'minor_edit' } });
    expect(editBody('finding', 4, before, values, { mark: 'correction', reason: 'Typo.' }, 'Because.')).toMatchObject({ rev: 4, mark: { mark: 'correction', reason: 'Typo.' }, statusReason: 'Because.' });
    expect(editBody('finding', 4, before, values, { mark: 'minor_edit', reason: 'Tidy.' })['mark']).toEqual({ mark: 'minor_edit', reason: 'Tidy.' });
    expect(Object.keys(editBody('finding', 4, before, { ...before, groupNote: rich('x'), projectId: 'p' }, { mark: '', reason: '' }))).toEqual(['rev']);
  });

  it('requires the Minor_Edit or Correction choice unless only status fields change (R22.2)', () => {
    expect(needsMark({ rev: 1, statusValueId: 'x', statusReason: 'y', mark: {} })).toBe(false);
    expect(needsMark({ rev: 1, outcomeId: 'x', supersededById: 'y', withdrawalReason: 'z' })).toBe(false);
    expect(needsMark({ rev: 1, statusValueId: 'x', eliminationScope: rich('All of it.') })).toBe(false);
    expect(needsMark({ rev: 1, eliminationScope: rich('All of it.') })).toBe(true);
    expect(needsMark({ rev: 1, title: 'x' })).toBe(true);
    expect(needsMark({ rev: 1 })).toBe(false);
  });

  it('reads every stored field back into the form unchanged', () => {
    const item = makeItem({
      kind: 'source', sourceKind: 'secondary', reliabilityId: RELIABILITY_HIGH, documentDate: { value: '1950', approx: false }, recoverer: { kind: 'member', id: MEMBER_ID },
      sections: [{ id: 'S', content: rich('x'), rev: 1, disclosure: { level: 'not_published', effective: 'not_published' } }],
    });
    const values = valuesFromItem(item);
    expect(values['documentDate']).toEqual({ start: { value: '1950', approx: false }, end: { value: '', approx: false } });
    for (const spec of fieldsFor('source', 'edit')) {
      const stored = item[spec.name];
      expect(toApi(spec, values[spec.name]), spec.name).toEqual(stored ?? undefined);
    }
    expect(valuesFromItem(makeItem({ kind: 'journal_entry', sections: item.sections! }))['sections']).toEqual([{ id: 'S', content: rich('x') }]);
    expect(fieldsFor('topic', 'edit').map((spec) => spec.name)).toEqual(['title', 'body', 'logSummary']);
    expect(KIND_FIELDS.topic.map((spec) => spec.name)).toEqual(['title', 'body', 'logSummary', 'groupNote']);
    expect(emptyValue('members')).toEqual([]);
  });

  it('offers values that can be newly chosen and keeps a retired current value (R4.6)', () => {
    const spec = KIND_FIELDS.source.find((entry) => entry.name === 'reliabilityId')!;
    expect(valueOptions(VALUE_SETS, spec, '').map((option) => option.label)).toEqual(['High']);
    expect(valueOptions(VALUE_SETS, spec, RETIRED_RELIABILITY).map((option) => option.label)).toEqual(['High', 'Doubtful (retired)']);
  });
});

describe('submitting a Research_Item', () => {
  const choice = { projects: [{ id: 'P0', name: 'Earlier project' }, PROJECT], preselected: PROJECT.id };

  it('preselects the Project of the starting page, offers Projects in order, and opens the new item (R39.2, R41.7)', async () => {
    const api = fakeApi({ 'POST /topics': json({ item: { id: 'NEW' } }, 201) });
    renderScreen(<CreateItemForm kind="topic" choice={choice} data={FORM_DATA} />, { client: api.client });
    const project = field(/^Project/u) as unknown as HTMLSelectElement;
    expect(project.value).toBe(PROJECT.id);
    expect([...project.options].map((option) => option.textContent)).toEqual(['Choose a Project', 'Earlier project', 'Synthetic project']);
    fireEvent.change(field(/^Title/u), { target: { value: 'A topic' } });
    typeInto('Body', 'What we know.');
    typeInto('Group Note', 'A note for the group.');
    expect(sessionStorage.getItem(`${UNSENT_PREFIX}item:new:topic`)).toContain('A topic');
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/items/NEW'));
    expect(api.writes()[0]).toMatchObject({ path: '/topics', body: { projectId: PROJECT.id, title: 'A topic', body: rich('What we know.'), groupNote: rich('A note for the group.') } });
    expect(api.writes()[0]!.body).not.toHaveProperty('reviews');
    expect(sessionStorage.getItem(`${UNSENT_PREFIX}item:new:topic`)).toBeNull();
  });

  it('says a Project is required when none exists (R39.3)', () => {
    renderScreen(<CreateItemForm kind="finding" choice={{ projects: [], preselected: null }} data={FORM_DATA} />, { client: fakeApi({}).client });
    expect(screen.getByRole('alert').textContent).toBe('A Project is required, and none exists yet. An Administrator must first create one.');
  });

  it('shows each field’s errors from a 422 next to the field and keeps the input in this tab (R41.2, R28.10)', async () => {
    const api = fakeApi({
      'POST /items/finding': failure(422, 'validation', { fields: [
        { field: 'projectId', rule: 'Choose a Project.' }, { field: 'logSummary', rule: 'This kind requires a Log Summary of 1 to 2000 Unicode code points.' },
        { field: 'claim.spans.0', rule: 'A Quote or Paraphrase needs a non-blank source.' }, { field: '$', rule: 'Send a JSON object.' },
      ] }),
    });
    const view = renderScreen(<CreateItemForm kind="finding" choice={{ ...choice, preselected: null }} data={FORM_DATA} />, { client: api.client });
    fireEvent.change(field(/^Title/u), { target: { value: 'Kept title' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await screen.findByText('Your input was not saved. Correct the fields marked below.');
    const errorOf = (label: string) => screen.getAllByText(label).find((element) => element.classList.contains('rf-field__label'))!.closest('.rf-field')!.querySelector('.rf-field__error')?.textContent;
    expect(errorOf('Project')).toBe('Choose a Project.');
    expect(errorOf('Log Summary')).toBe('This kind requires a Log Summary of 1 to 2000 Unicode code points.');
    expect(errorOf('Claim')).toBe('A Quote or Paraphrase needs a non-blank source.');
    expect(view.container.textContent).toContain('Send a JSON object.');
    expect(field(/^Title/u).value).toBe('Kept title');
    view.unmount();
    renderScreen(<CreateItemForm kind="finding" choice={choice} data={FORM_DATA} />, { client: api.client });
    expect(field(/^Title/u).value).toBe('Kept title');
    expect(screen.getByText('Your unsent input was restored. It has not been saved.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Discard the unsent input' }));
    expect(field(/^Title/u).value).toBe('');
  });

  it('offers active Members and External Parties, under a generic label when a Party is not to be named', () => {
    renderScreen(<CreateItemForm kind="archival_request" choice={choice} data={FORM_DATA} />, { client: fakeApi({}).client });
    const desk = field(/^Archive or desk/u) as unknown as HTMLSelectElement;
    expect([...desk.options].map((option) => option.textContent)).toEqual(['Choose…', 'Ada Example (Member)', 'Ben Sample (Member)', 'County Archive (External Party)', `${HIDDEN_PARTY.genericLabel} (External Party)`]);
  });

  it('loads the Project choice for the page the Submission started from', async () => {
    const api = fakeApi({
      'GET /projects/choice?unit=U1': choice, 'GET /value-sets': { valueSets: VALUE_SETS }, 'GET /parties': { parties: [PARTY] }, 'GET /members': { members: FORM_DATA.members },
    });
    renderScreen(<NewItemPage kind="hypothesis" search={new URLSearchParams('unit=U1&other=x')} />, { client: api.client });
    expect(await screen.findByRole('heading', { name: 'New Hypothesis' })).toBeTruthy();
    expect(api.calls.map((call) => call.path)).toContain('/projects/choice?unit=U1');
  });
});

describe('editing a Research_Item', () => {
  const finding = makeItem({ kind: 'finding', claim: rich('The claim.'), scopeCaveat: rich('Only here.'), statusValueId: BUILT_IN_VALUE_IDS.findingOpen, logSummary: rich('A summary.') });
  const radios = () => screen.getAllByRole('radio') as HTMLInputElement[];

  it('requires Minor_Edit or Correction with neither preselected, and a reason for a Correction (R22.2)', async () => {
    const api = fakeApi({ [`PATCH /items/${finding.id}`]: { item: finding } });
    renderScreen(<EditItemForm item={finding} data={FORM_DATA} onReload={() => undefined} />, { client: api.client });
    expect(radios().map((radio) => radio.checked)).toEqual([false, false]);
    fireEvent.change(field(/^Title/u), { target: { value: 'Changed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Choose Minor edit or Correction.')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Correction'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('A Correction needs a reason.')).toBeTruthy();
    expect(api.writes()).toEqual([]);
    fireEvent.change(field(/^Reason \(required\)/u), { target: { value: 'The date was wrong.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(`/items/${finding.id}`));
    expect(api.writes()[0]!.body).toEqual({ rev: 3, title: 'Changed', mark: { mark: 'correction', reason: 'The date was wrong.' } });
  });

  it('saves a status change without a mark, with its optional reason', async () => {
    const api = fakeApi({ [`PATCH /items/${finding.id}`]: { item: finding } });
    renderScreen(<EditItemForm item={finding} data={FORM_DATA} onReload={() => undefined} />, { client: api.client });
    fireEvent.change(field(/^Finding status/u), { target: { value: BUILT_IN_VALUE_IDS.findingConfirmed } });
    fireEvent.change(field(/^Reason for a status change/u), { target: { value: 'Two sources agree.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toEqual({ rev: 3, statusValueId: BUILT_IN_VALUE_IDS.findingConfirmed, statusReason: 'Two sources agree.' });
  });

  it('shows the Revisions saved since the record was opened and keeps the input after a 409 (R4.9, R22.10)', async () => {
    let reloaded = 0;
    const api = fakeApi({
      [`PATCH /items/${finding.id}`]: failure(409, 'conflict', { details: { rev: 5, revisions: [
        { kind: 'minor_edit', memberId: OTHER_ID, displayName: 'Ben Sample', at: '2026-10-27T09:30:00.000Z' },
        { kind: 'status_change', memberId: OTHER_ID, displayName: null, at: '2026-10-27T10:00:00.000Z' },
      ] } }),
    });
    renderScreen(<EditItemForm item={finding} data={FORM_DATA} onReload={() => { reloaded += 1; }} />, { client: api.client });
    fireEvent.change(field(/^Title/u), { target: { value: 'My unsaved title' } });
    fireEvent.click(screen.getByLabelText('Minor edit'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const notice = await screen.findByText('Someone saved a change after you opened this record. Your input was not saved; it is kept below.');
    const items = [...notice.closest('.rf-notice')!.querySelectorAll('li')].map((item) => item.textContent);
    expect(items).toEqual(['Minor edit by Ben Sample at 2026-10-27 09:30 UTC', 'Status change by a Member without a display name at 2026-10-27 10:00 UTC']);
    expect(field(/^Title/u).value).toBe('My unsaved title');
    expect(sessionStorage.getItem(`${UNSENT_PREFIX}item:${finding.id}:edit`)).toContain('My unsaved title');
    fireEvent.click(screen.getByRole('button', { name: 'Discard my input and load the latest version' }));
    expect(reloaded).toBe(1);
    expect(sessionStorage.getItem(`${UNSENT_PREFIX}item:${finding.id}:edit`)).toBeNull();
  });

  it('diffs a restored edit against the values first opened, so the save never reverts others’ changes', async () => {
    const api = fakeApi({ [`PATCH /items/${finding.id}`]: failure(409, 'conflict', { details: { rev: 4 } }) });
    const first = renderScreen(<EditItemForm item={finding} data={FORM_DATA} onReload={() => undefined} />, { client: api.client });
    fireEvent.change(field(/^Title/u), { target: { value: 'Mine' } });
    first.unmount();
    const newer = { ...finding, rev: 4, statusValueId: BUILT_IN_VALUE_IDS.findingConfirmed };
    renderScreen(<EditItemForm item={newer} data={FORM_DATA} onReload={() => undefined} />, { client: api.client });
    fireEvent.click(screen.getByLabelText('Minor edit'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toEqual({ rev: 3, title: 'Mine', mark: { mark: 'minor_edit' } });
  });

  it('edits the Elimination_Scope with the Eliminated status and run fields with counts', async () => {
    const hypothesis = makeItem({ kind: 'hypothesis', statement: rich('It was the river.'), statusValueId: LOCKED_VALUE_IDS.hypothesisOpen, logSummary: rich('S.') });
    const api = fakeApi({ [`PATCH /items/${hypothesis.id}`]: { item: hypothesis } });
    renderScreen(<EditItemForm item={hypothesis} data={FORM_DATA} onReload={() => undefined} />, { client: api.client });
    fireEvent.change(field(/^Hypothesis status/u), { target: { value: LOCKED_VALUE_IDS.hypothesisEliminated } });
    typeInto('Elimination scope', 'The whole river.');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toEqual({ rev: 3, statusValueId: LOCKED_VALUE_IDS.hypothesisEliminated, eliminationScope: rich('The whole river.') });
  });

  it('adds and removes repeated rows', () => {
    const run = makeItem({ kind: 'run', outcomeId: RUN_PARTIAL, scope: rich('a'), parameters: rich('b'), toolName: 't', toolVersion: '1', computeResource: 'c', startTime: '2026-10-01T00:00:00+00:00', logSummary: rich('s') });
    renderScreen(<EditItemForm item={run} data={FORM_DATA} onReload={() => undefined} />, { client: fakeApi({}).client });
    fireEvent.click(screen.getByRole('button', { name: 'Add a count' }));
    fireEvent.change(field(/^Count 1 name/u), { target: { value: 'tiles' } });
    fireEvent.change(field(/^Count 1 value/u), { target: { value: '7' } });
    expect(sessionStorage.getItem(`${UNSENT_PREFIX}item:${run.id}:edit`)).toContain('"tiles"');
    fireEvent.click(screen.getByRole('button', { name: 'Remove count 1' }));
    expect(screen.queryByLabelText(/^Count 1 name/u)).toBeNull();
  });
});
