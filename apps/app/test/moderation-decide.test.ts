import { beforeEach, describe, expect, it } from 'vitest';
import { newULID } from '@researchforce/domain/identifiers';
import type { OutsideSubmissionType, ULID } from '@researchforce/domain/types';
import type { DecisionResult } from '../src/moderation/decide';
import { completedUpload } from './files';
import { errorOf, itemWorld, rich } from './items';
import type { ItemView, Who } from './items';

const world = itemWorld();

interface SubmissionOptions {
  readonly type?: OutsideSubmissionType;
  readonly projectId?: ULID | null;
  readonly name?: string;
  readonly email?: string | null;
  readonly affiliation?: string | null;
}
let counter = 0;
/** Insert one Outside_Submission the way the rf-submit Worker stores it. */
async function submission(options: SubmissionOptions = {}): Promise<ULID> {
  const id = newULID(world.at);
  counter += 1;
  const type = options.type ?? 'material';
  const licence = type === 'removal_request' ? null : 'Synthetic Licence 1.0';
  const email = options.email === undefined ? `submitter${counter}@example.test` : options.email;
  await world.core().prepare(
    `INSERT INTO outside_submissions (id, reference, type, project_id, message, name, email, affiliation, page_ref, licence_agreed, received_at, state, rev, updated_seq)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9, ?10, 'queued', 1, 0)`,
  ).bind(
    id, `RS-TEST-${String(counter).padStart(4, '0')}`, type, options.projectId === undefined ? world.projectId : options.projectId,
    'A synthetic submission message.', options.name ?? 'Ada Lovelace', email, options.affiliation ?? null, licence, world.at,
  ).run();
  return id;
}

const decideBody = async (who: Who, id: string, body: unknown) => world.request(who, 'POST', `/moderation/${id}/decide`, body);
const decided = async (who: Who, id: string, body: unknown): Promise<DecisionResult> => {
  const response = await decideBody(who, id, body);
  if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return response.json<DecisionResult>();
};
/** The one email queued to a Submitter for an Outside_Submission, if any. */
const queuedEmail = (id: string) => world.core().prepare(
  'SELECT kind, recipient, payload_ref AS payloadRef FROM outgoing_emails WHERE outside_submission_id = ?1',
).bind(id).first<{ kind: string; recipient: string; payloadRef: string }>();

const materialItem = (overrides: Record<string, unknown> = {}) => ({
  unit: 'research_item' as const, kind: 'finding' as const,
  fields: { title: 'A finding from outside', claim: rich('A synthetic outside claim.'), scopeCaveat: rich('Synthetic caveat.'), logSummary: rich('Summary of the outside finding.') },
  ...overrides,
});

