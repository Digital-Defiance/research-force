import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { CreateItemForm } from '../src/items/forms/ItemForm';
import { ItemDetails } from '../src/items/page';
import { draftsToApi, ReviewList, ReviewQueuePage, ReviewRequestForm, reviewOptions, targetLink } from '../src/reviews/reviews';
import { sessionFor } from '../src/session';
import type { ReviewView } from '../src/types';
import { BUILT_IN, failure, fakeApi, json, makeMe, MEMBER_ID, OTHER_ID, renderScreen, SPECIALTY_ID } from './helpers';
import { FORM_DATA, makeItem, MEMBERS, PARTY, PROJECT, rich, VALUE_SETS } from './fixtures';

const ITEM_ID = '01J0000000000000000000IT01';
const ada = { id: MEMBER_ID, displayName: 'Ada Example' };
const ben = { id: OTHER_ID, displayName: 'Ben Sample' };
function review(id: string, extra: Partial<ReviewView> = {}): ReviewView {
  return {
    id, target: { id: ITEM_ID, type: 'research_item', rootId: ITEM_ID, identifier: 'RF-0001', title: 'A synthetic record' }, state: 'needs_review',
    requester: ben, addressees: [{ type: 'member', id: MEMBER_ID, name: 'Ada Example' }], note: 'Please check the dates.', createdAt: '2026-10-20T10:00:00.000Z',
    isPublicationRequest: false, ...extra,
  };
}
const OPTIONS = reviewOptions(sessionFor(makeMe(), BUILT_IN, () => undefined), MEMBERS);
const articles = () => screen.getAllByRole('article');

describe('review options and eligibility', () => {
  it('offer active Members other than the requester, Specialties that are not retired, and every Role', () => {
    expect(OPTIONS.members).toEqual([{ id: OTHER_ID, name: 'Ben Sample' }]);
    expect(OPTIONS.specialties.map((specialty) => specialty.name)).toEqual(['Historian', 'Cryptanalysis']);
    expect(OPTIONS.roles.map((role) => role.id)).toContain(ROLE_IDS.administrator);
  });

  it('turn drafts into the Submission’s requests, with the section index and a non-blank note only', () => {
    expect(draftsToApi([
      { section: '', addressees: { memberIds: [OTHER_ID], specialtyIds: [], roleIds: [] }, note: ' ' },
      { section: '1', addressees: { memberIds: [], specialtyIds: [SPECIALTY_ID], roleIds: [] }, note: 'The second section.' },
    ])).toEqual([
      { memberIds: [OTHER_ID], specialtyIds: [], roleIds: [] },
      { section: 1, memberIds: [], specialtyIds: [SPECIALTY_ID], roleIds: [], note: 'The second section.' },
    ]);
  });

  it('link each target to its Item, at the Entry_Section when it names one', () => {
    expect(targetLink(review('R'))).toEqual({ to: `/items/${ITEM_ID}`, name: 'Record RF-0001: A synthetic record' });
    expect(targetLink(review('R', { target: { id: 'SEC', type: 'entry_section', rootId: ITEM_ID, identifier: 'RF-0001', title: 'An entry' } })))
      .toEqual({ to: `/items/${ITEM_ID}#section-SEC`, name: 'Entry Section of RF-0001: An entry' });
    expect(targetLink(review('R', { target: { id: 'ATT', type: 'attachment', rootId: ITEM_ID, identifier: 'RF-0002', title: 'A scan' } })))
      .toEqual({ to: `/items/${ITEM_ID}`, name: 'Attachment RF-0002: A scan' });
  });
});

