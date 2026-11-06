import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { inject } from 'vitest';
import type { D1Migration } from 'cloudflare:test';
import { handle } from '../src/index';
import { requestFileUpload, sweepOutsideFiles } from '../src/sessions';
import type { Env } from '../src/index';

declare module 'vitest' {
  export interface ProvidedContext { d1Migrations: { core: D1Migration[]; search: D1Migration[]; public: D1Migration[] } }
}

let bindings: Env;

/** The same empty-content SHA-256 used across the file tests; the local R2 computes this for an empty object. */
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const SESSION_ID = 'a'.repeat(32);
const FILE_ID = 'b'.repeat(32);

/** A 128-bit-shaped hex id generated per call so unique-key clashes do not leak between tests. */
function hexId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);

beforeEach(async () => {
  const migrations = inject('d1Migrations');
  bindings = env as unknown as Env;
  await applyD1Migrations(bindings.RF_CORE, migrations.core);
  await applyD1Migrations((env as Record<string, unknown>)['RF_SEARCH'] as D1Database, migrations.search);
  await applyD1Migrations((env as Record<string, unknown>)['RF_PUBLIC'] as D1Database, migrations.public);
  Object.assign(bindings, {
    TURNSTILE_SECRET: 'synthetic-turnstile-secret',
    R2_ACCOUNT_ID: 'synthetic-account',
    R2_ACCESS_KEY_ID: 'synthetic-key',
    R2_SECRET_ACCESS_KEY: 'synthetic-secret',
    PRIVATE_BUCKET_NAME: 'rf-private',
  });
  await bindings.RF_CORE.batch(['outside_files', 'outside_sessions', 'outside_submissions'].map((t) => bindings.RF_CORE.prepare(`DELETE FROM ${t}`)));
});

afterEach(() => { vi.restoreAllMocks(); });

/** Stub Turnstile `siteverify` to the given outcome; it is the only external fetch the Worker makes. */
function stubSiteverify(success: boolean): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    if (target.includes('siteverify')) return new Response(JSON.stringify({ success }), { status: 200 });
    throw new Error(`unexpected fetch to ${target}`);
  });
}

