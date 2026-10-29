import { describe, expect, it } from 'vitest';
import { GuardedBatch, GuardViolation } from '@researchforce/db/batch';
import { newULID } from '@researchforce/domain/identifiers';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { asULID } from '@researchforce/domain/types';
import type { ULID } from '@researchforce/domain/types';
import { NO_ELIGIBLE_REVIEWER, writeReview } from '../src/reviews/reviews';
import type { ReviewView } from '../src/reviews/reviews';
import { SPECIALTY, addMember } from './api';
import { errorOf, itemBody, itemWorld } from './items';
import type { ItemView, Who } from './items';
import { addElement, addItem, addSubmissionRow, deleteUnit } from './units';

const world = itemWorld();
const UNKNOWN = asULID('01J00000000000000000000000');

const place = async (who: Who, completed = true) => ({ projectId: world.projectId, ownerId: world.ids[who], submissionId: await addSubmissionRow(world.core(), world.ids[who], world.at, completed), now: world.at });
async function requestReview(who: Who, body: Record<string, unknown>): Promise<ULID> {
  const response = await world.request(who, 'POST', '/reviews', body);
  if (response.status !== 201) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json<{ review: { id: ULID } }>()).review.id;
}
async function queue(who: Who): Promise<ReviewView[]> {
  const response = await world.request(who, 'GET', '/reviews/queue');
  expect(response.status).toBe(200);
  return (await response.json<{ reviews: ReviewView[] }>()).reviews;
}
const reviewsOf = (item: ItemView) => item['reviews'] as ReviewView[];
const sectionsOf = (item: ItemView) => item['sections'] as { id: ULID; pendingReview: boolean }[];
const complete = (who: Who, id: string, body: Record<string, unknown> = {}) => world.request(who, 'POST', `/reviews/${id}/complete`, body);
const nameOf = (id: ULID) => `Member ${id}`;