describe('the request list', () => {
  const reviews = [
    review('OPEN'),
    review('ROLE', { addressees: [{ type: 'role', id: ROLE_IDS.administrator, name: 'Administrator' }, { type: 'specialty', id: 'S9', name: 'Cryptanalysis' }], note: null }),
    review('MINE', { requester: ada, addressees: [{ type: 'member', id: MEMBER_ID, name: 'Ada Example' }, { type: 'role', id: ROLE_IDS.contributor, name: 'Contributor' }] }),
    review('HELD', { target: { id: 'SEC2', type: 'entry_section', rootId: ITEM_ID, identifier: 'RF-0001', title: 'A synthetic record' }, addressees: [{ type: 'specialty', id: SPECIALTY_ID, name: 'Historian' }] }),
    review('DONE', { state: 'reviewed', reviewer: ada, reviewedAt: '2026-10-21T09:30:00.000Z', reviewNote: 'Dates match.', outcome: null }),
    review('PUB', { isPublicationRequest: true, state: 'reviewed', reviewer: ada, reviewedAt: '2026-10-22T09:30:00.000Z', reviewNote: null, outcome: 'declined' }),
    review('CONTRIB', { addressees: [{ type: 'role', id: ROLE_IDS.contributor, name: 'Contributor' }] }),
    review('PUBOPEN', { isPublicationRequest: true }),
  ];

  it('shows every request in either state with requester, addressees, note, time, and the review (R17.11)', () => {
    renderScreen(<ReviewList reviews={reviews} sectionNumber={(id) => (id === 'SEC2' ? 2 : undefined)} onChanged={() => undefined} />, { client: fakeApi({}).client });
    const [open, role, , held, done, publication] = articles();
    expect(open!.textContent).toBe('Needs review This recordRequested by Ben Sample on 2026-10-20 10:00 UTCAddressed to: Ada Example (Member)Please check the dates.Review noteOptional; at most 2,000 characters.Mark reviewed');
    expect(role!.textContent).toContain('Addressed to: Administrator (Role), Cryptanalysis (Specialty)');
    expect(held!.textContent).toContain('Entry Section 2');
    expect(done!.textContent).toBe('Reviewed This recordRequested by Ben Sample on 2026-10-20 10:00 UTCAddressed to: Ada Example (Member)Please check the dates.Reviewed by Ada Example on 2026-10-21 09:30 UTCDates match.');
    expect(publication!.textContent).toContain('Publication request');
    expect(publication!.textContent).toContain('Outcome: Declined');
  });

  it('offers Mark reviewed only to Eligible_Reviewers of open, ordinary requests (R17.4, R17.5)', () => {
    renderScreen(<ReviewList reviews={reviews} sectionNumber={() => undefined} onChanged={() => undefined} />, { client: fakeApi({}).client });
    expect(articles().map((article) => within(article).queryByRole('button', { name: 'Mark reviewed' }) !== null)).toEqual([true, false, false, true, false, false, true, false]);
    expect(articles()[3]!.textContent).toContain('A removed Entry Section');
  });

  it('marks a request Reviewed with a note, and states why a refusal applies (R17.10)', async () => {
    const changes: number[] = [];
    const api = fakeApi({
      'POST /reviews/OPEN/complete': json({ completed: true }),
      'POST /reviews/HELD/complete': failure(422, 'rule', { details: { rule: 'reviewed', message: 'This Review Request is already Reviewed.' } }),
    });
    renderScreen(<ReviewList reviews={reviews} sectionNumber={() => 2} onChanged={() => changes.push(1)} />, { client: api.client });
    const [open, , , held] = articles();
    fireEvent.change(within(open!).getByLabelText(/Review note/u), { target: { value: 'Looks right.' } });
    fireEvent.click(within(open!).getByRole('button', { name: 'Mark reviewed' }));
    await waitFor(() => expect(changes).toHaveLength(1));
    fireEvent.click(within(held!).getByRole('button', { name: 'Mark reviewed' }));
    await within(held!).findByText('This Review Request is already Reviewed.');
    expect(api.writes().map((call) => [call.path, call.body])).toEqual([['/reviews/OPEN/complete', { note: 'Looks right.' }], ['/reviews/HELD/complete', {}]]);
    expect(changes).toHaveLength(1);
  });

  it('says when no review has been requested', () => {
    const view = renderScreen(<ReviewList reviews={[]} sectionNumber={() => undefined} onChanged={() => undefined} />, { client: fakeApi({}).client });
    expect(view.container.textContent).toContain('No review has been requested.');
  });
});

