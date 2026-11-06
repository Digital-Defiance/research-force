import { afterEach, beforeEach, describe, expect, it, inject, vi } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { GuardedBatch } from '@researchforce/db/batch';
import { RIGHTS_PERMISSION_GRANTED_ID, RIGHTS_RESTRICTED_ID } from '@researchforce/db/consent/answer';
import { correspondenceParties, correspondences, externalParties, researchItems, submissions, units } from '@researchforce/db/schema/core';
import type { Level, Timestamp, ULID } from '@researchforce/domain/types';
import { answerConsent, changeConsent, viewChange, viewConsent } from '../src/consent';
import type { ConsentConfirmation, ConsentRefusal, ConsentView } from '../src/consent';
import { handle } from '../src/index';
import type { Env } from '../src/index';

declare module 'vitest' {
  export interface ProvidedContext { d1Migrations: { core: D1Migration[]; search: D1Migration[]; public: D1Migration[] } }
}

let bindings: Env;

const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;
const ADMIN = '0000000000000000000000ADM1' as ULID;
const OWNER = '0000000000000000000000OWN1' as ULID;
const ADMIN_ROLE = '00000000000000000000000007';
const CONTRIB_ROLE = '00000000000000000000000006';
const PROJECT = '0000000000000000000000PRJ1' as ULID;
const PARTY = '0000000000000000000000PTY1' as ULID;
const REQUEST = '0000000000000000000000REQ1' as ULID;
const ITEM = '0000000000000000000000ITM1' as ULID;
const UNIT = '0000000000000000000000UNT1' as ULID;
const SUBMISSION = '0000000000000000000000SUB1' as ULID;
/** A valid 128-bit Crockford-base32 token (26 characters). */
const TOKEN = 'ABCDEFGHJKMNPQRSTVWXYZ0123';

async function sha256Hex(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function seedMembers(): Promise<void> {
  const member = (id: string, role: string) =>
    bindings.RF_CORE.prepare(`INSERT INTO members (id, email, email_lc, role_id, status, created_at, updated_seq)
      VALUES (?1, ?2, ?2, ?3, 'active', ?4, 0)`).bind(id, `${id}@example.test`, role, new Date(NOW).toISOString());
  await bindings.RF_CORE.batch([member(ADMIN, ADMIN_ROLE), member(OWNER, CONTRIB_ROLE)]);
}

/** Seed one Public Correspondence with one External_Party (consent not_asked) owned by OWNER, plus a Project. */
async function seedCorrespondence(level: Level = 'public'): Promise<void> {
  const now = new Date(NOW).toISOString() as Timestamp;
  await new GuardedBatch(bindings.RF_CORE, { id: ADMIN as ULID, now })
    .insert(submissions, { id: SUBMISSION, memberId: OWNER, kind: 'member', startedAt: now, completedAt: now })
    .insert(externalParties, { id: PARTY, name: 'A correspondent', nameFold: 'a correspondent', contactEmail: 'party@example.test', createdAt: now })
    .insert(units, { id: UNIT, unitType: 'research_item', projectId: PROJECT, rootId: UNIT, ownerId: OWNER, credit: [{ member: OWNER }], submissionId: SUBMISSION, createdAt: now, disclosureLevel: level, classificationState: 'classified', disclosureLine: level === 'withheld' ? { kindOfMaterial: 'correspondence', date: { value: '2026-10-01', approx: false }, partyIds: [] } : null })
    .insert(researchItems, { unitId: UNIT, kind: 'correspondence', itemIdentifier: 'RC-00001', projectId: PROJECT, title: 'A correspondence', itemDateKey: '2026-10-01', logDateKey: '2026-10-01' })
    .insert(correspondences, { unitId: UNIT, date: '2026-10-01', direction: 'sent' })
    .insert(correspondenceParties, { unitId: UNIT, position: 0, partyKind: 'external', partyId: PARTY, consentStatus: 'requested' })
    .commit();
}

/** Seed a Consent_Request (publication) and one item naming the correspondence, with a stored snapshot. */
async function seedRequest(options: { state?: string; expiresAt?: number } = {}): Promise<void> {
  const now = new Date(NOW).toISOString();
  const snapshot = { kind: 'publication', key: `u:${UNIT}`, view: { tag: 'research_item', key: `u:${UNIT}`, kind: 'correspondence', title: 'A correspondence' }, partyName: 'A correspondent' };
  const snapshotHash = await sha256Hex(JSON.stringify(snapshot));
  const state = options.state ?? 'sent';
  await bindings.RF_CORE.prepare(`INSERT INTO consent_requests (id, party_id, requested_by, kind, contact_email, token_hash, preview_digest, state, sent_at, expires_at, answered_at, updated_seq)
    VALUES (?1, ?2, ?3, 'publication', 'party@example.test', ?4, ?5, ?6, ?7, ?8, ?9, 0)`)
    .bind(REQUEST, PARTY, ADMIN, await sha256Hex(TOKEN), snapshotHash, state, now, new Date(options.expiresAt ?? NOW + 29 * DAY_MS).toISOString(), state === 'answered' ? now : null)
    .run();
  await bindings.RF_CORE.prepare(`INSERT INTO consent_request_items (id, request_id, unit_id, root_id, position, proposed_values_json, snapshot_json, snapshot_hash, updated_seq)
    VALUES (?1, ?2, ?3, ?3, 0, ?4, ?5, ?6, 0)`)
    .bind(ITEM, REQUEST, UNIT, JSON.stringify({ level: 'public' }), JSON.stringify(snapshot), snapshotHash)
    .run();
}

const isView = (r: ConsentView | ConsentRefusal): r is ConsentView => 'snapshots' in r;
const isConfirmation = (r: ConsentConfirmation | ConsentRefusal): r is ConsentConfirmation => 'recordedAt' in r;

/** Stub Turnstile `siteverify` to the given outcome; it is the only external fetch the Worker makes. */
function stubSiteverify(success: boolean): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    if (target.includes('siteverify')) return new Response(JSON.stringify({ success }), { status: 200 });
    throw new Error(`unexpected fetch to ${target}`);
  });
}

