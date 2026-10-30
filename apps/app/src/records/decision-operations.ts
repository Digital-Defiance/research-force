import { eq, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { GuardedBatch, GuardViolation } from '@researchforce/db/batch';
import { decisions, units } from '@researchforce/db/schema/core';
import { acknowledgementInputSchema, adoptInputSchema, adoptionIssues, DECISION_STATE_NAMES, DECISION_TRANSITIONS, REVISIT_REMINDER_DAYS, supersedeInputSchema, withdrawInputSchema } from '@researchforce/domain/decisions';
import type { Alternative, DecisionEventKind, DecisionState, Outcome } from '@researchforce/domain/decisions';
import type { RichText } from '@researchforce/domain/richtext';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import { parse } from '../api/input';
import { authorize } from '../auth/authorize';
import { announceRevisions } from '../activity/flags';
import type { Env } from '../env';
import { notifyDecisionAudience } from '../notifications/fanout';
import { recordAcknowledgement } from './decisions';
import { loadItem } from './items';
import { commitSave, revisionsFor } from './pipeline';
import type { FieldChange } from './pipeline';

interface Loaded { id: ULID; state: DecisionState; ownerId: ULID; projectId: ULID; rev: number; withdrawn: boolean; fields: Record<string, unknown> }

async function loadDecision(c: Context<ApiEnv>, id: string): Promise<Loaded> {
  const item = await loadItem(c, id);
  if (item.base.kind !== 'decision_record') throw new ApiError('not_found');
  const state = item.extra['decisionState'] as DecisionState;
  return { id: item.base.id, state, ownerId: item.base.ownerId, projectId: item.base.projectId, rev: item.base.rev, withdrawn: item.base.withdrawnAt !== null, fields: item.fields as Record<string, unknown> };
}

const mayEdit = (c: Context<ApiEnv>, decision: Loaded) => authorize(c, [{ permission: 'item.edit', target: { type: 'research_item', ownerId: decision.ownerId, itemKind: 'decision_record', field: 'content' } }]);

function requireTransition(decision: Loaded, to: DecisionState): void {
  if (decision.withdrawn) throw new ApiError('validation', { fields: [{ field: 'state', rule: 'This decision has been withdrawn from the Project.' }] });
  if (!DECISION_TRANSITIONS[decision.state].includes(to)) {
    throw new ApiError('conflict', { details: { state: decision.state, rule: `A ${DECISION_STATE_NAMES[decision.state].toLowerCase()} decision cannot become ${DECISION_STATE_NAMES[to].toLowerCase()}.` } });
  }
}

/** The adoption rule of R53.2, judged on what is stored: a rationale that is not blank, and a selected alternative or an explicit deferral. */
function requireAdoptable(decision: Loaded): void {
  const rationale = decision.fields['rationale'] as RichText | undefined;
  const issues = adoptionIssues({
    ...(rationale === undefined ? {} : { rationale: rationale.text }), ...(decision.fields['outcome'] === undefined ? {} : { outcome: decision.fields['outcome'] as Outcome }),
    alternatives: (decision.fields['alternatives'] ?? []) as Alternative[],
  });
  if (issues.length > 0) throw new ApiError('validation', { fields: issues });
}

/** Append one event to the decision's attributed timeline; the sequence is taken when the batch runs, so two writers never share one. */
export function recordEvent(batch: GuardedBatch, decisionId: string, kind: DecisionEventKind, options: { reason?: string | null; relatedId?: string | null } = {}): GuardedBatch {
  return batch.run(sql`INSERT INTO decision_events (decision_id, seq, kind, actor_id, at, reason, related_id)
    VALUES (${decisionId}, (SELECT COALESCE(MAX(seq), 0) + 1 FROM decision_events WHERE decision_id = ${decisionId}), ${kind}, ${batch.actor.id}, ${batch.actor.now}, ${options.reason ?? null}, ${options.relatedId ?? null})`);
}

const stateChange = (from: DecisionState, to: DecisionState): FieldChange => ({ field: 'decisionState', before: from, after: to, fieldClass: 'status' });

/** The state guard runs when the batch does, so a decision that moved since it was read is refused rather than moved twice (R53.4). */
const guardState = (batch: GuardedBatch, id: string, state: DecisionState): GuardedBatch => batch.guard('rev', sql`EXISTS (SELECT 1 FROM decisions WHERE unit_id = ${id} AND state = ${state})`);

/** Adopt a proposed decision: its effective date and the adopter are recorded, and the participants are told (R53.2, R53.4). */
export async function adoptDecision(c: Context<ApiEnv>, id: string, body: unknown): Promise<void> {
  const input = parse(adoptInputSchema, body);
  const decision = await loadDecision(c, id);
  await mayEdit(c, decision);
  requireTransition(decision, 'adopted');
  requireAdoptable(decision);
  await commitSave(c, {
    target: { type: 'unit', id, rootId: id }, startedFrom: input.rev, change: { fields: [stateChange('proposed', 'adopted')] },
    write: (batch) => {
      guardState(batch, id, 'proposed');
      batch.update(units, {}, eq(units.id, id));
      batch.update(decisions, { state: 'adopted', adoptedAt: batch.actor.now, adoptedBy: batch.actor.id!, stateChangedAt: batch.actor.now, stateChangedBy: batch.actor.id! }, eq(decisions.unitId, id));
      recordEvent(batch, id, 'adopted');
      notifyDecisionAudience(batch, id, { decision: 'adopted' }, { type: 'item_update', owner: false });
    },
    outbox: [['publish', `unit:${id}`], ['search', `unit:${id}`]],
  });
}

/** Withdraw a proposed or adopted decision. The record stays, with the reason, and is never presented as in force (R53.4). */
export async function withdrawDecision(c: Context<ApiEnv>, id: string, body: unknown): Promise<void> {
  const input = parse(withdrawInputSchema, body);
  const decision = await loadDecision(c, id);
  await mayEdit(c, decision);
  requireTransition(decision, 'withdrawn');
  const from = decision.state;
  await commitSave(c, {
    target: { type: 'unit', id, rootId: id }, startedFrom: input.rev,
    change: { fields: [stateChange(from, 'withdrawn')], ...(input.reason === undefined ? {} : { reasons: { status: input.reason } }) },
    write: (batch) => {
      guardState(batch, id, from);
      batch.update(units, {}, eq(units.id, id));
      batch.update(decisions, { state: 'withdrawn', stateChangedAt: batch.actor.now, stateChangedBy: batch.actor.id! }, eq(decisions.unitId, id));
      recordEvent(batch, id, 'withdrawn', { reason: input.reason ?? null });
      notifyDecisionAudience(batch, id, { decision: 'withdrawn' }, { type: 'item_update', owner: false });
    },
    outbox: [['publish', `unit:${id}`], ['search', `unit:${id}`]],
  });
}

/**
 * Adopt the proposed decision `id` as the replacement of an adopted one. The two link to each other and the earlier one is kept as it was,
 * marked superseded; both change together or neither does (R53.4). The replacement must be adoptable, and the actor must be able to edit both.
 */
export async function supersedeDecision(c: Context<ApiEnv>, id: string, body: unknown): Promise<void> {
  const input = parse(supersedeInputSchema, body);
  if (input.supersededId === id) throw new ApiError('validation', { fields: [{ field: 'supersededId', rule: 'A decision cannot replace itself.' }] });
  const replacement = await loadDecision(c, id);
  const earlier = await loadDecision(c, input.supersededId).catch((error: unknown) => {
    if (error instanceof ApiError && error.code === 'not_found') throw new ApiError('validation', { fields: [{ field: 'supersededId', rule: 'This decision does not exist or cannot be read.' }] });
    throw error;
  });
  await mayEdit(c, replacement);
  await mayEdit(c, earlier);
  if (replacement.projectId !== earlier.projectId) throw new ApiError('validation', { fields: [{ field: 'supersededId', rule: 'A decision can replace only a decision of the same Project.' }] });
  requireTransition(replacement, 'adopted');
  requireTransition(earlier, 'superseded');
  requireAdoptable(replacement);
  const earlierTarget = { type: 'unit', id: earlier.id, rootId: earlier.id } as const;
  await commitSave(c, {
    target: { type: 'unit', id, rootId: id }, startedFrom: input.rev, change: { fields: [stateChange('proposed', 'adopted')] },
    write: (batch) => {
      guardState(batch, id, 'proposed');
      batch.guard('rev', sql`(SELECT rev FROM units WHERE id = ${earlier.id}) = ${input.supersededRev}`);
      batch.guard('rev', sql`EXISTS (SELECT 1 FROM decisions WHERE unit_id = ${earlier.id} AND state = 'adopted' AND superseded_by_id IS NULL)`);
      batch.update(units, {}, eq(units.id, id));
      batch.update(units, {}, eq(units.id, earlier.id));
      batch.update(decisions, {
        state: 'adopted', adoptedAt: batch.actor.now, adoptedBy: batch.actor.id!, supersedesId: earlier.id, stateChangedAt: batch.actor.now, stateChangedBy: batch.actor.id!,
      }, eq(decisions.unitId, id));
      batch.update(decisions, { state: 'superseded', supersededById: id, stateChangedAt: batch.actor.now, stateChangedBy: batch.actor.id! }, eq(decisions.unitId, earlier.id));
      const revisions = revisionsFor(earlierTarget, { fields: [stateChange('adopted', 'superseded')] });
      for (const revision of revisions) batch.revision(revision);
      announceRevisions(batch, earlierTarget, revisions.map((revision) => revision.kind));
      recordEvent(batch, id, 'adopted', { relatedId: earlier.id });
      recordEvent(batch, earlier.id, 'superseded', { relatedId: id });
      notifyDecisionAudience(batch, id, { decision: 'adopted', supersedes: earlier.id }, { type: 'item_update', owner: false });
      notifyDecisionAudience(batch, earlier.id, { decision: 'superseded', supersededBy: id }, { type: 'item_update', owner: false });
      batch.outbox('publish', `unit:${earlier.id}`);
      batch.outbox('search', `unit:${earlier.id}`);
    },
    outbox: [['publish', `unit:${id}`], ['search', `unit:${id}`]],
  });
}

/**
 * Record the acting Member's own response to a Team decision. The Member is the session's, never the input's; the response names the wording it read
 * and the response of the Member's own it replaces, so a stale page cannot agree to newer wording (R53.2, R53.3).
 */
export async function acknowledgeDecision(c: Context<ApiEnv>, id: string, body: unknown): Promise<void> {
  const input = parse(acknowledgementInputSchema, body);
  const decision = await loadDecision(c, id);
  const memberId = c.get('session').member.id;
  await authorize(c, [{ permission: 'decision.acknowledge', target: { type: 'decision_response', memberId } }]);
  if (decision.state === 'superseded' || decision.state === 'withdrawn' || decision.withdrawn) {
    throw new ApiError('conflict', { details: { state: decision.state, rule: 'A response is recorded only while a decision is proposed or adopted.' } });
  }
  const batch = new GuardedBatch(c.env.RF_CORE, { id: memberId, now: c.get('now') });
  recordAcknowledgement(batch, decision.id, input);
  await batch.commit(c.get('accountant'));
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Decisions one sweep reminds; the rest wait for the next hour. */
export const REVISIT_REMINDERS_PER_SWEEP = 25;

/**
 * Remind the Owner, the adopter and the named participants of each adopted decision whose review date has come, and again after each further
 * interval until it is revisited (superseded or withdrawn). A reminder is caused by no Member (R53.4). Returns how many decisions were reminded.
 */
export async function sweepDecisionRevisits(env: Env, now: Timestamp): Promise<number> {
  const db = env.RF_CORE;
  const { results } = await db.prepare(
    `SELECT d.unit_id AS id FROM decisions d JOIN units u ON u.id = d.unit_id
      WHERE d.state = 'adopted' AND d.revisit_date IS NOT NULL AND d.revisit_date <= substr(?1, 1, 10) AND u.withdrawn_at IS NULL
        AND (d.revisit_reminded_at IS NULL OR d.revisit_reminded_at <= ?2) AND NOT EXISTS (SELECT 1 FROM deletions x WHERE x.unit_id IN (u.id, u.root_id))
      ORDER BY d.unit_id LIMIT ?3`,
  ).bind(now, new Date(Date.parse(now) - REVISIT_REMINDER_DAYS * DAY_MS).toISOString(), REVISIT_REMINDERS_PER_SWEEP).all<{ id: ULID }>();
  for (const { id } of results) {
    const batch = new GuardedBatch(db, { id: null, now });
    batch.guard('rev', sql`EXISTS (SELECT 1 FROM decisions WHERE unit_id = ${id} AND state = 'adopted')`);
    notifyDecisionAudience(batch, id, { reminder: 'decision_revisit' }, { type: 'reminder', owner: true });
    batch.run(sql`UPDATE decisions SET revisit_reminded_at = ${now} WHERE unit_id = ${id}`);
    recordEvent(batch, id, 'revisit_due');
    try {
      await batch.commit();
    } catch (error) {
      // Revisited between the query and the write: nothing to remind.
      if (!(error instanceof GuardViolation)) throw error;
    }
  }
  return results.length;
}

/** One decision as a Member can read it, for export: the wording, the state and its history, each participant's own status, and the decisions it replaced or was replaced by (R53.5). */
export const DECISION_EXPORT_FORMAT = 'researchforce-decision';
export async function exportDecision(c: Context<ApiEnv>, id: string): Promise<Record<string, unknown>> {
  const item = await loadItem(c, id);
  if (item.base.kind !== 'decision_record') throw new ApiError('not_found');
  const { extra, fields } = item;
  return {
    format: DECISION_EXPORT_FORMAT, version: 1, exportedAt: c.get('now'), id: item.base.id, record: item.base.identifier, title: item.base.title, rev: item.base.rev, fields,
    state: extra['decisionState'], adoptedAt: extra['decisionAdoptedAt'] ?? null, adoptedBy: extra['decisionAdoptedBy'] ?? null,
    wordingDigest: extra['wordingDigest'], wordingVersion: extra['wordingVersion'], events: extra['decisionEvents'] ?? [], participants: extra['participantResponses'] ?? [],
    supersedes: extra['supersedes'] ?? null, supersededBy: extra['supersededBy'] ?? null,
  };
}
