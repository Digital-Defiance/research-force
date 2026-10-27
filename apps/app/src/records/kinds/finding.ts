import { eq } from 'drizzle-orm';
import { findings } from '@researchforce/db/schema/core';
import { BUILT_IN_VALUE_IDS } from '@researchforce/domain/value-sets';
import type { ULID } from '@researchforce/domain/types';
import type { FieldIssue } from '../../api/errors';
import { guardStatusLinks, statusLinksPresent } from '../status-links';
import { visibleTo } from '../submissions';
import { classesOf, defined, richColumns, richText, rowsOf } from './kind';
import type { ItemFields, KindAdapter } from './kind';

const V = BUILT_IN_VALUE_IDS;

function row(fields: ItemFields) {
  const claim = richColumns(fields['claim']);
  const caveat = richColumns(fields['scopeCaveat']);
  return { claim: claim.text!, claimSpans: claim.spans, scopeCaveat: caveat.text!, scopeCaveatSpans: caveat.spans, supersededById: (fields['supersededById'] as string | undefined) ?? null };
}

export const finding: KindAdapter = {
  kind: 'finding',
  classes: () => classesOf(['claim', 'scopeCaveat'], 'content', { statusValueId: 'status', supersededById: 'status' }),
  load: (db, id) => [db.prepare('SELECT claim, claim_spans AS claimSpans, scope_caveat AS caveat, scope_caveat_spans AS caveatSpans, superseded_by_id AS supersededById FROM findings WHERE unit_id = ?1').bind(id)],
  read([result], base) {
    const stored = rowsOf<{ claim: string; claimSpans: string; caveat: string; caveatSpans: string; supersededById: ULID | null }>(result)[0];
    return {
      fields: defined({
        statusValueId: base.statusValueId ?? undefined, claim: richText(stored?.claim ?? '', stored?.claimSpans ?? null), scopeCaveat: richText(stored?.caveat ?? '', stored?.caveatSpans ?? null),
        supersededById: stored?.supersededById ?? undefined, withdrawalReason: base.statusValueId === V.findingWithdrawn ? base.withdrawalReason ?? undefined : undefined,
      }),
    };
  },
  dates: () => ({ kind: 'finding' }),
  insert: (batch, item, fields) => { batch.insert(findings, { unitId: item.id, ...row(fields) }); },
  update(batch, item, _before, after, changed) {
    if (['claim', 'scopeCaveat', 'supersededById'].some((field) => changed.has(field))) batch.update(findings, row(after), eq(findings.unitId, item.id));
  },
  adjust(merged, patch) {
    if (merged['statusValueId'] !== V.findingSuperseded && !Object.hasOwn(patch, 'supersededById')) delete merged['supersededById'];
  },
  async rules(c, save) {
    const issues: FieldIssue[] = [];
    const status = save.after['statusValueId'];
    const previous = save.before?.['statusValueId'];
    if (save.before) {
      const withdrawn = (value: unknown) => value === V.findingWithdrawn;
      if (withdrawn(status) !== withdrawn(previous)) issues.push({ field: 'statusValueId', rule: 'Withdraw a Finding with the Withdraw action; a withdrawn Finding is restored the same way.' });
      if ((save.after['withdrawalReason'] ?? null) !== (save.before['withdrawalReason'] ?? null)) issues.push({ field: 'withdrawalReason', rule: 'A withdrawal reason is given only when withdrawing the Finding.' });
    }
    const checkLinks = !save.before || status !== previous || save.after['supersededById'] !== save.before['supersededById'];
    if (checkLinks && status === V.findingConfirmed && !(await statusLinksPresent(c, save.id, { kind: 'finding' }, save.links))) {
      issues.push({ field: 'statusValueId', rule: 'A Confirmed Finding needs at least one Evidence_Link, which can be added in the same save.' });
    }
    const supersededBy = save.after['supersededById'] as string | undefined;
    if (checkLinks && status === V.findingSuperseded && supersededBy !== undefined) {
      const target = supersededBy === save.id ? undefined : await c.get('accountant').track(c.env.RF_CORE.prepare(
        `SELECT 1 AS ok FROM units u JOIN research_items ri ON ri.unit_id = u.id WHERE u.id = ?1 AND ri.kind = 'finding' AND ${visibleTo('u', '?2')}`,
      ).bind(supersededBy, c.get('session').member.id).all());
      if (!target?.results.length) issues.push({ field: 'supersededById', rule: 'Choose another existing Finding as the superseding Finding.' });
      else if (!(await statusLinksPresent(c, save.id, { kind: 'finding', supersededBy }, save.links))) {
        issues.push({ field: 'supersededById', rule: 'A Superseded Finding needs a Cross_Link to its superseding Finding, which can be added in the same save.' });
      }
    }
    return { issues, ...(checkLinks ? { write: (batch) => guardStatusLinks(batch, [save.id]) } : {}) };
  },
};