afterEach(() => { vi.restoreAllMocks(); });

beforeEach(async () => {
  const migrations = inject('d1Migrations');
  bindings = env as unknown as Env;
  await applyD1Migrations(bindings.RF_CORE, migrations.core);
  Object.assign(bindings, { TURNSTILE_SECRET: 'synthetic' });
  await bindings.RF_CORE.batch(
    ['consent_answers', 'consent_withdrawals', 'consent_request_items', 'consent_requests', 'correspondence_parties', 'correspondences', 'research_items', 'units', 'external_parties', 'submissions', 'projects', 'outgoing_emails', 'outbox', 'notification_events', 'revisions', 'members']
      .map((t) => bindings.RF_CORE.prepare(`DELETE FROM ${t}`)),
  );
  await seedMembers();
  stubSiteverify(true);
});

describe('POST /v1/consent/view (R51.5, R51.12)', () => {
  it('returns the stored snapshots and options for a usable Consent_Link, writing nothing', async () => {
    await seedCorrespondence();
    await seedRequest();
    const result = await viewConsent(bindings, TOKEN, NOW);
    expect(isView(result)).toBe(true);
    if (!isView(result)) throw new Error('expected a view');
    expect(result.kind).toBe('publication');
    expect(result.options).toEqual(['named', 'unnamed', 'refused']);
    expect(result.snapshots).toHaveLength(1);
    // Each element carries its item id so the Consent_Page can post a choice for it (R51.6).
    expect(result.items).toEqual([{ itemId: ITEM, snapshot: result.snapshots[0] }]);
    // Nothing is written by a view.
    expect(await bindings.RF_CORE.prepare('SELECT count(*) AS n FROM consent_answers').first<number>('n')).toBe(0);
  });

  it('gives one fixed refusal for a malformed, unknown, expired, or cancelled link', async () => {
    const malformed = await viewConsent(bindings, 'not a token', NOW);
    const unknown = await viewConsent(bindings, TOKEN, NOW);
    await seedCorrespondence();
    await seedRequest({ expiresAt: NOW - 1 });
    const expired = await viewConsent(bindings, TOKEN, NOW);
    for (const result of [malformed, unknown, expired]) {
      expect(isView(result)).toBe(false);
      if (isView(result)) throw new Error('expected a refusal');
      expect(result).toEqual({ error: 'invalid_link', message: 'This link is no longer valid.' });
    }
  });

  it('refuses an already-answered link with the same fixed refusal', async () => {
    await seedCorrespondence();
    await seedRequest({ state: 'answered' });
    const result = await viewConsent(bindings, TOKEN, NOW);
    expect(isView(result)).toBe(false);
    if (isView(result)) throw new Error('expected a refusal');
    expect(result.error).toBe('invalid_link');
  });
});

