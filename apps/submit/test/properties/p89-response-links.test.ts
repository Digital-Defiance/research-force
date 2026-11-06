// Feature: research-collab-cms, Property 89: Response_Link validity
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach, describe, expect, inject, it } from 'vitest';
import { fc } from '@researchforce/testing/fc';
import type { D1Migration } from 'cloudflare:test';
import { checkLink, respondSubmit } from '../../src/respond';
import type { CheckResult, RespondConfirmation, RespondRefusal } from '../../src/respond';
import type { Env } from '../../src/index';

/**
 * Property 89: Response_Link validity (Validates: Requirements 32.14).
 *
 * A Response_Link (minted on a More_Information_Requested Moderation_Decision) is usable EXACTLY when its token
 * is well-formed and its SHA-256 hash matches a stored `response_links` row, the link has not expired (valid
 * 30 days), it has not already been responded through (single-use), and its Outside_Submission has no Accepted
 * or Rejected (final) Moderation_Decision. The invariants, over arbitrary token states, are:
 *
 *   - An unusable Response_Link — malformed, unknown, expired past 30 days, already used, or whose submission
 *     is finally decided — always yields a refusal on BOTH `/check` and `/submit` and writes NOTHING: no
 *     response row, no files touched, no events, and the link is never marked used. An unknown or malformed
 *     token gets the one fixed "no longer valid" refusal.
 *   - A usable link's `/check` reports usable and writes nothing. A `/submit` through it attaches exactly one
 *     response with its receipt time, marks the link used (single-use), and fans out Outside_Submission events:
 *     one per Administrator, plus the Responsible_Person on a Removal_Request.
 *   - The link is single-use: a second response through the same link is refused and attaches nothing further.
 *   - Only the token's SHA-256 hash is ever stored or compared; the plaintext token is never stored.
 *
 * The real `checkLink`/`respondSubmit` paths drive a real local D1 through the shared Outside_Submission events
 * builder, so the property exercises the usability guard, the single-use mark, the append-only response, and
 * the event fan-out exactly as production does.
 *
 * fast-check runs each property many times (FC_RUNS, at least 100) within one `it`. The Workers-pool D1 is
 * shared across every run, so each run MUST reset the seeded tables at its START — not only in `beforeEach`,
 * which fires once per `it`. Without that, rows from earlier runs leak in and a run's seed collides on a
 * primary key, or an earlier run's response/used mark is observed instead of the untouched baseline. Every
 * property below therefore calls `reset()` first thing.
 */

declare module 'vitest' {
  export interface ProvidedContext { d1Migrations: { core: D1Migration[]; search: D1Migration[]; public: D1Migration[] } }
}

const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;
const ADMIN_A = '0000000000000000000000ADM1';
const ADMIN_B = '0000000000000000000000ADM2';
const RESPONSIBLE = '0000000000000000000000RES1';
const ADMIN_ROLE = '00000000000000000000000007';
const CONTRIB_ROLE = '00000000000000000000000006';
/** The one fixed refusal a malformed or unknown token gets, revealing nothing about any Outside_Submission. */
const FIXED = { error: 'invalid_link', message: 'This response link is no longer valid.' };
/** The tables a run seeds and must therefore clear at its start, so one run never inherits another's rows. */
const SEEDED_TABLES = [
  'outside_files', 'outside_sessions', 'outside_responses', 'moderation_decisions', 'response_links',
  'outside_submissions', 'notification_events', 'settings',
];

let bindings: Env;

