import { sql } from 'drizzle-orm';
import type { Timestamp } from '@researchforce/domain/types';
import { GuardedBatch } from './batch';

/**
 * The durable publication epoch and the fences every external Publisher operation checks against it.
 *
 * Task 59.1 owns the foundation that the full Publisher (tasks 32.1 to 32.5) builds on. A confidentiality
 * -affecting save increments the public invalidation epoch in the same transaction as its `publish` outbox
 * row (`GuardedBatch.bumpEpoch`, R24.16). Each Publisher run carries the epoch it observed when it started;
 * every file copy, render, and deploy/verify transition is fenced against the current authoritative epoch,
 * so a stale generation or a late provider answer can never copy back a suppressed file, promote stale
 * assets unchecked, or reopen containment (R24.16, R24.17, R25.3, R30.7).
 *
 * This module lives in `@researchforce/db` so both the Publisher Durable Object in `rf-app` (task 32.2) and
 * `rf-ops.deploySite` (task 32.1) can import the same contract — `rf-ops` may depend on `db` and `domain`
 * but not on `rf-app`. The decision logic here is pure and exhaustively testable; the thin D1 helpers record
 * logical external operations in the existing `external_operations` table (one row per deploy/file operation
 * identity). No new table and no migration are needed: `external_operations` already exists and `bumpEpoch`
 * self-initializes the `epoch` counter row.
 */

/** Read the current authoritative public invalidation epoch; 0 until the first confidentiality-affecting save. */
export async function readEpoch(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT coalesce((SELECT v FROM counters WHERE k = 'epoch'), 0) AS v").first<{ v: number }>();
  return row?.v ?? 0;
}

/**
 * The kind of external effect a Publisher operation has. `deploy` promotes a rendered version; `file_copy`
 * puts a newly public Attachment into `rf-public`; `file_delete` removes a suppressed copy first. Each is
 * recorded under a durable, epoch-labelled operation id so a lost provider answer is visible and reconciled
 * rather than silently retried (R24.17, R60.2).
 */
export const OPERATION_KINDS = ['deploy', 'file_copy', 'file_delete'] as const;
export type OperationKind = typeof OPERATION_KINDS[number];

/**
 * The outcome states an external operation row carries. `pending` is recorded before the request leaves;
 * `accepted`/`confirmed` are provider success; `failed` is a definite refusal; `uncertain` means no answer
 * arrived, so the effect may or may not have happened and must be reconciled against actual provider state
 * before anything depends on it. These mirror the `external_operations.state` check constraint.
 */
export type OperationState = 'pending' | 'accepted' | 'confirmed' | 'failed' | 'uncertain';

/**
 * A durable, deterministic operation identity. The `run` generation and `epoch` are baked in so a replay of
 * an obsolete generation reuses the same row (and so cannot masquerade as new work), while the epoch label
 * lets a reader fence the operation without a second lookup. `target` names the concrete effect (the site
 * version for a deploy, the Item_Identifier for a file copy or delete).
 */
export function operationId(kind: OperationKind, run: string, epoch: number, target: string): string {
  return `publish:${kind}:${run}:e${epoch}:${target}`;
}

/** A Publisher run's durable identity: its generation id and the epoch it observed when it began (design "Publisher"). */
export interface Generation {
  readonly run: string;
  readonly epoch: number;
}

/**
 * Whether a run of `kind` is still authorized to take a fenced step, given the epoch it observed and the
 * current authoritative epoch. A step is authorized only while the two match: once a confidentiality
 * -affecting save has advanced the epoch, every copy, render, and deploy/verify transition of the older
 * generation is refused, so it cannot resurrect suppressed output (R24.16). A `removal` step — one that
 * deletes a public copy or deploys a version that drops material — stays authorized under its own generation
 * even as the epoch advances, because suppression must always be allowed to proceed; only `addition` and
 * `promotion` steps are fenced out by a newer epoch.
 */
export function fence(step: Generation, authoritative: number, kind: 'addition' | 'promotion' | 'removal'): { readonly authorized: boolean; readonly reason: 'current' | 'stale_generation' | 'removal_always' } {
  if (kind === 'removal') return { authorized: true, reason: 'removal_always' };
  if (step.epoch === authoritative) return { authorized: true, reason: 'current' };
  return { authorized: false, reason: 'stale_generation' };
}

/**
 * Whether an older addition run must be preempted at its next bounded yield. An urgent invalidation (a save
 * that removed or edited already-public material) advances the epoch; any addition generation that observed
 * an earlier epoch is obsolete and must stop adding at its next slice boundary so the urgent removal can
 * deploy first (R24.16, design "Classify urgency"). A generation that is itself at the current epoch keeps
 * running.
 */
export function shouldPreempt(run: Generation, authoritative: number): boolean {
  return run.epoch < authoritative;
}

/**
 * The `rf-ops` serialized promotion check. `rf-ops` serializes epoch-labelled deployment operations and
 * rechecks the authoritative expected epoch immediately BEFORE and AFTER promotion; containment stays in
 * force while a stale promotion or a provider race is unresolved (design "Publisher", R24.16, R24.17, R60.2).
 *
 * A promotion is allowed only when the expected epoch matched the authoritative epoch both when the check
 * ran and after the version was promoted. If the epoch advanced in between — a confidentiality-affecting
 * save landed mid-promotion — the promotion is a stale one: it is denied, and any containment already in
 * force is kept, never cleared by this operation. The result tells the caller whether to proceed, and
 * whether containment must remain.
 */
