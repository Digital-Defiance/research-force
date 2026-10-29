import { eq } from 'drizzle-orm';
import { hypotheses } from '@researchforce/db/schema/core';
import { isBlank } from '@researchforce/domain/text';
import { BUILT_IN_VALUE_IDS } from '@researchforce/domain/value-sets';
import { canonicalJson } from '@researchforce/kernel/views';
import type { FieldIssue } from '../../api/errors';
import { guardStatusLinks, statusLinksPresent } from '../status-links';
import { defined, richColumns, richText, rowsOf } from './kind';
import type { ItemFields, KindAdapter } from './kind';

const V = BUILT_IN_VALUE_IDS;

function row(fields: ItemFields) {
  const statement = richColumns(fields['statement']);
  const scope = richColumns(fields['eliminationScope']);
  return { statement: statement.text!, statementSpans: statement.spans, eliminationScope: scope.text, eliminationScopeSpans: scope.spans };
}

export const hypothesis: KindAdapter = {
  kind: 'hypothesis',
  /** The Elimination_Scope belongs to the Status_Change that sets or clears it, so a reopening records the scope that applied (R8.4). */
  classes: (before, after) => ({
    statusValueId: 'status', statement: 'content',
    eliminationScope: before && before['statusValueId'] !== after['statusValueId'] ? 'status' : 'content',
  }),
  load: (db, id) => [db.prepare('SELECT statement, statement_spans AS statementSpans, elimination_scope AS scope, elimination_scope_spans AS scopeSpans FROM hypotheses WHERE unit_id = ?1').bind(id)],
  read([result], base) {
    const stored = rowsOf<{ statement: string; statementSpans: string; scope: string | null; scopeSpans: string }>(result)[0];
    return { fields: defined({ statusValueId: base.statusValueId ?? undefined, statement: richText(stored?.statement ?? '', stored?.statementSpans ?? null), eliminationScope: richText(stored?.scope ?? null, stored?.scopeSpans ?? null) }) };
  },
  dates: () => ({ kind: 'hypothesis' }),
  insert: (batch, item, fields) => { batch.insert(hypotheses, { unitId: item.id, ...row(fields) }); },
  update(batch, item, _before, after, changed) {
    if (changed.has('statement') || changed.has('eliminationScope')) batch.update(hypotheses, row(after), eq(hypotheses.unitId, item.id));
  },
  adjust(merged, patch) {
    if (merged['statusValueId'] !== V.hypothesisEliminated && !Object.hasOwn(patch, 'eliminationScope')) delete merged['eliminationScope'];
  },
  async rules(c, save) {
    const issues: FieldIssue[] = [];
    const status = save.after['statusValueId'];
    const eliminated = status === V.hypothesisEliminated;
    const wasEliminated = save.before?.['statusValueId'] === V.hypothesisEliminated;
    if (!save.before && status !== V.hypothesisOpen) issues.push({ field: 'statusValueId', rule: 'A new Hypothesis starts Open.' });
    if (!eliminated && save.after['eliminationScope'] !== undefined) issues.push({ field: 'eliminationScope', rule: 'Only an Eliminated Hypothesis has an Elimination Scope.' });
    if (wasEliminated && !eliminated && (save.statusReason === undefined || isBlank(save.statusReason))) issues.push({ field: 'statusReason', rule: 'Give a reason for reopening the Hypothesis.' });
    if (wasEliminated && eliminated && canonicalJson(save.before!['eliminationScope'] ?? null) !== canonicalJson(save.after['eliminationScope'] ?? null) && save.mark?.mark !== 'correction') {
      issues.push({ field: 'mark', rule: 'A change to the Elimination Scope of an Eliminated Hypothesis must be marked as a Correction with a reason.' });
    }
    if (eliminated && !(await statusLinksPresent(c, save.id, { kind: 'hypothesis' }, save.links))) {
      issues.push({ field: 'statusValueId', rule: 'An Eliminated Hypothesis needs an Evidence_Link with a Run or Finding, which can be added in the same save.' });
    }
    return { issues, ...(eliminated ? { write: (batch) => guardStatusLinks(batch, [save.id]) } : {}) };
  },
};
