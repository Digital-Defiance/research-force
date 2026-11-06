// Feature: research-collab-cms, Property 107: Consent links record only explicit answers and change exactly what was asked
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach, afterEach, describe, expect, inject, it, vi } from 'vitest';
import { fc } from '@researchforce/testing/fc';
import type { D1Migration } from 'cloudflare:test';
import { RIGHTS_PERMISSION_GRANTED_ID, RIGHTS_RESTRICTED_ID } from '@researchforce/db/consent/answer';
import { answerConsent, changeConsent, viewChange, viewConsent } from '../../src/consent';
import type { ConsentConfirmation, ConsentRefusal, ConsentView } from '../../src/consent';
import type { Env } from '../../src/index';

/**
 * Property 107: Consent links record only explicit answers and change exactly what was asked
 * (Validates: Requirements 51.3, 51.4, 51.5, 51.6, 51.7, 51.8, 51.10, 51.11, 51.12).
 *
 * A Consent_Link records ONLY the explicit answers the person gave and changes EXACTLY what was asked, nothing
 * more. Across arbitrary sequences of valid, malformed, unknown, expired, used, cancelled, and final-decided
 * tokens, and arbitrary per-element answer choices, the invariants are:
 *
 *   - An unusable token always yields the ONE fixed "no longer valid" refusal and writes nothing, whether it is
 *     viewed or submitted (R51.5, R51.12): a malformed string, an unknown hash, a Consent_Link expired past 30
 *     days, a request already answered, cancelled, or expired, or a Change_Link that is unanswered or already
 *     fully withdrawn.
 *   - A missing or failed Bot_Check (Turnstile) refuses and writes nothing (R51.6).
 *   - A successful answer records exactly one append-only `consent_answers` row per answered element with the
 *     submitted choice; the Consent_Status or Rights_Status of each answered unit changes exactly as its choice
 *     dictates and NO other unit's status changes; `unnamed` turns on Do_Not_Name with the Generic_Label; a
 *     refusal (or a rights no) downgrades only a Public element to Withheld; the request becomes Answered with a
 *     Change_Link expiry of the answer plus 12 months (R51.6, R51.7, R51.8).
 *   - The Consent_Link is single-use: a second answer through the same link is refused and writes nothing more
 *     (R51.12). A Change_Link withdrawal likewise sets each answered unit to Refused/Restricted, keeps
 *     Do_Not_Name on, and is single-use (R51.10, R51.12).
 *   - A cancelled or expired request leaves every Consent_Status and Rights_Status unchanged (R51.11).
 *
 * The real `answerConsent`/`changeConsent`/`viewConsent`/`viewChange` paths drive a real local D1 through the
 * shared batch builder, so the property exercises the single-use guard, the append-only rows, and the status,
 * downgrade, and email effects exactly as production does.
 *
 * fast-check runs each property many times (FC_RUNS, at least 100) within one `it`. The Workers-pool D1 is
 * shared across every run, so each run MUST reset the seeded tables at its START — not only in `beforeEach`,
 * which fires once per `it`. Without that, rows from earlier runs leak in: a second run's seed of the same
 * party, unit, or request id collides on the primary key, and the status of a unit touched by an earlier run is
 * observed instead of the untouched baseline. Every property below therefore calls `reset()` first thing.
 */

declare module 'vitest' {
  export interface ProvidedContext { d1Migrations: { core: D1Migration[]; search: D1Migration[]; public: D1Migration[] } }
}