describe('the review request form', () => {
  const targets = [{ value: ITEM_ID, label: 'The whole record' }, { value: 'SEC1', label: 'Entry Section 1' }];

  it('asks Members, Specialties, and Roles in any combination to review the Item or an Entry_Section (R17.1, R17.2)', async () => {
    const changes: number[] = [];
    const api = fakeApi({ 'POST /reviews': json({ review: { id: 'NEW' } }, 201) });
    renderScreen(<ReviewRequestForm targets={targets} options={OPTIONS} onRequested={() => changes.push(1)} />, { client: api.client });
    fireEvent.change(screen.getByLabelText(/What to review/u), { target: { value: 'SEC1' } });
    fireEvent.click(screen.getByLabelText('Ben Sample'));
    fireEvent.click(screen.getByLabelText('Historian'));
    fireEvent.click(screen.getByLabelText('Administrator'));
    fireEvent.change(screen.getByLabelText(/Request note/u), { target: { value: 'The second paragraph.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask for review' }));
    await waitFor(() => expect(changes).toHaveLength(1));
    expect(api.writes()[0]!.body).toEqual({ targetId: 'SEC1', memberIds: [OTHER_ID], specialtyIds: [SPECIALTY_ID], roleIds: [ROLE_IDS.administrator], note: 'The second paragraph.' });
    expect((screen.getByLabelText('Ben Sample') as HTMLInputElement).checked).toBe(false);
  });

  it('shows missing addressees and a request without an Eligible_Reviewer (R17.9)', async () => {
    const api = fakeApi({
      'POST /reviews': (call) => ((call.body as { memberIds: string[] }).memberIds.length === 0
        ? failure(422, 'validation', { fields: [{ field: 'memberIds', rule: 'Choose at least one Member, Specialty or Role as an addressee.' }] })
        : failure(422, 'rule', { details: { rule: 'no_eligible_reviewer', message: 'The addressees include no active Member other than you.' } })),
    });
    renderScreen(<ReviewRequestForm targets={targets.slice(0, 1)} options={OPTIONS} onRequested={() => undefined} />, { client: api.client });
    expect(screen.queryByLabelText(/What to review/u)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ask for review' }));
    expect(await screen.findByText('Choose at least one Member, Specialty or Role as an addressee.')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Ben Sample'));
    fireEvent.click(screen.getByRole('button', { name: 'Ask for review' }));
    expect(await screen.findByText('The addressees include no active Member other than you.')).toBeTruthy();
    expect((screen.getByLabelText('Ben Sample') as HTMLInputElement).checked).toBe(true);
  });
});

describe('the review queue', () => {
  it('lists the requests waiting for the Member, oldest first, with links to the Item or Entry_Section (R17.8)', async () => {
    const section = review('SEC', { target: { id: 'S2', type: 'entry_section', rootId: ITEM_ID, identifier: 'RF-0001', title: 'An entry' } });
    const api = fakeApi({ 'GET /reviews/queue': { reviews: [review('FIRST'), section] } });
    renderScreen(<ReviewQueuePage />, { client: api.client });
    await screen.findByRole('heading', { name: 'Review queue' });
    expect(screen.getAllByRole('link').filter((link) => link.getAttribute('href')?.startsWith('/items/')).map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Record RF-0001: A synthetic record', `/items/${ITEM_ID}`], ['Entry Section of RF-0001: An entry', `/items/${ITEM_ID}#section-S2`],
    ]);
    expect(articles()[0]!.textContent).toContain('Requested by Ben Sample on 2026-10-20 10:00 UTC');
    expect(articles()[0]!.textContent).toContain('Please check the dates.');
  });

  it('says when nothing is waiting', async () => {
    renderScreen(<ReviewQueuePage />, { client: fakeApi({ 'GET /reviews/queue': { reviews: [] } }).client });
    expect(await screen.findByText('No Review Requests are waiting for you.')).toBeTruthy();
  });
});

describe('reviews on the item page', () => {
  it('marks the Item and each Entry_Section with a Needs_Review request and lists the requests (R17.7, R17.11)', () => {
    const item = makeItem({
      kind: 'journal_entry', pendingReview: true, reviews: [review('R1')],
      sections: [
        { id: 'S1', content: rich('First.'), rev: 1, disclosure: { level: 'private', effective: 'private' }, pendingReview: false },
        { id: 'S2', content: rich('Second.'), rev: 1, disclosure: { level: 'private', effective: 'private' }, pendingReview: true },
      ],
    });
    const view = renderScreen(<ItemDetails data={{ item, valueSets: VALUE_SETS, parties: [PARTY], members: MEMBERS, links: [], backlinks: [], thread: [] }} />, { client: fakeApi({}).client });
    expect(view.container.querySelector('header')!.textContent).toContain('Review pending');
    expect(screen.getByRole('region', { name: 'Entry Section 1' }).textContent).not.toContain('Review pending');
    expect(screen.getByRole('region', { name: 'Entry Section 2' }).textContent).toContain('Review pending');
    expect(screen.getByRole('region', { name: 'Entry Section 2' }).id).toBe('section-S2');
    const requests = screen.getByRole('region', { name: 'Review requests' });
    expect(within(requests).getAllByRole('article')).toHaveLength(1);
    expect([...(within(requests).getByLabelText(/What to review/u) as HTMLSelectElement).options].map((option) => option.textContent)).toEqual(['The whole record', 'Entry Section 1', 'Entry Section 2']);
  });

  it('shows no marker without a Needs_Review request', () => {
    const view = renderScreen(<ItemDetails data={{ item: makeItem({ kind: 'topic' }), valueSets: VALUE_SETS, parties: [], members: MEMBERS, links: [], backlinks: [], thread: [] }} />, { client: fakeApi({}).client });
    expect(view.container.textContent).not.toContain('Review pending');
  });
});

describe('review requests within a Submission', () => {
  const choice = { projects: [PROJECT], preselected: PROJECT.id };

  it('sends each request with the new Journal_Entry, naming the Entry_Section by its index (R17.1)', async () => {
    const api = fakeApi({ 'POST /items/journal-entry': json({ item: { id: 'NEW' } }, 201) });
    renderScreen(<CreateItemForm kind="journal_entry" choice={choice} data={FORM_DATA} />, { client: api.client });
    fireEvent.click(screen.getByRole('button', { name: 'Add a review request' }));
    const request = screen.getByRole('group', { name: 'Review request 1' });
    expect([...(within(request).getByLabelText(/What to review/u) as HTMLSelectElement).options].map((option) => option.textContent)).toEqual(['The whole record', 'Entry Section 1']);
    fireEvent.change(within(request).getByLabelText(/What to review/u), { target: { value: '0' } });
    fireEvent.click(within(request).getByLabelText('Ben Sample'));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toMatchObject({ reviews: [{ section: 0, memberIds: [OTHER_ID], specialtyIds: [], roleIds: [] }] });
  });

  it('shows the refusal of a request at that request, and removes a request', async () => {
    const api = fakeApi({
      'POST /items/finding': failure(422, 'validation', { fields: [
        { field: 'reviews.0', rule: 'The addressees include no active Member other than you.' }, { field: 'reviews.1.memberIds', rule: 'Choose at least one Member, Specialty or Role as an addressee.' },
      ] }),
    });
    renderScreen(<CreateItemForm kind="finding" choice={choice} data={FORM_DATA} />, { client: api.client });
    fireEvent.click(screen.getByRole('button', { name: 'Add a review request' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add a review request' }));
    expect(within(screen.getByRole('group', { name: 'Review request 1' })).queryByLabelText(/What to review/u)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await within(screen.getByRole('group', { name: 'Review request 1' })).findByText('The addressees include no active Member other than you.')).toBeTruthy();
    expect(within(screen.getByRole('group', { name: 'Review request 2' })).getByText('Choose at least one Member, Specialty or Role as an addressee.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove review request 2' }));
    expect(screen.queryByRole('group', { name: 'Review request 2' })).toBeNull();
  });
});