describe('POST /v1/consent/answer (R51.6 to R51.8)', () => {
  it('records a "named" answer: Consent_Status Granted, an answer row, a Change_Link, and a confirmation email', async () => {
    await seedCorrespondence();
    await seedRequest();
    const result = await answerConsent(bindings, 'https://submit.researchforce.org', { token: TOKEN, turnstileToken: 'ok', answers: [{ itemId: ITEM, choice: 'named' }] }, NOW);
    expect(isConfirmation(result)).toBe(true);

    const party = await bindings.RF_CORE.prepare('SELECT consent_status AS status FROM correspondence_parties WHERE unit_id = ?1 AND party_id = ?2').bind(UNIT, PARTY).first<{ status: string }>();
    expect(party?.status).toBe('granted');

    const answer = await bindings.RF_CORE.prepare('SELECT choice, result_status AS status FROM consent_answers WHERE item_id = ?1').bind(ITEM).first<{ choice: string; status: string }>();
    expect(answer).toMatchObject({ choice: 'named', status: 'granted' });

    const request = await bindings.RF_CORE.prepare('SELECT state, change_token_hash AS changeHash, change_expires_at AS changeExpires FROM consent_requests WHERE id = ?1').bind(REQUEST).first<{ state: string; changeHash: string | null; changeExpires: string | null }>();
    expect(request?.state).toBe('answered');
    expect(request?.changeHash).not.toBeNull();
    expect(request?.changeExpires).not.toBeNull();

    const linked = await bindings.RF_CORE.prepare('SELECT answer_id AS answerId FROM consent_request_items WHERE id = ?1').bind(ITEM).first<{ answerId: string | null }>();
    expect(linked?.answerId).not.toBeNull();

    const email = await bindings.RF_CORE.prepare("SELECT kind, recipient FROM outgoing_emails WHERE kind = 'consent_confirmation'").first<{ kind: string; recipient: string }>();
    expect(email).toMatchObject({ kind: 'consent_confirmation', recipient: 'party@example.test' });

    // A named yes keeps the Correspondence Public (no downgrade).
    const unit = await bindings.RF_CORE.prepare('SELECT disclosure_level AS level FROM units WHERE id = ?1').bind(UNIT).first<{ level: string }>();
    expect(unit?.level).toBe('public');
  });

  it('a "do not name me" answer turns on Do_Not_Name with the given Generic_Label and keeps the unit Public', async () => {
    await seedCorrespondence();
    await seedRequest();
    const result = await answerConsent(bindings, 'https://submit.researchforce.org', { token: TOKEN, turnstileToken: 'ok', answers: [{ itemId: ITEM, choice: 'unnamed' }], genericLabel: 'a wartime correspondent' }, NOW);
    expect(isConfirmation(result)).toBe(true);
    const party = await bindings.RF_CORE.prepare('SELECT do_not_name AS dnn, generic_label AS label FROM external_parties WHERE id = ?1').bind(PARTY).first<{ dnn: number; label: string }>();
    expect(party?.dnn).toBe(1);
    expect(party?.label).toBe('a wartime correspondent');
    const unit = await bindings.RF_CORE.prepare('SELECT disclosure_level AS level FROM units WHERE id = ?1').bind(UNIT).first<{ level: string }>();
    expect(unit?.level).toBe('public');
  });

  it('a "no" on a Public Correspondence sets Refused and downgrades it to Withheld with a Disclosure_Change', async () => {
    await seedCorrespondence();
    await seedRequest();
    const result = await answerConsent(bindings, 'https://submit.researchforce.org', { token: TOKEN, turnstileToken: 'ok', answers: [{ itemId: ITEM, choice: 'refused' }] }, NOW);
    expect(isConfirmation(result)).toBe(true);
    const party = await bindings.RF_CORE.prepare('SELECT consent_status AS status FROM correspondence_parties WHERE unit_id = ?1 AND party_id = ?2').bind(UNIT, PARTY).first<{ status: string }>();
    expect(party?.status).toBe('refused');
    const unit = await bindings.RF_CORE.prepare('SELECT disclosure_level AS level, disclosure_line AS line FROM units WHERE id = ?1').bind(UNIT).first<{ level: string; line: string }>();
    expect(unit?.level).toBe('withheld');
    expect(JSON.parse(unit!.line)).toMatchObject({ kindOfMaterial: 'correspondence' });
    const rev = await bindings.RF_CORE.prepare("SELECT count(*) AS n FROM revisions WHERE target_id = ?1 AND kind = 'disclosure_change' AND member_id = ?2").bind(UNIT, ADMIN).first<number>('n');
    expect(rev).toBe(1);
  });

  it('fans out an Item_Update to the requesting Administrator and the Owner', async () => {
    await seedCorrespondence();
    await seedRequest();
    await answerConsent(bindings, 'https://submit.researchforce.org', { token: TOKEN, turnstileToken: 'ok', answers: [{ itemId: ITEM, choice: 'named' }] }, NOW);
    const events = await bindings.RF_CORE.prepare("SELECT member_id AS memberId, event_type AS type, actor_id AS actorId FROM notification_events").all<{ memberId: string; type: string; actorId: string }>();
    expect(events.results.map((e) => e.memberId).sort()).toEqual([ADMIN, OWNER].sort());
    expect(events.results.every((e) => e.type === 'item_update' && e.actorId === ADMIN)).toBe(true);
  });

  it('refuses a missing Turnstile token and writes nothing', async () => {
    await seedCorrespondence();
    await seedRequest();
    Object.assign(bindings, { TURNSTILE_SECRET: '' });
    const result = await answerConsent(bindings, 'https://submit.researchforce.org', { token: TOKEN, turnstileToken: 'ok', answers: [{ itemId: ITEM, choice: 'named' }] }, NOW);
    expect(isConfirmation(result)).toBe(false);
    if (isConfirmation(result)) throw new Error('expected a refusal');
    expect(result.error).toBe('bot_check');
    expect(await bindings.RF_CORE.prepare('SELECT count(*) AS n FROM consent_answers').first<number>('n')).toBe(0);
  });

  it('refuses a second answer through the same link and writes one answer only', async () => {
    await seedCorrespondence();
    await seedRequest();
    const first = await answerConsent(bindings, 'https://submit.researchforce.org', { token: TOKEN, turnstileToken: 'ok', answers: [{ itemId: ITEM, choice: 'named' }] }, NOW);
    expect(isConfirmation(first)).toBe(true);
    const second = await answerConsent(bindings, 'https://submit.researchforce.org', { token: TOKEN, turnstileToken: 'ok', answers: [{ itemId: ITEM, choice: 'refused' }] }, NOW + 1000);
    expect(isConfirmation(second)).toBe(false);
    if (isConfirmation(second)) throw new Error('expected a refusal');
    expect(second.error).toBe('invalid_link');
    expect(await bindings.RF_CORE.prepare('SELECT count(*) AS n FROM consent_answers').first<number>('n')).toBe(1);
  });
});