const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;
const ORIGIN = 'https://submit.researchforce.org';
const ADMIN = '0000000000000000000000ADM1';
const OWNER = '0000000000000000000000OWN1';
const ADMIN_ROLE = '00000000000000000000000007';
const CONTRIB_ROLE = '00000000000000000000000006';
const PROJECT = '0000000000000000000000PRJ1';
const RELIABILITY_HIGH = '0000000000000000000000Q001';
const RIGHTS_UNKNOWN = '00000000000000000000000005';
const CONTACT = 'party@example.test';
/** The one fixed refusal every unusable link gets, revealing nothing about the request (R51.12). */
const FIXED = { error: 'invalid_link', message: 'This link is no longer valid.' };
/** The tables a run seeds and must therefore clear at its start, so one run never inherits another's rows. */
const SEEDED_TABLES = [
  'consent_answers', 'consent_withdrawals', 'consent_request_items', 'consent_requests',
  'correspondence_parties', 'correspondences', 'sources', 'attachments', 'research_items', 'units',
  'external_parties', 'submissions', 'outgoing_emails', 'outbox', 'notification_events', 'revisions',
];

let bindings: Env;

/** A 128-bit-shaped hex id; fresh per call so seeded rows and tokens never clash across runs. */
function hexId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}
/** A 26-char Crockford-base32 id for seeding units, parties, and requests directly. */
function ulidish(): string {
  return hexId().toUpperCase().replace(/[^0-9A-HJKMNP-TV-Z]/g, '0').padEnd(26, '0').slice(0, 26);
}
/** A valid 128-bit Crockford-base32 Consent_Link / Change_Link token (26 chars), as the sender mints it. */
function validToken(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  return Array.from(crypto.getRandomValues(new Uint8Array(26)), (b) => alphabet[b % 32]).join('');
}
async function sha256Hex(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
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

/**
 * Clear every seeded data table so one property run never inherits another run's rows (the shared-D1 reset).
 * The two Members are seeded once per `it` in `beforeEach` and left in place, so their unique email index is
 * never re-inserted; only the per-run request, unit, party, and effect rows are cleared here.
 */
async function reset(): Promise<void> {
  await bindings.RF_CORE.batch(SEEDED_TABLES.map((t) => bindings.RF_CORE.prepare(`DELETE FROM ${t}`)));
}

async function seedMembers(): Promise<void> {
  const now = new Date(NOW).toISOString();
  const member = (id: string, role: string) =>
    bindings.RF_CORE.prepare(`INSERT INTO members (id, email, email_lc, role_id, status, created_at, updated_seq)
      VALUES (?1, ?2, ?2, ?3, 'active', ?4, 0)`).bind(id, `${id}@example.test`, role, now);
  await bindings.RF_CORE.batch([member(ADMIN, ADMIN_ROLE), member(OWNER, CONTRIB_ROLE)]);
}

/** One External_Party (consent not yet set), owned by OWNER through a seeded Submission. */
async function seedParty(partyId: string): Promise<void> {
  const now = new Date(NOW).toISOString();
  await bindings.RF_CORE.prepare(`INSERT INTO external_parties (id, name, name_fold, do_not_name, generic_label, contact_email, created_at, rev, updated_seq)
    VALUES (?1, 'A correspondent', 'a correspondent', 0, NULL, ?2, ?3, 1, 0)`).bind(partyId, CONTACT, now).run();
}

/** One Submission row the seeded units point at. */
async function seedSubmission(submissionId: string): Promise<void> {
  const now = new Date(NOW).toISOString();
  await bindings.RF_CORE.prepare(`INSERT INTO submissions (id, member_id, kind, started_at, completed_at)
    VALUES (?1, ?2, 'member', ?3, ?3)`).bind(submissionId, OWNER, now).run();
}

/** One Correspondence unit at `level`, with the External_Party as its one external Party (consent 'requested'). */
async function seedCorrespondence(unitId: string, partyId: string, submissionId: string, level: string): Promise<void> {
  const now = new Date(NOW).toISOString();
  const line = level === 'withheld' ? JSON.stringify({ kindOfMaterial: 'correspondence', date: { value: '2026-10-01', approx: false }, partyIds: [] }) : null;
  await bindings.RF_CORE.prepare(`INSERT INTO units (id, unit_type, project_id, root_id, owner_id, credit, submission_id, created_at, disclosure_level, classification_state, disclosure_line, rev, updated_seq)
    VALUES (?1, 'research_item', ?2, ?1, ?3, ?4, ?5, ?6, ?7, 'classified', ?8, 1, 0)`)
    .bind(unitId, PROJECT, OWNER, JSON.stringify([{ member: OWNER }]), submissionId, now, level, line).run();
  await bindings.RF_CORE.prepare(`INSERT INTO research_items (unit_id, kind, item_identifier, project_id, title, item_date_key, log_date_key)
    VALUES (?1, 'correspondence', ?2, ?3, 'A correspondence', '2026-10-01', '2026-10-01')`).bind(unitId, `RC-${hexId().slice(0, 8)}`, PROJECT).run();
  await bindings.RF_CORE.prepare("INSERT INTO correspondences (unit_id, date, direction) VALUES (?1, '2026-10-01', 'sent')").bind(unitId).run();
  await bindings.RF_CORE.prepare(`INSERT INTO correspondence_parties (unit_id, position, party_kind, party_id, consent_status)
    VALUES (?1, 0, 'external', ?2, 'requested')`).bind(unitId, partyId).run();
}

/**
 * One Attachment unit at `level`, its Rights_Status Unknown so a grant/refusal changes it. An Attachment is a
 * child unit, so it hangs under a Source Research_Item as its Root_Item (the `units_root_shape` CHECK forbids a
 * non-research_item from being its own root). The returned `rootId` is that Source, which the Consent_Request
 * item carries. The downgrade and Rights_Status both act on the Attachment unit itself.
 */
async function seedAttachment(unitId: string, submissionId: string, level: string): Promise<string> {
  const now = new Date(NOW).toISOString();
  const rootId = ulidish();
  // The Root_Item: a Source Research_Item that owns the Version_Chain the Attachment belongs to.
  await bindings.RF_CORE.prepare(`INSERT INTO units (id, unit_type, project_id, root_id, owner_id, credit, submission_id, created_at, disclosure_level, classification_state, rev, updated_seq)
    VALUES (?1, 'research_item', ?2, ?1, ?3, ?4, ?5, ?6, 'not_published', 'classified', 1, 0)`)
    .bind(rootId, PROJECT, OWNER, JSON.stringify([{ member: OWNER }]), submissionId, now).run();
  await bindings.RF_CORE.prepare(`INSERT INTO research_items (unit_id, kind, item_identifier, project_id, title, item_date_key, log_date_key)
    VALUES (?1, 'source', ?2, ?3, 'A source', '2026-10-01', '2026-10-01')`).bind(rootId, `RS-${hexId().slice(0, 8)}`, PROJECT).run();
  await bindings.RF_CORE.prepare(`INSERT INTO sources (unit_id, source_kind, reliability_id, rights_status_id)
    VALUES (?1, 'primary', ?2, ?3)`).bind(rootId, RELIABILITY_HIGH, RIGHTS_UNKNOWN).run();
  // The Attachment unit: a child of the Source, at the given Disclosure_Level, with its own Rights_Status.
  const line = level === 'withheld' ? JSON.stringify({ kindOfMaterial: 'PDF', date: { value: '2026-10-01', approx: false }, partyIds: [] }) : null;
  await bindings.RF_CORE.prepare(`INSERT INTO units (id, unit_type, project_id, root_id, parent_id, owner_id, credit, submission_id, created_at, disclosure_level, classification_state, disclosure_line, rev, updated_seq)
    VALUES (?1, 'attachment', ?2, ?3, ?3, ?4, ?5, ?6, ?7, ?8, 'classified', ?9, 1, 0)`)
    .bind(unitId, PROJECT, rootId, OWNER, JSON.stringify([{ member: OWNER }]), submissionId, now, level, line).run();
  await bindings.RF_CORE.prepare(`INSERT INTO attachments (unit_id, item_identifier, title, file_kind, original_name, size_bytes, sha256, r2_key, origin, uploaded_at, rights_status_id, chain_id)
    VALUES (?1, ?2, 'A file', 'pdf', 'a.pdf', 1, ?3, ?4, 'upload', ?5, ?6, ?1)`)
    .bind(unitId, `AT-${hexId().slice(0, 8)}`, '0'.repeat(64), `synthetic/${unitId}`, now, RIGHTS_UNKNOWN).run();
  return rootId;
}

/** The stored Consent_Page snapshot for one element, and its SHA-256 (as the sender froze it). */
async function snapshotFor(unitId: string, kind: 'publication' | 'rights'): Promise<{ json: string; hash: string }> {
  const snapshot = kind === 'publication'
    ? { kind: 'publication', key: `u:${unitId}`, view: { tag: 'research_item', key: `u:${unitId}`, kind: 'correspondence', title: 'A correspondence' }, partyName: 'A correspondent' }
    : { kind: 'rights', key: `u:${unitId}`, view: { tag: 'attachment', key: `u:${unitId}`, title: 'A file' } };
  const json = JSON.stringify(snapshot);
  return { json, hash: await sha256Hex(json) };
}

interface SeededItem { readonly itemId: string; readonly unitId: string; readonly level: string; }

/** The seeded request and its items; the token is the plaintext Consent_Link (never stored). */
interface Seeded {
  readonly requestId: string;
  readonly partyId: string;
  readonly token: string;
  readonly kind: 'publication' | 'rights';
  readonly items: readonly SeededItem[];
}

/**
 * Seed one Consent_Request of `kind` naming `count` units at the given per-element Disclosure_Levels, in the
 * given `state`, with its Consent_Link token. Each element gets its stored snapshot, exactly as the request
 * would have frozen it. Returns everything the assertions need, including the plaintext token.
 */
async function seedRequest(options: {
  kind: 'publication' | 'rights';
  levels: readonly string[];
  state?: string;
  expiresAt?: number;
}): Promise<Seeded> {
  const { kind, levels } = options;
  const state = options.state ?? 'sent';
  const now = new Date(NOW).toISOString();
  const partyId = ulidish();
  const submissionId = ulidish();
  const requestId = ulidish();
  const token = validToken();
  await seedParty(partyId);
  await seedSubmission(submissionId);

  const items: SeededItem[] = [];
  const digests: string[] = [];
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i]!;
    const unitId = ulidish();
    // A Correspondence is its own Root_Item; an Attachment's root is the Source that owns it.
    let rootId = unitId;
    if (kind === 'publication') await seedCorrespondence(unitId, partyId, submissionId, level);
    else rootId = await seedAttachment(unitId, submissionId, level);
    const snap = await snapshotFor(unitId, kind);
    const itemId = ulidish();
    await bindings.RF_CORE.prepare(`INSERT INTO consent_request_items (id, request_id, unit_id, root_id, position, proposed_values_json, snapshot_json, snapshot_hash, updated_seq)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0)`)
      .bind(itemId, requestId, unitId, rootId, i, JSON.stringify({ level: 'public' }), snap.json, snap.hash).run();
    items.push({ itemId, unitId, level });
    digests.push(snap.hash);
  }
  const previewDigest = await sha256Hex(digests.join(''));
  const expiresAt = new Date(options.expiresAt ?? NOW + 29 * DAY_MS).toISOString();
  await bindings.RF_CORE.prepare(`INSERT INTO consent_requests (id, party_id, requested_by, kind, contact_email, token_hash, preview_digest, state, sent_at, expires_at, answered_at, cancelled_at, expired_at, updated_seq)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0)`)
    .bind(
      requestId, partyId, ADMIN, kind, CONTACT, await sha256Hex(token), previewDigest, state, now, expiresAt,
      state === 'answered' ? now : null, state === 'cancelled' ? now : null, state === 'expired' ? now : null,
    ).run();
  return { requestId, partyId, token, kind, items };
}

