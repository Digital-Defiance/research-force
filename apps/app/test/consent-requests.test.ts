import { beforeEach, describe, expect, it } from 'vitest';
import { GuardedBatch } from '@researchforce/db/batch';
import { correspondenceParties, correspondences, externalParties, identifiers, researchItems, units } from '@researchforce/db/schema/core';
import { newItemIdentifier, newULID } from '@researchforce/domain/identifiers';
import type { ULID } from '@researchforce/domain/types';
import { unitKey } from '@researchforce/kernel/views';
import { CONSENT_SUBJECT } from '@researchforce/public-render/email/consent';
import { MemoryAttemptLog, runQueue } from '../src/mail/mailer';
import type { MailerDeps } from '../src/mail/mailer';
import type { EmailMessage, EmailProvider, SendResult } from '../src/mail/provider';
import { itemWorld } from './items';
import type { Who } from './items';
import { addElement, addSubmissionRow } from './units';

class FakeProvider implements EmailProvider {
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<SendResult> {
    this.sent.push(message);
    return { ok: true };
  }
}

const SECRET = 'synthetic-preview-hmac-secret-for-tests';
const LICENCE = 'Synthetic Content Licence 1.0';
const world = itemWorld(undefined, { contentLicence: LICENCE });

interface PreviewResponse {
  readonly email: { readonly subject: string; readonly text: string; readonly html: string };
  readonly snapshots: readonly { readonly kind: string; readonly key: string; readonly partyName?: string; readonly document?: { readonly fileName: string; readonly sha256: string } }[];
  readonly token: string;
}

function withSecret(): void {
  world.bindings.DOWNLOAD_HMAC_KEY = SECRET;
}

/** A correspondence owned by `admin` with one External_Party, which has a Contact_Email. The Party is a Party of it. */
async function correspondenceWithParty(options: { readonly contactEmail?: string | null } = {}): Promise<{ unitId: ULID; partyId: ULID }> {
  const now = world.at;
  const partyId = newULID(now) as ULID;
  const unitId = newULID(now) as ULID;
  const { identifier, registryKey } = newItemIdentifier();
  const submissionId = await addSubmissionRow(world.core(), world.ids.admin, now);
  await new GuardedBatch(world.core(), { id: world.ids.admin, now })
    .insert(externalParties, {
      id: partyId, name: 'A synthetic correspondent', nameFold: 'a synthetic correspondent',
      ...(options.contactEmail === undefined ? { contactEmail: 'party@example.test' } : options.contactEmail === null ? {} : { contactEmail: options.contactEmail }),
      createdAt: now,
    })
    .insert(units, { id: unitId, unitType: 'research_item', projectId: world.projectId, rootId: unitId, ownerId: world.ids.admin, credit: [{ member: world.ids.admin }], submissionId, createdAt: now })
    .insert(researchItems, { unitId, kind: 'correspondence', itemIdentifier: identifier, projectId: world.projectId, title: 'A synthetic correspondence', itemDateKey: '2026-10-01', logDateKey: '2026-10-01' })
    .insert(identifiers, { identifierLc: registryKey, identifier, unitId, issuedAt: now })
    .insert(correspondences, { unitId, date: '2026-10-01', direction: 'sent' })
    .insert(correspondenceParties, { unitId, position: 0, partyKind: 'external', partyId, consentStatus: 'not_asked' })
    .commit();
  return { unitId, partyId };
}

/** An Attachment owned by `admin` under a finding root, for a Rights_Permission_Request. */
async function attachmentUnit(): Promise<{ rootId: ULID; attachmentId: ULID; partyId: ULID }> {
  const now = world.at;
  const root = await world.created('admin', 'finding');
  const submissionId = await addSubmissionRow(world.core(), world.ids.admin, now);
  const added = await addElement(world.core(), { projectId: world.projectId, ownerId: world.ids.admin, submissionId, now }, 'attachment', root.id as ULID);
  const partyId = newULID(now) as ULID;
  await new GuardedBatch(world.core(), { id: world.ids.admin, now })
    .insert(externalParties, { id: partyId, name: 'A rights holder', nameFold: 'a rights holder', contactEmail: 'holder@example.test', createdAt: now })
    .commit();
  return { rootId: root.id as ULID, attachmentId: added.id as ULID, partyId };
}

