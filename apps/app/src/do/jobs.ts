import { DurableObject } from 'cloudflare:workers';
import type { OutboxTopic } from '@researchforce/db/accountant';
import type { JOB_STATES, JOB_TYPES } from '@researchforce/db/schema/core';
import { OPERATIONS } from '@researchforce/domain/settings';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import { isDailyLimitError } from '../api/errors';
import type { Env } from '../env';
import { createLogger } from '../log';
import { drainOutbox } from '../outbox';

export type JobType = typeof JOB_TYPES[number];
type JobState = typeof JOB_STATES[number];
type RunState = Exclude<JobState, 'paused'>;
/** What a job stores as its parameters, cursor, and progress. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface JobRecord { readonly id: string; readonly type: JobType; readonly params: JsonValue; readonly requestedBy: ULID | null }
export interface JobContext { readonly env: Env; readonly job: JobRecord; readonly now: Timestamp }
export interface SliceResult {
  readonly cursor: JsonValue;
  readonly progress: JsonValue;
  readonly done: boolean;
  /** How a finished job ended; complete unless the handler found something missing. */
  readonly outcome?: 'complete' | 'incomplete';
}
/**
 * One kind of job. A slice does about 5 ms of CPU after `cursor` (null at the start), sized by the
 * operations budgets. Its writes must commit together or be idempotent: a slice stopped by an error,
 * such as a daily limit, runs again from the previous cursor.
 */
export interface JobHandler { slice(context: JobContext, cursor: JsonValue): Promise<SliceResult> }

/** Each job type's handler, registered by its feature. */
export const JOB_HANDLERS: Partial<Record<JobType, JobHandler>> = {};

/** Pausing until a little after 00:00 UTC keeps clear of clock differences with D1's reset. */
export const DAILY_LIMIT_RESUME_DELAY_MS = 60_000;
/** Each `jobs` outbox row starts a job through one Durable Object call. */
const DISPATCH_SLICE_ROWS = OPERATIONS.maxExternalSubrequests;
const TERMINAL: ReadonlySet<RunState> = new Set(['complete', 'incomplete', 'failed']);

export function resumeAfterDailyLimit(nowMs: number): number {
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) + DAILY_LIMIT_RESUME_DELAY_MS;
}

const jobIdOf = (scope: string): string | undefined => /^job:(.+)$/u.exec(scope)?.[1];

interface StoredJob {
  readonly role: 'dispatcher' | 'job';
  readonly id: string;
  readonly type: JobType | null;
  readonly params: JsonValue;
  readonly requestedBy: ULID | null;
  readonly state: RunState;
  readonly cursor: JsonValue;
  readonly progress: JsonValue;
  readonly pausedUntil: number | null;
  /** Whether the `jobs` row shows this state; it lags while D1 refuses writes. */
  readonly mirrored: boolean;
}
export interface JobStatus {
  readonly id: string;
  readonly state: RunState;
  readonly pausedUntil: number | null;
  readonly mirrored: boolean;
  readonly cursor: string;
  readonly progress: string;
}
type StoredRow = Record<'role' | 'id' | 'type' | 'params' | 'requested_by' | 'state' | 'cursor' | 'progress' | 'paused_until' | 'mirrored', SqlStorageValue>;

/**
 * One instance per job, named by the job id, plus the `dispatcher` instance that drains the `jobs`
 * topic and the `indexer` instance of the search topic (Task 28.1). A job's cursor and progress live in
 * this object's SQLite storage first, so a D1 failure never loses work, and are mirrored to `jobs`.
 */