/** The current statuses of every unit (by id), for an exact before/after comparison of what changed. */
async function unitLevels(): Promise<Map<string, string>> {
  const rows = await bindings.RF_CORE.prepare('SELECT id, disclosure_level AS level FROM units').all<{ id: string; level: string }>();
  return new Map(rows.results.map((r) => [r.id, r.level]));
}
async function consentStatusOf(unitId: string, partyId: string): Promise<string | null> {
  const row = await bindings.RF_CORE.prepare('SELECT consent_status AS s FROM correspondence_parties WHERE unit_id = ?1 AND party_id = ?2').bind(unitId, partyId).first<{ s: string }>();
  return row?.s ?? null;
}
async function rightsStatusOf(unitId: string): Promise<string | null> {
  const row = await bindings.RF_CORE.prepare('SELECT rights_status_id AS s FROM attachments WHERE unit_id = ?1').bind(unitId).first<{ s: string }>();
  return row?.s ?? null;
}
async function countRows(table: string): Promise<number> {
  return (await bindings.RF_CORE.prepare(`SELECT count(*) AS n FROM ${table}`).first<number>('n')) ?? 0;
}

/** Recover the Change_Link token from the confirmation email's payload ref (`...:{changeUrl}`), after the `#`. */
async function changeTokenFromEmail(): Promise<string> {
  const email = await bindings.RF_CORE.prepare("SELECT payload_ref AS ref FROM outgoing_emails WHERE kind = 'consent_confirmation' ORDER BY created_at DESC").first<{ ref: string }>();
  const ref = email!.ref;
  return ref.slice(ref.indexOf('#') + 1);
}

