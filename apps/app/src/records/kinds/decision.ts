import { eq, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { decisionAlternatives, decisionEvidence, decisionParticipants, decisions } from '@researchforce/db/schema/core';
import { decisionDigest, revisitIsDue } from '@researchforce/domain/decisions';
import type { DecisionEventKind, DecisionState } from '@researchforce/domain/decisions';
import type { Alternative, Outcome } from '@researchforce/domain/decisions';
import type { RichText } from '@researchforce/domain/richtext';
import type { ApiEnv } from '../../api/app';
import type { FieldIssue } from '../../api/errors';
import { readParticipantResponses } from '../decisions';
import { visibleTo } from '../submissions';
import { richColumns, richText, rowsOf } from './kind';
import type { ItemFields, KindAdapter, KindRules } from './kind';

const WORDING = ['question', 'context', 'rationale', 'alternatives', 'outcome'];
const FIELDS = [...WORDING, 'scope', 'participantIds', 'evidenceCitationIds', 'revisitDate', 'revisitCondition'];
const alternativesOf = (fields: ItemFields): readonly Alternative[] => (fields['alternatives'] ?? []) as readonly Alternative[];
const idsOf = (fields: ItemFields, name: string): readonly string[] => (fields[name] ?? []) as readonly string[];
/** A list is left out when it is empty, as a saved item leaves out an empty list. */
const listed = (name: string, values: readonly string[]): ItemFields => (values.length === 0 ? {} : { [name]: values });
const json = (values: readonly unknown[]) => JSON.stringify(values);

/** The wording a personal acknowledgement answers: the question, context, rationale, alternatives and outcome as saved (R53.3). */
export function wordingDigestOf(fields: ItemFields): string {
  return decisionDigest({
    question: String(fields['question']), context: (fields['context'] as RichText | undefined)?.text, rationale: (fields['rationale'] as RichText | undefined)?.text,
    alternatives: alternativesOf(fields), outcome: fields['outcome'] as Outcome | undefined,
  });
}

/** The Decision_Record's own columns; the state, adoption and supersession columns belong to the decision operations, not to the item's fields (R53.1). */
function row(fields: ItemFields) {
  const context = richColumns(fields['context']);
  const rationale = richColumns(fields['rationale']);
  const outcome = fields['outcome'] as Outcome | undefined;
  return {
    question: String(fields['question']), context: context.text, contextSpans: context.spans, rationale: rationale.text, rationaleSpans: rationale.spans,
    scope: fields['scope'] as 'individual' | 'team', outcomeKind: outcome?.kind ?? null, outcomeAlternative: outcome?.kind === 'selected' ? outcome.alternative : null,
    outcomeReason: outcome?.kind === 'deferred' ? outcome.reason ?? null : null,
    revisitDate: (fields['revisitDate'] as { value: string } | undefined)?.value ?? null, revisitCondition: (fields['revisitCondition'] as string | undefined) ?? null,
    wordingDigest: wordingDigestOf(fields),
  };
}

function writeAlternatives(batch: Parameters<KindAdapter['insert']>[0], id: string, alternatives: readonly Alternative[]): void {
  if (alternatives.length > 0) batch.insert(decisionAlternatives, alternatives.map((alternative, position) => ({ decisionId: id, position, title: alternative.title, description: alternative.description })));
}
function writeParticipants(batch: Parameters<KindAdapter['insert']>[0], id: string, members: readonly string[]): void {
  if (members.length > 0) batch.insert(decisionParticipants, members.map((memberId, position) => ({ decisionId: id, memberId, position })));
}
function writeEvidence(batch: Parameters<KindAdapter['insert']>[0], id: string, citations: readonly string[]): void {
  if (citations.length > 0) batch.insert(decisionEvidence, citations.map((citationId, position) => ({ decisionId: id, citationId, position })));
}

export const decision: KindAdapter = {
  kind: 'decision_record',
  classes: () => ({ ...Object.fromEntries(WORDING.map((field) => [field, 'content' as const])), ...Object.fromEntries(FIELDS.filter((field) => !WORDING.includes(field)).map((field) => [field, 'detail' as const])) }),
  load: (db, id) => [
    db.prepare(`SELECT question, context, context_spans AS contextSpans, rationale, rationale_spans AS rationaleSpans, scope, outcome_kind AS outcomeKind,
      outcome_alternative AS outcomeAlternative, outcome_reason AS outcomeReason, revisit_date AS revisitDate, revisit_condition AS revisitCondition FROM decisions WHERE unit_id = ?1`).bind(id),
    db.prepare('SELECT title, description FROM decision_alternatives WHERE decision_id = ?1 ORDER BY position').bind(id),
    db.prepare('SELECT member_id AS memberId FROM decision_participants WHERE decision_id = ?1 ORDER BY position').bind(id),
    db.prepare('SELECT citation_id AS citationId FROM decision_evidence WHERE decision_id = ?1 ORDER BY position').bind(id),
  ],
  read([result, alternatives, participants, evidence]) {
    const stored = rowsOf<{
      question: string; context: string | null; contextSpans: string; rationale: string | null; rationaleSpans: string; scope: 'individual' | 'team';
      outcomeKind: 'selected' | 'deferred' | null; outcomeAlternative: number | null; outcomeReason: string | null; revisitDate: string | null; revisitCondition: string | null;
    }>(result)[0];
    if (!stored) return { fields: {} };
    const context = richText(stored.context, stored.contextSpans);
    const rationale = richText(stored.rationale, stored.rationaleSpans);
    const outcome: Outcome | undefined = stored.outcomeKind === 'selected' ? { kind: 'selected', alternative: stored.outcomeAlternative! }
      : stored.outcomeKind === 'deferred' ? { kind: 'deferred', ...(stored.outcomeReason === null ? {} : { reason: stored.outcomeReason }) } : undefined;
    return {
      fields: {
        question: stored.question, ...(context === undefined ? {} : { context }), ...(rationale === undefined ? {} : { rationale }),
        alternatives: rowsOf<Alternative>(alternatives), ...(outcome === undefined ? {} : { outcome }), scope: stored.scope,
        ...listed('participantIds', rowsOf<{ memberId: string }>(participants).map((participant) => participant.memberId)),
        ...listed('evidenceCitationIds', rowsOf<{ citationId: string }>(evidence).map((citation) => citation.citationId)),
        ...(stored.revisitDate === null ? {} : { revisitDate: { value: stored.revisitDate, approx: false } }),
        ...(stored.revisitCondition === null ? {} : { revisitCondition: stored.revisitCondition }),
      },
    };
  },
  dates: () => ({ kind: 'decision_record' }),
  insert(batch, item, fields) {
    batch.insert(decisions, { unitId: item.id, ...row(fields) });
    writeAlternatives(batch, item.id, alternativesOf(fields));
    writeParticipants(batch, item.id, idsOf(fields, 'participantIds'));
    writeEvidence(batch, item.id, idsOf(fields, 'evidenceCitationIds'));
  },
  update(batch, item, _before, after, changed) {
    if (FIELDS.some((field) => changed.has(field) && field !== 'alternatives' && field !== 'participantIds' && field !== 'evidenceCitationIds')) {
      // A change to what a response answers starts a new wording version, so that older responses read as earlier wording (R53.3).
      batch.update(decisions, row(after), eq(decisions.unitId, item.id));
    } else if (changed.has('alternatives')) {
      batch.update(decisions, { wordingDigest: wordingDigestOf(after) }, eq(decisions.unitId, item.id));
    }
    if (WORDING.some((field) => changed.has(field))) batch.run(sql`UPDATE decisions SET wording_version = wording_version + 1 WHERE unit_id = ${item.id}`);
    if (changed.has('alternatives')) {
      batch.run(sql`DELETE FROM decision_alternatives WHERE decision_id = ${item.id}`);
      writeAlternatives(batch, item.id, alternativesOf(after));
    }
    if (changed.has('participantIds')) {
      batch.run(sql`DELETE FROM decision_participants WHERE decision_id = ${item.id}`);
      writeParticipants(batch, item.id, idsOf(after, 'participantIds'));
    }
    if (changed.has('evidenceCitationIds')) {
      batch.run(sql`DELETE FROM decision_evidence WHERE decision_id = ${item.id}`);
      writeEvidence(batch, item.id, idsOf(after, 'evidenceCitationIds'));
    }
  },
  /**
   * What the viewer may see of the decision: its state and history, each named participant's own response, the decisions it replaced or was replaced
   * by when they can read them, and the evidence whose Source they can read, with its locator and whether the cited version is still current
   * (R53.2, R53.4, R54.5).
   */
  async visible(c: Context<ApiEnv>, fields, id) {
    const db = c.env.RF_CORE;
    const viewer = c.get('session').member.id;
    const [stateRows, eventRows, nameRows] = await c.get('accountant').track(db.batch([
      db.prepare(`SELECT state, adopted_at AS adoptedAt, adopted_by AS adoptedBy, supersedes_id AS supersedesId, superseded_by_id AS supersededById,
        wording_digest AS digest, wording_version AS wordingVersion, revisit_reminded_at AS revisitRemindedAt FROM decisions WHERE unit_id = ?1`).bind(id),
      db.prepare(`SELECT e.seq, e.kind, e.actor_id AS actorId, p.display_name AS actorName, e.at, e.reason, e.related_id AS relatedId
        FROM decision_events e LEFT JOIN profiles p ON p.member_id = e.actor_id WHERE e.decision_id = ?1 ORDER BY e.seq`).bind(id),
      db.prepare(`SELECT p.member_id AS id, pr.display_name AS name FROM decision_participants p LEFT JOIN profiles pr ON pr.member_id = p.member_id WHERE p.decision_id = ?1`).bind(id),
    ]));
    const stored = rowsOf<{ state: DecisionState; adoptedAt: string | null; adoptedBy: string | null; supersedesId: string | null; supersededById: string | null; digest: string; wordingVersion: number; revisitRemindedAt: string | null }>(stateRows)[0];
    const names = new Map(rowsOf<{ id: string; name: string | null }>(nameRows).map((row) => [row.id, row.name]));
    const state: Record<string, unknown> = {};
    if (stored !== undefined) {
      const neighbours = [stored.supersedesId, stored.supersededById].filter((value): value is string => value !== null);
      const readableNeighbours = neighbours.length === 0 ? [] : rowsOf<{ id: string; title: string; state: DecisionState; adoptedAt: string | null; rationale: string | null }>(await c.get('accountant').track(db.prepare(
        `SELECT d.unit_id AS id, ri.title, d.state, d.adopted_at AS adoptedAt, d.rationale FROM decisions d JOIN units u ON u.id = d.unit_id JOIN research_items ri ON ri.unit_id = d.unit_id
          WHERE d.unit_id IN (SELECT value FROM json_each(?1)) AND ${visibleTo('u', '?2')} AND NOT EXISTS (SELECT 1 FROM deletions x WHERE x.unit_id IN (u.id, u.root_id))`,
      ).bind(JSON.stringify(neighbours), viewer).all()));
      const summary = async (neighbourId: string | null) => {
        const found = readableNeighbours.find((row) => row.id === neighbourId);
        if (found === undefined) return undefined;
        const responses = await readParticipantResponses(db, found.id);
        const ids = responses.map((response) => response.memberId);
        const named = ids.length === 0 ? [] : rowsOf<{ id: string; name: string | null }>(await c.get('accountant').track(db.prepare('SELECT member_id AS id, display_name AS name FROM profiles WHERE member_id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(ids)).all()));
        return { id: found.id, title: found.title, state: found.state, adoptedAt: found.adoptedAt, rationale: found.rationale, responses: responses.map((response) => ({ ...response, name: named.find((row) => row.id === response.memberId)?.name ?? null })) };
      };
      const events = rowsOf<{ seq: number; kind: DecisionEventKind; actorId: string | null; actorName: string | null; at: string; reason: string | null; relatedId: string | null }>(eventRows)
        .map((event) => ({ ...event, relatedId: event.relatedId !== null && readableNeighbours.some((row) => row.id === event.relatedId) ? event.relatedId : null }));
      const responses = await readParticipantResponses(db, id);
      Object.assign(state, {
        decisionState: stored.state, decisionAdoptedAt: stored.adoptedAt, decisionAdoptedBy: stored.adoptedBy, wordingDigest: stored.digest, wordingVersion: stored.wordingVersion,
        revisitDue: revisitIsDue(stored.state, (fields['revisitDate'] as { value: string } | undefined)?.value, c.get('now').slice(0, 10)), decisionEvents: events,
        participantResponses: responses.map((response) => ({ ...response, name: names.get(response.memberId) ?? null })),
        supersedes: await summary(stored.supersedesId) ?? null, supersededBy: await summary(stored.supersededById) ?? null,
      });
    }
    const wanted = idsOf(fields, 'evidenceCitationIds');
    if (wanted.length === 0) return { fields, extra: { ...state, evidenceDetails: {} } };
    const { readableCitations } = await import('../citations'); // citations load items, which load the kind adapters
    const found = await readableCitations(c, { ids: wanted, includeRetired: true });
    const details = Object.fromEntries(found.map((citation) => [citation.id, citation]));
    return { fields: { ...fields, evidenceCitationIds: wanted.filter((id) => details[id] !== undefined) }, extra: { ...state, evidenceDetails: details } };
  },
  /**
   * A decision that is Superseded or Withdrawn is final (R53.4). Evidence must be citations recorded from this decision that are still in use
   * and that the Member can read; evidence an edit keeps is not checked again, but a Member who cannot read all of it cannot rearrange it.
   */
  async rules(c: Context<ApiEnv>, save): Promise<KindRules> {
    const issues: FieldIssue[] = [];
    const state = save.base === undefined ? undefined : (await c.get('accountant').track(c.env.RF_CORE.prepare('SELECT state FROM decisions WHERE unit_id = ?1').bind(save.id).all<{ state: string }>())).results[0]?.state;
    const changedAny = save.before !== undefined && FIELDS.some((field) => JSON.stringify(save.before![field]) !== JSON.stringify(save.after[field]));
    if (changedAny && (state === 'superseded' || state === 'withdrawn')) return { issues: [{ field: 'question', rule: `A ${state} decision is kept as it was; record a new decision instead.` }] };
    const wanted = idsOf(save.after, 'evidenceCitationIds');
    const existing = new Set(idsOf(save.before ?? {}, 'evidenceCitationIds'));
    if (save.base === undefined && wanted.length > 0) return { issues: [{ field: 'evidenceCitationIds', rule: 'Cite evidence after the decision is saved, so the citations can name it.' }] };
    if (save.base !== undefined && json(wanted) !== json([...existing])) {
      const stored = (await c.get('accountant').track(c.env.RF_CORE.prepare('SELECT count(*) AS n FROM decision_evidence WHERE decision_id = ?1').bind(save.id).all<{ n: number }>())).results[0]?.n ?? 0;
      if (stored > existing.size) issues.push({ field: 'evidenceCitationIds', rule: 'This decision cites evidence that you cannot read, so only a Member who can read all of it can change the list.' });
    }
    const added = wanted.filter((id) => !existing.has(id));
    if (added.length > 0) {
      const { readableCitations } = await import('../citations');
      const found = new Map((await readableCitations(c, { ids: added })).map((citation) => [citation.id as string, citation]));
      wanted.forEach((id, index) => {
        if (existing.has(id)) return;
        const citation = found.get(id);
        if (citation === undefined) issues.push({ field: `evidenceCitationIds.${index}`, rule: 'This citation does not exist, has been removed, or cannot be read.' });
        else if (citation.citingUnitId !== save.id) issues.push({ field: `evidenceCitationIds.${index}`, rule: 'Cite from this decision: the citation was recorded for another record.' });
      });
    }
    return { issues };
  },
};
