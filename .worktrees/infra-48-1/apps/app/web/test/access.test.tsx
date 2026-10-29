import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ACCESS_STATEMENT, ROLE_IDS } from '@researchforce/domain/permissions';
import { AccessSummary, BulkAccess, listable } from '../src/access/access';
import { describeAccess, HistoryList } from '../src/history/history';
import { CreateItemForm } from '../src/items/forms/ItemForm';
import type { AccessPreviewView, AccessView, HistoryEntry } from '../src/types';
import { failure, fakeApi, json, makeMe, MEMBER_ID, OTHER_ID, renderScreen } from './helpers';
import { FORM_DATA, makeItem, MEMBERS, PROJECT } from './fixtures';

const ADA = { id: MEMBER_ID, displayName: 'Ada Example' };
const BEN = { id: OTHER_ID, displayName: 'Ben Sample' };
const PENDING = '01J00000000000000000000004';
const restricted = (members: AccessView['members'] = []): AccessView => ({ level: 'restricted', members, statement: ACCESS_STATEMENT });
const ITEM = makeItem({ kind: 'finding', access: restricted([BEN]) });
const PREVIEW: AccessPreviewView = {
  items: [{ id: ITEM.id, identifier: ITEM.identifier, title: ITEM.title, changed: true, from: { level: 'whole_team', members: [] }, to: { level: 'restricted', members: [BEN] } }],
  gaining: [], resets: [{ unitId: ITEM.id, rootId: ITEM.id, unitType: 'research_item', identifier: ITEM.identifier, title: ITEM.title, level: 'public' }],
  statement: ACCESS_STATEMENT, confirmation: 'c1',
};
const radio = (dialog: HTMLElement, name: string) => within(dialog).getByRole('radio', { name });

