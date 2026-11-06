import { RETENTION } from '@researchforce/domain/retention';

/**
 * The PURE decisions for reference-safe OPERATIONAL retention (task 67.3, R28.8, R28.17, R57.2, R60.7, R60.8). This
 * module is kept apart from D1/R2 exactly as `backup-retention.ts` keeps `retentionKeep`/`pointsToExpire` pure, so the
 * retention windows and the reference-safety guard are unit-testable on their own. The operational SWEEPS in
 * `operational-cron.ts` read the live rows, call these pure functions to decide what may go, and apply the deletions;
 * nothing here touches a binding.
 *
 * WHAT MAY BE SWEPT (R60.8, exact):
 *   • a RECONCILED outbox or external-operation side-effect payload, 30 days after it reconciled;
 *   • a CLOSED job checkpoint, kept while its owner is active and for 30 days after the owner closes;
 *   • a per-failure metadata row, after its count has been folded into the content-free 90-day aggregate.
 *
 * WHAT IS NEVER SWEPT (R28.8, R60.8): required immutable research history (scholarly Revisions), exact-version
 * refs/evidence (the field versions a live citation or release pins), required permission evidence and manifests,
 * suppressed identifiers and the independently-retained recovery suppression ledger, and content-free operation
 * tombstones (the identity-only `idempotency_results`, which remain for the record's life and reveal no removed
 * content). None of these are operational-bookkeeping rows, so the sweeps never name their tables; and as a second
 * line of defence {@link referenceSafe} refuses to remove anything a LIVE citation, release, proposal, or backup
 * dependency still references.
 */