/** The per-element choice a publication or rights request offers. */
const PUBLICATION_CHOICES = ['named', 'unnamed', 'refused'] as const;
const RIGHTS_CHOICES = ['granted', 'refused'] as const;

beforeEach(async () => {
  const migrations = inject('d1Migrations');
  bindings = env as unknown as Env;
  await applyD1Migrations(bindings.RF_CORE, migrations.core);
  Object.assign(bindings, { TURNSTILE_SECRET: 'synthetic' });
  await bindings.RF_CORE.prepare('DELETE FROM members').run();
  await reset();
  await seedMembers();
  stubSiteverify(true);
});

afterEach(() => { vi.restoreAllMocks(); });

describe('Property 107: an unusable link writes nothing and gets the one fixed refusal (R51.5, R51.11, R51.12)', () => {
  it('refuses a malformed, unknown, expired, answered, cancelled, or expired-state link on view and on answer', async () => {
    // A tagged union of the unusable-token kinds; each must refuse identically and leave every status untouched.
    const unusable = fc.oneof(
      fc.constant({ tag: 'malformed' as const }),
      fc.constant({ tag: 'unknown' as const }),
      fc.constant({ tag: 'expired' as const }),
      fc.constant({ tag: 'answered' as const }),
      fc.constant({ tag: 'cancelled' as const }),
      fc.constant({ tag: 'expired_state' as const }),
    );
    await fc.assert(fc.asyncProperty(unusable, fc.constantFrom('publication', 'rights'), async (unusableKind, kind) => {
      await reset();
      let token: string;
      let seeded: Seeded | null = null;
      if (unusableKind.tag === 'malformed') {
        token = 'not a valid token!!';
      } else if (unusableKind.tag === 'unknown') {
        token = validToken(); // never seeded, so its hash is unknown
      } else if (unusableKind.tag === 'expired') {
        seeded = await seedRequest({ kind: kind as 'publication' | 'rights', levels: ['public'], expiresAt: NOW - 1 });
        token = seeded.token;
      } else {
        const state = unusableKind.tag === 'answered' ? 'answered' : unusableKind.tag === 'cancelled' ? 'cancelled' : 'expired';
        seeded = await seedRequest({ kind: kind as 'publication' | 'rights', levels: ['public'], state });
        token = seeded.token;
      }

      const before = await unitLevels();
      // The view refuses and writes nothing.
      const viewed = await viewConsent(bindings, token, NOW);
      expect(isView(viewed)).toBe(false);
      expect(viewed).toEqual(FIXED);
      // The answer refuses and writes nothing, whatever body is posted.
      const answers = seeded ? seeded.items.map((item) => ({ itemId: item.itemId, choice: 'refused' })) : [];
      const answered = await answerConsent(bindings, ORIGIN, { token, turnstileToken: 'ok', answers }, NOW);
      expect(isConfirmation(answered)).toBe(false);
      expect(answered).toEqual(FIXED);

      // Nothing is written, and no unit's Disclosure_Level changed (R51.11, R51.12).
      expect(await countRows('consent_answers')).toBe(0);
      expect(await countRows('consent_withdrawals')).toBe(0);
      expect(await countRows('revisions')).toBe(0);
      expect(await countRows('outgoing_emails')).toBe(0);
      expect(await unitLevels()).toEqual(before);
    }));
  });

  it('refuses a Change_Link that is unanswered or already fully withdrawn, writing nothing more', async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom('publication', 'rights'), async (kind) => {
      await reset();
      // An unanswered request has no Change_Link, so even its (non-change) token refuses on the change path.
      const unanswered = await seedRequest({ kind: kind as 'publication' | 'rights', levels: ['public'] });
      const beforeView = await viewChange(bindings, unanswered.token, NOW);
      expect(beforeView).toEqual(FIXED);
      const beforeChange = await changeConsent(bindings, ORIGIN, { token: unanswered.token, turnstileToken: 'ok' }, NOW);
      expect(beforeChange).toEqual(FIXED);
      expect(await countRows('consent_withdrawals')).toBe(0);
    }));
  });
});