describe('POST /v1/consent/change (R51.10)', () => {
  async function answerFirst(): Promise<string> {
    await seedCorrespondence();
    await seedRequest();
    await answerConsent(bindings, 'https://submit.researchforce.org', { token: TOKEN, turnstileToken: 'ok', answers: [{ itemId: ITEM, choice: 'named' }] }, NOW);
    // Recover the Change_Link token from the queued confirmation email's payload ref.
    const email = await bindings.RF_CORE.prepare("SELECT payload_ref AS ref FROM outgoing_emails WHERE kind = 'consent_confirmation'").first<{ ref: string }>();
    const url = email!.ref.slice(email!.ref.indexOf('#') + 1);
    return url;
  }

  it('the change view shows the stored snapshots for a usable Change_Link', async () => {
    const changeToken = await answerFirst();
    const result = await viewChange(bindings, changeToken, NOW + 1000);
    expect(isView(result)).toBe(true);
    if (!isView(result)) throw new Error('expected a view');
    expect(result.snapshots).toHaveLength(1);
  });

  it('a withdrawal sets Refused, downgrades to Withheld, keeps Do_Not_Name on, and records a withdrawal row', async () => {
    // Answer "do not name me" so Do_Not_Name is on before the withdrawal.
    await seedCorrespondence();
    await seedRequest();
    await answerConsent(bindings, 'https://submit.researchforce.org', { token: TOKEN, turnstileToken: 'ok', answers: [{ itemId: ITEM, choice: 'unnamed' }], genericLabel: 'a correspondent' }, NOW);
    const email = await bindings.RF_CORE.prepare("SELECT payload_ref AS ref FROM outgoing_emails WHERE kind = 'consent_confirmation'").first<{ ref: string }>();
    const changeToken = email!.ref.slice(email!.ref.indexOf('#') + 1);

    const result = await changeConsent(bindings, 'https://submit.researchforce.org', { token: changeToken, turnstileToken: 'ok' }, NOW + 1000);
    expect(isConfirmation(result)).toBe(true);

    const party = await bindings.RF_CORE.prepare('SELECT consent_status AS status FROM correspondence_parties WHERE unit_id = ?1 AND party_id = ?2').bind(UNIT, PARTY).first<{ status: string }>();
    expect(party?.status).toBe('refused');
    const unit = await bindings.RF_CORE.prepare('SELECT disclosure_level AS level FROM units WHERE id = ?1').bind(UNIT).first<{ level: string }>();
    expect(unit?.level).toBe('withheld');
    const external = await bindings.RF_CORE.prepare('SELECT do_not_name AS dnn FROM external_parties WHERE id = ?1').bind(PARTY).first<{ dnn: number }>();
    expect(external?.dnn).toBe(1); // Do_Not_Name stays on through a withdrawal (R51.10)
    const withdrawal = await bindings.RF_CORE.prepare('SELECT count(*) AS n FROM consent_withdrawals WHERE item_id = ?1').bind(ITEM).first<number>('n');
    expect(withdrawal).toBe(1);
  });

  it('refuses a second withdrawal once every named element has been withdrawn, writing one withdrawal only', async () => {
    const changeToken = await answerFirst();
    const first = await changeConsent(bindings, 'https://submit.researchforce.org', { token: changeToken, turnstileToken: 'ok' }, NOW + 1000);
    expect(isConfirmation(first)).toBe(true);
    const second = await changeConsent(bindings, 'https://submit.researchforce.org', { token: changeToken, turnstileToken: 'ok' }, NOW + 2000);
    expect(isConfirmation(second)).toBe(false);
    if (isConfirmation(second)) throw new Error('expected a refusal');
    expect(second.error).toBe('invalid_link');
    expect(await bindings.RF_CORE.prepare('SELECT count(*) AS n FROM consent_withdrawals').first<number>('n')).toBe(1);
  });

  it('refuses a withdrawal through an unanswered request (no Change_Link) with the fixed refusal', async () => {
    await seedCorrespondence();
    await seedRequest();
    const result = await changeConsent(bindings, 'https://submit.researchforce.org', { token: TOKEN, turnstileToken: 'ok' }, NOW);
    expect(isConfirmation(result)).toBe(false);
    if (isConfirmation(result)) throw new Error('expected a refusal');
    expect(result.error).toBe('invalid_link');
  });
});