describe('POST /reviews', () => {
  it('records a Needs_Review request that the item page lists with its addressees and the pending-review marker', async () => {
    const item = await world.created('author', 'finding');
    const id = await requestReview('author', { targetId: item.id, memberIds: [world.ids.colleague], specialtyIds: [SPECIALTY], roleIds: [ROLE_IDS.administrator], note: 'Please check the caveat.' });
    const view = await world.view('colleague', item.id);
    expect(view['pendingReview']).toBe(true);
    expect(reviewsOf(view)).toEqual([{
      id, target: { id: item.id, type: 'research_item', rootId: item.id, identifier: item.identifier, title: item.title }, state: 'needs_review',
      requester: { id: world.ids.author, displayName: nameOf(world.ids.author) },
      addressees: [
        { type: 'member', id: world.ids.colleague, name: nameOf(world.ids.colleague) }, { type: 'specialty', id: SPECIALTY, name: 'Historian' },
        { type: 'role', id: ROLE_IDS.administrator, name: 'Administrator' },
      ],
      note: 'Please check the caveat.', createdAt: world.at, isPublicationRequest: false,
    }]);
  });

  it('marks the Entry_Section, not the Item, when a request names the section', async () => {
    const item = await world.created('author', 'journal_entry');
    const [, second] = sectionsOf(item);
    await requestReview('colleague', { targetId: second!.id, memberIds: [world.ids.author] });
    const view = await world.view('author', item.id);
    expect(view['pendingReview']).toBe(false);
    expect(sectionsOf(view).map((section) => section.pendingReview)).toEqual([false, true]);
    expect(reviewsOf(view).map((review) => review.target)).toEqual([{ id: second!.id, type: 'entry_section', rootId: item.id, identifier: item.identifier, title: item.title }]);
  });

  it('accepts withdrawn targets and Attachments, keeping the Attachment’s own identifier', async () => {
    const withdrawn = await addItem(world.core(), await place('author'), { withdrawn: true });
    const first = await requestReview('author', { targetId: withdrawn.id, memberIds: [world.ids.colleague] });
    await world.core().prepare("UPDATE review_requests SET created_at = '2026-10-27T17:00:00.000Z' WHERE id = ?1").bind(first).run();
    const item = await world.created('author', 'finding');
    const file = await addElement(world.core(), await place('author'), 'attachment', item.id, { title: 'A synthetic scan' });
    await requestReview('author', { targetId: file.id, roleIds: [ROLE_IDS.contributor] });
    expect(reviewsOf(await world.view('author', item.id))).toEqual([]);
    expect((await queue('colleague')).map((review) => review.target)).toEqual([
      { id: withdrawn.id, type: 'research_item', rootId: withdrawn.id, identifier: withdrawn.identifier, title: `Item ${withdrawn.id}` },
      { id: file.id, type: 'attachment', rootId: item.id, identifier: file.identifier, title: 'A synthetic scan' },
    ]);
  });

  it('refuses targets that are missing, deleted, unseen, or Replies', async () => {
    const item = await world.created('author', 'finding');
    const deleted = await addItem(world.core(), await place('author'));
    await deleteUnit(world.core(), deleted.id, world.ids.admin, world.at);
    const unseen = await addItem(world.core(), await place('colleague', false));
    const reply = await addElement(world.core(), await place('colleague'), 'reply', item.id);
    for (const targetId of [UNKNOWN, 'not-an-id', undefined, deleted.id, unseen.id, reply.id]) {
      expect(await errorOf(await world.request('author', 'POST', '/reviews', { targetId, memberIds: [world.ids.colleague] })))
        .toMatchObject({ status: 422, error: 'validation', fields: [{ field: 'targetId', rule: 'Choose an Item or Entry Section that exists.' }] });
    }
    expect(await world.core().prepare('SELECT count(*) AS n FROM review_requests').first('n')).toBe(0);
  });

  it('refuses unknown, inactive, retired, repeated, or missing addressees', async () => {
    const item = await world.created('author', 'finding');
    const revoked = await addMember(world.core(), 'gone@example.test', 'revoked', world.at);
    const cases: [Record<string, unknown>, string][] = [
      [{}, 'memberIds'], [{ memberIds: [], specialtyIds: [], roleIds: [] }, 'memberIds'], [{ memberIds: [revoked] }, 'memberIds.0'], [{ memberIds: [UNKNOWN] }, 'memberIds.0'],
      [{ specialtyIds: [UNKNOWN] }, 'specialtyIds.0'], [{ roleIds: [UNKNOWN] }, 'roleIds.0'], [{ memberIds: [world.ids.colleague, world.ids.colleague] }, 'memberIds.1'],
    ];
    for (const [addressees, field] of cases) {
      const error = await errorOf(await world.request('author', 'POST', '/reviews', { targetId: item.id, ...addressees }));
      expect(error.status).toBe(422);
      expect(error.fields?.map((issue) => issue.field)).toContain(field);
    }
    expect((await world.request('author', 'POST', '/reviews', { targetId: item.id, memberIds: [world.ids.colleague], extra: 1 })).status).toBe(422);
  });

  it('refuses targets under an Item whose deletion was requested, before the deletion job runs', async () => {
    const item = await world.created('author', 'journal_entry');
    const [section] = sectionsOf(item);
    const queued = await requestReview('author', { targetId: section!.id, memberIds: [world.ids.colleague] });
    expect((await queue('colleague')).map((review) => review.id)).toEqual([queued]);
    expect((await world.request('admin', 'DELETE', `/items/${item.id}`, { identifier: item.identifier, reason: 'Synthetic.' })).status).toBe(202);
    expect(await errorOf(await world.request('author', 'POST', '/reviews', { targetId: section!.id, memberIds: [world.ids.colleague] }))).toMatchObject({ status: 422, fields: [{ field: 'targetId' }] });
    expect(await queue('colleague')).toEqual([]);
  });

  it('refuses a request whose only possible reviewer is the requester', async () => {
    const item = await world.created('author', 'finding');
    await world.core().prepare('DELETE FROM profile_specialties WHERE member_id <> ?1').bind(world.ids.author).run();
    await addMember(world.core(), 'revoked@example.test', 'revoked', world.at);
    for (const addressees of [{ memberIds: [world.ids.author] }, { specialtyIds: [SPECIALTY] }]) {
      expect(await errorOf(await world.request('author', 'POST', '/reviews', { targetId: item.id, ...addressees })))
        .toMatchObject({ status: 422, error: 'rule', details: { rule: 'no_eligible_reviewer', message: NO_ELIGIBLE_REVIEWER } });
    }
    expect(await world.core().prepare('SELECT count(*) AS n FROM review_requests').first('n')).toBe(0);
  });

  it('guards the batch so no request is written once its last Eligible_Reviewer is gone', async () => {
    const item = await world.created('author', 'finding');
    const batch = new GuardedBatch(world.core(), { id: world.ids.author, now: world.at });
    writeReview(batch, { id: newULID(world.at), targetId: item.id, rootId: item.id, requesterId: world.ids.author, memberIds: [world.ids.author], specialtyIds: [], roleIds: [], scope: { rootId: item.id } }, world.at);
    await expect(batch.commit()).rejects.toThrow(GuardViolation);
    expect(await world.core().prepare('SELECT count(*) AS n FROM review_requests').first('n')).toBe(0);
  });
});