async function preview(who: Who, body: unknown): Promise<Response> {
  withSecret();
  return world.request(who, 'POST', '/consent-requests/preview', body);
}

async function send(who: Who, body: unknown): Promise<Response> {
  withSecret();
  return world.request(who, 'POST', '/consent-requests', body);
}

beforeEach(async () => {
  withSecret();
  // The requesting Administrator holds a Licence_Agreement for the current Content_Licence, so the licence gate
  // never blocks setting a Disclosure_Line on a proposed Public_View.
  await world.core().prepare('UPDATE profiles SET licence_name = ?1, licence_given_on = ?2 WHERE member_id = ?3').bind(LICENCE, '2026-10-27', world.ids.admin).run();
});

describe('POST /consent-requests/preview', () => {
  it('needs the consent.request permission', async () => {
    const { unitId, partyId } = await correspondenceWithParty();
    const response = await preview('author', { partyId, kind: 'publication', units: [{ key: unitKey(unitId), level: 'withheld' }] });
    expect(response.status).toBe(403);
  });

  it('returns the email text, the snapshots, and a preview token for a publication request', async () => {
    const { unitId, partyId } = await correspondenceWithParty();
    const response = await preview('admin', { partyId, kind: 'publication', message: 'Please may we publish this?', units: [{ key: unitKey(unitId), level: 'withheld', disclosureLine: { kindOfMaterial: 'A letter', date: { value: '2026-10-01', approx: false }, partyIds: [] } }] });
    expect(response.status).toBe(200);
    const body = await response.json<PreviewResponse>();
    expect(body.email.subject).toBe(`ResearchForce: ${CONSENT_SUBJECT}`);
    expect(body.email.text).toContain('Please may we publish this?');
    expect(body.snapshots).toHaveLength(1);
    expect(body.snapshots[0]!.kind).toBe('publication');
    expect(body.snapshots[0]!.partyName).toBe('A synthetic correspondent');
    expect(body.token).toBeTruthy();
    // Previewing writes no Consent_Request.
    const count = await world.core().prepare('SELECT count(*) AS n FROM consent_requests').first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it('lists every reason to refuse when the Party has no Contact_Email and the kind is wrong', async () => {
    const { attachmentId, partyId } = await attachmentUnit();
    // Erase the Party's Contact_Email, and name an Attachment in a publication request (wrong kind).
    await world.core().prepare('UPDATE external_parties SET contact_email = NULL WHERE id = ?1').bind(partyId).run();
    const response = await preview('admin', { partyId, kind: 'publication', units: [{ key: unitKey(attachmentId) }] });
    expect(response.status).toBe(422);
    const body = await response.json<{ error: string; details: { rule: string; failures: { reason: string }[] } }>();
    expect(body.details.rule).toBe('consent_checks');
    const reasons = body.details.failures.map((f) => f.reason).sort();
    expect(reasons).toContain('no_contact_email');
    expect(reasons).toContain('wrong_kind');
  });

  it('includes the document file name and SHA-256 but never the file for a rights request', async () => {
    const { attachmentId, partyId } = await attachmentUnit();
    const response = await preview('admin', { partyId, kind: 'rights', units: [{ key: unitKey(attachmentId) }] });
    expect(response.status).toBe(200);
    const body = await response.json<PreviewResponse>();
    expect(body.snapshots[0]!.kind).toBe('rights');
    expect(body.snapshots[0]!.document?.fileName).toBe('synthetic.pdf');
    expect(body.snapshots[0]!.document?.sha256).toBe('0'.repeat(64));
    // The file bytes are never part of the snapshot.
    expect(JSON.stringify(body)).not.toContain('r2Key');
  });
});

describe('POST /consent-requests (send)', () => {
  it('stores the request, items, token hash, expiry, sets Consent_Status Requested, and queues the email', async () => {
    const { unitId, partyId } = await correspondenceWithParty();
    const body = { partyId, kind: 'publication', message: 'A message.', units: [{ key: unitKey(unitId), level: 'withheld', disclosureLine: { kindOfMaterial: 'A letter', date: { value: '2026-10-01', approx: false }, partyIds: [] } }] };
    const previewed = await (await preview('admin', body)).json<PreviewResponse>();
    const response = await send('admin', { ...body, token: previewed.token });
    expect(response.status).toBe(201);
    const { id } = await response.json<{ id: string }>();

    const request = await world.core().prepare('SELECT party_id AS partyId, kind, state, contact_email AS contactEmail, token_hash AS tokenHash, preview_digest AS previewDigest, expires_at AS expiresAt FROM consent_requests WHERE id = ?1').bind(id).first<{ partyId: string; kind: string; state: string; contactEmail: string; tokenHash: string; previewDigest: string; expiresAt: string }>();
    expect(request).toMatchObject({ partyId, kind: 'publication', state: 'sent', contactEmail: 'party@example.test' });
    expect(request!.tokenHash).toHaveLength(64);
    expect(request!.previewDigest).toHaveLength(64);
    // Expiry is sending plus 30 days.
    expect(Date.parse(request!.expiresAt) - Date.parse(world.at)).toBe(30 * 24 * 60 * 60 * 1000);

    const item = await world.core().prepare('SELECT unit_id AS unitId, snapshot_hash AS snapshotHash, position FROM consent_request_items WHERE request_id = ?1').bind(id).first<{ unitId: string; snapshotHash: string; position: number }>();
    expect(item).toMatchObject({ unitId, position: 0 });
    expect(item!.snapshotHash).toHaveLength(64);

    const status = await world.core().prepare('SELECT consent_status AS status FROM correspondence_parties WHERE unit_id = ?1 AND party_id = ?2').bind(unitId, partyId).first<{ status: string }>();
    expect(status?.status).toBe('requested');

    const email = await world.core().prepare("SELECT kind, recipient, state FROM outgoing_emails WHERE kind = 'consent'").first<{ kind: string; recipient: string; state: string }>();
    expect(email).toEqual({ kind: 'consent', recipient: 'party@example.test', state: 'queued' });
  });

  it('leaves a Granted Consent_Status unchanged when sending', async () => {
    const { unitId, partyId } = await correspondenceWithParty();
    await world.core().prepare("UPDATE correspondence_parties SET consent_status = 'granted' WHERE unit_id = ?1 AND party_id = ?2").bind(unitId, partyId).run();
    const body = { partyId, kind: 'publication', units: [{ key: unitKey(unitId), level: 'withheld', disclosureLine: { kindOfMaterial: 'A letter', date: { value: '2026-10-01', approx: false }, partyIds: [] } }] };
    const previewed = await (await preview('admin', body)).json<PreviewResponse>();
    expect((await send('admin', { ...body, token: previewed.token })).status).toBe(201);
    const status = await world.core().prepare('SELECT consent_status AS status FROM correspondence_parties WHERE unit_id = ?1 AND party_id = ?2').bind(unitId, partyId).first<{ status: string }>();
    expect(status?.status).toBe('granted');
  });

  it('refuses a send whose token does not match the previewed content', async () => {
    const { unitId, partyId } = await correspondenceWithParty();
    const body = { partyId, kind: 'publication', units: [{ key: unitKey(unitId), level: 'withheld', disclosureLine: { kindOfMaterial: 'A letter', date: { value: '2026-10-01', approx: false }, partyIds: [] } }] };
    const previewed = await (await preview('admin', body)).json<PreviewResponse>();
    // The message changes the snapshot digests are unaffected, but a different party makes the token's party mismatch.
    const other = await correspondenceWithParty();
    const response = await send('admin', { ...body, partyId: other.partyId, units: [{ key: unitKey(other.unitId), level: 'withheld', disclosureLine: { kindOfMaterial: 'A letter', date: { value: '2026-10-01', approx: false }, partyIds: [] } }], token: previewed.token });
    expect(response.status).toBe(409);
  });

  it('stores only the token hash, never the plaintext token', async () => {
    const { unitId, partyId } = await correspondenceWithParty();
    const body = { partyId, kind: 'publication', units: [{ key: unitKey(unitId), level: 'withheld', disclosureLine: { kindOfMaterial: 'A letter', date: { value: '2026-10-01', approx: false }, partyIds: [] } }] };
    const previewed = await (await preview('admin', body)).json<PreviewResponse>();
    const { id } = await (await send('admin', { ...body, token: previewed.token })).json<{ id: string }>();
    const request = await world.core().prepare('SELECT token_hash AS tokenHash FROM consent_requests WHERE id = ?1').bind(id).first<{ tokenHash: string }>();
    // The hash is 64 hex characters, not a base32 token.
    expect(request!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('the queued consent email', () => {
  it('composes and sends the Consent_Request email with the subject, message, snapshot, and Consent_Link', async () => {
    const { unitId, partyId } = await correspondenceWithParty();
    const body = { partyId, kind: 'publication', message: 'Please consider this request.', units: [{ key: unitKey(unitId), level: 'withheld', disclosureLine: { kindOfMaterial: 'A letter', date: { value: '2026-10-01', approx: false }, partyIds: [] } }] };
    const previewed = await (await preview('admin', body)).json<PreviewResponse>();
    await (await send('admin', { ...body, token: previewed.token })).json<{ id: string }>();

    const fake = new FakeProvider();
    const deps: MailerDeps = { db: world.core(), origin: 'https://app.example.test', log: new MemoryAttemptLog(), provider: () => fake };
    await runQueue(deps, Date.parse(world.at));
    const message = fake.sent.find((sent) => sent.subject === `ResearchForce: ${CONSENT_SUBJECT}`);
    expect(message).toBeTruthy();
    expect(message!.to).toBe('party@example.test');
    expect(message!.text).toContain('Please consider this request.');
    expect(message!.text).toContain('A synthetic correspondent');
    // The Consent_Link URL is in the email; the submit host serves the Consent_Page.
    expect(message!.text).toMatch(/\/consent#[0-9A-Z]+/);
    const marked = await world.core().prepare("SELECT state FROM outgoing_emails WHERE kind = 'consent'").first<{ state: string }>();
    expect(marked?.state).toBe('sent');
  });
});

describe('GET /consent-requests and cancel', () => {
  async function seedSent(): Promise<{ id: string; unitId: ULID; partyId: ULID }> {
    const { unitId, partyId } = await correspondenceWithParty();
    const body = { partyId, kind: 'publication', units: [{ key: unitKey(unitId), level: 'withheld', disclosureLine: { kindOfMaterial: 'A letter', date: { value: '2026-10-01', approx: false }, partyIds: [] } }] };
    const previewed = await (await preview('admin', body)).json<PreviewResponse>();
    const { id } = await (await send('admin', { ...body, token: previewed.token })).json<{ id: string }>();
    return { id, unitId, partyId };
  }

  it('lists requests with their state and named elements, filtered by party', async () => {
    const { id, unitId, partyId } = await seedSent();
    const response = await world.request('author', 'GET', `/consent-requests?party=${partyId}`);
    expect(response.status).toBe(200);
    const body = await response.json<{ requests: { id: string; state: string; units: { key: string }[] }[] }>();
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0]).toMatchObject({ id, state: 'sent' });
    expect(body.requests[0]!.units[0]!.key).toBe(unitKey(unitId));
  });

  it('cancels an open request without changing any Consent_Status', async () => {
    const { id, unitId, partyId } = await seedSent();
    const response = await world.request('admin', 'POST', `/consent-requests/${id}/cancel`, {});
    expect(response.status).toBe(200);
    const request = await world.core().prepare('SELECT state, cancelled_at AS cancelledAt FROM consent_requests WHERE id = ?1').bind(id).first<{ state: string; cancelledAt: string | null }>();
    expect(request?.state).toBe('cancelled');
    expect(request?.cancelledAt).toBeTruthy();
    // The Consent_Status set to Requested on send is left as it was (R51.11).
    const status = await world.core().prepare('SELECT consent_status AS status FROM correspondence_parties WHERE unit_id = ?1 AND party_id = ?2').bind(unitId, partyId).first<{ status: string }>();
    expect(status?.status).toBe('requested');
  });

  it('refuses to cancel a request that is not open', async () => {
    const { id } = await seedSent();
    expect((await world.request('admin', 'POST', `/consent-requests/${id}/cancel`, {})).status).toBe(200);
    const again = await world.request('admin', 'POST', `/consent-requests/${id}/cancel`, {});
    expect(again.status).toBe(422);
  });

  it('needs the consent.request permission to cancel', async () => {
    const { id } = await seedSent();
    expect((await world.request('author', 'POST', `/consent-requests/${id}/cancel`, {})).status).toBe(403);
  });

  it('surfaces the recorded answers, comments, and withdrawals, never a token hash or snapshot (R51.13)', async () => {
    const { id, unitId, partyId } = await seedSent();
    const now = world.at;
    const itemId = (await world.core().prepare('SELECT id FROM consent_request_items WHERE request_id = ?1').bind(id).first<{ id: string }>())!.id;
    // Record a Consent_Answer and then a withdrawal on the one named element, as the answer batch would.
    await world.core().prepare(
      `INSERT INTO consent_answers (id, request_id, item_id, unit_id, root_id, choice, generic_label, comment, result_status, seen_snapshot_json, seen_snapshot_hash, answered_at, updated_seq)
       VALUES (?1, ?2, ?3, ?4, ?4, 'unnamed', 'an archive', 'Keep me anonymous.', 'granted', ?5, ?6, ?7, 0)`,
    ).bind(newULID(now), id, itemId, unitId, JSON.stringify({ kind: 'publication' }), '0'.repeat(64), now).run();
    await world.core().prepare(
      `INSERT INTO consent_withdrawals (id, request_id, item_id, unit_id, root_id, comment, withdrawn_at, updated_seq)
       VALUES (?1, ?2, ?3, ?4, ?4, 'On second thought, no.', ?5, 0)`,
    ).bind(newULID(now), id, itemId, unitId, now).run();

    const response = await world.request('author', 'GET', `/consent-requests?party=${partyId}`);
    expect(response.status).toBe(200);
    const body = await response.json<{ requests: { id: string; answers: { unitId: string; choice: string; genericLabel: string | null; comment: string | null }[]; withdrawals: { unitId: string; comment: string | null }[] }[] }>();
    const request = body.requests.find((entry) => entry.id === id)!;
    expect(request.answers).toEqual([{ unitId, key: unitKey(unitId), choice: 'unnamed', genericLabel: 'an archive', comment: 'Keep me anonymous.', answeredAt: now }]);
    expect(request.withdrawals).toEqual([{ unitId, key: unitKey(unitId), comment: 'On second thought, no.', withdrawnAt: now }]);
    // No token hash, change token hash, or stored snapshot is ever returned (R51.13).
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('tokenHash');
    expect(serialized).not.toContain('token_hash');
    expect(serialized).not.toContain('seen_snapshot');
    expect(serialized).not.toContain('seenSnapshot');
  });
});

describe('GET /parties/:id', () => {
  it('returns one External_Party with its Contact_Email to a Member', async () => {
    const { partyId } = await correspondenceWithParty();
    const response = await world.request('author', 'GET', `/parties/${partyId}`);
    expect(response.status).toBe(200);
    const body = await response.json<{ party: { id: string; name: string; contactEmail: string | null } }>();
    expect(body.party).toMatchObject({ id: partyId, name: 'A synthetic correspondent', contactEmail: 'party@example.test' });
  });

  it('answers not_found for an unknown party', async () => {
    const response = await world.request('author', 'GET', '/parties/01J00000000000000000000ZZZ');
    expect(response.status).toBe(404);
  });
});