function post(path: string, body: unknown): Request {
  return new Request(`https://submit.researchforce.org${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
}

/** Open a session directly (bypassing Turnstile) and return its id. */
async function openSessionRow(id = SESSION_ID): Promise<string> {
  await bindings.RF_CORE
    .prepare("INSERT INTO outside_sessions (id, purpose, created_at, expires_at) VALUES (?1, 'submission', ?2, ?3)")
    .bind(id, new Date(NOW).toISOString(), new Date(NOW + 2 * 3600_000).toISOString())
    .run();
  return id;
}

describe('POST /v1/sessions', () => {
  it('opens a 2-hour session after a passed Turnstile check', async () => {
    stubSiteverify(true);
    const response = await handle(post('/v1/sessions', { token: 'good' }), bindings, NOW);
    expect(response.status).toBe(201);
    const body = await response.json<{ id: string; expiresAt: string }>();
    expect(body.id).toMatch(/^[0-9a-f]{32}$/);
    expect(Date.parse(body.expiresAt) - NOW).toBe(2 * 3600_000);
    const row = await bindings.RF_CORE.prepare('SELECT purpose FROM outside_sessions WHERE id = ?1').bind(body.id).first<{ purpose: string }>();
    expect(row?.purpose).toBe('submission');
  });

  it('refuses when the Turnstile check fails, opening no session', async () => {
    stubSiteverify(false);
    const response = await handle(post('/v1/sessions', { token: 'bad' }), bindings, NOW);
    expect(response.status).toBe(400);
    expect(await response.json<{ error: string }>()).toMatchObject({ error: 'bot_check' });
    expect(await bindings.RF_CORE.prepare('SELECT count(*) AS n FROM outside_sessions').first('n')).toBe(0);
  });
});

describe('POST /v1/sessions/{id}/files', () => {
  it('returns a presigned PUT signing the length and SHA-256 for a valid file', async () => {
    stubSiteverify(true);
    const sessionId = await openSessionRow();
    const result = await requestFileUpload(bindings, sessionId, { fileId: FILE_ID, fileName: 'Synthetic.pdf', sizeBytes: 10, sha256: EMPTY_SHA }, NOW);
    expect('url' in result).toBe(true);
    if (!('url' in result)) throw new Error('expected a presigned URL');
    const url = new URL(result.url);
    expect(url.hostname).toBe('synthetic-account.r2.cloudflarestorage.com');
    expect(url.pathname).toBe(`/rf-private/outside/${sessionId}/${FILE_ID}`);
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;host;if-none-match;x-amz-checksum-sha256');
    expect(result.headers['content-length']).toBe('10');
    const row = await bindings.RF_CORE.prepare('SELECT state, r2_key AS r2Key FROM outside_files WHERE id = ?1').bind(FILE_ID).first<{ state: string; r2Key: string }>();
    expect(row).toMatchObject({ state: 'uploading', r2Key: `outside/${sessionId}/${FILE_ID}` });
  });

  it('refuses a file over the Public_Upload_Size_Limit and stores no part of it', async () => {
    const sessionId = await openSessionRow();
    const result = await requestFileUpload(bindings, sessionId, { fileId: FILE_ID, fileName: 'Big.bin', sizeBytes: 100_000_001, sha256: EMPTY_SHA }, NOW);
    expect(result).toMatchObject({ error: 'file_too_large' });
    expect(await bindings.RF_CORE.prepare('SELECT count(*) AS n FROM outside_files').first('n')).toBe(0);
  });

  it('refuses the 11th file of an Outside_Submission', async () => {
    const sessionId = await openSessionRow();
    for (let i = 0; i < 10; i++) {
      const r = await requestFileUpload(bindings, sessionId, { fileId: hexId(), fileName: `f${i}.txt`, sizeBytes: 1, sha256: EMPTY_SHA }, NOW);
      expect('url' in r).toBe(true);
    }
    const eleventh = await requestFileUpload(bindings, sessionId, { fileId: hexId(), fileName: 'f10.txt', sizeBytes: 1, sha256: EMPTY_SHA }, NOW);
    expect(eleventh).toMatchObject({ error: 'too_many_files' });
  });

  it('refuses a file that would push the Outside_Submission past 500 MB', async () => {
    const sessionId = await openSessionRow();
    const first = await requestFileUpload(bindings, sessionId, { fileId: hexId(), fileName: 'a.bin', sizeBytes: 90_000_000, sha256: EMPTY_SHA }, NOW);
    expect('url' in first).toBe(true);
    // Six 90 MB files = 540 MB > 500 MB; the sixth is refused (each is under the 100 MB per-file limit).
    let refusal: unknown;
    for (let i = 0; i < 5; i++) {
      refusal = await requestFileUpload(bindings, sessionId, { fileId: hexId(), fileName: `b${i}.bin`, sizeBytes: 90_000_000, sha256: EMPTY_SHA }, NOW);
      if (refusal && typeof refusal === 'object' && 'error' in refusal) break;
    }
    expect(refusal).toMatchObject({ error: 'submission_too_large' });
  });

  it('refuses a file that would push the daily total past 1 GB across sessions', async () => {
    const dayStart = Date.UTC(2026, 9, 29, 0, 0, 0);
    // Seed ~990 MB of files already uploaded today under other sessions.
    for (let i = 0; i < 11; i++) {
      await bindings.RF_CORE.prepare(`INSERT INTO outside_files (id, session_id, r2_key, file_name, size_bytes, sha256, state, created_at)
        VALUES (?1, ?2, ?3, 'seed.bin', 90000000, ?4, 'complete', ?5)`)
        .bind(hexId(), hexId(), `outside/seed/${i}`, EMPTY_SHA, new Date(dayStart + 3600_000).toISOString()).run();
    }
    const sessionId = await openSessionRow();
    const result = await requestFileUpload(bindings, sessionId, { fileId: hexId(), fileName: 'last.bin', sizeBytes: 90_000_000, sha256: EMPTY_SHA }, NOW);
    expect(result).toMatchObject({ error: 'daily_limit' });
  });

  it('refuses an upload without a live session', async () => {
    const result = await requestFileUpload(bindings, 'c'.repeat(32), { fileId: FILE_ID, fileName: 'x.txt', sizeBytes: 1, sha256: EMPTY_SHA }, NOW);
    expect(result).toMatchObject({ error: 'no_session' });
  });
});

describe('POST /v1/sessions/{id}/files/{file}/complete', () => {
  it('confirms a file whose stored size and checksum match, and fails a mismatch', async () => {
    const sessionId = await openSessionRow();
    const good = await requestFileUpload(bindings, sessionId, { fileId: FILE_ID, fileName: 'ok.txt', sizeBytes: 0, sha256: EMPTY_SHA }, NOW);
    expect('url' in good).toBe(true);
    await bindings.RF_PRIVATE_BUCKET.put(`outside/${sessionId}/${FILE_ID}`, '', { sha256: EMPTY_SHA });
    const complete = await handle(post(`/v1/sessions/${sessionId}/files/${FILE_ID}/complete`, {}), bindings, NOW);
    expect(complete.status).toBe(200);
    expect(await complete.json<{ state: string }>()).toMatchObject({ state: 'complete' });

    // A mismatch (wrong declared size) is reported as a failed upload the Visitor can retry.
    const bad = await requestFileUpload(bindings, sessionId, { fileId: 'd'.repeat(32), fileName: 'bad.txt', sizeBytes: 5, sha256: EMPTY_SHA }, NOW);
    expect('url' in bad).toBe(true);
    await bindings.RF_PRIVATE_BUCKET.put(`outside/${sessionId}/${'d'.repeat(32)}`, '', { sha256: EMPTY_SHA });
    const failed = await handle(post(`/v1/sessions/${sessionId}/files/${'d'.repeat(32)}/complete`, {}), bindings, NOW);
    expect(failed.status).toBe(400);
    expect(await failed.json<{ error: string }>()).toMatchObject({ error: 'upload_failed' });
    const row = await bindings.RF_CORE.prepare("SELECT state FROM outside_files WHERE id = ?1").bind('d'.repeat(32)).first<{ state: string }>();
    expect(row?.state).toBe('failed');
  });
});

describe('the hourly sweep (R31.8)', () => {
  it('deletes uploaded files not part of a complete Outside_Submission 24 hours after upload', async () => {
    const sessionId = await openSessionRow();
    const long = NOW - 25 * 3600_000;
    // An old unattached file: eligible.
    await bindings.RF_PRIVATE_BUCKET.put(`outside/${sessionId}/old`, 'x');
    await bindings.RF_CORE.prepare(`INSERT INTO outside_files (id, session_id, r2_key, file_name, size_bytes, sha256, state, created_at)
      VALUES ('old', ?1, ?2, 'old.txt', 1, ?3, 'complete', ?4)`).bind(sessionId, `outside/${sessionId}/old`, EMPTY_SHA, new Date(long).toISOString()).run();
    // A recent unattached file: kept (within 24 hours).
    await bindings.RF_CORE.prepare(`INSERT INTO outside_files (id, session_id, r2_key, file_name, size_bytes, sha256, state, created_at)
      VALUES ('recent', ?1, ?2, 'recent.txt', 1, ?3, 'complete', ?4)`).bind(sessionId, `outside/${sessionId}/recent`, EMPTY_SHA, new Date(NOW).toISOString()).run();
    // An old file attached to a non-rejected Outside_Submission: kept.
    await bindings.RF_CORE.prepare(`INSERT INTO outside_submissions (id, reference, type, message, name, licence_agreed, received_at, state, rev, updated_seq)
      VALUES ('sub1', 'RS-AAAAA-BBBBB', 'comment', 'm', 'n', 'CC BY 4.0', ?1, 'queued', 0, 0)`).bind(new Date(long).toISOString()).run();
    await bindings.RF_CORE.prepare(`INSERT INTO outside_files (id, session_id, outside_submission_id, r2_key, file_name, size_bytes, sha256, state, created_at)
      VALUES ('kept', ?1, 'sub1', ?2, 'kept.txt', 1, ?3, 'complete', ?4)`).bind(sessionId, `outside/${sessionId}/kept`, EMPTY_SHA, new Date(long).toISOString()).run();

    const deleted = await sweepOutsideFiles(bindings, NOW);
    expect(deleted).toBe(1);
    expect(await bindings.RF_CORE.prepare("SELECT state FROM outside_files WHERE id = 'old'").first<{ state: string }>()).toMatchObject({ state: 'deleted' });
    expect(await bindings.RF_CORE.prepare("SELECT state FROM outside_files WHERE id = 'recent'").first<{ state: string }>()).toMatchObject({ state: 'complete' });
    expect(await bindings.RF_CORE.prepare("SELECT state FROM outside_files WHERE id = 'kept'").first<{ state: string }>()).toMatchObject({ state: 'complete' });
    expect(await bindings.RF_PRIVATE_BUCKET.head(`outside/${sessionId}/old`)).toBeNull();
  });
});