describe('Review_Requests within a Submission', () => {
  it('records requests for the new Item and for a submitted Entry_Section', async () => {
    const response = await world.create('author', 'journal_entry', itemBody('journal_entry', world.projectId, {
      reviews: [{ memberIds: [world.ids.colleague], note: 'Whole entry.' }, { section: 1, specialtyIds: [SPECIALTY] }],
    }));
    expect(response.status).toBe(201);
    const { item } = await response.json<{ item: ItemView }>();
    expect(item['pendingReview']).toBe(true);
    expect(sectionsOf(item).map((section) => section.pendingReview)).toEqual([false, true]);
    expect(reviewsOf(item).map((review) => [review.target.id, review.note])).toEqual(expect.arrayContaining([[item.id, 'Whole entry.'], [sectionsOf(item)[1]!.id, null]]));
  });

  it('keeps the whole Submission unsubmitted when a request is refused', async () => {
    const before = await world.core().prepare('SELECT count(*) AS n FROM units').first('n');
    const cases: [Record<string, unknown>[], string, string?][] = [
      [[{ memberIds: [world.ids.colleague] }, { memberIds: [world.ids.author] }], 'reviews.1', NO_ELIGIBLE_REVIEWER],
      [[{ section: 5, memberIds: [world.ids.colleague] }], 'reviews.0.section', 'Choose one of the Entry Sections in this Submission.'],
      [[{ section: 'first', memberIds: [world.ids.colleague] }], 'reviews.0.section'],
      [[{ memberIds: [UNKNOWN] }], 'reviews.0.memberIds.0'],
      [[{}], 'reviews.0.memberIds'],
    ];
    for (const [reviews, field, rule] of cases) {
      const error = await errorOf(await world.create('author', 'journal_entry', itemBody('journal_entry', world.projectId, { reviews })));
      expect(error.status).toBe(422);
      expect(error.fields).toContainEqual(rule === undefined ? expect.objectContaining({ field }) : { field, rule });
    }
    expect(await world.core().prepare('SELECT count(*) AS n FROM units').first('n')).toBe(before);
    expect(await world.core().prepare('SELECT count(*) AS n FROM review_requests').first('n')).toBe(0);
  });
});

