import { sql } from 'drizzle-orm';
import type { GuardedBatch } from '@researchforce/db/batch';
import { newULID } from '@researchforce/domain/identifiers';
import type { WorkEventKind } from '@researchforce/domain/work';

/** Add one attributed event to a Work_Item's history; events are added in order and never changed (R52.6). */
export function recordWorkEvent(batch: GuardedBatch, workId: string, kind: WorkEventKind, subjectId: string | null, detail?: Readonly<Record<string, unknown>>): GuardedBatch {
  return batch.run(sql`INSERT INTO work_events (id, work_id, seq, kind, actor_id, at, subject_id, detail)
    VALUES (${newULID(batch.actor.now)}, ${workId}, (SELECT COALESCE(MAX(seq), 0) + 1 FROM work_events WHERE work_id = ${workId}), ${kind}, ${batch.actor.id},
      ${batch.actor.now}, ${subjectId}, ${detail === undefined ? null : JSON.stringify(detail)})`);
}