describe('Moderation_Decisions (R32.4 to R32.18, R41.2, R46.23, R46.33)', () => {
  beforeEach(async () => {
    await world.core().batch([
      world.core().prepare('DELETE FROM outgoing_emails'),
      world.core().prepare('DELETE FROM response_links'),
      world.core().prepare('DELETE FROM moderation_decisions'),
      world.core().prepare('DELETE FROM outside_files'),
      world.core().prepare('DELETE FROM outside_submissions'),
    ]);
    counter = 0;
  });

  it('only Administrators may decide (moderation.decide)', async () => {
    const id = await submission();
    expect((await decideBody('author', id, { decision: 'rejected', text: 'No.' })).status).toBe(403);
    expect((await decideBody('admin', id, { decision: 'rejected', text: 'No.' })).status).toBe(200);
  });

  it('returns the exact email text first and applies only after confirmation (R32.10)', async () => {
    const id = await submission({ email: 'ada@example.test' });
    const preview = await decided('admin', id, { decision: 'rejected', text: 'Thank you, but this is out of scope.' });
    expect(preview.applied).toBeUndefined();
    expect(preview.email.body.join('\n')).toContain('out of scope');
    // Nothing is recorded or queued by a preview.
    expect(await world.core().prepare('SELECT count(*) AS n FROM moderation_decisions WHERE outside_submission_id = ?1').bind(id).first<number>('n')).toBe(0);
    expect(await queuedEmail(id)).toBeNull();

    const applied = await decided('admin', id, { decision: 'rejected', confirm: true, text: 'Thank you, but this is out of scope.' });
    expect(applied.applied?.kind).toBe('rejected');
    const email = await queuedEmail(id);
    expect(email).toMatchObject({ kind: 'decision', recipient: 'ada@example.test' });
  });

  it('limits a message to 5,000 characters (R32.10)', async () => {
    const id = await submission();
    expect((await errorOf(await decideBody('admin', id, { decision: 'rejected', text: 'x'.repeat(5001) }))).status).toBe(422);
  });

  it('accepts Material as Items credited to the Submitter, Not_Published and Unclassified, as one Submission (R32.4, R32.5, R32.18, R41.2)', async () => {
    const id = await submission({ name: 'Grace Hopper', affiliation: 'Navy' });
    const result = await decided('admin', id, { decision: 'accepted', confirm: true, text: 'Accepted with thanks.', items: [materialItem()] });
    expect(result.applied?.createdUnitIds).toHaveLength(1);
    const itemId = result.applied!.createdUnitIds[0]!;

    const item = await world.view('admin', itemId);
    expect(item.credit).toEqual([{ outside: { name: 'Grace Hopper', affiliation: 'Navy' } }]);
    expect((item.disclosure as { level: string }).level).toBe('not_published');
    expect((item.project as { id: string }).id).toBe(world.projectId);
    // One Submission by the accepting Administrator, now complete so the Item is visible.
    const row = await world.core().prepare('SELECT u.submission_id AS submissionId, u.classification_state AS classification, s.member_id AS memberId, s.completed_at AS completedAt FROM units u JOIN submissions s ON s.id = u.submission_id WHERE u.id = ?1').bind(itemId).first<{ submissionId: string; classification: string; memberId: string; completedAt: string | null }>();
    expect(row?.classification).toBe('unclassified');
    expect(row?.memberId).toBe(world.ids.admin);
    expect(row?.completedAt).not.toBeNull();
  });

  it('refuses an acceptance too large for one atomic save with a clear 422, writing nothing (R32.5, R32.15)', async () => {
    const id = await submission({ name: 'Grace Hopper' });
    // An acceptance commits as one atomic save bounded by the statement budget (40). Twelve Research_Items, each
    // needing several statements, exceed it; the save is refused before any statement runs, so nothing is written.
    const items = Array.from({ length: 12 }, (_unused, index) => materialItem({ fields: { title: `An outside finding ${index}`, claim: rich('A synthetic outside claim.'), scopeCaveat: rich('Synthetic caveat.'), logSummary: rich('Summary of the outside finding.') } }));
    const error = await errorOf(await decideBody('admin', id, { decision: 'accepted', confirm: true, text: 'Accepted with thanks.', items }));
    // A clean, user-facing refusal, not a 500 internal error.
    expect(error.status).toBe(422);
    expect(error.fields?.some((field) => field.field === 'items')).toBe(true);
    // All-or-nothing: no Item, no Submission, and no Moderation_Decision was recorded (R32.15).
    expect(await world.core().prepare('SELECT count(*) AS n FROM moderation_decisions WHERE outside_submission_id = ?1').bind(id).first<number>('n')).toBe(0);
    expect(await world.core().prepare("SELECT count(*) AS n FROM units WHERE submission_id IN (SELECT id FROM submissions WHERE member_id = ?1 AND completed_at IS NULL)").bind(world.ids.admin).first<number>('n')).toBe(0);
    const state = await world.core().prepare('SELECT state FROM outside_submissions WHERE id = ?1').bind(id).first<string>('state');
    expect(state).toBe('queued');
  });

  it('requires at least one Item and a Log_Summary for each Research_Item (R32.4, R41.2)', async () => {
    const id = await submission();
    expect((await errorOf(await decideBody('admin', id, { decision: 'accepted', confirm: true, text: 'ok', items: [] }))).status).toBe(422);
    // A Finding with no Log_Summary fails validation; nothing is created and no decision is recorded (R32.15).
    const missingSummary = await errorOf(await decideBody('admin', id, { decision: 'accepted', confirm: true, text: 'ok', items: [materialItem({ fields: { title: 'No summary', claim: rich('A claim.'), scopeCaveat: rich('Caveat.') } })] }));
    expect(missingSummary.status).toBe(422);
    expect(await world.core().prepare('SELECT count(*) AS n FROM moderation_decisions WHERE outside_submission_id = ?1').bind(id).first<number>('n')).toBe(0);
  });

  it('creates Attachments and Replies on Items created in the same acceptance, all-or-nothing (R32.4, R32.15)', async () => {
    const id = await submission();
    const upload = await completedUpload(world, 'admin', 'outside-evidence.txt');
    const result = await decided('admin', id, {
      decision: 'accepted', confirm: true, text: 'Accepted.',
      items: [
        materialItem({ ref: 'finding' }),
        { unit: 'reply', parent: { created: 'finding' }, text: { text: 'A reply from the Submitter.', spans: [] } },
        { unit: 'attachment', parent: { created: 'finding' }, uploadId: upload, metadata: { origin: 'Submitter upload.' } },
      ],
    });
    expect(result.applied?.createdUnitIds).toHaveLength(3);
    // The upload is now attached, and all three units share one Submission.
    const attached = await world.core().prepare('SELECT state FROM uploads WHERE id = ?1').bind(upload).first<string>('state');
    expect(attached).toBe('attached');
    const subs = await world.core().prepare('SELECT DISTINCT submission_id AS id FROM units WHERE id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(result.applied!.createdUnitIds)).all<{ id: string }>();
    expect(subs.results).toHaveLength(1);
  });

  it('a General_Choice submission requires a Project for each Research_Item (R32.18)', async () => {
    const id = await submission({ projectId: null });
    expect((await errorOf(await decideBody('admin', id, { decision: 'accepted', confirm: true, text: 'ok', items: [materialItem()] }))).status).toBe(422);
    const result = await decided('admin', id, { decision: 'accepted', confirm: true, text: 'ok', items: [materialItem({ projectId: world.projectId })] });
    expect(result.applied?.createdUnitIds).toHaveLength(1);
  });

  it('More_Information_Requested sends the message with a Response_Link valid for 30 days (R32.6)', async () => {
    const id = await submission({ email: 'ada@example.test' });
    const result = await decided('admin', id, { decision: 'more_information_requested', confirm: true, text: 'Could you send the original scan?' });
    expect(result.applied?.kind).toBe('more_information_requested');
    // A non-final decision leaves the Outside_Submission open to a later final decision.
    const state = await world.core().prepare('SELECT state FROM outside_submissions WHERE id = ?1').bind(id).first<string>('state');
    expect(state).toBe('more_information_requested');
    const link = await world.core().prepare('SELECT token_hash AS tokenHash, expires_at AS expiresAt FROM response_links WHERE outside_submission_id = ?1').bind(id).first<{ tokenHash: string; expiresAt: string }>();
    expect(link).not.toBeNull();
    expect(Date.parse(link!.expiresAt) - Date.parse(world.at)).toBe(30 * 24 * 60 * 60 * 1000);
    const email = await queuedEmail(id);
    expect(email?.kind).toBe('more_information');
    // The token travels only in the queued email's payload (the URL fragment), never stored as plaintext elsewhere.
    expect(email?.payloadRef).toContain('#');
  });

  it('a Removal_Request needs a statement, records the changed elements, and creates no Item (R32.12, R46.23)', async () => {
    const id = await submission({ type: 'removal_request', email: 'ada@example.test' });
    // The ordinary accept path does not apply to a Removal_Request.
    expect((await errorOf(await decideBody('admin', id, { decision: 'accepted', confirm: true, text: 'x', items: [materialItem()] }))).status).toBe(422);
    // A removal acceptance needs a statement and records what changed; it creates no Item.
    const result = await decided('admin', id, { decision: 'removal_accepted', confirm: true, statement: 'Removed the named record.', changed: [{ kind: 'item', reference: 'RI-000123' }] });
    expect(result.applied?.createdUnitIds).toHaveLength(0);
    const row = await world.core().prepare('SELECT kind, changed_refs AS changedRefs FROM moderation_decisions WHERE outside_submission_id = ?1').bind(id).first<{ kind: string; changedRefs: string }>();
    expect(row?.kind).toBe('accepted');
    expect(JSON.parse(row!.changedRefs)).toEqual([{ kind: 'item', reference: 'RI-000123' }]);
  });

  it('a rejection and an accepted Removal_Request schedule the email erasure 90 days on (R32.8, R46.26)', async () => {
    const rejected = await submission();
    await decided('admin', rejected, { decision: 'rejected', confirm: true, text: 'Out of scope.' });
    const r = await world.core().prepare('SELECT email_erase_after AS eraseAfter FROM outside_submissions WHERE id = ?1').bind(rejected).first<{ eraseAfter: string | null }>();
    expect(Date.parse(r!.eraseAfter!) - Date.parse(world.at)).toBe(90 * 24 * 60 * 60 * 1000);

    const removal = await submission({ type: 'removal_request' });
    await decided('admin', removal, { decision: 'removal_accepted', confirm: true, statement: 'Done.' });
    const rm = await world.core().prepare('SELECT email_erase_after AS eraseAfter FROM outside_submissions WHERE id = ?1').bind(removal).first<{ eraseAfter: string | null }>();
    expect(rm!.eraseAfter).not.toBeNull();

    // An acceptance of an ordinary submission does not schedule erasure.
    const accepted = await submission();
    await decided('admin', accepted, { decision: 'accepted', confirm: true, text: 'Thanks.', items: [materialItem()] });
    const a = await world.core().prepare('SELECT email_erase_after AS eraseAfter FROM outside_submissions WHERE id = ?1').bind(accepted).first<{ eraseAfter: string | null }>();
    expect(a!.eraseAfter).toBeNull();
  });

  it('refuses a decision after a final one and shows the recorded decision (R32.16)', async () => {
    const id = await submission();
    await decided('admin', id, { decision: 'rejected', confirm: true, text: 'No.' });
    const second = await decideBody('admin', id, { decision: 'rejected', confirm: true, text: 'No again.' });
    expect(second.status).toBe(409);
    const body = await second.json<{ error: string; details?: { decision?: { kind: string; admin: { id: string } } } }>();
    expect(body.details?.decision?.kind).toBe('rejected');
    expect(body.details?.decision?.admin.id).toBe(world.ids.admin);
    // Decision rows are append-only: only the one final decision exists.
    expect(await world.core().prepare('SELECT count(*) AS n FROM moderation_decisions WHERE outside_submission_id = ?1').bind(id).first<number>('n')).toBe(1);
  });

  it('More_Information_Requested does not block a later final decision (R32.16)', async () => {
    const id = await submission();
    await decided('admin', id, { decision: 'more_information_requested', confirm: true, text: 'More please.' });
    const result = await decided('admin', id, { decision: 'rejected', confirm: true, text: 'Still no.' });
    expect(result.applied?.kind).toBe('rejected');
  });

  it('sends no email when the Submitter address has been erased (R32.11)', async () => {
    const id = await submission({ email: null });
    await decided('admin', id, { decision: 'rejected', confirm: true, text: 'No.' });
    expect(await queuedEmail(id)).toBeNull();
    // The decision is still recorded.
    expect(await world.core().prepare('SELECT count(*) AS n FROM moderation_decisions WHERE outside_submission_id = ?1').bind(id).first<number>('n')).toBe(1);
  });
});

export type { ItemView };
