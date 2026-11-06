import { afterEach, beforeEach, describe, expect, it, inject, vi } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { GuardedBatch } from '@researchforce/db/batch';
import { correspondenceParties, correspondences, externalParties, researchItems, submissions, units } from '@researchforce/db/schema/core';
import type { Level, Timestamp, ULID } from '@researchforce/domain/types';
import type { ConsentConfirmation, ConsentRefusal, ConsentView } from '../src/consent';
import { handle } from '../src/index';
import type { Env } from '../src/index';

declare module 'vitest' {
  export interface ProvidedContext { d1Migrations: { core: D1Migration[]; search: D1Migration[]; public: D1Migration[] } }
}

/**
 * End-to-end integration tests for emailed Consent_Requests (task 56.10, R51.5, R51.8, R51.10, R51.12).
 *
 * Unlike the unit/property tests (consent.test.ts, the p107/p108 property tests) which call the
 * `viewConsent`/`answerConsent`/`changeConsent` functions directly, every scenario here drives the real
 * Worker router `handle(request, env, now)` — the Budget-gated HTTP entry — so each test covers the routing,
 * the Budget gate, the Turnstile Bot_Check, the view/answer/change endpoints, and the D1 (and Mailer queueing)
 * effects together. These are example/scenario integration tests, so no fast-check and no per-run D1 reset: a
 * `beforeEach` reset is enough.
 *
 * The scenarios, from the task:
 *  1. A scanner-style view of a usable Consent_Link changes nothing (R51.5).
 *  2. A full answer sets the Consent_Status/Rights_Status and queues the confirmation to the Contact_Email (R51.8).
 *  3. A "refused" answer on a Public Correspondence withholds it with a disclosure_change Revision (R51.8).
 *  4. An expired, a cancelled, and an already-used link each get the one fixed "no longer valid" notice (R51.12).
 *  5. A withdrawal through the Change_Link (recovered from the confirmation email) downgrades and keeps
 *     Do_Not_Name on (R51.10).
 */

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
const CONTACT_EMAIL = 'party@example.test';
/** A valid 128-bit Crockford-base32 token (26 characters), delivered only through the request email. */
const TOKEN = 'ABCDEFGHJKMNPQRSTVWXYZ0123';
const ORIGIN = 'https://submit.researchforce.org';

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

/** Seed one Public Correspondence with one External_Party (consent requested) owned by OWNER, plus a Project. */
async function seedCorrespondence(level: Level = 'public'): Promise<void> {
  const now = new Date(NOW).toISOString() as Timestamp;
  await new GuardedBatch(bindings.RF_CORE, { id: ADMIN as ULID, now })
    .insert(submissions, { id: SUBMISSION, memberId: OWNER, kind: 'member', startedAt: now, completedAt: now })
    .insert(externalParties, { id: PARTY, name: 'A correspondent', nameFold: 'a correspondent', contactEmail: CONTACT_EMAIL, createdAt: now })
    .insert(units, { id: UNIT, unitType: 'research_item', projectId: PROJECT, rootId: UNIT, ownerId: OWNER, credit: [{ member: OWNER }], submissionId: SUBMISSION, createdAt: now, disclosureLevel: level, classificationState: 'classified', disclosureLine: level === 'withheld' ? { kindOfMaterial: 'correspondence', date: { value: '2026-10-01', approx: false }, partyIds: [] } : null })
    .insert(researchItems, { unitId: UNIT, kind: 'correspondence', itemIdentifier: 'RC-00001', projectId: PROJECT, title: 'A correspondence', itemDateKey: '2026-10-01', logDateKey: '2026-10-01' })
    .insert(correspondences, { unitId: UNIT, date: '2026-10-01', direction: 'sent' })
    .insert(correspondenceParties, { unitId: UNIT, position: 0, partyKind: 'external', partyId: PARTY, consentStatus: 'requested' })
    .commit();
}

/**
 * Seed a Consent_Request (publication) and one item naming the correspondence, with a stored snapshot. The
 * `consent_requests_state_stamp` CHECK ties each non-sent state to its own timestamp column, so the matching
 * stamp is set for the chosen state.
 */