describe('Property 107: a Bot_Check failure refuses and writes nothing (R51.6)', () => {
  it('refuses an answer when Turnstile is not satisfied, leaving every status untouched', async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom('publication', 'rights'), fc.boolean(), async (kind, failMode) => {
      await reset();
      const seeded = await seedRequest({ kind: kind as 'publication' | 'rights', levels: ['public'] });
      const before = await unitLevels();
      // Either the verification fetch reports failure, or the secret is absent so no token is even possible.
      if (failMode) stubSiteverify(false);
      else Object.assign(bindings, { TURNSTILE_SECRET: '' });
      const answers = seeded.items.map((item) => ({ itemId: item.itemId, choice: 'refused' }));
      const result = await answerConsent(bindings, ORIGIN, { token: seeded.token, turnstileToken: 'ok', answers }, NOW);
      expect(isConfirmation(result)).toBe(false);
      expect((result as ConsentRefusal).error).toBe('bot_check');
      expect(await countRows('consent_answers')).toBe(0);
      expect(await countRows('revisions')).toBe(0);
      expect(await unitLevels()).toEqual(before);
      // Restore for the next run.
      Object.assign(bindings, { TURNSTILE_SECRET: 'synthetic' });
      stubSiteverify(true);
    }));
  });
});

describe('Property 107: an answer records exactly the choices given and changes exactly those units (R51.6, R51.7, R51.8)', () => {
  it('records one row per element, changes each answered unit as its choice dictates, and touches no other unit', async () => {
    const publicationChoice = fc.record({ level: fc.constantFrom('public', 'withheld', 'not_published'), choice: fc.constantFrom(...PUBLICATION_CHOICES) });
    const rightsChoice = fc.record({ level: fc.constantFrom('public', 'withheld', 'not_published'), choice: fc.constantFrom(...RIGHTS_CHOICES) });
    await fc.assert(fc.asyncProperty(
      fc.constantFrom('publication', 'rights'),
      fc.array(fc.oneof(publicationChoice, rightsChoice), { minLength: 1, maxLength: 4 }),
      fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: undefined }),
      async (kind, picks, rawLabel) => {
        await reset();
        const typed = kind as 'publication' | 'rights';
        // Keep only the choices valid for the kind; ensure at least one element.
        const valid = (kind === 'publication' ? PUBLICATION_CHOICES : RIGHTS_CHOICES) as readonly string[];
        const elements = picks.filter((p) => valid.includes(p.choice)).slice(0, 4);
        if (elements.length === 0) elements.push({ level: 'public', choice: kind === 'publication' ? 'refused' : 'refused' });
        const genericLabel = rawLabel === undefined || rawLabel.trim() === '' ? undefined : rawLabel;

        // Seed one noise request that is NOT answered, so we can assert its units never change.
        const noise = await seedRequest({ kind: typed, levels: ['public'] });

        const seeded = await seedRequest({ kind: typed, levels: elements.map((e) => e.level) });
        const before = await unitLevels();
        const answers = seeded.items.map((item, i) => ({ itemId: item.itemId, choice: elements[i]!.choice }));
        const result = await answerConsent(bindings, ORIGIN, { token: seeded.token, turnstileToken: 'ok', answers, genericLabel }, NOW);
        expect(isConfirmation(result)).toBe(true);

        // Exactly one append-only answer row per answered element, each carrying its submitted choice (R51.7).
        expect(await countRows('consent_answers')).toBe(elements.length);
        for (let i = 0; i < elements.length; i++) {
          const item = seeded.items[i]!;
          const row = await bindings.RF_CORE.prepare('SELECT choice, result_status AS status FROM consent_answers WHERE item_id = ?1').bind(item.itemId).first<{ choice: string; status: string }>();
          const choice = elements[i]!.choice;
          expect(row?.choice).toBe(choice);
          if (typed === 'publication') {
            const expectedStatus = choice === 'refused' ? 'refused' : 'granted';
            expect(row?.status).toBe(expectedStatus);
            expect(await consentStatusOf(item.unitId, seeded.partyId)).toBe(expectedStatus);
          } else {
            const expectedStatus = choice === 'granted' ? 'granted' : 'refused';
            expect(row?.status).toBe(expectedStatus);
            expect(await rightsStatusOf(item.unitId)).toBe(choice === 'granted' ? RIGHTS_PERMISSION_GRANTED_ID : RIGHTS_RESTRICTED_ID);
          }

          // A refusal (or rights no) downgrades ONLY a Public element to Withheld; a yes keeps the level (R51.8).
          const loses = choice === 'refused';
          const after = (await unitLevels()).get(item.unitId);
          if (loses && item.level === 'public') expect(after).toBe('withheld');
          else expect(after).toBe(item.level);
        }

        // Do_Not_Name is on exactly when some element was answered `unnamed` (publication only) (R51.7).
        const anyUnnamed = typed === 'publication' && elements.some((e) => e.choice === 'unnamed');
        const party = await bindings.RF_CORE.prepare('SELECT do_not_name AS dnn, generic_label AS label FROM external_parties WHERE id = ?1').bind(seeded.partyId).first<{ dnn: number; label: string | null }>();
        expect(party?.dnn).toBe(anyUnnamed ? 1 : 0);
        if (anyUnnamed) {
          // The given label, or "a correspondent" when none was given (R51.7).
          expect(party?.label).toBe(genericLabel ?? 'a correspondent');
        }

        // The request is Answered with a Change_Link whose expiry is the answer plus 12 months (R51.8).
        const req = await bindings.RF_CORE.prepare('SELECT state, change_token_hash AS hash, change_expires_at AS exp FROM consent_requests WHERE id = ?1').bind(seeded.requestId).first<{ state: string; hash: string | null; exp: string | null }>();
        expect(req?.state).toBe('answered');
        expect(req?.hash).not.toBeNull();
        expect(Date.parse(req!.exp!)).toBe(NOW + 12 * 30 * DAY_MS);

        // A confirmation email went to the Contact_Email only (R51.8).
        const email = await bindings.RF_CORE.prepare("SELECT recipient FROM outgoing_emails WHERE kind = 'consent_confirmation'").first<{ recipient: string }>();
        expect(email?.recipient).toBe(CONTACT);

        // The noise request's units were NOT touched: nothing beyond exactly what was asked changed (R51.7).
        for (const item of noise.items) {
          expect((await unitLevels()).get(item.unitId)).toBe(before.get(item.unitId));
          if (typed === 'publication') expect(await consentStatusOf(item.unitId, noise.partyId)).toBe('requested');
          else expect(await rightsStatusOf(item.unitId)).toBe(RIGHTS_UNKNOWN);
        }
      },
    ));
  });
});

