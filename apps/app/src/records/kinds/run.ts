import { eq, sql } from 'drizzle-orm';
import { runCounts, runs } from '@researchforce/db/schema/core';
import { enteredTimestamp } from '@researchforce/domain/dates';
import type { ULID } from '@researchforce/domain/types';
import { classesOf, defined, richColumns, richText, rowsOf } from './kind';
import type { ItemFields, KindAdapter } from './kind';

const DETAIL = ['scope', 'parameters', 'toolName', 'toolVersion', 'computeResource', 'startTime', 'endTime', 'outcomeId', 'resumePoint', 'notes'];
interface Count { readonly name: string; readonly value: string }
interface RunRow {
  scope: string; scopeSpans: string; parameters: string; parametersSpans: string; toolName: string; toolVersion: string; computeResource: string;
  startTime: string; endTime: string | null; outcomeId: string; resumePoint: string | null; notes: string | null; notesSpans: string;
}

/** The start time keeps its offset and fractional digits as entered; the key orders Runs by the instant (R7.1). */
export function startKey(startTime: string): string {
  return new Date(Date.parse(enteredTimestamp(startTime))).toISOString();
}

function row(fields: ItemFields) {
  const scope = richColumns(fields['scope']);
  const parameters = richColumns(fields['parameters']);
  const notes = richColumns(fields['notes']);
  const startTime = fields['startTime'] as string;
  return {
    scope: scope.text!, scopeSpans: scope.spans, parameters: parameters.text!, parametersSpans: parameters.spans,
    toolName: fields['toolName'] as string, toolVersion: fields['toolVersion'] as string, computeResource: fields['computeResource'] as string,
    startTime, startKey: startKey(startTime), endTime: (fields['endTime'] as string | undefined) ?? null, outcomeId: fields['outcomeId'] as string,
    resumePoint: (fields['resumePoint'] as string | undefined) ?? null, notes: notes.text, notesSpans: notes.spans,
  };
}
/** Counts stay digit strings from request to storage and back, never numbers (R7.2). */
const countRows = (id: ULID, fields: ItemFields) => ((fields['counts'] ?? []) as readonly Count[]).map((count, position) => ({ unitId: id, position, name: count.name, value: count.value }));

export const run: KindAdapter = {
  kind: 'run',
  classes: () => classesOf([...DETAIL, 'counts'], 'content', { outcomeId: 'status' }),
  load: (db, id) => [
    db.prepare(`SELECT scope, scope_spans AS scopeSpans, parameters, parameters_spans AS parametersSpans, tool_name AS toolName, tool_version AS toolVersion,
      compute_resource AS computeResource, start_time AS startTime, end_time AS endTime, outcome_id AS outcomeId, resume_point AS resumePoint,
      notes, notes_spans AS notesSpans FROM runs WHERE unit_id = ?1`).bind(id),
    db.prepare('SELECT name, value FROM run_counts WHERE unit_id = ?1 ORDER BY position').bind(id),
  ],
  read([result, counts]) {
    const stored = rowsOf<RunRow>(result)[0];
    if (!stored) return { fields: {} };
    return {
      fields: defined({
        scope: richText(stored.scope, stored.scopeSpans), parameters: richText(stored.parameters, stored.parametersSpans), toolName: stored.toolName, toolVersion: stored.toolVersion,
        computeResource: stored.computeResource, startTime: stored.startTime, endTime: stored.endTime ?? undefined, outcomeId: stored.outcomeId,
        resumePoint: stored.resumePoint ?? undefined, notes: richText(stored.notes, stored.notesSpans),
        counts: rowsOf<Count>(counts).map((count) => ({ name: count.name, value: count.value })),
      }),
    };
  },
  dates: (fields) => ({ kind: 'run', startTime: fields['startTime'] as string }),
  insert: (batch, item, fields) => { batch.insert(runs, { unitId: item.id, ...row(fields) }).bulkInsert(runCounts, countRows(item.id, fields)); },
  update(batch, item, _before, after, changed) {
    if (DETAIL.some((field) => changed.has(field))) batch.update(runs, row(after), eq(runs.unitId, item.id));
    if (changed.has('counts')) batch.run(sql`DELETE FROM run_counts WHERE unit_id = ${item.id}`).bulkInsert(runCounts, countRows(item.id, after));
  },
};
