import { DurableObject } from 'cloudflare:workers';
import { emailKey } from '@researchforce/domain/identifiers';
import type { OpsAccess } from '@researchforce/domain/ops';
import type { EmailMessage, SendResult } from '../mail/provider';
import type { Env } from '../env';
import { assertDevRuntime } from '../auth/dev';

export const LOCAL_RETENTION = 200;
export type CapturedMail = { id: number; at: string; to: string; subject: string; html: string; text: string };
export type MailSummary = Omit<CapturedMail, 'html' | 'text'>;
export interface LocalAiResponse { response: string; local: true; usage: { prompt_tokens: 0; completion_tokens: 0; total_tokens: 0 } }
export interface LocalAiError { error: string; local: true }

/** SQLite state belongs only to the local namespace and its resettable Miniflare directory. */
export class LocalServices extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    assertDevRuntime(env, true);
    if (env.RF_LOCAL_SERVICES !== '1') throw new Error('Local service storage is disabled.');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS captured_mail (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, recipient TEXT NOT NULL, subject TEXT NOT NULL, html TEXT NOT NULL, plain TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS ops_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, method TEXT NOT NULL, email TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS access_list (email TEXT PRIMARY KEY)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS ai_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, model TEXT NOT NULL, digest TEXT NOT NULL)');
  }
  async addMember(email: string): Promise<void> { this.#ops('addMember', email); }
  async removeMember(email: string): Promise<void> { this.#ops('removeMember', email); }
  async revokeSessions(email: string): Promise<void> { this.#ops('revokeSessions', email); }
  #ops(method: keyof OpsAccess, email: string): void {
    if (typeof email !== 'string' || email.length < 1 || email.length > 254) throw new Error('Invalid local OPS request.');
    const normalized = emailKey(email);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('INSERT INTO ops_calls (at, method, email) VALUES (?, ?, ?)', new Date().toISOString(), method, normalized);
      if (method === 'addMember') this.ctx.storage.sql.exec('INSERT INTO access_list (email) VALUES (?) ON CONFLICT(email) DO NOTHING', normalized);
      if (method === 'removeMember') this.ctx.storage.sql.exec('DELETE FROM access_list WHERE email = ?', normalized);
      this.ctx.storage.sql.exec('DELETE FROM ops_calls WHERE id NOT IN (SELECT id FROM ops_calls ORDER BY id DESC LIMIT ?)', LOCAL_RETENTION);
    });
  }
  async captureMail(message: EmailMessage): Promise<SendResult> {
    if (!message || ['to', 'subject', 'html', 'text'].some((key) => typeof message[key as keyof EmailMessage] !== 'string')
      || message.to.length > 254 || message.subject.length > 2000 || new TextEncoder().encode(JSON.stringify(message)).byteLength > 1_048_576) return { ok: false, status: 413, retryAfterMs: null };
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('INSERT INTO captured_mail (at, recipient, subject, html, plain) VALUES (?, ?, ?, ?, ?)', new Date().toISOString(), message.to, message.subject, message.html, message.text);
      this.ctx.storage.sql.exec('DELETE FROM captured_mail WHERE id NOT IN (SELECT id FROM captured_mail ORDER BY id DESC LIMIT ?)', LOCAL_RETENTION);
    });
    return { ok: true }; // Accepted by the local capture only; no delivery is attempted.
  }
  async mailPage(before = Number.MAX_SAFE_INTEGER): Promise<{ messages: MailSummary[]; nextBefore: number | null }> {
    if (!Number.isSafeInteger(before) || before < 1) throw new Error('Invalid local outbox cursor.');
    const rows = this.ctx.storage.sql.exec<MailSummary>('SELECT id, at, recipient AS "to", subject FROM captured_mail WHERE id < ? ORDER BY id DESC LIMIT 51', before).toArray();
    return { messages: rows.slice(0, 50), nextBefore: rows.length > 50 ? rows[49]!.id : null };
  }
  async mail(id: number): Promise<CapturedMail | null> {
    if (!Number.isSafeInteger(id) || id < 1) return null;
    return this.ctx.storage.sql.exec<CapturedMail>('SELECT id, at, recipient AS "to", subject, html, plain AS text FROM captured_mail WHERE id = ?', id).toArray()[0] ?? null;
  }
  async ai(model: string, input: unknown): Promise<LocalAiResponse | LocalAiError> {
    const json = JSON.stringify(input);
    if (!/^@cf\/[a-z0-9._/-]{1,160}$/iu.test(model) || !json || new TextEncoder().encode(json).byteLength > 32_768
      || !input || typeof input !== 'object' || (input as { stream?: unknown }).stream === true) return { local: true, error: 'Local AI supports bounded non-streaming JSON and @cf model names only.' };
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(model + '\n' + json)));
    const digest = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    this.ctx.storage.sql.exec('INSERT INTO ai_calls (at, model, digest) VALUES (?, ?, ?)', new Date().toISOString(), model, digest);
    this.ctx.storage.sql.exec('DELETE FROM ai_calls WHERE id NOT IN (SELECT id FROM ai_calls ORDER BY id DESC LIMIT ?)', LOCAL_RETENTION);
    return { response: `Synthetic local draft (${digest.slice(0, 12)}). No AI model ran.`, local: true, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
  }
  async diagnostics() {
    return {
      local: true, deliveredEmails: 0,
      retainedMail: this.ctx.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM captured_mail').one().n,
      accessChanges: this.ctx.storage.sql.exec<{ at: string; method: string; email: string }>('SELECT at, method, email FROM ops_calls ORDER BY id DESC LIMIT 50').toArray(),
      accessList: this.ctx.storage.sql.exec<{ email: string }>('SELECT email FROM access_list ORDER BY email LIMIT 500').toArray().map((row) => row.email),
      aiCalls: this.ctx.storage.sql.exec<{ at: string; model: string; digest: string }>('SELECT at, model, digest FROM ai_calls ORDER BY id DESC LIMIT 50').toArray(),
    };
  }
}

/** Called only by the local entrypoint and local Mailer subclass, before any adapters are injected. */
export function localServicesFor(env: Env): DurableObjectStub<LocalServices> {
  assertDevRuntime(env, true);
  if (env.RF_LOCAL_SERVICES !== '1' || !env.LOCAL_SERVICES) throw new Error('Local service namespace is unavailable.');
  return env.LOCAL_SERVICES.getByName('local-services');
}