describe('Property 107: a link is single-use for answers and withdrawals (R51.10, R51.12)', () => {
  it('refuses a second answer through the same Consent_Link, writing exactly one answer', async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom('publication', 'rights'), async (kind) => {
      await reset();
      const typed = kind as 'publication' | 'rights';
      const seeded = await seedRequest({ kind: typed, levels: ['public'] });
      const firstChoice = typed === 'publication' ? 'named' : 'granted';
      const answers = seeded.items.map((item) => ({ itemId: item.itemId, choice: firstChoice }));
      const first = await answerConsent(bindings, ORIGIN, { token: seeded.token, turnstileToken: 'ok', answers }, NOW);
      expect(isConfirmation(first)).toBe(true);

      const second = await answerConsent(bindings, ORIGIN, { token: seeded.token, turnstileToken: 'ok', answers: seeded.items.map((item) => ({ itemId: item.itemId, choice: 'refused' })) }, NOW + 1000);
      expect(second).toEqual(FIXED);
      expect(await countRows('consent_answers')).toBe(1);
    }));
  });

  it('a withdrawal sets each answered unit to Refused/Restricted, keeps Do_Not_Name on, and is single-use', async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom('publication', 'rights'), async (kind) => {
      await reset();
      const typed = kind as 'publication' | 'rights';
      const seeded = await seedRequest({ kind: typed, levels: ['public'] });
      // Answer with a yes first (unnamed for publication, so Do_Not_Name is on before the withdrawal).
      const yes = typed === 'publication' ? 'unnamed' : 'granted';
      const answers = seeded.items.map((item) => ({ itemId: item.itemId, choice: yes }));
      await answerConsent(bindings, ORIGIN, { token: seeded.token, turnstileToken: 'ok', answers, genericLabel: 'a correspondent' }, NOW);

      const changeToken = await changeTokenFromEmail();
      const withdrew = await changeConsent(bindings, ORIGIN, { token: changeToken, turnstileToken: 'ok' }, NOW + 1000);
      expect(isConfirmation(withdrew)).toBe(true);
      expect(await countRows('consent_withdrawals')).toBe(seeded.items.length);

      for (const item of seeded.items) {
        if (typed === 'publication') {
          expect(await consentStatusOf(item.unitId, seeded.partyId)).toBe('refused');
          // Do_Not_Name stays on through a withdrawal (R51.10).
          const party = await bindings.RF_CORE.prepare('SELECT do_not_name AS dnn FROM external_parties WHERE id = ?1').bind(seeded.partyId).first<{ dnn: number }>();
          expect(party?.dnn).toBe(1);
        } else {
          expect(await rightsStatusOf(item.unitId)).toBe(RIGHTS_RESTRICTED_ID);
        }
        // A Public element is downgraded to Withheld by the withdrawal (R51.10, R51.8).
        expect((await unitLevels()).get(item.unitId)).toBe('withheld');
      }

      // A second withdrawal through the now-spent Change_Link is refused, writing no further rows (R51.12).
      const second = await changeConsent(bindings, ORIGIN, { token: changeToken, turnstileToken: 'ok' }, NOW + 2000);
      expect(second).toEqual(FIXED);
      expect(await countRows('consent_withdrawals')).toBe(seeded.items.length);
    }));
  });
});
