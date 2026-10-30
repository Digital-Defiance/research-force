import { sql } from 'drizzle-orm';
import type { GuardedBatch } from '@researchforce/db/batch';
import { newULID } from '@researchforce/domain/identifiers';
import type { WorkEventKind } from '@researchforce/domain/work';

export interface WorkEventEntry { readonly subjectId: string | null; readonly detail?: Readonly<Record<string, unknown>> }

/**
 * Add attributed events to a Work_Item's history, in order and in one statement however many there are; events are added and never changed (R52.6).
 * Their sequence numbers follow the work's last one.
 */
export function recordWorkEvents(batch: GuardedBatch, workId: string, kind: WorkEventKind, entries: readonly WorkEventEntry[]): GuardedBatch {
  if (entries.length === 0) return batch;
  const rows = entries.map((entry) => ({ id: newULID(batch.actor.now), subject: entry.subjectId, detail: entry.detail === undefined ? null : JSON.stringify(entry.detail) }));
  return batch.run(sql`INSERT INTO work_events (id, work_id, seq, kind, actor_id, at, subject_id, detail)
    SELECT j.value ->> '$.id', ${workId}, (SELECT COALESCE(MAX(seq), 0) FROM work_events WHERE work_id = ${workId}) + j.key + 1, ${kind}, ${batch.actor.id}, ${batch.actor.now},
      j.value ->> '$.subject', j.value ->> '$.detail'
    FROM json_each(${JSON.stringify(rows)}) j ORDER BY j.key`);
}

/** One event, for the changes that are always single. */
export const recordWorkEvent = (batch: GuardedBatch, workId: string, kind: WorkEventKind, subjectId: string | null, detail?: Readonly<Record<string, unknown>>): GuardedBatch =>
  recordWorkEvents(batch, workId, kind, [{ subjectId, ...(detail === undefined ? {} : { detail }) }]);
