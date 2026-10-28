import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { BUILT_IN_VALUE_IDS } from '@researchforce/domain/value-sets';
import { DeletePage, DeletedItem } from '../src/history/delete';
import { Comparison, fieldLabel, ItemHistoryPage, plainValue } from '../src/history/history';
import { publicReasonStatement, WithdrawPage } from '../src/history/withdraw';
import { ItemPage } from '../src/items/page';
import type { HistoryEntry, ItemHistoryView } from '../src/types';
import { failure, fakeApi, makeMe, MEMBER_ID, OTHER_ID, renderScreen } from './helpers';
import { makeItem, rich } from './fixtures';

const ITEM = makeItem({
  kind: 'journal_entry', title: 'A retitled entry', logSummary: rich('A newer summary.'),
  sections: [{ id: 'S2', content: rich('Second, corrected.'), rev: 2, disclosure: { level: 'private', effective: 'private' } }],
});
const entry = (id: string, kind: string, extra: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id, kind, memberId: MEMBER_ID, displayName: 'Ada Example', at: '2026-10-27T18:00:00.000Z', reason: null, restoredPoint: null, sectionId: null, fields: [], ...extra,
});
const ENTRIES = [
  entry('R3', 'restoration', { restoredPoint: 'creation', fields: ['title'] }),
  entry('R2', 'correction', { reason: 'Fix the sections.', fields: ['sections'] }),
  entry('R1', 'disclosure_change', { sectionId: 'S2', fields: ['disclosureLevel'], memberId: OTHER_ID, displayName: 'Ben Sample' }),
  entry('creation', 'creation'),
];
const STATE: ItemHistoryView['state'] = {
  item: { title: 'A synthetic journal_entry', logSummary: rich('Old summary.'), disclosureLevel: 'private', sections: [{ id: 'S1', content: rich('First.') }, { id: 'S2', content: rich('Second.') }] },
  sections: { S2: { disclosureLevel: 'public' } },
};
const historyApi = (extra: Parameters<typeof fakeApi>[0] = {}) => fakeApi({
  [`GET /items/${ITEM.id}`]: { item: ITEM },
  [`GET /items/${ITEM.id}/history`]: { entries: ENTRIES },
  [`GET /items/${ITEM.id}/history?point=creation`]: { entries: ENTRIES, point: 'creation', state: STATE },
  ...extra,
});

