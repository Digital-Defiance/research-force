import type { Env } from '../env';
import { recoveryCustodians } from './custodians';
import { independentDestination } from './copies';

/**
 * The SOLE-COPY RESEARCH CUSTODY gate (task 58.2, R36.12; design "Internal_Backup and independent recovery":
 * "Provisioning and the first successfully decrypted fresh restore are prerequisites for sole-copy research custody."
 * and "Sole-copy research use is blocked until the independent destination, recovery-key custody, and an initial
 * successful restore rehearsal are configured and verified.").
 *
 * Sole-copy custody — keeping research only in this installation, with no other live copy an operator holds — is
 * REFUSED until every prerequisite below is configured and recorded. The gate is a checked precondition: it reports
 * which of {destination, budget, recovery key, initial fresh restore} is missing, so the operator sees exactly what to
 * configure. The actual restore is task 38.5; here the gate reads the recorded "initial fresh restore completed" flag
 * the operator sets and refuses custody until it is set.
 */

/** The individual preconditions the sole-copy custody gate checks (R36.12). */
export type CustodyPrecondition = 'destination' | 'budget' | 'recoveryKey' | 'initialRestore';

/** The result of the custody gate: whether sole-copy custody is allowed, and which preconditions are still missing. */
export interface CustodyGate {
  /** True only when every precondition passes; otherwise sole-copy custody is refused. */
  readonly allowed: boolean;
  /** The preconditions not yet satisfied, in a stable order, each with a human-facing reason. */
  readonly missing: readonly { readonly precondition: CustodyPrecondition; readonly reason: string }[];
}

/** Whether an installation flag is explicitly truthy (`"1"` or `"true"`, case-insensitively). */
function approved(value: string | undefined): boolean {
  const trimmed = value?.trim().toLowerCase();
  return trimmed === '1' || trimmed === 'true';
}

/**
 * Evaluate the sole-copy custody gate against the installation configuration (R36.12). Each precondition is checked
 * independently so the report names every missing piece at once, not just the first:
 *   • destination — an independent copy destination OUTSIDE the production account is configured ({@link BACKUP_COPY_DESTINATION}).
 *   • recoveryKey — at least one recovery custodian key is configured ({@link BACKUP_RECOVERY_CUSTODIANS}), so a copy
 *     can be decrypted outside production. A malformed custodian list counts as missing (the parse throws, caught here).
 *   • budget — the operator has approved the independent-backup storage budget ({@link BACKUP_COPY_BUDGET_APPROVED}).
 *   • initialRestore — an initial fresh restore rehearsal has completed ({@link BACKUP_INITIAL_RESTORE_DONE}).
 * `allowed` is true only when none is missing.
 */
export function soleCopyCustodyGate(env: Env): CustodyGate {
  const missing: { precondition: CustodyPrecondition; reason: string }[] = [];

  if (independentDestination(env) === null) {
    missing.push({ precondition: 'destination', reason: 'No independent backup destination outside the production account is configured.' });
  }

  let hasRecoveryKey = false;
  try {
    hasRecoveryKey = recoveryCustodians(env).length > 0;
  } catch {
    hasRecoveryKey = false; // a malformed custodian list is treated as no usable recovery key
  }
  if (!hasRecoveryKey) {
    missing.push({ precondition: 'recoveryKey', reason: 'No recovery-key custody is configured, so an independent copy could not be decrypted.' });
  }

  if (!approved(env.BACKUP_COPY_BUDGET_APPROVED)) {
    missing.push({ precondition: 'budget', reason: 'The independent-backup storage budget has not been approved by the operator.' });
  }

  if (!approved(env.BACKUP_INITIAL_RESTORE_DONE)) {
    missing.push({ precondition: 'initialRestore', reason: 'An initial fresh restore rehearsal has not been completed and recorded.' });
  }

  return { allowed: missing.length === 0, missing };
}