/** The operational-retention windows (30d reconciled payloads, 30d closed checkpoints, 90d failure metadata), from the one retention-config source — never a re-typed literal (R60.8). */
export const OPERATIONAL_RETENTION = Object.freeze({
  reconciledPayloadDays: RETENTION.operationalRecords.reconciledPayloadDays,
  closedCheckpointDays: RETENTION.operationalRecords.closedCheckpointDays,
  failureMetadataDays: RETENTION.operationalRecords.failureMetadataDays,
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** The ISO-8601 cutoff `now - days`: an operational record whose window timestamp is at or before this is due. */
export function retentionCutoff(now: string, days: number): string {
  const base = Date.parse(now);
  if (!Number.isFinite(base)) throw new RangeError('A retention cutoff needs a valid current time.');
  return new Date(base - days * DAY_MS).toISOString();
}

/**
 * The reconciled TERMINAL states of an external-operation side-effect payload (design "Atomic saves and uncertain
 * outcomes"): a provider-accepted, confirmed, or definitely-failed send is reconciled; a `pending` or `uncertain`
 * send is NOT — its outcome is still unknown, so its payload must be kept until a status query or retry reconciles it
 * (R60.2, R60.8). A failed send is reconciled for payload-expiry purposes but its content-free FAILURE METADATA is the
 * separate 90-day aggregate ({@link failureMetadataToAggregate}).
 */
export const RECONCILED_EXTERNAL_STATES = Object.freeze(['accepted', 'confirmed', 'failed'] as const);
/** The states whose side-effect payload is still in flight and must never be expired as "reconciled" (R60.2). */
export const UNRECONCILED_EXTERNAL_STATES = Object.freeze(['pending', 'uncertain'] as const);

export type ExternalOperationState = typeof RECONCILED_EXTERNAL_STATES[number] | typeof UNRECONCILED_EXTERNAL_STATES[number];

/** Whether a side-effect payload in this state has reconciled, so its 30-day expiry clock may run (R60.8). */
export function isReconciled(state: ExternalOperationState): boolean {
  return (RECONCILED_EXTERNAL_STATES as readonly string[]).includes(state);
}

/**
 * The LIVE references that pin operational and derived data so cleanup cannot orphan them (R28.8, R60.7, R60.8). Each
 * set holds the opaque ids a live dependency still needs: the field-version / artifact / recovery-point / revision ids
 * a citation, release, proposal, or backup points at. The guard treats any id in ANY set as untouchable.
 */
export interface LiveReferences {
  /** The exact-version ids pinned by live (not retired) Evidence_Citations — the cited field versions/targets (R54.2). */
  readonly citations: ReadonlySet<string>;
  /** The artifact/version ids captured by a sealed or draft Research_Release manifest, kept independently of later editing (R59.2, R59.5). */
  readonly releases: ReadonlySet<string>;
  /** The base-revision/target ids an open Edit_Proposal depends on (R57.4, R57.5). */
  readonly proposals: ReadonlySet<string>;
  /** The recovery-point and suppressed-element ids a verified backup / its suppression ledger still needs (R36.3, R36.16). */
  readonly backups: ReadonlySet<string>;
}

/** An empty live-reference set, for a sweep that has confirmed no live dependency exists on the ids it is about to touch. */
export const NO_LIVE_REFERENCES: LiveReferences = Object.freeze({
  citations: new Set<string>(), releases: new Set<string>(), proposals: new Set<string>(), backups: new Set<string>(),
});

/** Which live dependency pins an id, or null when none does. Deterministic order: citation, release, proposal, backup. */
export function referencedBy(id: string, live: LiveReferences): 'citation' | 'release' | 'proposal' | 'backup' | null {
  if (live.citations.has(id)) return 'citation';
  if (live.releases.has(id)) return 'release';
  if (live.proposals.has(id)) return 'proposal';
  if (live.backups.has(id)) return 'backup';
  return null;
}

/**
 * THE REFERENCE-SAFETY GUARD (R28.8, R60.8): whether an operational record identified by `id` (and every id it would
 * free when removed, via `frees`) may be cleaned up. It is safe ONLY when neither the record's own id nor any id its
 * removal would free is pinned by a LIVE citation, release, proposal, or backup dependency. This is the pure, testable
 * proof that the operational cleanup can never remove a live citation, release, proposal, or backup dependency: a
 * sweep calls it before every deletion and skips any id it refuses, so a referenced id is structurally unreachable by
 * the cleanup regardless of its age.
 */
export function referenceSafe(id: string, live: LiveReferences, frees: readonly string[] = []): boolean {
  if (referencedBy(id, live) !== null) return false;
  for (const freed of frees) if (referencedBy(freed, live) !== null) return false;
  return true;
}

/** One candidate operational record the guard considers: its id, the ids its removal would free, and why it is a candidate. */
export interface OperationalRecord {
  readonly id: string;
  /** The window timestamp the retention clock reads: reconciliation time, checkpoint closure time, or failure time. */
  readonly at: string;
  /** Ids that become unreferenced if this record is removed (e.g. a field version a reconciled payload last held); default none. */
  readonly frees?: readonly string[];
}

/**
 * Partition operational candidates into the ids that may be REMOVED now and the ids RETAINED, applying both the
 * age window (`cutoff`) and the reference-safety guard (R60.8). A candidate is removed only when it is due
 * (`at <= cutoff`) AND {@link referenceSafe}; otherwise it is retained, with the reason recorded so a sweep can log
 * why a due record was kept. The partition is a pure function of its inputs, so a property test can assert that no
 * referenced id ever lands in `remove` for any window or reference set.
 */
export interface Partition {
  readonly remove: readonly string[];
  readonly retained: readonly { readonly id: string; readonly reason: 'not_due' | 'referenced' }[];
}
export function partitionOperationalRecords(records: readonly OperationalRecord[], cutoff: string, live: LiveReferences): Partition {
  const remove: string[] = [];
  const retained: { id: string; reason: 'not_due' | 'referenced' }[] = [];
  for (const record of records) {
    if (record.at > cutoff) { retained.push({ id: record.id, reason: 'not_due' }); continue; }
    if (!referenceSafe(record.id, live, record.frees ?? [])) { retained.push({ id: record.id, reason: 'referenced' }); continue; }
    remove.push(record.id);
  }
  return { remove, retained };
}

/** One per-failure row the 90-day aggregate folds in: an opaque kind and a content-free detail code, never a body (R60.6, R60.8). */
export interface FailureRecord {
  readonly id: string;
  readonly kind: string;
  /** A content-free outcome code such as `status-503` or `not-sent`; never a research body, bearer link, or recovery secret (R60.6). */
  readonly detail: string;
  readonly at: string;
}
/** One aggregated, audited failure bucket kept past the 90-day per-row horizon: counts by (kind, detail), no bodies (R60.8). */
export interface FailureAggregate {
  readonly kind: string;
  readonly detail: string;
  readonly count: number;
  /** The earliest and latest failure folded into this bucket, so the audited aggregate keeps the window it covers. */
  readonly firstAt: string;
  readonly lastAt: string;
}

/**
 * Fold the per-failure rows older than the 90-day horizon into content-free (kind, detail) buckets, and report which
 * per-row ids may then be dropped (R60.8 "aggregate/audited failure metadata for 90 days"). The aggregate retains the
 * audited count and the window it covers while the individual rows go, so no research body, bearer link, or recovery
 * secret is kept past its horizon (R60.6). Rows newer than the cutoff are left untouched. The bucket order is stable
 * by (kind, detail) so the aggregate is deterministic.
 */
export function failureMetadataToAggregate(failures: readonly FailureRecord[], cutoff: string): { readonly aggregates: readonly FailureAggregate[]; readonly dropIds: readonly string[] } {
  const buckets = new Map<string, { kind: string; detail: string; count: number; firstAt: string; lastAt: string }>();
  const dropIds: string[] = [];
  for (const failure of failures) {
    if (failure.at > cutoff) continue; // still within the 90-day per-row window
    const key = `${failure.kind}\u0000${failure.detail}`;
    const existing = buckets.get(key);
    if (existing === undefined) buckets.set(key, { kind: failure.kind, detail: failure.detail, count: 1, firstAt: failure.at, lastAt: failure.at });
    else {
      existing.count += 1;
      if (failure.at < existing.firstAt) existing.firstAt = failure.at;
      if (failure.at > existing.lastAt) existing.lastAt = failure.at;
    }
    dropIds.push(failure.id);
  }
  const aggregates = [...buckets.values()].sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0));
  return { aggregates, dropIds };
}
