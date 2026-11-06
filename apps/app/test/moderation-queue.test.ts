import { beforeEach, describe, expect, it } from 'vitest';
import { newULID } from '@researchforce/domain/identifiers';
import type { OutsideSubmissionType, ULID } from '@researchforce/domain/types';
import type { QueueEntry, QueuePage } from '../src/moderation/queue';
import { errorOf, itemWorld } from './items';
import type { Who } from './items';

const world = itemWorld();

interface SubmissionOptions {
  readonly type?: OutsideSubmissionType;
  readonly state?: 'queued' | 'more_information_requested' | 'accepted' | 'rejected';
  readonly projectId?: ULID | null;
  readonly name?: string;
  readonly email?: string | null;
  readonly affiliation?: string | null;
  readonly message?: string;
  readonly pageRef?: string | null;
  /** Receipt time; defaults to the world clock. */
  readonly receivedAt?: string;
  /** The scheduled Contact_Review due date; defaults to none. */
  readonly contactReviewDueAt?: string | null;
  /** When the Submitter_Contact was erased; defaults to none. */
  readonly emailErasedAt?: string | null;
}

let counter = 0;
/** Insert one Outside_Submission the way the rf-submit Worker stores it (no network address is ever kept). */
async function submission(options: SubmissionOptions = {}): Promise<ULID> {
  const id = newULID(world.at);
  counter += 1;
  const type = options.type ?? 'material';
  const licence = type === 'removal_request' ? null : 'Synthetic Licence 1.0';
  const email = options.email === undefined ? `submitter${counter}@example.test` : options.email;
  await world.core().prepare(
    `INSERT INTO outside_submissions (id, reference, type, project_id, message, name, email, affiliation, page_ref, licence_agreed, received_at, state, contact_review_due_at, email_erased_at, rev, updated_seq)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 1, 0)`,
  ).bind(
    id, `RS-TEST-${String(counter).padStart(4, '0')}`, type, options.projectId ?? null,
    options.message ?? 'A synthetic submission message.', options.name ?? 'Ada Lovelace', email,
    options.affiliation ?? null, options.pageRef ?? null, licence, options.receivedAt ?? world.at, options.state ?? 'queued',
    options.contactReviewDueAt ?? null, options.emailErasedAt ?? null,
  ).run();
  return id;
}

/** Insert an append-only Contact_Review row the way `recordContactReview` does. */
async function review(submissionId: ULID, action: 'keep' | 'erase', reason: string | null, at: string): Promise<void> {
  await world.core().prepare(
    'INSERT INTO contact_reviews (id, outside_submission_id, action, reason, admin_id, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
  ).bind(newULID(world.at), submissionId, action, reason, world.ids.admin, at).run();
}