describe('the history list', () => {
  it('lists every Revision newest first with Member, time, kind, reason, section, and changed fields (R22.3)', async () => {
    renderScreen(<ItemHistoryPage id={ITEM.id} />, { client: historyApi().client });
    const list = await screen.findByRole('region', { name: 'Revisions' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((item) => item.querySelector('p')?.textContent)).toEqual([
      'Restoration by Ada Example at 2026-10-27 18:00 UTC',
      'Correction by Ada Example at 2026-10-27 18:00 UTC',
      'Disclosure change of Entry Section 1 by Ben Sample at 2026-10-27 18:00 UTC',
      'Creation by Ada Example at 2026-10-27 18:00 UTC',
    ]);
    expect(items[0]!.textContent).toContain('Restored to: Creation, 2026-10-27 18:00 UTC');
    expect(items[0]!.textContent).toContain('Changed: Title');
    expect(items[1]!.textContent).toContain('Reason: Fix the sections.');
    expect(items[1]!.textContent).toContain('Changed: Entry Sections');
    expect(within(items[2]!).getByRole('link', { name: 'Ben Sample' }).getAttribute('href')).toBe(`/members/${OTHER_ID}`);
  });

  it('shows the record as it was after a chosen point and restores it with the restore dialog (R22.5)', async () => {
    const api = historyApi({ [`POST /items/${ITEM.id}/restore`]: { restored: true, item: ITEM } });
    renderScreen(<ItemHistoryPage id={ITEM.id} />, { client: api.client });
    const list = await screen.findByRole('region', { name: 'Revisions' });
    fireEvent.click(within(within(list).getAllByRole('listitem')[3]!).getByRole('button', { name: 'Show the record as it was after this' }));
    const state = await screen.findByRole('region', { name: 'The record at the chosen point' });
    expect(state.textContent).toContain('A synthetic journal_entry');
    expect(state.textContent).toContain('Old summary.');
    expect(within(state).getByRole('region', { name: 'Entry Section 2 at this point' }).textContent).toContain('Disclosure level: Public');
    fireEvent.click(within(state).getByRole('button', { name: 'Restore this version' }));
    const dialog = screen.getByRole('dialog', { name: 'Restore' });
    expect(dialog.textContent).toContain('Status, withdrawal, and disclosure stay as they are now.');
    expect(dialog.textContent).toContain('starts Private');
    expect(dialog.textContent).not.toContain('only the Owner restores it');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));
    await screen.findByText('The Restoration was saved.');
    expect(api.writes().map((call) => call.body)).toEqual([{ rev: ITEM.rev, point: 'creation' }]);
  });

  it('restores one Entry Section, and tells an Administrator that the Log Summary stays', async () => {
    const api = historyApi({ [`POST /items/${ITEM.id}/restore`]: { restored: false, item: ITEM } });
    renderScreen(<ItemHistoryPage id={ITEM.id} />, { client: api.client, me: makeMe({ member: { id: OTHER_ID, roleId: ROLE_IDS.administrator } }) });
    const list = await screen.findByRole('region', { name: 'Revisions' });
    fireEvent.click(within(within(list).getAllByRole('listitem')[3]!).getByRole('button', { name: 'Show the record as it was after this' }));
    const state = await screen.findByRole('region', { name: 'The record at the chosen point' });
    fireEvent.click(within(state).getByRole('button', { name: 'Restore Entry Section 1 only' }));
    expect(screen.getByRole('dialog', { name: 'Restore' }).textContent).not.toContain('Log Summary');
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Restore' })).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(state).getByRole('button', { name: 'Restore this version' }));
    expect(screen.getByRole('dialog', { name: 'Restore' }).textContent).toContain('The Log Summary stays as it is, because only the Owner restores it.');
    fireEvent.click(within(state).getByRole('button', { name: 'Restore Entry Section 1 only' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Restore' })).getByRole('button', { name: 'Restore' }));
    await screen.findByText('Nothing differs from that point, so nothing was saved.');
    expect(api.writes().map((call) => call.body)).toEqual([{ rev: ITEM.rev, point: 'creation', sectionId: 'S1' }]);
  });

  it('offers no Restoration to Members who neither own the Item nor administer', async () => {
    const other = makeItem({ ...ITEM, owner: { id: OTHER_ID, displayName: 'Ben Sample', specialties: [] } });
    renderScreen(<ItemHistoryPage id={ITEM.id} />, { client: historyApi({ [`GET /items/${ITEM.id}`]: { item: other } }).client });
    const list = await screen.findByRole('region', { name: 'Revisions' });
    fireEvent.click(within(within(list).getAllByRole('listitem')[3]!).getByRole('button', { name: 'Show the record as it was after this' }));
    const state = await screen.findByRole('region', { name: 'The record at the chosen point' });
    expect(within(state).queryByRole('button', { name: /Restore/u })).toBeNull();
  });

  it('shows a refused Restoration without leaving the dialog', async () => {
    const api = historyApi({ [`POST /items/${ITEM.id}/restore`]: failure(409, 'conflict', { details: { rev: 9 } }) });
    renderScreen(<ItemHistoryPage id={ITEM.id} />, { client: api.client });
    const list = await screen.findByRole('region', { name: 'Revisions' });
    fireEvent.click(within(within(list).getAllByRole('listitem')[3]!).getByRole('button', { name: 'Show the record as it was after this' }));
    fireEvent.click(within(await screen.findByRole('region', { name: 'The record at the chosen point' })).getByRole('button', { name: 'Restore this version' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Restore' })).getByRole('button', { name: 'Restore' }));
    expect(await screen.findByText('Your input was not saved because someone else saved a change first.')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Restore' })).toBeTruthy();
  });
});

describe('comparisons', () => {
  it('compares two chosen points with marked words and labels (R22.4)', async () => {
    const differences = [
      { field: 'title', before: 'A synthetic journal_entry', after: 'A retitled entry', words: [{ value: 'A ' }, { value: 'synthetic journal_entry', removed: true }, { value: 'retitled entry', added: true }] },
      { field: 'sections.S2', before: rich('Second.'), after: { text: 'Second.', spans: [{ s: 0, e: 6, k: 'quote', source: 'Book' }] }, words: [{ value: 'Second.' }], labels: { removed: [], added: [{ s: 0, e: 6, k: 'quote', source: 'Book' }] } },
      { field: 'sections.order', before: ['S1', 'S2'], after: ['S2'] },
      { field: 'disclosureLevel', before: 'private', after: 'public' },
    ];
    const api = historyApi({ [`GET /items/${ITEM.id}/compare?from=creation&to=R3`]: { differences } });
    renderScreen(<ItemHistoryPage id={ITEM.id} />, { client: api.client });
    const region = await screen.findByRole('region', { name: 'Compare two points' });
    const compare = within(region).getByRole('button', { name: 'Compare' });
    expect((compare as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(region).getByLabelText('From'), { target: { value: 'creation' } });
    fireEvent.change(within(region).getByLabelText('To'), { target: { value: 'R3' } });
    fireEvent.click(compare);
    await within(region).findByText('Title');
    expect([...region.querySelectorAll('del')].map((node) => node.textContent)).toEqual(['synthetic journal_entry']);
    expect([...region.querySelectorAll('ins')].map((node) => node.textContent)).toEqual(['retitled entry']);
    expect(region.textContent).toContain('Entry Section 1');
    expect(region.textContent).toContain('Label added: Quote on characters 1 to 6 (Book)');
    expect(region.textContent).toContain('Order of the Entry Sections');
    expect(region.textContent).toContain('S1, S2 → S2');
    expect(region.textContent).toContain('Private → Public');
  });

  it('says when nothing differs and names removed Entry Sections', () => {
    renderScreen(<Comparison item={ITEM} differences={[]} order={[]} />, { client: fakeApi({}).client });
    expect(screen.getByText('Nothing differs between these two points.')).toBeTruthy();
    expect(fieldLabel(ITEM, 'sections.gone', ['S2'])).toBe('A removed Entry Section');
    expect(fieldLabel(ITEM, 'phaseId')).toBe('Phase');
    expect(fieldLabel(ITEM, 'withdrawnAt')).toBe('Withdrawn on');
    expect(fieldLabel(ITEM, 'unknownField')).toBe('unknownField');
    expect(plainValue('withdrawnAt', '2026-10-27T18:00:00.000Z')).toBe('2026-10-27 18:00 UTC');
    expect(plainValue('x', null)).toBe('none');
    expect(plainValue('x', { a: 1 })).toBe('{"a":1}');
  });
});

describe('the withdrawal dialog', () => {
  it('states whether the Public Site will show the reason before withdrawing (R22.6, R24.10)', async () => {
    const api = fakeApi({
      [`GET /items/${ITEM.id}`]: { item: ITEM },
      [`POST /items/${ITEM.id}/withdraw`]: (call) => ((call.body as { confirm?: unknown }).confirm === undefined
        ? { withdrawn: false, preview: { reasonPublic: true } } : { withdrawn: true, preview: { reasonPublic: true }, item: ITEM }),
    });
    renderScreen(<WithdrawPage id={ITEM.id} />, { client: api.client });
    const dialog = await screen.findByRole('dialog', { name: 'Withdraw' });
    fireEvent.change(within(dialog).getByLabelText(/^Reason for withdrawing/u), { target: { value: 'Synthetic reason.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(await within(dialog).findByText(publicReasonStatement(true))).toBeTruthy();
    expect(publicReasonStatement(true)).toMatch(/^The Public Site shows this record, so it will show/u);
    expect(publicReasonStatement(false)).toMatch(/^The Public Site does not show this record, so it will not show this reason\./u);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw' }));
    await screen.findByText('The record was withdrawn.');
    expect(api.writes().map((call) => call.body)).toEqual([
      { rev: ITEM.rev, reason: 'Synthetic reason.' },
      { rev: ITEM.rev, reason: 'Synthetic reason.', confirm: { reasonPublic: true } },
    ]);
  });

  it('checks again after a changed reason or a stale preview, and shows reason errors', async () => {
    let previews = 0;
    const api = fakeApi({
      [`GET /items/${ITEM.id}`]: { item: ITEM },
      [`POST /items/${ITEM.id}/withdraw`]: (call) => {
        const body = call.body as { reason: string; confirm?: unknown };
        if (body.reason === '') return failure(422, 'validation', { fields: [{ field: 'reason', rule: 'Give a reason of 1 to 1,000 characters.' }] });
        if (body.confirm !== undefined) return failure(409, 'preview_stale', { details: { reasonPublic: true } });
        previews += 1;
        return { withdrawn: false, preview: { reasonPublic: false } };
      },
    });
    renderScreen(<WithdrawPage id={ITEM.id} />, { client: api.client });
    const dialog = await screen.findByRole('dialog', { name: 'Withdraw' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(await within(dialog).findByText('Give a reason of 1 to 1,000 characters.')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(/^Reason for withdrawing/u), { target: { value: 'First.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(await within(dialog).findByText(publicReasonStatement(false))).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(/^Reason for withdrawing/u), { target: { value: 'Second.' } });
    expect(within(dialog).queryByText(publicReasonStatement(false))).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await within(dialog).findByRole('button', { name: 'Withdraw' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw' }));
    expect(await within(dialog).findByText('The record’s disclosure changed. Check the statement again.')).toBeTruthy();
    expect(within(dialog).getByText(publicReasonStatement(true))).toBeTruthy();
    expect(previews).toBe(2);
  });

  it('says when the record is already withdrawn', async () => {
    const withdrawn = makeItem({ ...ITEM, withdrawal: { at: '2026-10-27T18:00:00.000Z', by: { id: MEMBER_ID, displayName: 'Ada Example' }, reason: 'Done.' } });
    renderScreen(<WithdrawPage id={ITEM.id} />, { client: fakeApi({ [`GET /items/${ITEM.id}`]: { item: withdrawn } }).client });
    expect(await screen.findByText('This record is already withdrawn.')).toBeTruthy();
  });
});

describe('the deletion confirmation', () => {
  it('asks an Administrator to type the Item Identifier and give a reason (R22.7)', async () => {
    const api = fakeApi({ [`GET /items/${ITEM.id}`]: { item: ITEM }, [`DELETE /items/${ITEM.id}`]: json202() });
    renderScreen(<DeletePage id={ITEM.id} />, { client: api.client, administrator: true });
    const dialog = await screen.findByRole('dialog', { name: 'Delete permanently' });
    expect(dialog.textContent).toContain('cannot be undone');
    expect(dialog.textContent).toContain('within 24 hours');
    const button = within(dialog).getByRole('button', { name: 'Delete permanently' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/^Type the Item Identifier/u), { target: { value: ' rf-0001 ' } });
    fireEvent.change(within(dialog).getByLabelText(/^Reason for the deletion/u), { target: { value: 'Synthetic.' } });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await screen.findByText('The record was permanently deleted.');
    expect(api.writes()).toMatchObject([{ method: 'DELETE', body: { identifier: ' rf-0001 ', reason: 'Synthetic.' } }]);
  });

  it('shows reason errors and refuses Members without the Permission', async () => {
    const api = fakeApi({ [`GET /items/${ITEM.id}`]: { item: ITEM }, [`DELETE /items/${ITEM.id}`]: failure(422, 'validation', { fields: [{ field: 'reason', rule: 'Give a reason.' }] }) });
    const admin = renderScreen(<DeletePage id={ITEM.id} />, { client: api.client, administrator: true });
    const dialog = await screen.findByRole('dialog', { name: 'Delete permanently' });
    fireEvent.change(within(dialog).getByLabelText(/^Type the Item Identifier/u), { target: { value: 'RF-0001' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));
    expect(await within(dialog).findByText('Give a reason.')).toBeTruthy();
    admin.unmount();
    renderScreen(<DeletePage id={ITEM.id} />, { client: api.client });
    expect(screen.getByText('Only Administrators delete records permanently.')).toBeTruthy();
  });

  it('shows the Deletion record in a deleted Item’s place', async () => {
    const deletion = { kind: 'finding', identifier: 'RF-0002', deletedBy: { id: OTHER_ID, displayName: 'Ben Sample' }, deletedAt: '2026-10-27T18:00:00.000Z', reason: 'Synthetic.' };
    const api = fakeApi({ [`GET /items/${ITEM.id}`]: failure(404, 'not_found', { details: { deletion } }), 'GET /value-sets': { valueSets: {} }, 'GET /parties': { parties: [] }, 'GET /members': { members: [] } });
    renderScreen(<ItemPage id={ITEM.id} />, { client: api.client });
    expect(await screen.findByText('This Finding was permanently deleted on 2026-10-27 18:00 UTC.')).toBeTruthy();
    expect(screen.getByText('RF-0002')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Ben Sample' }).getAttribute('href')).toBe(`/members/${OTHER_ID}`);
    expect(screen.getByText('Synthetic.')).toBeTruthy();
    const page = renderScreen(<DeletePage id={ITEM.id} />, { client: api.client, administrator: true });
    await waitFor(() => expect(page.container.textContent).toContain('This Finding was permanently deleted'));
    page.unmount();
    renderScreen(<DeletedItem deletion={{ ...deletion, kind: 'journal_entry' }} />, { client: api.client });
    expect(screen.getByText(/This Journal entry was permanently deleted/u)).toBeTruthy();
  });
});

describe('the item page actions', () => {
  it('links to the history, the withdrawal, and, for Administrators, the deletion', async () => {
    const api = fakeApi({
      [`GET /items/${ITEM.id}`]: { item: { ...ITEM, kind: 'finding', statusValueId: BUILT_IN_VALUE_IDS.findingOpen } },
      'GET /value-sets': { valueSets: {} }, 'GET /parties': { parties: [] }, 'GET /members': { members: [] },
      'GET /links': { entries: [], next: null },
    });
    const member = renderScreen(<ItemPage id={ITEM.id} />, { client: api.client });
    await screen.findByRole('link', { name: 'History' });
    expect(screen.getByRole('link', { name: 'History' }).getAttribute('href')).toBe(`/items/${ITEM.id}/history`);
    expect(screen.getByRole('link', { name: 'Withdraw' }).getAttribute('href')).toBe(`/items/${ITEM.id}/withdraw`);
    expect(screen.queryByRole('link', { name: 'Delete permanently' })).toBeNull();
    member.unmount();
    renderScreen(<ItemPage id={ITEM.id} />, { client: api.client, administrator: true });
    expect((await screen.findByRole('link', { name: 'Delete permanently' })).getAttribute('href')).toBe(`/items/${ITEM.id}/delete`);
  });
});

function json202(): Response {
  return new Response(JSON.stringify({ deletion: { jobId: 'J1' } }), { status: 202, headers: { 'Content-Type': 'application/json' } });
}