async function seedRequest(options: { state?: string; expiresAt?: number } = {}): Promise<void> {
  const now = new Date(NOW).toISOString();
  const snapshot = { kind: 'publication', key: `u:${UNIT}`, view: { tag: 'research_item', key: `u:${UNIT}`, kind: 'correspondence', title: 'A correspondence' }, partyName: 'A correspondent' };
  const snapshotHash = await sha256Hex(JSON.stringify(snapshot));
  const state = options.state ?? 'sent';
  await bindings.RF_CORE.prepare(`INSERT INTO consent_requests (id, party_id, requested_by, kind, contact_email, token_hash, preview_digest, state, sent_at, expires_at, answered_at, cancelled_at, expired_at, updated_seq)
    VALUES (?1, ?2, ?3, 'publication', ?12, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0)`)
    .bind(
      REQUEST, PARTY, ADMIN, await sha256Hex(TOKEN), snapshotHash, state, now,
      new Date(options.expiresAt ?? NOW + 29 * DAY_MS).toISOString(),
      state === 'answered' ? now : null,
      state === 'cancelled' ? now : null,
      state === 'expired' ? now : null,
      CONTACT_EMAIL,
    )
    .run();
  await bindings.RF_CORE.prepare(`INSERT INTO consent_request_items (id, request_id, unit_id, root_id, position, proposed_values_json, snapshot_json, snapshot_hash, updated_seq)
    VALUES (?1, ?2, ?3, ?3, 0, ?4, ?5, ?6, 0)`)
    .bind(ITEM, REQUEST, UNIT, JSON.stringify({ level: 'public' }), JSON.stringify(snapshot), snapshotHash)
    .run();
}

