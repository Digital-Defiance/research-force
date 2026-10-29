import type { OutboxTopic } from '@researchforce/db/accountant';
import { OUTBOX_TOPICS } from '@researchforce/db/schema/core';
import { OPERATIONS } from '@researchforce/domain/settings';
import type { Timestamp } from '@researchforce/domain/types';
import type { Env } from './env';
import type { Logger } from './log';

export interface OutboxRow { readonly seq: number; readonly scope: string; readonly changeSeq: number; readonly createdAt: Timestamp }

/** The Durable Object instance that drains each topic (design "Outbox, kick, sweep"). */
export const OUTBOX_OWNERS = Object.freeze({ publish: 'publisher', mail: 'mailer', search: 'indexer', jobs: 'dispatcher' } satisfies Record<OutboxTopic, string>);

export function ownerOf(env: Env, topic: OutboxTopic): { kick(topic: OutboxTopic): Promise<void> } {
  switch (topic) {
    case 'publish': return env.PUBLISHER.getByName(OUTBOX_OWNERS.publish);
    case 'mail': return env.MAILER.getByName(OUTBOX_OWNERS.mail);
    case 'search': return env.JOBS.getByName(OUTBOX_OWNERS.search);
    case 'jobs': return env.JOBS.getByName(OUTBOX_OWNERS.jobs);
  }
}

/** The topic's pending rows, oldest first. */
export async function readOutbox(db: D1Database, topic: OutboxTopic, limit: number = OPERATIONS.jobSliceRows): Promise<OutboxRow[]> {
  const result = await db.prepare('SELECT seq, scope, change_seq AS changeSeq, created_at AS createdAt FROM outbox WHERE topic = ?1 AND done_at IS NULL ORDER BY seq LIMIT ?2')
    .bind(topic, limit).all<OutboxRow>();
  return result.results;
}

/** Mark rows of the topic done; rows already marked keep their first time. */
export async function markOutboxDone(db: D1Database, topic: OutboxTopic, seqs: readonly number[], now: Timestamp): Promise<number> {
  if (seqs.length === 0) return 0;
  const result = await db.prepare('UPDATE outbox SET done_at = ?1 WHERE topic = ?2 AND done_at IS NULL AND seq IN (SELECT value FROM json_each(?3))')
    .bind(now, topic, JSON.stringify(seqs)).run();
  return result.meta.changes;
}

/**
 * Process one slice of the topic in `seq` order and mark it done. Rows are marked only after `process`
 * returns, so a failed slice is read again and processing must be idempotent per row.
 */
export async function drainOutbox(
  db: D1Database, topic: OutboxTopic, process: (rows: readonly OutboxRow[]) => Promise<void>, options: { readonly now: Timestamp; readonly limit?: number },
): Promise<{ readonly processed: number; readonly more: boolean }> {
  const limit = options.limit ?? OPERATIONS.jobSliceRows;
  const rows = await readOutbox(db, topic, limit);
  if (rows.length === 0) return { processed: 0, more: false };
  await process(rows);
  await markOutboxDone(db, topic, rows.map((row) => row.seq), options.now);
  return { processed: rows.length, more: rows.length === limit };
}

/** Best-effort kicks; a lost one delays the work until the next one-minute cron run. */
export async function kick(env: Env, topics: readonly OutboxTopic[], log: Logger): Promise<void> {
  await Promise.all(topics.map(async (topic) => {
    try {
      await ownerOf(env, topic).kick(topic);
    } catch (error) {
      log('warn', 'kick_failed', { topic, error });
    }
  }));
}

export function kickAll(env: Env, log: Logger): Promise<void> {
  return kick(env, OUTBOX_TOPICS, log);
}
