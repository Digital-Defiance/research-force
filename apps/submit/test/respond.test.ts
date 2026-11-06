import { beforeEach, describe, expect, it, inject } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { checkLink, respondSubmit } from '../src/respond';
import type { CheckResult, RespondConfirmation, RespondRefusal } from '../src/respond';
import { handle } from '../src/index';
import type { Env } from '../src/index';

declare module 'vitest' {
  export interface ProvidedContext { d1Migrations: { core: D1Migration[]; search: D1Migration[]; public: D1Migration[] } }
}

let bindings: Env;

const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;
const ADMIN_A = '0000000000000000000000ADM1';
const ADMIN_B = '0000000000000000000000ADM2';
const RESPONSIBLE = '0000000000000000000000RES1';
const ADMIN_ROLE = '00000000000000000000000007';
const CONTRIB_ROLE = '00000000000000000000000006';
const SUBMISSION_ID = '0000000000000000000000SUB1';
const DECISION_ID = '0000000000000000000000DEC1';
/** A valid 128-bit Crockford-base32 token (26 characters). */
const TOKEN = 'ABCDEFGHJKMNPQRSTVWXYZ0123';
const RESPONSE_SESSION = 'a'.repeat(32);

function hexId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The SHA-256 hex of a token, as respond.ts stores and compares it. */
async function sha256Hex(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function seedMembers(): Promise<void> {
  const member = (id: string, role: string, status = 'active') =>
    bindings.RF_CORE.prepare(`INSERT INTO members (id, email, email_lc, role_id, status, created_at, updated_seq)
      VALUES (?1, ?2, ?2, ?3, ?4, ?5, 0)`).bind(id, `${id}@example.test`, role, status, new Date(NOW).toISOString());
  await bindings.RF_CORE.batch([member(ADMIN_A, ADMIN_ROLE), member(ADMIN_B, ADMIN_ROLE), member(RESPONSIBLE, CONTRIB_ROLE)]);
}

/** Seed an Outside_Submission, a More_Information_Requested decision, and a Response_Link for TOKEN. */
async function seedLink(options: { type?: string; expiresAt?: number; used?: boolean; finalKind?: string | null } = {}): Promise<void> {
  const type = options.type ?? 'material';
  const receivedAt = new Date(NOW - DAY_MS).toISOString();
  const licence = type === 'removal_request' ? null : 'Synthetic Content Licence 1.0';
  await bindings.RF_CORE.prepare(`INSERT INTO outside_submissions (id, reference, type, message, name, email, licence_agreed, received_at, state, rev, updated_seq)
    VALUES (?1, 'RS-ABCDE-12345', ?2, 'please clarify', 'Ada Visitor', 'ada@example.test', ?3, ?4, 'more_information_requested', 1, 0)`)
    .bind(SUBMISSION_ID, type, licence, receivedAt).run();
  await bindings.RF_CORE.prepare(`INSERT INTO moderation_decisions (id, outside_submission_id, kind, final, admin_id, at, text)
    VALUES (?1, ?2, 'more_information_requested', 0, ?3, ?4, 'Please send more detail.')`)
    .bind(DECISION_ID, SUBMISSION_ID, ADMIN_A, receivedAt).run();
  if (options.finalKind) {
    await bindings.RF_CORE.prepare(`INSERT INTO moderation_decisions (id, outside_submission_id, kind, final, admin_id, at, text)
      VALUES (?1, ?2, ?3, 1, ?4, ?5, 'Final.')`).bind(hexId().toUpperCase().slice(0, 26).padEnd(26, '0'), SUBMISSION_ID, options.finalKind, ADMIN_A, new Date(NOW).toISOString()).run();
  }
  const expiresAt = new Date(options.expiresAt ?? NOW + 29 * DAY_MS).toISOString();
  await bindings.RF_CORE.prepare(`INSERT INTO response_links (token_hash, outside_submission_id, decision_id, created_at, expires_at, used_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
    .bind(await sha256Hex(TOKEN), SUBMISSION_ID, DECISION_ID, receivedAt, expiresAt, options.used ? new Date(NOW).toISOString() : null).run();
}

async function openResponseSession(id = RESPONSE_SESSION): Promise<string> {
  await bindings.RF_CORE.prepare("INSERT INTO outside_sessions (id, purpose, created_at, expires_at) VALUES (?1, 'response', ?2, ?3)")
    .bind(id, new Date(NOW).toISOString(), new Date(NOW + 2 * 3600_000).toISOString()).run();
  return id;
}

const isCheck = (r: CheckResult | RespondRefusal): r is CheckResult => 'usable' in r;
const isConfirmation = (r: RespondConfirmation | RespondRefusal): r is RespondConfirmation => 'receivedAt' in r;

beforeEach(async () => {
  const migrations = inject('d1Migrations');
  bindings = env as unknown as Env;
  await applyD1Migrations(bindings.RF_CORE, migrations.core);
  Object.assign(bindings, { TURNSTILE_SECRET: 'synthetic' });
  await bindings.RF_CORE.batch(
    ['outside_files', 'outside_sessions', 'outside_submissions', 'outside_responses', 'moderation_decisions', 'response_links', 'notification_events', 'members', 'settings']
      .map((t) => bindings.RF_CORE.prepare(`DELETE FROM ${t}`)),
  );
  await seedMembers();
});

describe('POST /v1/respond/check (R32.14)', () => {
  it('reports a fresh, unused, undecided Response_Link as usable', async () => {
    await seedLink();
    const result = await checkLink(bindings, TOKEN, NOW);
    expect(isCheck(result)).toBe(true);
    if (isCheck(result)) expect(result.usable).toBe(true);
  });

  it('refuses a malformed token and an unknown token the same way (never reveals the submission)', async () => {
    const malformed = await checkLink(bindings, 'not a token', NOW);
    const unknown = await checkLink(bindings, TOKEN, NOW); // nothing seeded
    expect(isCheck(malformed)).toBe(false);
    expect(isCheck(unknown)).toBe(false);
    if (isCheck(malformed) || isCheck(unknown)) throw new Error('expected refusals');
    expect(malformed.error).toBe('invalid_link');
    expect(unknown.error).toBe('invalid_link');
  });

  it('refuses an expired link (past 30 days)', async () => {
    await seedLink({ expiresAt: NOW - 1 });
    const result = await checkLink(bindings, TOKEN, NOW);
    expect(isCheck(result)).toBe(false);
    if (isCheck(result)) throw new Error('expected a refusal');
    expect(result.error).toBe('expired');
  });

  it('refuses a link already responded through', async () => {
    await seedLink({ used: true });
    const result = await checkLink(bindings, TOKEN, NOW);
    expect(isCheck(result)).toBe(false);
    if (isCheck(result)) throw new Error('expected a refusal');
    expect(result.error).toBe('already_responded');
  });

  it('refuses a link whose Outside_Submission has an Accepted or Rejected decision', async () => {
    await seedLink({ finalKind: 'rejected' });
    const result = await checkLink(bindings, TOKEN, NOW);
    expect(isCheck(result)).toBe(false);
    if (isCheck(result)) throw new Error('expected a refusal');
    expect(result.error).toBe('decided');
  });
});

describe('POST /v1/respond/submit (R32.7, R46.36)', () => {
  it('attaches the response text and receipt time, marks the link used, and fans out to Administrators', async () => {
    await seedLink();
    const sessionId = await openResponseSession();
    const result = await respondSubmit(bindings, sessionId, { token: TOKEN, message: 'Here is the extra detail you asked for.', files: [] }, NOW);
    expect(isConfirmation(result)).toBe(true);
    if (!isConfirmation(result)) throw new Error('expected a confirmation');
    expect(result.receivedAt).toBe(new Date(NOW).toISOString());

    const response = await bindings.RF_CORE.prepare('SELECT outside_submission_id AS sub, message, received_at AS receivedAt FROM outside_responses WHERE outside_submission_id = ?1').bind(SUBMISSION_ID).first<{ sub: string; message: string; receivedAt: string }>();
    expect(response).toMatchObject({ sub: SUBMISSION_ID, message: 'Here is the extra detail you asked for.', receivedAt: new Date(NOW).toISOString() });

    const link = await bindings.RF_CORE.prepare('SELECT used_at AS usedAt FROM response_links WHERE outside_submission_id = ?1').bind(SUBMISSION_ID).first<{ usedAt: string | null }>();
    expect(link?.usedAt).not.toBeNull();

    // One Outside_Submission event per Administrator; the non-Administrator Responsible_Person gets none on a Material submission.
    const events = await bindings.RF_CORE.prepare("SELECT member_id AS memberId, event_type AS type, actor_id AS actorId FROM notification_events ORDER BY member_id").all<{ memberId: string; type: string; actorId: string | null }>();
    expect(events.results.map((e) => e.memberId).sort()).toEqual([ADMIN_A, ADMIN_B].sort());
    expect(events.results.every((e) => e.type === 'outside_submission' && e.actorId === null)).toBe(true);

    // The Outside_Submission itself is unchanged (still more_information_requested).
    const sub = await bindings.RF_CORE.prepare('SELECT state FROM outside_submissions WHERE id = ?1').bind(SUBMISSION_ID).first<{ state: string }>();
    expect(sub?.state).toBe('more_information_requested');
  });

  it('creates an event for the Responsible_Person on a Removal_Request too (R46.36)', async () => {
    await seedLink({ type: 'removal_request' });
    await bindings.RF_CORE.prepare("INSERT INTO settings (key, value, updated_at, updated_seq) VALUES ('responsiblePerson', ?1, ?2, 0)").bind(JSON.stringify(RESPONSIBLE), new Date(NOW).toISOString()).run();
    const result = await respondSubmit(bindings, await openResponseSession(), { token: TOKEN, message: 'My removal grounds.', files: [] }, NOW);
    expect(isConfirmation(result)).toBe(true);
    const events = await bindings.RF_CORE.prepare('SELECT member_id AS memberId FROM notification_events ORDER BY member_id').all<{ memberId: string }>();
    expect(events.results.map((e) => e.memberId).sort()).toEqual([ADMIN_A, ADMIN_B, RESPONSIBLE].sort());
  });

  it('refuses a blank message and stores nothing', async () => {
    await seedLink();
    const result = await respondSubmit(bindings, await openResponseSession(), { token: TOKEN, message: '   ', files: [] }, NOW);
    expect(isConfirmation(result)).toBe(false);
    if (isConfirmation(result)) throw new Error('expected a refusal');
    expect(result.error).toBe('invalid');
    expect(await bindings.RF_CORE.prepare('SELECT count(*) AS n FROM outside_responses').first<number>('n')).toBe(0);
  });

  it('refuses when the link expired between the check and the submit, leaving the submission unchanged', async () => {
    await seedLink({ expiresAt: NOW - 1 });
    const result = await respondSubmit(bindings, await openResponseSession(), { token: TOKEN, message: 'Too late.', files: [] }, NOW);
    expect(isConfirmation(result)).toBe(false);
    if (isConfirmation(result)) throw new Error('expected a refusal');
    expect(result.error).toBe('expired');
    expect(await bindings.RF_CORE.prepare('SELECT count(*) AS n FROM outside_responses').first<number>('n')).toBe(0);
  });

  it('refuses a second response through the same link (R32.14)', async () => {
    await seedLink();
    const first = await respondSubmit(bindings, await openResponseSession('b'.repeat(32)), { token: TOKEN, message: 'First response.', files: [] }, NOW);
    expect(isConfirmation(first)).toBe(true);
    const second = await respondSubmit(bindings, await openResponseSession('c'.repeat(32)), { token: TOKEN, message: 'Second response.', files: [] }, NOW + 1000);
    expect(isConfirmation(second)).toBe(false);
    if (isConfirmation(second)) throw new Error('expected a refusal');
    expect(second.error).toBe('already_responded');
    expect(await bindings.RF_CORE.prepare('SELECT count(*) AS n FROM outside_responses').first<number>('n')).toBe(1);
  });

  it('attaches a complete response file to the submission and the response', async () => {
    await seedLink();
    const sessionId = await openResponseSession();
    const fileId = hexId();
    await bindings.RF_CORE.prepare(`INSERT INTO outside_files (id, session_id, r2_key, file_name, size_bytes, sha256, state, created_at)
      VALUES (?1, ?2, ?3, 'doc.pdf', 10, 'aa', 'complete', ?4)`).bind(fileId, sessionId, `outside/${sessionId}/${fileId}`, new Date(NOW).toISOString()).run();
    const result = await respondSubmit(bindings, sessionId, { token: TOKEN, message: 'With a file.', files: [{ fileId }] }, NOW);
    expect(isConfirmation(result)).toBe(true);
    const row = await bindings.RF_CORE.prepare('SELECT outside_submission_id AS sub, response_id AS resp FROM outside_files WHERE id = ?1').bind(fileId).first<{ sub: string | null; resp: string | null }>();
    expect(row?.sub).toBe(SUBMISSION_ID);
    expect(row?.resp).not.toBeNull();
  });

  it('refuses when an added file is not complete (R32.14)', async () => {
    await seedLink();
    const sessionId = await openResponseSession();
    const fileId = hexId();
    await bindings.RF_CORE.prepare(`INSERT INTO outside_files (id, session_id, r2_key, file_name, size_bytes, sha256, state, created_at)
      VALUES (?1, ?2, ?3, 'doc.pdf', 10, 'aa', 'uploading', ?4)`).bind(fileId, sessionId, `outside/${sessionId}/${fileId}`, new Date(NOW).toISOString()).run();
    const result = await respondSubmit(bindings, sessionId, { token: TOKEN, message: 'With a file.', files: [{ fileId }] }, NOW);
    expect(isConfirmation(result)).toBe(false);
    if (isConfirmation(result)) throw new Error('expected a refusal');
    expect(result.error).toBe('file_incomplete');
    expect(await bindings.RF_CORE.prepare('SELECT count(*) AS n FROM outside_responses').first<number>('n')).toBe(0);
  });
});

describe('the respond routes through the Budget gate (handle)', () => {
  function post(path: string, body: unknown): Request {
    return new Request(`https://submit.researchforce.org${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' } });
  }
  it('answers /v1/respond/check with only a usability boolean for a good link', async () => {
    await seedLink();
    const response = await handle(post('/v1/respond/check', { token: TOKEN }), bindings, NOW);
    expect(response.status).toBe(200);
    expect(await response.json<CheckResult>()).toEqual({ usable: true });
  });
  it('returns the fixed-text refusal shape for an unusable link', async () => {
    const response = await handle(post('/v1/respond/check', { token: TOKEN }), bindings, NOW);
    expect(response.status).toBe(400);
    const body = await response.json<RespondRefusal>();
    expect(body.error).toBe('invalid_link');
    expect(typeof body.message).toBe('string');
  });
  it('stores a response through /v1/respond/sessions/{id}/submit and returns 201', async () => {
    await seedLink();
    const sessionId = await openResponseSession();
    const response = await handle(post(`/v1/respond/sessions/${sessionId}/submit`, { token: TOKEN, message: 'Through the router.', files: [] }), bindings, NOW);
    expect(response.status).toBe(201);
    const body = await response.json<RespondConfirmation>();
    expect(body.receivedAt).toBe(new Date(NOW).toISOString());
  });
});