describe('POST /reviews/{id}/complete', () => {
  it('lets an Eligible_Reviewer mark the request Reviewed once, with a note', async () => {
    const item = await world.created('author', 'finding');
    const id = await requestReview('author', { targetId: item.id, memberIds: [world.ids.colleague] });
    const response = await complete('colleague', id, { note: 'Looks right.' });
    expect(response.status).toBe(200);
    const view = await world.view('author', item.id);
    expect(view['pendingReview']).toBe(false);
    expect(reviewsOf(view)[0]).toMatchObject({
      state: 'reviewed', reviewer: { id: world.ids.colleague, displayName: nameOf(world.ids.colleague) }, reviewedAt: world.at, reviewNote: 'Looks right.', outcome: null,
    });
    expect(await errorOf(await complete('colleague', id))).toMatchObject({ status: 422, error: 'rule', details: { rule: 'reviewed' } });
  });

  it('refuses the requester, Members not addressed, former addressees, and unknown requests', async () => {
    const item = await world.created('author', 'finding');
    const id = await requestReview('author', { targetId: item.id, memberIds: [world.ids.author, world.ids.colleague], roleIds: [ROLE_IDS.administrator] });
    const forbidden = { status: 403, details: { rule: 'not_eligible', message: 'You are not an Eligible Reviewer of this Review Request.' } };
    expect(await errorOf(await complete('author', id))).toMatchObject(forbidden);
    await world.core().prepare('UPDATE members SET role_id = ?2 WHERE id = ?1').bind(world.ids.admin, ROLE_IDS.contributor).run();
    expect(await errorOf(await complete('admin', id))).toMatchObject(forbidden);
    expect((await complete('colleague', UNKNOWN)).status).toBe(404);
    expect((await complete('colleague', 'not-an-id')).status).toBe(404);
    expect((await complete('colleague', id, { note: 'x', extra: 1 })).status).toBe(422);
    expect(await world.core().prepare('SELECT state FROM review_requests WHERE id = ?1').bind(id).first('state')).toBe('needs_review');
  });

  it('accepts a Member eligible through a Specialty or Role', async () => {
    const item = await world.created('author', 'finding');
    const bySpecialty = await requestReview('author', { targetId: item.id, specialtyIds: [SPECIALTY] });
    const byRole = await requestReview('author', { targetId: item.id, roleIds: [ROLE_IDS.administrator] });
    expect((await complete('colleague', bySpecialty)).status).toBe(200);
    expect((await complete('admin', byRole)).status).toBe(200);
  });

  it('leaves a Publication_Request to its apply and decline actions', async () => {
    const item = await world.created('author', 'finding');
    const id = newULID(world.at);
    await world.core().prepare(`INSERT INTO review_requests (id, target_id, root_id, requester_id, created_at, is_publication_request, proposal, updated_seq)
      VALUES (?1, ?2, ?2, ?3, ?4, 1, '{}', 0)`).bind(id, item.id, world.ids.author, world.at).run();
    await world.core().prepare("INSERT INTO review_addressees (request_id, addressee_type, addressee_id) VALUES (?1, 'role', ?2)").bind(id, ROLE_IDS.administrator).run();
    expect(await errorOf(await complete('admin', id))).toMatchObject({ status: 422, error: 'rule', details: { rule: 'publication_request' } });
    expect(reviewsOf(await world.view('author', item.id))[0]).toMatchObject({ id, isPublicationRequest: true, state: 'needs_review' });
  });
});

describe('GET /reviews/queue', () => {
  it('lists the open requests the Member can review now, oldest first', async () => {
    const item = await world.created('author', 'finding');
    const other = await world.created('colleague', 'finding');
    const later = await requestReview('author', { targetId: item.id, memberIds: [world.ids.colleague] });
    const earlier = await requestReview('author', { targetId: other.id, roleIds: [ROLE_IDS.contributor] });
    const own = await requestReview('colleague', { targetId: item.id, memberIds: [world.ids.author] });
    const done = await requestReview('author', { targetId: item.id, memberIds: [world.ids.colleague] });
    await world.core().prepare("UPDATE review_requests SET created_at = '2026-10-27T17:00:00.000Z' WHERE id = ?1").bind(earlier).run();
    expect((await complete('colleague', done)).status).toBe(200);
    expect((await queue('colleague')).map((review) => review.id)).toEqual([earlier, later]);
    expect((await queue('author')).map((review) => review.id)).toEqual([own]);
    expect(await queue('admin')).toEqual([]);
  });

  it('leaves out requests on deleted or unseen targets and those the Member is no longer eligible for', async () => {
    const deleted = await addItem(world.core(), await place('author'));
    const visible = await world.created('author', 'finding');
    await requestReview('author', { targetId: deleted.id, memberIds: [world.ids.colleague] });
    const lost = await requestReview('author', { targetId: visible.id, roleIds: [ROLE_IDS.contributor] });
    await deleteUnit(world.core(), deleted.id, world.ids.admin, world.at);
    expect((await queue('colleague')).map((review) => review.id)).toEqual([lost]);
    await world.core().prepare('UPDATE members SET role_id = ?2 WHERE id = ?1').bind(world.ids.colleague, ROLE_IDS.administrator).run();
    expect(await queue('colleague')).toEqual([]);
    await world.core().prepare("UPDATE submissions SET completed_at = NULL WHERE id = (SELECT submission_id FROM units WHERE id = ?1)").bind(visible.id).run();
    await world.core().prepare('UPDATE members SET role_id = ?2 WHERE id = ?1').bind(world.ids.colleague, ROLE_IDS.contributor).run();
    expect(await queue('colleague')).toEqual([]);
  });
});