/** A 128-bit-shaped hex id; fresh per call so seeded ids and r2 keys never clash across runs. */
function hexId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}
/** A 26-char Crockford-base32 id for seeding submissions, decisions, and sessions directly. */
function ulidish(): string {
  return hexId().toUpperCase().replace(/[^0-9A-HJKMNP-TV-Z]/g, '0').padEnd(26, '0').slice(0, 26);
}
/** A valid 128-bit Crockford-base32 Response_Link token (26 chars), exactly as the decision mints it. */
function validToken(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  return Array.from(crypto.getRandomValues(new Uint8Array(26)), (b) => alphabet[b % 32]).join('');
}
/** The SHA-256 hex of a token, as respond.ts stores and compares it (never the plaintext). */
async function sha256Hex(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const isCheck = (r: CheckResult | RespondRefusal): r is CheckResult => 'usable' in r;
const isConfirmation = (r: RespondConfirmation | RespondRefusal): r is RespondConfirmation => 'receivedAt' in r;

/** Clear every seeded data table so one property run never inherits another run's rows (the shared-D1 reset). */
async function reset(): Promise<void> {
  await bindings.RF_CORE.batch(SEEDED_TABLES.map((t) => bindings.RF_CORE.prepare(`DELETE FROM ${t}`)));
}

async function seedMembers(): Promise<void> {
  const now = new Date(NOW).toISOString();
  const member = (id: string, role: string) =>
    bindings.RF_CORE.prepare(`INSERT INTO members (id, email, email_lc, role_id, status, created_at, updated_seq)
      VALUES (?1, ?2, ?2, ?3, 'active', ?4, 0)`).bind(id, `${id}@example.test`, role, now);
  await bindings.RF_CORE.batch([member(ADMIN_A, ADMIN_ROLE), member(ADMIN_B, ADMIN_ROLE), member(RESPONSIBLE, CONTRIB_ROLE)]);
}

interface Seeded {
  readonly submissionId: string;
  readonly token: string;
  readonly tokenHash: string;
  readonly type: string;
}

/**
 * Seed one Outside_Submission, its More_Information_Requested decision, and a Response_Link for a fresh token.
 * `expiresAt`, `used`, and `finalKind` drive the four unusable-but-known states; `type` drives the fan-out.
 * Returns the plaintext token (never stored) and its hash so assertions can read the row by hash.
 */
async function seedLink(options: { type?: string; expiresAt?: number; used?: boolean; finalKind?: string | null } = {}): Promise<Seeded> {
  const type = options.type ?? 'material';
  const submissionId = ulidish();
  const decisionId = ulidish();
  const token = validToken();
  const tokenHash = await sha256Hex(token);
  const receivedAt = new Date(NOW - DAY_MS).toISOString();
  const licence = type === 'removal_request' ? null : 'Synthetic Content Licence 1.0';
  await bindings.RF_CORE.prepare(`INSERT INTO outside_submissions (id, reference, type, message, name, email, licence_agreed, received_at, state, rev, updated_seq)
    VALUES (?1, ?2, ?3, 'please clarify', 'Ada Visitor', 'ada@example.test', ?4, ?5, 'more_information_requested', 1, 0)`)
    .bind(submissionId, `RS-${hexId().slice(0, 5).toUpperCase()}-12345`, type, licence, receivedAt).run();
  await bindings.RF_CORE.prepare(`INSERT INTO moderation_decisions (id, outside_submission_id, kind, final, admin_id, at, text)
    VALUES (?1, ?2, 'more_information_requested', 0, ?3, ?4, 'Please send more detail.')`)
    .bind(decisionId, submissionId, ADMIN_A, receivedAt).run();
  if (options.finalKind) {
    await bindings.RF_CORE.prepare(`INSERT INTO moderation_decisions (id, outside_submission_id, kind, final, admin_id, at, text)
      VALUES (?1, ?2, ?3, 1, ?4, ?5, 'Final.')`).bind(ulidish(), submissionId, options.finalKind, ADMIN_A, new Date(NOW).toISOString()).run();
  }
  const expiresAt = new Date(options.expiresAt ?? NOW + 29 * DAY_MS).toISOString();
  await bindings.RF_CORE.prepare(`INSERT INTO response_links (token_hash, outside_submission_id, decision_id, created_at, expires_at, used_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
    .bind(tokenHash, submissionId, decisionId, receivedAt, expiresAt, options.used ? new Date(NOW).toISOString() : null).run();
  return { submissionId, token, tokenHash, type };
}

async function openResponseSession(): Promise<string> {
  const id = hexId(); // 32 lower-case hex chars, as SESSION_ID_PATTERN requires
  await bindings.RF_CORE.prepare("INSERT INTO outside_sessions (id, purpose, created_at, expires_at) VALUES (?1, 'response', ?2, ?3)")
    .bind(id, new Date(NOW).toISOString(), new Date(NOW + 2 * 3600_000).toISOString()).run();
  return id;
}

async function countRows(table: string): Promise<number> {
  return (await bindings.RF_CORE.prepare(`SELECT count(*) AS n FROM ${table}`).first<number>('n')) ?? 0;
}
async function usedAtOf(tokenHash: string): Promise<string | null> {
  const row = await bindings.RF_CORE.prepare('SELECT used_at AS usedAt FROM response_links WHERE token_hash = ?1').bind(tokenHash).first<{ usedAt: string | null }>();
  return row?.usedAt ?? null;
}
/** The recipient ids of every Outside_Submission event, sorted, for an exact fan-out comparison. */
async function eventRecipients(): Promise<string[]> {
  const rows = await bindings.RF_CORE.prepare("SELECT member_id AS memberId FROM notification_events WHERE event_type = 'outside_submission' ORDER BY member_id").all<{ memberId: string }>();
  return rows.results.map((r) => r.memberId).sort();
}

beforeEach(async () => {
  const migrations = inject('d1Migrations');
  bindings = env as unknown as Env;
  await applyD1Migrations(bindings.RF_CORE, migrations.core);
  Object.assign(bindings, { TURNSTILE_SECRET: 'synthetic' });
  await bindings.RF_CORE.prepare('DELETE FROM members').run();
  await reset();
  await seedMembers();
});

describe('Property 89: an unusable Response_Link refuses on check and submit and writes nothing (R32.14)', () => {
  it('refuses a malformed, unknown, expired, used, or finally-decided link identically and leaves the submission untouched', async () => {
    // A tagged union of the unusable-token kinds; each must refuse on both paths and write nothing.
    const unusable = fc.oneof(
      fc.constant({ tag: 'malformed' as const }),
      fc.constant({ tag: 'unknown' as const }),
      fc.constant({ tag: 'expired' as const }),
      fc.constant({ tag: 'used' as const }),
      fc.constant({ tag: 'rejected' as const }),
      fc.constant({ tag: 'accepted' as const }),
    );
    await fc.assert(fc.asyncProperty(unusable, fc.constantFrom('material', 'removal_request', 'correction', 'comment'), async (kind, type) => {
      await reset();
      let token: string;
      let tokenHash: string | null = null;
      if (kind.tag === 'malformed') {
        token = 'not a valid token!!';
      } else if (kind.tag === 'unknown') {
        token = validToken(); // never seeded, so its hash is unknown
      } else if (kind.tag === 'expired') {
        const seeded = await seedLink({ type, expiresAt: NOW - 1 });
        token = seeded.token;
        tokenHash = seeded.tokenHash;
      } else if (kind.tag === 'used') {
        const seeded = await seedLink({ type, used: true });
        token = seeded.token;
        tokenHash = seeded.tokenHash;
      } else {
        const finalKind = kind.tag === 'rejected' ? 'rejected' : 'accepted';
        const seeded = await seedLink({ type, finalKind });
        token = seeded.token;
        tokenHash = seeded.tokenHash;
      }

      // The check refuses and writes nothing. A malformed/unknown token gets the one fixed refusal.
      const checked = await checkLink(bindings, token, NOW);
      expect(isCheck(checked)).toBe(false);
      if (isCheck(checked)) throw new Error('expected a check refusal');
      if (kind.tag === 'malformed' || kind.tag === 'unknown') expect(checked).toEqual(FIXED);

      // The submit refuses and writes nothing, whatever message is posted.
      const submitted = await respondSubmit(bindings, await openResponseSession(), { token, message: 'Here is the detail.', files: [] }, NOW);
      expect(isConfirmation(submitted)).toBe(false);
      if (isConfirmation(submitted)) throw new Error('expected a submit refusal');
      if (kind.tag === 'malformed' || kind.tag === 'unknown') expect(submitted).toEqual(FIXED);

      // Nothing was written: no response row, no event, and a known link is never marked used.
      expect(await countRows('outside_responses')).toBe(0);
      expect(await countRows('notification_events')).toBe(0);
      if (kind.tag === 'used') {
        // The pre-existing used mark is untouched (it was set at seed, not by this submit).
        expect(await usedAtOf(tokenHash!)).toBe(new Date(NOW).toISOString());
      } else if (tokenHash !== null) {
        expect(await usedAtOf(tokenHash)).toBeNull();
      }
    }));
  });
});

describe('Property 89: a usable link checks usable without writing, and a submit attaches exactly one response and fans out (R32.7, R32.14, R46.36)', () => {
  it('reports usable on check (writing nothing), then attaches the response with its receipt and fans out one event per Administrator plus the Responsible_Person on a Removal_Request', async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom('material', 'removal_request', 'correction', 'comment'),
      fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length >= 1),
      fc.boolean(),
      async (type, message, withResponsible) => {
        await reset();
        const seeded = await seedLink({ type });
        // A Responsible_Person is configured for some runs; it only matters on a Removal_Request (R46.36).
        if (withResponsible) {
          await bindings.RF_CORE.prepare("INSERT INTO settings (key, value, updated_at, updated_seq) VALUES ('responsiblePerson', ?1, ?2, 0)")
            .bind(JSON.stringify(RESPONSIBLE), new Date(NOW).toISOString()).run();
        }

        // The check reports usable and writes nothing.
        const checked = await checkLink(bindings, seeded.token, NOW);
        expect(isCheck(checked)).toBe(true);
        if (isCheck(checked)) expect(checked.usable).toBe(true);
        expect(await countRows('outside_responses')).toBe(0);
        expect(await countRows('notification_events')).toBe(0);
        expect(await usedAtOf(seeded.tokenHash)).toBeNull();

        // The submit attaches exactly one response with its receipt time, against the same Outside_Submission.
        const result = await respondSubmit(bindings, await openResponseSession(), { token: seeded.token, message, files: [] }, NOW);
        expect(isConfirmation(result)).toBe(true);
        if (!isConfirmation(result)) throw new Error('expected a confirmation');
        expect(result.receivedAt).toBe(new Date(NOW).toISOString());

        expect(await countRows('outside_responses')).toBe(1);
        const response = await bindings.RF_CORE.prepare('SELECT outside_submission_id AS sub, message, received_at AS receivedAt, response_link_hash AS hash FROM outside_responses WHERE outside_submission_id = ?1').bind(seeded.submissionId).first<{ sub: string; message: string; receivedAt: string; hash: string }>();
        expect(response?.sub).toBe(seeded.submissionId);
        expect(response?.message).toBe(message);
        expect(response?.receivedAt).toBe(new Date(NOW).toISOString());
        // Only the SHA-256 hash is stored/compared; the plaintext token is never written anywhere.
        expect(response?.hash).toBe(seeded.tokenHash);

        // The link is marked used (single-use).
        expect(await usedAtOf(seeded.tokenHash)).toBe(new Date(NOW).toISOString());

        // The fan-out: one event per Administrator, plus the Responsible_Person only on a Removal_Request.
        const expected = [ADMIN_A, ADMIN_B];
        if (type === 'removal_request' && withResponsible) expected.push(RESPONSIBLE);
        expect(await eventRecipients()).toEqual(expected.sort());

        // The Outside_Submission itself is unchanged (still more_information_requested).
        const sub = await bindings.RF_CORE.prepare('SELECT state FROM outside_submissions WHERE id = ?1').bind(seeded.submissionId).first<{ state: string }>();
        expect(sub?.state).toBe('more_information_requested');
      },
    ));
  });
});

describe('Property 89: a Response_Link is single-use (R32.14)', () => {
  it('refuses a second response through the same link and attaches nothing further', async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom('material', 'removal_request', 'correction', 'comment'),
      async (type) => {
        await reset();
        const seeded = await seedLink({ type });

        const first = await respondSubmit(bindings, await openResponseSession(), { token: seeded.token, message: 'First response.', files: [] }, NOW);
        expect(isConfirmation(first)).toBe(true);
        expect(await countRows('outside_responses')).toBe(1);

        // A second answer through the same link is refused and writes nothing more.
        const second = await respondSubmit(bindings, await openResponseSession(), { token: seeded.token, message: 'Second response.', files: [] }, NOW + 1000);
        expect(isConfirmation(second)).toBe(false);
        if (isConfirmation(second)) throw new Error('expected a refusal');
        expect((second as RespondRefusal).error).toBe('already_responded');

        // Still exactly one response; the second check now reports the link unusable too.
        expect(await countRows('outside_responses')).toBe(1);
        const recheck = await checkLink(bindings, seeded.token, NOW + 1000);
        expect(isCheck(recheck)).toBe(false);
      },
    ));
  });
});