/** Insert an append-only Submitter correction row the way `correctSubmitter` does. */
async function correction(submissionId: ULID, values: Record<string, unknown>): Promise<void> {
  await world.core().prepare(
    `INSERT INTO submitter_corrections (id, outside_submission_id, kind, erased, new_name, new_affiliation, new_email, prev_name, prev_affiliation, prev_email, admin_id, reason, at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
  ).bind(
    newULID(world.at), submissionId, values['kind'], values['erased'] ?? 0,
    values['newName'] ?? null, values['newAffiliation'] ?? null, values['newEmail'] ?? null,
    values['prevName'] ?? null, values['prevAffiliation'] ?? null, values['prevEmail'] ?? null,
    world.ids.admin, values['reason'], values['at'],
  ).run();
}

/** Attach a complete file to an Outside_Submission, optionally already deleted. */
async function file(submissionId: ULID, fileName: string, options: { deleted?: boolean } = {}): Promise<ULID> {
  const id = newULID(world.at);
  await world.core().prepare(
    `INSERT INTO outside_files (id, session_id, outside_submission_id, r2_key, file_name, size_bytes, sha256, state, created_at, deleted_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'complete', ?8, ?9)`,
  ).bind(id, newULID(world.at), submissionId, `outside/${id}`, fileName, 1234, '0'.repeat(64), world.at, options.deleted ? world.at : null).run();
  return id;
}

const queue = async (who: Who, path = '/moderation'): Promise<QueuePage> => {
  const response = await world.request(who, 'GET', path);
  if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return response.json<QueuePage>();
};
const ids = (page: QueuePage) => page.items.map((entry) => entry.id);
const entry = (page: QueuePage, id: ULID): QueueEntry => page.items.find((row) => row.id === id)!;
const setZone = (who: Who, zone: string) => world.core().prepare('UPDATE profiles SET time_zone = ?2 WHERE member_id = ?1').bind(world.ids[who], zone).run();

describe('Moderation_Queue (R32.1, R32.2, R32.17, R39.14, R46.20, R46.24)', () => {
  beforeEach(async () => {
    await world.core().batch([
      world.core().prepare('DELETE FROM contact_reviews'),
      world.core().prepare('DELETE FROM submitter_corrections'),
      world.core().prepare('DELETE FROM outside_files'),
      world.core().prepare('DELETE FROM outside_submissions'),
    ]);
    counter = 0;
  });

  it('shows the queue to every active Member, Contributor or Administrator (R2.8, R32.2)', async () => {
    await submission();
    // The queue uses the same active-Member read gate as every other list (R2.8); both Roles are allowed in.
    expect((await world.request('author', 'GET', '/moderation')).status).toBe(200);
    expect((await world.request('admin', 'GET', '/moderation')).status).toBe(200);
    // A request with no Access assertion is unauthenticated.
    expect((await world.request(undefined as never, 'GET', '/moderation')).status).toBe(401);
  });

  it('lists each Outside_Submission with its reference, type, Project or General, state, text, Submitter, files, and page, newest first', async () => {
    const general = await submission({ type: 'comment', name: 'Grace Hopper', affiliation: 'Navy', pageRef: '/p/one', projectId: null, receivedAt: '2026-10-20T10:00:00.000Z' });
    const inProject = await submission({ type: 'material', projectId: world.projectId, receivedAt: '2026-10-25T10:00:00.000Z' });
    const keptFile = await file(inProject, 'evidence.pdf');
    await file(inProject, 'gone.pdf', { deleted: true });

    const page = await queue('author');
    // Newest receipt first.
    expect(ids(page)).toEqual([inProject, general]);

    const g = entry(page, general);
    expect(g).toMatchObject({ type: 'comment', state: 'queued', projectId: null, projectName: null, text: 'A synthetic submission message.', pageRef: '/p/one' });
    expect(g.submitter).toEqual({ name: 'Grace Hopper', email: expect.stringContaining('@example.test'), affiliation: 'Navy' });
    expect(g.responseTarget).toBeNull();

    const m = entry(page, inProject);
    expect(m).toMatchObject({ type: 'material', projectId: world.projectId, projectName: expect.stringContaining('Synthetic project') });
    // Only files that still exist appear; a deleted file does not.
    expect(m.files.map((f) => f.fileName)).toEqual(['evidence.pdf']);
    expect(m.files[0]).toMatchObject({ id: keptFile, sizeBytes: 1234 });
  });

  it('never exposes a network address, which is not even stored (R46.20)', async () => {
    const id = await submission();
    const page = await queue('author');
    const serialized = JSON.stringify(entry(page, id));
    expect(serialized).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/u); // no IPv4
    expect(serialized.toLowerCase()).not.toContain('address');
    // The stored row has no column for it, so none can leak.
    const columns = (await world.core().prepare('PRAGMA table_info(outside_submissions)').all<{ name: string }>()).results.map((row) => row.name);
    expect(columns).not.toContain('ip');
    expect(columns).not.toContain('ip_address');
    expect(columns).not.toContain('network_address');
  });

  it('shows the receipt date and Response_Target end date (receipt plus 14 days) in the viewer’s zone with an overdue mark only while undecided (R46.24)', async () => {
    const correction = await submission({ type: 'correction', receivedAt: '2026-10-20T23:30:00.000Z' });
    const removal = await submission({ type: 'removal_request', email: null, receivedAt: '2026-10-01T23:30:00.000Z' });
    const material = await submission({ type: 'material', receivedAt: '2026-10-01T10:00:00.000Z' });

    const utc = await queue('author');
    // Material and Comment carry no Response_Target.
    expect(entry(utc, material).responseTarget).toBeNull();
    // Correction: 20 Oct + 14 days = 3 Nov; the world clock is 27 Oct, so it is not yet overdue.
    expect(entry(utc, correction).responseTarget).toEqual({ receivedOn: '2026-10-20', dueOn: '2026-11-03', overdue: false });
    // Removal_Request received 1 Oct is past 14 days and still queued, so it is overdue.
    expect(entry(utc, removal).responseTarget).toEqual({ receivedOn: '2026-10-01', dueOn: '2026-10-15', overdue: true });

    // The dates follow the viewer's zone: 23:30 UTC on 20 Oct is the 21st in Auckland.
    await setZone('author', 'Pacific/Auckland');
    const auckland = await queue('author');
    expect(entry(auckland, correction).responseTarget).toMatchObject({ receivedOn: '2026-10-21', dueOn: '2026-11-04' });
    expect(entry(auckland, correction).receiptTime).toMatch(/2026 \d{2}:\d{2}:\d{2} Pacific\/Auckland$/u);
  });

  it('stops marking a Correction overdue once it has a Moderation_Decision', async () => {
    const decided = await submission({ type: 'correction', state: 'accepted', receivedAt: '2026-10-01T10:00:00.000Z' });
    const asked = await submission({ type: 'correction', state: 'more_information_requested', receivedAt: '2026-10-01T10:00:00.000Z' });
    const open = await submission({ type: 'correction', state: 'queued', receivedAt: '2026-10-01T10:00:00.000Z' });
    const page = await queue('author');
    expect(entry(page, decided).responseTarget?.overdue).toBe(false);
    // More_Information_Requested IS a Moderation_Decision, so the overdue mark no longer applies (R46.24).
    expect(entry(page, asked).responseTarget?.overdue).toBe(false);
    expect(entry(page, open).responseTarget?.overdue).toBe(true);
  });

  it('shows no email once it has been erased', async () => {
    const id = await submission({ type: 'removal_request', email: null });
    expect(entry(await queue('author'), id).submitter.email).toBeNull();
  });

  it('filters by type, state, and Project or General as a conjunction (R39.14)', async () => {
    const generalComment = await submission({ type: 'comment', projectId: null, state: 'queued' });
    const projectMaterial = await submission({ type: 'material', projectId: world.projectId, state: 'accepted' });
    const projectCorrection = await submission({ type: 'correction', projectId: world.projectId, state: 'queued' });

    expect(ids(await queue('author', '/moderation?type=comment'))).toEqual([generalComment]);
    expect(ids(await queue('author', '/moderation?project=general'))).toEqual([generalComment]);
    expect(ids(await queue('author', `/moderation?project=${world.projectId}`)).sort()).toEqual([projectMaterial, projectCorrection].sort());
    expect(ids(await queue('author', `/moderation?project=${world.projectId}&state=queued`))).toEqual([projectCorrection]);
    expect(ids(await queue('author', `/moderation?project=${world.projectId}&type=material&state=accepted`))).toEqual([projectMaterial]);
    expect((await errorOf(await world.request('author', 'GET', '/moderation?type=nonsense'))).status).toBe(422);
    expect((await errorOf(await world.request('author', 'GET', '/moderation?state=nonsense'))).status).toBe(422);
    expect((await errorOf(await world.request('author', 'GET', '/moderation?project=garbage'))).status).toBe(422);
  });

  it('pages newest first without skipping or repeating an Outside_Submission', async () => {
    const all: ULID[] = [];
    for (let index = 0; index < 52; index += 1) {
      all.push(await submission({ receivedAt: new Date(Date.parse('2026-10-20T00:00:00.000Z') + index * 60_000).toISOString() }));
    }
    const first = await queue('author');
    expect(first.items).toHaveLength(50);
    expect(first.next).not.toBeNull();
    const rest = await queue('author', `/moderation?after=${encodeURIComponent(first.next!)}`);
    const seen = [...ids(first), ...ids(rest)];
    expect(new Set(seen).size).toBe(seen.length);
    for (const id of all) expect(seen, id).toContain(id);
    expect((await errorOf(await world.request('author', 'GET', '/moderation?after=garbage'))).status).toBe(422);
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;
const atDays = (days: number) => new Date(Date.parse(world.at) + days * DAY_MS).toISOString();

describe('Moderation_Queue Contact_Review state and history (R32.19, R32.20, R32.21, R32.22)', () => {
  beforeEach(async () => {
    await world.core().batch([
      world.core().prepare('DELETE FROM contact_reviews'),
      world.core().prepare('DELETE FROM submitter_corrections'),
      world.core().prepare('DELETE FROM outside_files'),
      world.core().prepare('DELETE FROM outside_submissions'),
    ]);
    counter = 0;
  });

  it('marks an Outside_Submission due for Contact_Review, and overdue once 30 days have passed (R32.19, R32.21)', async () => {
    const notYet = await submission({ state: 'accepted', contactReviewDueAt: atDays(5) });
    const due = await submission({ state: 'accepted', contactReviewDueAt: atDays(-5) });
    const overdue = await submission({ state: 'accepted', contactReviewDueAt: atDays(-31) });
    const none = await submission({ state: 'accepted', contactReviewDueAt: null });
    const page = await queue('author');
    // A due date still in the future shows no mark.
    expect(entry(page, notYet).contactReview).toBeNull();
    expect(entry(page, due).contactReview).toEqual({ dueOn: '2026-10-22', overdue: false });
    // 31 days past due is 30 days or more overdue.
    expect(entry(page, overdue).contactReview).toMatchObject({ overdue: true });
    expect(entry(page, none).contactReview).toBeNull();
  });

  it('shows no Contact_Review mark once the Submitter_Contact has been erased (R32.20)', async () => {
    // A due date left over but the contact erased: no review is due any more, so no mark.
    const erased = await submission({ state: 'accepted', email: null, emailErasedAt: world.at, contactReviewDueAt: atDays(-5) });
    expect(entry(await queue('author'), erased).contactReview).toBeNull();
  });

  it('filters to Outside_Submissions due for a Contact_Review whose contact is still held (R32.19)', async () => {
    const due = await submission({ state: 'accepted', contactReviewDueAt: atDays(-5) });
    await submission({ state: 'accepted', contactReviewDueAt: atDays(5) }); // not yet due
    await submission({ state: 'accepted', email: null, emailErasedAt: world.at, contactReviewDueAt: atDays(-5) }); // erased
    await submission({ state: 'queued' }); // never scheduled
    expect(ids(await queue('author', '/moderation?contactReview=due'))).toEqual([due]);
    expect((await errorOf(await world.request('author', 'GET', '/moderation?contactReview=nonsense'))).status).toBe(422);
  });

  it('surfaces the Contact_Review and correction history newest first, never a previously erased email (R32.20, R32.22)', async () => {
    const id = await submission({ state: 'accepted', name: 'Augusta Ada King', affiliation: null });
    await review(id, 'keep', 'Correspondence is ongoing.', atDays(-40));
    await review(id, 'erase', null, atDays(-5));
    await correction(id, { kind: 'attribution', newName: 'Augusta Ada King', newAffiliation: null, prevName: 'Ada Lovelace', prevAffiliation: 'Analytical Society', reason: 'Full name.', at: atDays(-30) });
    // A contact erasure NEVER keeps the previous email.
    await correction(id, { kind: 'contact', erased: 1, newEmail: null, prevEmail: null, reason: 'Deletion request.', at: atDays(-3) });

    const e = entry(await queue('admin'), id);
    // Reviews newest first: the Erase, then the Keep with its reason and the acting Administrator.
    expect(e.history.contactReviews.map((r) => r.action)).toEqual(['erase', 'keep']);
    expect(e.history.contactReviews[1]).toMatchObject({ action: 'keep', reason: 'Correspondence is ongoing.', admin: { id: world.ids.admin } });
    expect(e.history.contactReviews[0]).toMatchObject({ action: 'erase', reason: null });
    // Corrections newest first: the erasure, then the attribution correction with its previous values.
    expect(e.history.corrections.map((r) => r.kind)).toEqual(['contact', 'attribution']);
    expect(e.history.corrections[0]).toMatchObject({ kind: 'contact', erased: true, newEmail: null, prevEmail: null });
    expect(e.history.corrections[1]).toMatchObject({ kind: 'attribution', newName: 'Augusta Ada King', prevName: 'Ada Lovelace', prevAffiliation: 'Analytical Society' });
    // No erased email is ever present in the history.
    expect(JSON.stringify(e.history)).not.toContain('@');
  });

  it('has an empty history for an Outside_Submission with no reviews or corrections', async () => {
    const id = await submission({ state: 'accepted' });
    const e = entry(await queue('author'), id);
    expect(e.history).toEqual({ contactReviews: [], corrections: [] });
  });
});