describe('the access fields of a new Research_Item', () => {
  it('sends Whole_Team by default, and Restricted with the chosen Pending or Active Members (R47.1, R47.2)', async () => {
    const api = fakeApi({ 'POST /items/finding': json({ item: { id: 'NEW' } }, 201) });
    renderScreen(<CreateItemForm kind="finding" choice={{ projects: [PROJECT], preselected: PROJECT.id }} data={FORM_DATA} />, { client: api.client });
    const region = screen.getByRole('region', { name: 'Who can read' });
    expect(region.textContent).toContain(ACCESS_STATEMENT);
    expect(within(region).queryByRole('group', { name: 'Access list' })).toBeNull();
    fireEvent.click(within(region).getByRole('radio', { name: 'Restricted' }));
    const list = within(region).getByRole('group', { name: 'Access list' });
    expect(within(list).getAllByRole('checkbox').map((box) => box.parentElement!.textContent)).toEqual(['Ben Sample', `${PENDING.toLowerCase()}@example.test`]);
    fireEvent.click(within(list).getByRole('checkbox', { name: 'Ben Sample' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toMatchObject({ access: { level: 'restricted', members: [OTHER_ID] } });
  });

  it('offers every Pending or Active Member except the Owner', () => {
    expect(listable(MEMBERS, MEMBER_ID).map((member) => member.id)).toEqual([OTHER_ID, PENDING]);
  });
});

describe('who can read an item', () => {
  it('shows the Restricted mark, the Owner, the Access_List, and who can always read (R47.11)', () => {
    renderScreen(<AccessSummary item={ITEM} members={MEMBERS} onChanged={() => undefined} />, { client: fakeApi({}).client });
    const region = screen.getByRole('region', { name: 'Who can read' });
    expect(within(region).getByText('Restricted')).toBeTruthy();
    expect(within(region).getByRole('link', { name: 'Ada Example' })).toBeTruthy();
    expect(region.textContent).toContain('Access list: Ben Sample.');
    expect(region.textContent).toContain(ACCESS_STATEMENT);
  });

  it('offers the change to the Owner and Administrators only', () => {
    const owned = renderScreen(<AccessSummary item={ITEM} members={MEMBERS} onChanged={() => undefined} />, { client: fakeApi({}).client });
    expect(screen.getByRole('button', { name: 'Change who can read' })).toBeTruthy();
    owned.unmount();
    const other = makeMe({ member: { id: OTHER_ID, roleId: ROLE_IDS.contributor } });
    const colleague = renderScreen(<AccessSummary item={ITEM} members={MEMBERS} onChanged={() => undefined} />, { client: fakeApi({}).client, me: other });
    expect(screen.queryByRole('button', { name: 'Change who can read' })).toBeNull();
    colleague.unmount();
    renderScreen(<AccessSummary item={ITEM} members={MEMBERS} onChanged={() => undefined} />, { client: fakeApi({}).client, me: makeMe({ member: { id: OTHER_ID, roleId: ROLE_IDS.administrator } }) });
    expect(screen.getByRole('button', { name: 'Change who can read' })).toBeTruthy();
  });

  it('previews the change, then applies it with the preview’s confirmation (R47.7, R47.8)', async () => {
    const open = makeItem({ kind: 'finding' });
    let changed = 0;
    const api = fakeApi({ [`POST /items/${open.id}/access/preview`]: PREVIEW, [`POST /items/${open.id}/access`]: { access: PREVIEW, item: open } });
    renderScreen(<AccessSummary item={open} members={MEMBERS} onChanged={() => { changed += 1; }} />, { client: api.client });
    expect(screen.getByText('Every Member of the team can read this record.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Change who can read' }));
    const dialog = screen.getByRole('dialog', { name: 'Change who can read' });
    expect((within(dialog).getByRole('button', { name: 'Confirm the change' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(radio(dialog, 'Restricted'));
    fireEvent.click(within(within(dialog).getByRole('group', { name: 'Add to the Access list' })).getByRole('checkbox', { name: 'Ben Sample' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check what this changes' }));
    const preview = await within(dialog).findByRole('region', { name: 'What this change does' });
    expect(preview.textContent).toContain('RF-0001 A synthetic record: Whole team → Restricted, Access list: Ben Sample');
    expect(preview.textContent).toContain('These would become Not published, and their public pages would be removed:');
    expect(preview.textContent).toContain('RF-0001 A synthetic record (Public)');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm the change' }));
    await waitFor(() => expect(changed).toBe(1));
    expect(api.writes().map((call) => call.body)).toEqual([
      { level: 'restricted', add: [OTHER_ID] }, { level: 'restricted', add: [OTHER_ID], confirmation: 'c1' },
    ]);
  });

  it('shows a fresh preview when the confirmation is stale, and a refused change cannot be confirmed', async () => {
    let applies = 0;
    const api = fakeApi({
      [`POST /items/${ITEM.id}/access/preview`]: { ...PREVIEW, gaining: [ADA] },
      [`POST /items/${ITEM.id}/access`]: (call) => {
        applies += 1;
        return (call.body as { confirmation?: string }).confirmation === 'c2' ? { access: PREVIEW, item: ITEM } : failure(409, 'preview_stale', { details: { preview: { ...PREVIEW, confirmation: 'c2' } } });
      },
    });
    renderScreen(<AccessSummary item={ITEM} members={MEMBERS} onChanged={() => undefined} />, { client: api.client });
    fireEvent.click(screen.getByRole('button', { name: 'Change who can read' }));
    const dialog = screen.getByRole('dialog', { name: 'Change who can read' });
    expect(within(within(dialog).getByRole('group', { name: 'Remove from the Access list' })).getAllByRole('checkbox').map((box) => box.parentElement!.textContent)).toEqual(['Ben Sample']);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check what this changes' }));
    expect((await within(dialog).findByRole('region', { name: 'What this change does' })).textContent).toContain('These Members would gain read access: Ada Example.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm the change' }));
    expect(await within(dialog).findByText('Something changed since you checked. Check what the change does again before confirming.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm the change' }));
    await waitFor(() => expect(applies).toBe(2));
    expect(api.writes().at(-1)!.body).toMatchObject({ confirmation: 'c2' });
  });

  it('names the reason a change is refused and keeps it from being confirmed', async () => {
    const refusal = { ...PREVIEW, items: [{ ...PREVIEW.items[0]!, refusal: 'Only its Owner can let more Members read this item.' }] };
    const api = fakeApi({ [`POST /items/${ITEM.id}/access/preview`]: refusal });
    renderScreen(<AccessSummary item={ITEM} members={MEMBERS} onChanged={() => undefined} />, { client: api.client, administrator: true });
    fireEvent.click(screen.getByRole('button', { name: 'Change who can read' }));
    const dialog = screen.getByRole('dialog', { name: 'Change who can read' });
    fireEvent.click(radio(dialog, 'Whole team'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check what this changes' }));
    expect(await within(dialog).findByText('This change cannot be made, so it applies to none of the records.')).toBeTruthy();
    expect(dialog.textContent).toContain('Only its Owner can let more Members read this item.');
    expect((within(dialog).getByRole('button', { name: 'Confirm the change' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('bulk access changes', () => {
  it('sends the chosen records with the change and its confirmation (R47.14)', async () => {
    let done = 0;
    const api = fakeApi({ 'POST /access/bulk/preview': PREVIEW, 'POST /access/bulk': { access: PREVIEW } });
    renderScreen(<BulkAccess itemIds={['A', 'B']} members={MEMBERS} onDone={() => { done += 1; }} />, { client: api.client });
    expect(screen.getByText('2 records chosen.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Change who can read the chosen records' }));
    const dialog = screen.getByRole('dialog', { name: 'Change who can read the chosen records' });
    expect((radio(dialog, 'Keep each record’s level') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(radio(dialog, 'Restricted'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check what this changes' }));
    await within(dialog).findByRole('region', { name: 'What this change does' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm the change' }));
    await waitFor(() => expect(done).toBe(1));
    expect(api.writes().map((call) => call.body)).toEqual([{ itemIds: ['A', 'B'], level: 'restricted' }, { itemIds: ['A', 'B'], level: 'restricted', confirmation: 'c1' }]);
  });

  it('refuses more than 1,000 records and shows nothing when none is chosen', () => {
    const many = renderScreen(<BulkAccess itemIds={Array.from({ length: 1001 }, (_, index) => String(index))} members={MEMBERS} onDone={() => undefined} />, { client: fakeApi({}).client });
    expect(screen.getByText('Choose at most 1,000 records for one change.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Change who can read the chosen records' }) as HTMLButtonElement).disabled).toBe(true);
    many.unmount();
    const none = renderScreen(<BulkAccess itemIds={[]} members={MEMBERS} onDone={() => undefined} />, { client: fakeApi({}).client });
    expect(none.container.textContent).toBe('/');
  });
});

describe('Access_Changes in the history', () => {
  it('lists the level and list before and after (R47.6)', () => {
    const entry: HistoryEntry = {
      id: 'R1', kind: 'access_change', memberId: MEMBER_ID, displayName: 'Ada Example', at: '2026-10-27T18:00:00.000Z', reason: null, restoredPoint: null, sectionId: null,
      fields: ['accessLevel', 'accessMembers'], access: { before: { level: 'whole_team', members: [] }, after: { level: 'restricted', members: [BEN] } },
    };
    renderScreen(<HistoryList item={ITEM} entries={[entry]} selected={undefined} onSelect={() => undefined} />, { client: fakeApi({}).client });
    const item = screen.getByRole('listitem');
    expect(item.querySelector('p')!.textContent).toBe('Access change by Ada Example at 2026-10-27 18:00 UTC');
    expect(item.textContent).toContain('Before: Whole team. After: Restricted, Access list: Ben Sample.');
    expect(item.textContent).toContain('Changed: Who can read, Access list');
    expect(describeAccess({ level: 'restricted', members: [{ id: 'X', displayName: null }] })).toBe('Restricted, Access list: a Member without a display name');
  });
});
