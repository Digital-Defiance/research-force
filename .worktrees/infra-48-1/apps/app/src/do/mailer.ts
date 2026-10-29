import { DurableObject } from 'cloudflare:workers';
import type { Timestamp } from '@researchforce/domain/types';
import type { Env } from '../env';
import { createLogger } from '../log';
import { queueDigests } from '../mail/digest';
import { runQueue } from '../mail/mailer';
import type { AttemptLog } from '../mail/mailer';
import { providerFor } from '../mail/provider';
import type { EmailProvider } from '../mail/provider';
import { drainOutbox } from '../outbox';

/** The quarter-hour check of the Daily_Digests (R20.13). */
const DIGEST_CHECK_MS = 15 * 60_000;

/** The attempt log in the object's own SQLite storage, which survives restarts so that the limits hold across them (R20.15). */
class StoredAttemptLog implements AttemptLog {
  constructor(private readonly sql: SqlStorage) {
    sql.exec('CREATE TABLE IF NOT EXISTS attempts (at INTEGER NOT NULL, recipients INTEGER NOT NULL)');
    sql.exec('CREATE INDEX IF NOT EXISTS attempts_at ON attempts (at)');
  }
  since(sinceMs: number) { return this.sql.exec<{ at: number; recipients: number }>('SELECT at, recipients FROM attempts WHERE at >= ?1 ORDER BY at', sinceMs).toArray(); }
  add(at: number, recipients: number) { this.sql.exec('INSERT INTO attempts (at, recipients) VALUES (?1, ?2)', at, recipients); }
  prune(beforeMs: number) { this.sql.exec('DELETE FROM attempts WHERE at < ?1', beforeMs); }
}

/**
 * The one sending queue: invitations, notification emails, Daily_Digests, and emails to Submitters (R20.17). A kick from the
 * outbox or the one-minute cron, or its own alarm, runs a pass; the alarm is set for the earliest moment something is due.
 */
export class Mailer extends DurableObject<Env> {
  readonly #log: AttemptLog;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#log = new StoredAttemptLog(ctx.storage.sql);
  }

  async kick(): Promise<void> { await this.#pass(); }
  override async alarm(): Promise<void> { await this.#pass(); }

  /** The local-only subclass captures mail; the deployable class always uses the configured provider. */
  protected emailProvider(): EmailProvider | null { return providerFor(this.env); }

  async #pass(): Promise<void> {
    const log = createLogger();
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString() as Timestamp;
    try {
      const checked = (await this.ctx.storage.get<number>('digestCheckedAt')) ?? 0;
      if (nowMs - checked >= DIGEST_CHECK_MS) {
        await queueDigests(this.env.RF_CORE, now);
        await this.ctx.storage.put('digestCheckedAt', nowMs);
      }
      const wake = await runQueue({ db: this.env.RF_CORE, origin: this.env.WORKSPACE_ORIGIN, log: this.#log, provider: () => this.emailProvider() }, nowMs);
      await drainOutbox(this.env.RF_CORE, 'mail', async () => undefined, { now });
      const digestAt = (await this.ctx.storage.get<number>('digestCheckedAt'))! + DIGEST_CHECK_MS;
      await this.ctx.storage.setAlarm(Math.max(nowMs + 1000, Math.min(wake ?? digestAt, digestAt)));
    } catch (error) {
      log('error', 'mailer_pass_failed', { error });
      await this.ctx.storage.setAlarm(nowMs + 60_000);
    }
  }
}