export interface PromotionCheck {
  /** The epoch the run was authorized at (the version it wants to promote was rendered under this epoch). */
  readonly expected: number;
  /** The authoritative epoch read immediately before promotion. */
  readonly before: number;
  /** The authoritative epoch read immediately after promotion (the same read repeated once the version is live). */
  readonly after: number;
  /** Whether independent containment is currently in force on the public hosts. */
  readonly containmentActive: boolean;
}
export interface PromotionDecision {
  /** Whether the promotion is authorized to stand. False means a stale promotion or a provider race. */
  readonly promoted: boolean;
  /** Whether containment must remain in force after this operation. Never cleared while a promotion is stale. */
  readonly keepContainment: boolean;
  readonly reason: 'promoted' | 'stale_before' | 'raced_after';
}
export function promoteUnderEpoch(check: PromotionCheck): PromotionDecision {
  if (check.expected !== check.before) {
    // The epoch already advanced before promotion: an obsolete operation. Deny and keep any containment.
    return { promoted: false, keepContainment: check.containmentActive, reason: 'stale_before' };
  }
  if (check.after !== check.expected) {
    // A confidentiality-affecting save landed during promotion: the now-live version may show suppressed
    // material, so the promotion must not stand and containment is kept until the next authorized
    // generation verifies (R24.17).
    return { promoted: false, keepContainment: true, reason: 'raced_after' };
  }
  return { promoted: true, keepContainment: false, reason: 'promoted' };
}

/**
 * Reconcile an ambiguous version-promotion or file-operation answer against actual provider state. A late or
 * uncertain provider response, or an old retry, must not be taken as success: denial (and containment, when a
 * removal is involved) is kept until the latest authorized generation verifies the real state (R24.17, R25.3).
 *
 * `observed` is what a direct read of the provider now reports; `expected` is the epoch under which the
 * operation was authorized; `authoritative` is the current epoch. The reconciliation only concludes success
 * when the provider actually reflects the operation AND the operation was still current — otherwise it stays
 * denied and asks the caller to re-run under the latest authorized generation.
 */
export interface Reconciliation {
  readonly operation: Generation;
  readonly authoritative: number;
  /** What a fresh read of the provider reports the effect to be. */
  readonly observed: 'present' | 'absent' | 'unknown';
  /** What the operation intended: a promotion/copy makes the effect present; a removal makes it absent. */
  readonly intent: 'present' | 'absent';
}
export interface ReconciliationResult {
  readonly resolved: boolean;
  /** Keep denial (and containment for a removal) until a current generation verifies. */
  readonly keepDenied: boolean;
  readonly reason: 'verified' | 'stale_generation' | 'provider_mismatch' | 'provider_unknown';
}
export function reconcile(r: Reconciliation): ReconciliationResult {
  if (r.observed === 'unknown') {
    // No authoritative read of the provider: never assert success; a removal keeps containment.
    return { resolved: false, keepDenied: true, reason: 'provider_unknown' };
  }
  if (r.operation.epoch !== r.authoritative) {
    // The generation that issued the operation is obsolete; its outcome cannot be adopted even if the
    // provider happens to match, because a newer epoch supersedes it.
    return { resolved: false, keepDenied: true, reason: 'stale_generation' };
  }
  if (r.observed !== r.intent) {
    // The provider does not reflect the intended effect: the operation did not take hold; retry under the
    // current generation, keeping denial meanwhile.
    return { resolved: false, keepDenied: true, reason: 'provider_mismatch' };
  }
  return { resolved: true, keepDenied: false, reason: 'verified' };
}

/**
 * Record that an epoch-labelled external operation is about to reach the provider. Content-free: the row
 * names the operation identity and its request digest, never any research body. Idempotent on the id, so a
 * re-entry of the same generation reuses the row rather than creating a duplicate (R60.2). `ignoreFreeze`:
 * `external_operations` is side-effect bookkeeping, not a snapshotted research table, so it is exempt from the
 * Internal_Backup write-freeze (R36.14); recording a provider side effect must not stall behind a backup.
 */
export async function beginOperation(
  db: D1Database,
  operation: { readonly id: string; readonly kind: OperationKind; readonly requestHash: string },
  now: Timestamp,
): Promise<void> {
  await new GuardedBatch(db, { id: null, now }, { ignoreFreeze: true })
    .run(sql`INSERT INTO external_operations (id, kind, request_hash, state, created_at, updated_at)
      VALUES (${operation.id}, ${operation.kind}, ${operation.requestHash}, 'pending', ${now}, ${now})
      ON CONFLICT (id) DO UPDATE SET state = 'pending', updated_at = ${now}`)
    .commit();
}

/** Record what became of an epoch-labelled external operation, with the provider's reference once known. */
export async function settleOperation(
  db: D1Database,
  id: string,
  outcome: { readonly state: OperationState; readonly detail?: string | null; readonly providerRef?: string | null },
  now: Timestamp,
): Promise<void> {
  await new GuardedBatch(db, { id: null, now }, { ignoreFreeze: true })
    .run(sql`UPDATE external_operations SET state = ${outcome.state}, detail = ${outcome.detail ?? null},
      provider_ref = ${outcome.providerRef ?? null}, updated_at = ${now} WHERE id = ${id}`)
    .commit();
}

/** The stored state of an external operation, for a status read or a reconciliation after a lost answer. */
export interface StoredOperation {
  readonly id: string;
  readonly kind: string;
  readonly state: OperationState;
  readonly providerRef: string | null;
  readonly detail: string | null;
}
export async function readOperation(db: D1Database, id: string): Promise<StoredOperation | null> {
  const row = await db.prepare(
    'SELECT id, kind, state, provider_ref AS providerRef, detail FROM external_operations WHERE id = ?1',
  ).bind(id).first<StoredOperation>();
  return row ?? null;
}