/** A POST request to the `rf-submit` Worker, as the Consent_Page's browser would send it (token in the body). */
function post(path: string, body: unknown): Request {
  return new Request(`${ORIGIN}${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' } });
}

/** Stub Turnstile `siteverify` to the given outcome; it is the only external fetch the Worker makes. */
function stubSiteverify(success: boolean): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    if (target.includes('siteverify')) return new Response(JSON.stringify({ success }), { status: 200 });
    throw new Error(`unexpected fetch to ${target}`);
  });
}

/** Counts of every write the flow could make, to assert a scanner-style view writes nothing. */
async function writeCounts(): Promise<{ answers: number; withdrawals: number; emails: number; revisions: number; events: number }> {
  const one = async (table: string): Promise<number> =>
    (await bindings.RF_CORE.prepare(`SELECT count(*) AS n FROM ${table}`).first<number>('n')) ?? 0;
  return {
    answers: await one('consent_answers'),
    withdrawals: await one('consent_withdrawals'),
    emails: await one('outgoing_emails'),
    revisions: await one('revisions'),
    events: await one('notification_events'),
  };
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

describe('emailed consent, end to end through handle (task 56.10)', () => {
  it('a scanner-style view of a usable Consent_Link returns the snapshots and writes nothing (R51.5)', async () => {
    await seedCorrespondence();
    await seedRequest();

    const response = await handle(post('/v1/consent/view', { token: TOKEN }), bindings, NOW);
    expect(response.status).toBe(200);
    const body = await response.json<ConsentView>();
    expect(body.kind).toBe('publication');
    expect(body.options).toEqual(['named', 'unnamed', 'refused']);
    expect(body.snapshots).toHaveLength(1);
    expect(body.items).toEqual([{ itemId: ITEM, snapshot: body.snapshots[0] }]);

    // A mail scanner opening the link must change nothing: no answer, no email, no status/level change (R51.5).
    expect(await writeCounts()).toEqual({ answers: 0, withdrawals: 0, emails: 0, revisions: 0, events: 0 });
    const party = await bindings.RF_CORE.prepare('SELECT consent_status AS status FROM correspondence_parties WHERE unit_id = ?1 AND party_id = ?2').bind(UNIT, PARTY).first<{ status: string }>();
    expect(party?.status).toBe('requested');
    const request = await bindings.RF_CORE.prepare('SELECT state FROM consent_requests WHERE id = ?1').bind(REQUEST).first<{ state: string }>();
    expect(request?.state).toBe('sent');
    const unit = await bindings.RF_CORE.prepare('SELECT disclosure_level AS level FROM units WHERE id = ?1').bind(UNIT).first<{ level: string }>();
    expect(unit?.level).toBe('public');
  });

  it('a full "named" answer sets Consent_Status Granted, answers the request, and queues the confirmation to the Contact_Email (R51.8)', async () => {
    await seedCorrespondence();
    await seedRequest();

    const response = await handle(post('/v1/consent/answer', { token: TOKEN, turnstileToken: 'ok', answers: [{ itemId: ITEM, choice: 'named' }] }), bindings, NOW);
    expect(response.status).toBe(201);
    const body = await response.json<ConsentConfirmation>();
    expect(body.recordedAt).toBe(new Date(NOW).toISOString());

    // The Party's Consent_Status becomes Granted, and a named yes keeps the Correspondence Public.
    const party = await bindings.RF_CORE.prepare('SELECT consent_status AS status FROM correspondence_parties WHERE unit_id = ?1 AND party_id = ?2').bind(UNIT, PARTY).first<{ status: string }>();
    expect(party?.status).toBe('granted');
    const unit = await bindings.RF_CORE.prepare('SELECT disclosure_level AS level FROM units WHERE id = ?1').bind(UNIT).first<{ level: string }>();
    expect(unit?.level).toBe('public');

    // The answer row carries the choice and its resulting status.
    const answer = await bindings.RF_CORE.prepare('SELECT choice, result_status AS status FROM consent_answers WHERE item_id = ?1').bind(ITEM).first<{ choice: string; status: string }>();
    expect(answer).toMatchObject({ choice: 'named', status: 'granted' });

    // The request is Answered with a Change_Link.
    const request = await bindings.RF_CORE.prepare('SELECT state, change_token_hash AS changeHash, change_expires_at AS changeExpires FROM consent_requests WHERE id = ?1').bind(REQUEST).first<{ state: string; changeHash: string | null; changeExpires: string | null }>();
    expect(request?.state).toBe('answered');
    expect(request?.changeHash).not.toBeNull();
    expect(request?.changeExpires).not.toBeNull();

    // The confirmation email goes to the Contact_Email only.
    const email = await bindings.RF_CORE.prepare("SELECT kind, recipient FROM outgoing_emails WHERE kind = 'consent_confirmation'").first<{ kind: string; recipient: string }>();
    expect(email).toMatchObject({ kind: 'consent_confirmation', recipient: CONTACT_EMAIL });

    // Item_Update events reach the requesting Administrator and the Owner.
    const events = await bindings.RF_CORE.prepare('SELECT member_id AS memberId, event_type AS type, actor_id AS actorId FROM notification_events').all<{ memberId: string; type: string; actorId: string }>();
    expect(events.results.map((e) => e.memberId).sort()).toEqual([ADMIN, OWNER].sort());
    expect(events.results.every((e) => e.type === 'item_update' && e.actorId === ADMIN)).toBe(true);
  });

  it('a "refused" answer on a Public Correspondence withholds it with a disclosure_change Revision (R51.8)', async () => {
    await seedCorrespondence();
    await seedRequest();

    const response = await handle(post('/v1/consent/answer', { token: TOKEN, turnstileToken: 'ok', answers: [{ itemId: ITEM, choice: 'refused' }] }), bindings, NOW);
    expect(response.status).toBe(201);

    const party = await bindings.RF_CORE.prepare('SELECT consent_status AS status FROM correspondence_parties WHERE unit_id = ?1 AND party_id = ?2').bind(UNIT, PARTY).first<{ status: string }>();
    expect(party?.status).toBe('refused');

    // The Public Correspondence is downgraded to Withheld with a pre-filled Disclosure_Line (R33.5/R34.3 via R51.8).
    const unit = await bindings.RF_CORE.prepare('SELECT disclosure_level AS level, disclosure_line AS line FROM units WHERE id = ?1').bind(UNIT).first<{ level: string; line: string }>();
    expect(unit?.level).toBe('withheld');
    expect(JSON.parse(unit!.line)).toMatchObject({ kindOfMaterial: 'correspondence' });

    // One disclosure_change Revision, attributed to the requesting Administrator.
    const rev = await bindings.RF_CORE.prepare("SELECT count(*) AS n FROM revisions WHERE target_id = ?1 AND kind = 'disclosure_change' AND member_id = ?2").bind(UNIT, ADMIN).first<number>('n');
    expect(rev).toBe(1);

    // The confirmation still goes out.
    const email = await bindings.RF_CORE.prepare("SELECT count(*) AS n FROM outgoing_emails WHERE kind = 'consent_confirmation'").first<number>('n');
    expect(email).toBe(1);
  });

  it('an expired link gets the one fixed "no longer valid" notice at 400 and changes nothing (R51.12)', async () => {
    await seedCorrespondence();
    await seedRequest({ expiresAt: NOW - 1 });

    const view = await handle(post('/v1/consent/view', { token: TOKEN }), bindings, NOW);
    expect(view.status).toBe(400);
    expect((await view.json<ConsentRefusal>())).toEqual({ error: 'invalid_link', message: 'This link is no longer valid.' });

    const answer = await handle(post('/v1/consent/answer', { token: TOKEN, turnstileToken: 'ok', answers: [{ itemId: ITEM, choice: 'named' }] }), bindings, NOW);
    expect(answer.status).toBe(400);
    expect((await answer.json<ConsentRefusal>()).error).toBe('invalid_link');

    expect(await writeCounts()).toEqual({ answers: 0, withdrawals: 0, emails: 0, revisions: 0, events: 0 });
    const party = await bindings.RF_CORE.prepare('SELECT consent_status AS status FROM correspondence_parties WHERE unit_id = ?1 AND party_id = ?2').bind(UNIT, PARTY).first<{ status: string }>();
    expect(party?.status).toBe('requested');
  });

  it('a cancelled link gets the one fixed "no longer valid" notice at 400 and changes nothing (R51.12)', async () => {
    await seedCorrespondence();
    await seedRequest({ state: 'cancelled' });

    const view = await handle(post('/v1/consent/view', { token: TOKEN }), bindings, NOW);
    expect(view.status).toBe(400);
    expect((await view.json<ConsentRefusal>())).toEqual({ error: 'invalid_link', message: 'This link is no longer valid.' });

    const answer = await handle(post('/v1/consent/answer', { token: TOKEN, turnstileToken: 'ok', answers: [{ itemId: ITEM, choice: 'named' }] }), bindings, NOW);
    expect(answer.status).toBe(400);
    expect((await answer.json<ConsentRefusal>()).error).toBe('invalid_link');

    expect(await writeCounts()).toEqual({ answers: 0, withdrawals: 0, emails: 0, revisions: 0, events: 0 });
  });

  it('an already-used (answered) link gets the one fixed "no longer valid" notice and does not record a second answer (R51.12)', async () => {
    await seedCorrespondence();
    await seedRequest();

    // First answer succeeds and spends the Consent_Link.
    const first = await handle(post('/v1/consent/answer', { token: TOKEN, turnstileToken: 'ok', answers: [{ itemId: ITEM, choice: 'named' }] }), bindings, NOW);
    expect(first.status).toBe(201);

    // A second use of the same link — view or answer — gets the fixed refusal and writes no new answer.
    const view = await handle(post('/v1/consent/view', { token: TOKEN }), bindings, NOW + 1000);
    expect(view.status).toBe(400);
    expect((await view.json<ConsentRefusal>()).error).toBe('invalid_link');

    const second = await handle(post('/v1/consent/answer', { token: TOKEN, turnstileToken: 'ok', answers: [{ itemId: ITEM, choice: 'refused' }] }), bindings, NOW + 2000);
    expect(second.status).toBe(400);
    expect((await second.json<ConsentRefusal>()).error).toBe('invalid_link');

    expect(await bindings.RF_CORE.prepare('SELECT count(*) AS n FROM consent_answers').first<number>('n')).toBe(1);
    // The first answer stands unchanged (still granted, still Public).
    const party = await bindings.RF_CORE.prepare('SELECT consent_status AS status FROM correspondence_parties WHERE unit_id = ?1 AND party_id = ?2').bind(UNIT, PARTY).first<{ status: string }>();
    expect(party?.status).toBe('granted');
  });

  it('a withdrawal through the Change_Link downgrades the element and keeps Do_Not_Name on (R51.10)', async () => {
    await seedCorrespondence();
    await seedRequest();

    // Answer "do not name me" through the router, so Do_Not_Name is on before the withdrawal.
    const answer = await handle(post('/v1/consent/answer', { token: TOKEN, turnstileToken: 'ok', answers: [{ itemId: ITEM, choice: 'unnamed' }], genericLabel: 'a wartime correspondent' }), bindings, NOW);
    expect(answer.status).toBe(201);
    const afterAnswer = await bindings.RF_CORE.prepare('SELECT do_not_name AS dnn, generic_label AS label FROM external_parties WHERE id = ?1').bind(PARTY).first<{ dnn: number; label: string }>();
    expect(afterAnswer).toMatchObject({ dnn: 1, label: 'a wartime correspondent' });
    // A named-but-unnamed yes keeps the Correspondence Public until the withdrawal.
    const beforeWithdrawal = await bindings.RF_CORE.prepare('SELECT disclosure_level AS level FROM units WHERE id = ?1').bind(UNIT).first<{ level: string }>();
    expect(beforeWithdrawal?.level).toBe('public');

    // Recover the Change_Link token from the confirmation email's payload_ref (it lives only in the email).
    const email = await bindings.RF_CORE.prepare("SELECT payload_ref AS ref FROM outgoing_emails WHERE kind = 'consent_confirmation'").first<{ ref: string }>();
    const changeToken = email!.ref.slice(email!.ref.indexOf('#') + 1);
    expect(changeToken).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    // The Change_Link view shows the stored snapshot (writes nothing).
    const changeView = await handle(post('/v1/consent/change/view', { token: changeToken }), bindings, NOW + 1000);
    expect(changeView.status).toBe(200);
    expect((await changeView.json<ConsentView>()).snapshots).toHaveLength(1);

    // The withdrawal.
    const withdrawal = await handle(post('/v1/consent/change', { token: changeToken, turnstileToken: 'ok' }), bindings, NOW + 2000);
    expect(withdrawal.status).toBe(201);

    // The consent is Refused and the Public Correspondence is downgraded to Withheld.
    const party = await bindings.RF_CORE.prepare('SELECT consent_status AS status FROM correspondence_parties WHERE unit_id = ?1 AND party_id = ?2').bind(UNIT, PARTY).first<{ status: string }>();
    expect(party?.status).toBe('refused');
    const unit = await bindings.RF_CORE.prepare('SELECT disclosure_level AS level FROM units WHERE id = ?1').bind(UNIT).first<{ level: string }>();
    expect(unit?.level).toBe('withheld');

    // Do_Not_Name stays on through the withdrawal (R51.10), and a withdrawal row is recorded.
    const external = await bindings.RF_CORE.prepare('SELECT do_not_name AS dnn FROM external_parties WHERE id = ?1').bind(PARTY).first<{ dnn: number }>();
    expect(external?.dnn).toBe(1);
    const withdrawn = await bindings.RF_CORE.prepare('SELECT count(*) AS n FROM consent_withdrawals WHERE item_id = ?1').bind(ITEM).first<number>('n');
    expect(withdrawn).toBe(1);

    // A second withdrawal through the now-spent Change_Link gets the fixed refusal and records nothing more.
    const second = await handle(post('/v1/consent/change', { token: changeToken, turnstileToken: 'ok' }), bindings, NOW + 3000);
    expect(second.status).toBe(400);
    expect((await second.json<ConsentRefusal>()).error).toBe('invalid_link');
    expect(await bindings.RF_CORE.prepare('SELECT count(*) AS n FROM consent_withdrawals').first<number>('n')).toBe(1);
  });
});