export class Jobs extends DurableObject<Env> {
  readonly #log = createLogger();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS job_state (
      only INTEGER PRIMARY KEY CHECK (only = 1), role TEXT NOT NULL, id TEXT NOT NULL, type TEXT, params TEXT, requested_by TEXT,
      state TEXT NOT NULL, cursor TEXT, progress TEXT, paused_until INTEGER, mirrored INTEGER NOT NULL DEFAULT 1)`);
  }

  /** The topic owner's kick: drain the `jobs` topic. The search indexer's rows stay pending until Task 28.1. */
  async kick(topic: OutboxTopic): Promise<void> {
    if (topic !== 'jobs') return;
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO job_state (only, role, id, state) VALUES (1, 'dispatcher', 'dispatcher', 'running')");
    await this.#wake(Date.now());
  }

  /** Start the job with this id from its `jobs` row; starting a started job only wakes it. */
  async start(id: string): Promise<void> {
    const stored = this.#load();
    if (stored) {
      if (stored.role === 'job' && !TERMINAL.has(stored.state)) await this.#wake(stored.pausedUntil ?? Date.now());
      return;
    }
    const row = await this.env.RF_CORE.prepare('SELECT type, state, params, cursor, progress, requested_by AS requestedBy FROM jobs WHERE id = ?1')
      .bind(id).first<{ type: JobType; state: JobState; params: string | null; cursor: string | null; progress: string | null; requestedBy: ULID | null }>();
    if (!row || TERMINAL.has(row.state as RunState)) return;
    this.ctx.storage.sql.exec(
      "INSERT INTO job_state (only, role, id, type, params, requested_by, state, cursor, progress, mirrored) VALUES (1, 'job', ?, ?, ?, ?, 'running', ?, ?, 0)",
      id, row.type, row.params, row.requestedBy, row.cursor, row.progress,
    );
    await this.#wake(Date.now());
  }

  /** The stored state, with the cursor and progress as JSON text. */
  status(): JobStatus | null {
    const job = this.#load();
    return job && { id: job.id, state: job.state, pausedUntil: job.pausedUntil, mirrored: job.mirrored, cursor: JSON.stringify(job.cursor), progress: JSON.stringify(job.progress) };
  }

  override async alarm(): Promise<void> {
    const stored = this.#load();
    if (!stored) return;
    if (stored.role === 'dispatcher') await this.#dispatch();
    else await this.#runSlice(stored);
  }

  async #dispatch(): Promise<void> {
    try {
      const { more } = await drainOutbox(this.env.RF_CORE, 'jobs', async (rows) => {
        for (const row of rows) {
          const id = jobIdOf(row.scope);
          if (id === undefined) this.#log('warn', 'job_scope_invalid', { seq: row.seq });
          else await this.env.JOBS.getByName(id).start(id);
        }
      }, { now: new Date().toISOString() as Timestamp, limit: DISPATCH_SLICE_ROWS });
      if (more) await this.ctx.storage.setAlarm(Date.now());
    } catch (error) {
      // At a daily limit the next one-minute cron kick tries again; anything else lets the platform retry the alarm.
      if (!isDailyLimitError(error)) throw error;
    }
  }

  async #runSlice(stored: StoredJob): Promise<void> {
    const nowMs = Date.now();
    if (stored.pausedUntil !== null && nowMs < stored.pausedUntil) {
      await this.ctx.storage.setAlarm(stored.pausedUntil);
      return;
    }
    let job = stored.pausedUntil === null ? stored : this.#update({ pausedUntil: null, mirrored: false });
    try {
      if (!job.mirrored) job = await this.#mirror(job);
      if (TERMINAL.has(job.state)) return;
      const handler = job.type === null ? undefined : JOB_HANDLERS[job.type];
      if (!handler) {
        this.#log('error', 'job_handler_missing', { job: job.id, type: job.type });
        await this.#mirror(this.#update({ state: 'failed', mirrored: false }));
        return;
      }
      const record: JobRecord = { id: job.id, type: job.type!, params: job.params, requestedBy: job.requestedBy };
      let result: SliceResult;
      try {
        result = await handler.slice({ env: this.env, job: record, now: new Date(nowMs).toISOString() as Timestamp }, job.cursor);
      } catch (error) {
        if (isDailyLimitError(error)) throw error;
        this.#log('error', 'job_failed', { job: job.id, type: job.type, error });
        await this.#mirror(this.#update({ state: 'failed', mirrored: false }));
        return;
      }
      job = this.#update({ cursor: result.cursor, progress: result.progress, state: result.done ? result.outcome ?? 'complete' : 'running', mirrored: false });
      job = await this.#mirror(job);
      if (!TERMINAL.has(job.state)) await this.ctx.storage.setAlarm(Date.now());
    } catch (error) {
      if (!isDailyLimitError(error)) throw error;
      const resumeAt = resumeAfterDailyLimit(nowMs);
      const paused = this.#update({ pausedUntil: resumeAt, mirrored: false });
      await this.ctx.storage.setAlarm(resumeAt);
      this.#log('warn', 'job_paused', { job: stored.id, type: stored.type, until: new Date(resumeAt).toISOString() });
      // The limit may cover only what the slice wrote, so the row can often still show the pause.
      await this.#mirror(paused).catch((mirrorError: unknown) => {
        if (!isDailyLimitError(mirrorError)) this.#log('warn', 'job_mirror_failed', { job: stored.id, error: mirrorError });
      });
    }
  }

  /** Copy the stored state to the `jobs` row; at a daily limit the row lags until the job resumes. */
  async #mirror(job: StoredJob): Promise<StoredJob> {
    const now = new Date().toISOString();
    await this.env.RF_CORE.prepare(`UPDATE jobs SET state = ?1, cursor = ?2, progress = ?3, updated_at = ?4,
      finished_at = CASE WHEN ?1 IN ('complete', 'incomplete', 'failed') THEN coalesce(finished_at, ?4) END WHERE id = ?5`)
      .bind(job.pausedUntil === null ? job.state : 'paused', JSON.stringify(job.cursor ?? null), JSON.stringify(job.progress ?? null), now, job.id).run();
    return this.#update({ mirrored: true });
  }

  async #wake(atMs: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > atMs) await this.ctx.storage.setAlarm(atMs);
  }

  #update(change: Partial<Pick<StoredJob, 'state' | 'cursor' | 'progress' | 'pausedUntil' | 'mirrored'>>): StoredJob {
    const current = this.#load()!;
    const next = { ...current, ...change };
    this.ctx.storage.sql.exec(
      'UPDATE job_state SET state = ?, cursor = ?, progress = ?, paused_until = ?, mirrored = ? WHERE only = 1',
      next.state, JSON.stringify(next.cursor ?? null), JSON.stringify(next.progress ?? null), next.pausedUntil, next.mirrored ? 1 : 0,
    );
    return next;
  }

  #load(): StoredJob | null {
    const row = this.ctx.storage.sql.exec<StoredRow>('SELECT role, id, type, params, requested_by, state, cursor, progress, paused_until, mirrored FROM job_state').toArray()[0];
    if (!row) return null;
    const json = (value: SqlStorageValue): JsonValue => (typeof value === 'string' ? JSON.parse(value) as JsonValue : null);
    return {
      role: row.role as StoredJob['role'], id: row.id as string, type: row.type as JobType | null, params: json(row.params),
      requestedBy: row.requested_by as ULID | null, state: row.state as RunState, cursor: json(row.cursor), progress: json(row.progress),
      pausedUntil: row.paused_until as number | null, mirrored: row.mirrored === 1,
    };
  }
}
