import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * The QUARANTINE GATE and the INDEPENDENT SUPPRESSION APPLICATION for a restore (R36.5, R36.9, R36.15, R36.16;
 * design "Restore (R36.4–R36.17)": "Keep restored research unavailable to public projection until validation ...
 * independent post-snapshot suppression reconciliation, and a fresh disclosure/consent preflight succeed ... Do not
 * automatically republish a revoked permission from an older snapshot").
 *
 * Restored data stays QUARANTINED — not visible, the Publisher paused — until validation AND the independently known
 * suppressions pass. Two pieces live here as pure, checkable building blocks the restore job (task 38.5) consumes:
 *   1. SUPPRESSION APPLICATION ({@link applySuppressions}): the independently retained minimal suppression ledger
 *      (the 58.2 `suppression_generations` rows: opaque ids, invalidation generation, time, and an authenticating
 *      digest) is applied so a restore NEVER reinstates a suppressed element. A deleted/suppressed element is not
 *      resurrected: an id present in the ledger must NOT be installed (or must be re-tombstoned if it would otherwise
 *      appear). The old package's manifest is evidence of historic state, not authorisation to override a known later
 *      withdrawal (R36.16).
 *   2. QUARANTINE-RELEASE PRECONDITION ({@link quarantineReleasePrecondition}): the restore stays contained until
 *      EVERY gate passes — preflight validation, the suppression application, and the fresh disclosure/consent
 *      preflight. If the latest suppression state cannot be established, release is DENIED (design: "public research
 *      remains denied until an authorized review revalidates"). The actual Publisher-pause/containment-release wiring
 *      is task 38.5; this provides the precondition it checks.
 *
 * SECURITY: the ledger carries NO deleted body — only opaque ids, generations, and times. A restore creates NO
 * Notification_Events and queues NO email (R36.4), so nothing here produces a notification or an external send; it
 * only decides what must not be installed and whether containment may be released.
 */

/** Lowercase-hex SHA-256 of a UTF-8 string, matching the ledger's digest convention (58.2 `persistSuppressionLedger`). */
const hashUtf8 = (text: string): string => bytesToHex(sha256(utf8ToBytes(text)));

/** One independently retained suppression record (the 58.2 `suppression_generations` row image). */
export interface SuppressionRecord {
  /** The opaque identity of the suppressed element (an Item_Identifier or unit id); never any content. */
  readonly suppressedId: string;
  /** The monotonic invalidation generation at which the element was suppressed (R36.16). */
  readonly generation: number;
  /** When the suppression took effect (ISO-8601). */
  readonly suppressedAt: string;
  /** The lowercase-hex SHA-256 over the minimal record, authenticating it independently (58.2). */
  readonly digest: string;
}

/** The digest the ledger writer binds over a record's minimal fields (58.2 `persistSuppressionLedger`). */
export function suppressionDigest(record: Pick<SuppressionRecord, 'suppressedId' | 'generation' | 'suppressedAt'>): string {
  return hashUtf8(`${record.suppressedId}\u0000${record.generation}\u0000${record.suppressedAt}`);
}

/** Why a suppression ledger could not be trusted, so the restore denies public release rather than guessing (R36.16). */
export type SuppressionFault = 'tampered-ledger';

/** The outcome of applying the suppression ledger to a set of restored ids. */
export type SuppressionApplication =
  | {
      readonly ok: true;
      /** The restored ids the ledger suppresses: these must NOT be installed, or must be re-tombstoned (R36.15). */
      readonly suppressed: readonly string[];
    }
  | { readonly ok: false; readonly fault: SuppressionFault; readonly element: string };

/**
 * Apply the independently known suppression ledger to the ids a restore would install (R36.15, R36.16). Every ledger
 * record is first AUTHENTICATED against its own digest — a tampered ledger (any record whose digest does not match its
 * minimal fields) fails with `tampered-ledger`, so the restore denies public release rather than trusting an altered
 * suppression set. Then the restored ids that appear in the ledger are returned as `suppressed`: the restore must not
 * reinstate them (a deleted/suppressed element is never resurrected). An id absent from the ledger is unaffected.
 *
 * Pure and total: it performs no I/O and depends only on its arguments, so it is unit-testable. The restore job reads
 * the `suppression_generations` rows and passes them here; this decides which ids are off-limits.
 */
export function applySuppressions(
  restoredIds: readonly string[], ledger: readonly SuppressionRecord[],
): SuppressionApplication {
  for (const record of ledger) {
    if (record.digest !== suppressionDigest(record)) {
      return { ok: false, fault: 'tampered-ledger', element: `suppression:${record.suppressedId}` };
    }
  }
  const suppressedSet = new Set(ledger.map((record) => record.suppressedId));
  const suppressed = restoredIds.filter((id) => suppressedSet.has(id));
  return { ok: true, suppressed };
}

/** Each gate the quarantine-release precondition requires, so a failed gate names exactly what is outstanding. */
export interface QuarantineGates {
  /** The byte/manifest/reference preflight validation passed (R36.8). */
  readonly validationPassed: boolean;
  /** The independently known suppressions were applied (no tampered ledger, R36.15, R36.16). */
  readonly suppressionsApplied: boolean;
  /** The fresh disclosure/consent preflight passed, so no revoked permission is republished (R36.16, design). */
  readonly disclosureConsentPassed: boolean;
}

/** The named gates, for a `blocked` report that lists every outstanding one. */
export type QuarantineGateName = 'validation' | 'suppressions' | 'disclosure-consent';

/** The quarantine-release decision: release allowed, or the gates still blocking it. */
export type QuarantineRelease =
  | { readonly released: true }
  | { readonly released: false; readonly blockedBy: readonly QuarantineGateName[] };

/**
 * The QUARANTINE-RELEASE PRECONDITION (R36.5, R36.16): restored data may leave containment — become visible, the
 * Publisher resume — ONLY when every gate passes. Any unmet gate keeps the restore quarantined and is listed in
 * `blockedBy`, so the restore job reports exactly what is outstanding rather than releasing on a partial check. Pure
 * and total; the job supplies the gate results and performs the actual containment release.
 */
export function quarantineReleasePrecondition(gates: QuarantineGates): QuarantineRelease {
  const blockedBy: QuarantineGateName[] = [];
  if (!gates.validationPassed) blockedBy.push('validation');
  if (!gates.suppressionsApplied) blockedBy.push('suppressions');
  if (!gates.disclosureConsentPassed) blockedBy.push('disclosure-consent');
  return blockedBy.length === 0 ? { released: true } : { released: false, blockedBy };
}