describe('the consent routes through the Budget gate (handle)', () => {
  function post(path: string, body: unknown): Request {
    return new Request(`https://submit.researchforce.org${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' } });
  }
  it('answers /v1/consent/view with the snapshots for a usable link', async () => {
    await seedCorrespondence();
    await seedRequest();
    const response = await handle(post('/v1/consent/view', { token: TOKEN }), bindings, NOW);
    expect(response.status).toBe(200);
    const body = await response.json<ConsentView>();
    expect(body.snapshots).toHaveLength(1);
  });
  it('returns the fixed-text refusal shape at 400 for an unusable link', async () => {
    const response = await handle(post('/v1/consent/view', { token: TOKEN }), bindings, NOW);
    expect(response.status).toBe(400);
    const body = await response.json<ConsentRefusal>();
    expect(body.error).toBe('invalid_link');
  });
  it('records an answer through /v1/consent/answer and returns 201', async () => {
    await seedCorrespondence();
    await seedRequest();
    const response = await handle(post('/v1/consent/answer', { token: TOKEN, turnstileToken: 'ok', answers: [{ itemId: ITEM, choice: 'named' }] }), bindings, NOW);
    expect(response.status).toBe(201);
  });
});

describe('the seeded Rights_Status identities', () => {
  it('are the stable Permission granted and Restricted value ids', () => {
    expect(RIGHTS_PERMISSION_GRANTED_ID).toBe('0000000000000000000000P004');
    expect(RIGHTS_RESTRICTED_ID).toBe('0000000000000000000000P005');
  });
});
