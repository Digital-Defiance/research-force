/**
 * BOOTSTRAP IDENTITY RECONCILIATION for a restore (R36.9, R36.10, R36.15; design "Restore (R36.4–R36.17)": "Reconcile
 * a temporary bootstrap Administrator by verified identity and expected source Member ID in one bootstrap
 * transaction, retaining backed-up IDs and all attribution; conflicting identities fail preflight").
 *
 * A restore runs into a FRESH, otherwise-empty Research_CMS whose only Member is the operator who authenticated to run
 * the restore — the TEMPORARY BOOTSTRAP ADMINISTRATOR (R36.4). That operator exists so someone is authorised to drive
 * the restore; they are usually the SAME PERSON as a Member in the backup, created again by Cloudflare Access with the
 * same verified EMAIL but a NEW id. The restore must recreate every backed-up Member with their ORIGINAL ids and
 * attribution (R36.5: "Member Roles and Member_Statuses ... equivalent to those of the backed-up Research_CMS"),
 * NEVER rewriting a backed-up id. So instead of inserting the bootstrap Member as a new row, the restore MATCHES the
 * bootstrap Administrator to the INTENDED backed-up Member — the one with the same verified email — and maps the
 * bootstrap id onto that original backed-up Member id for the rest of the restore. Every reference the backup carries
 * to the original id stays valid; the transient bootstrap id simply becomes an alias for it.
 *
 * This reconciliation is a PURE, CHECKABLE function ({@link reconcileBootstrapIdentity}) so it is unit-testable with
 * no database: it takes the verified bootstrap identity and the backed-up Member rows and returns either the id
 * mapping to apply or the specific conflict that must fail preflight (R36.8: "incompatible bootstrap identity"). The
 * restore job (task 38.5) applies the resulting mapping inside its bootstrap transaction; this task only decides it.
 */

/** The VERIFIED bootstrap Administrator: the operator authenticated to run the restore in the fresh environment. */
export interface BootstrapIdentity {
  /** The bootstrap Member's fresh id in the empty Research_CMS (NOT a backed-up id). */
  readonly id: string;
  /** The operator's verified email, folded to lowercase for matching (Access verifies the address). */
  readonly emailLc: string;
}

/** A backed-up Member row the restore intends to recreate, by its ORIGINAL id and email (the identity-matching fields). */
export interface BackedUpMember {
  /** The ORIGINAL backed-up Member id; the restore preserves it unchanged (R36.5, R36.15). */
  readonly id: string;
  /** The backed-up Member's email, folded to lowercase; the match is on this verified address. */
  readonly emailLc: string;
}

/** The reasons a bootstrap reconciliation fails preflight, each reported with its colliding identities (R36.8). */
export type ReconcileConflict =
  | {
      /** The verified bootstrap email matches MORE THAN ONE backed-up Member, so the intended identity is ambiguous. */
      readonly kind: 'ambiguous-email';
      readonly emailLc: string;
      readonly backedUpIds: readonly string[];
    }
  | {
      /**
       * The bootstrap id collides with a DIFFERENT backed-up Member's id (a backed-up Member other than the intended
       * email match already owns the bootstrap id), so mapping it would overwrite or merge two distinct identities.
       */
      readonly kind: 'id-collision';
      readonly bootstrapId: string;
      readonly conflictingBackedUpId: string;
    };

/** The reconciliation outcome: the id mapping to apply, or the conflict that fails preflight. */
export type Reconciliation =
  | {
      readonly ok: true;
      /**
       * How to treat the bootstrap identity. `matched` means the bootstrap Administrator IS a backed-up Member (same
       * verified email): map the bootstrap id onto the original backed-up id and insert no new Member row for it.
       * `standalone` means no backed-up Member shares the email: the bootstrap Administrator is a genuinely new
       * operator kept alongside the restored Members, with no id rewrite.
       */
      readonly mapping:
        | { readonly kind: 'matched'; readonly fromBootstrapId: string; readonly toBackedUpId: string }
        | { readonly kind: 'standalone'; readonly bootstrapId: string };
    }
  | { readonly ok: false; readonly conflict: ReconcileConflict };

/**
 * Decide how to reconcile a verified bootstrap Administrator against the backed-up Member rows (R36.9, R36.10,
 * R36.15). Pure and total:
 *   1. Find the backed-up Members whose folded email equals the bootstrap's verified email.
 *        • More than one  → `ambiguous-email` conflict: the intended identity is not unique, so preflight fails
 *          (R36.8) rather than guessing which Member the operator is.
 *        • Exactly one    → the INTENDED Member. Map the bootstrap id onto that original backed-up id, UNLESS the
 *          bootstrap id already belongs to a DIFFERENT backed-up Member (`id-collision`), which would merge two
 *          identities and is rejected.
 *        • None           → the bootstrap Administrator is a genuinely new operator. It is kept `standalone` with no
 *          id rewrite, UNLESS its id collides with any backed-up id (`id-collision`), which is likewise rejected.
 *
 * In every accepted case the backed-up ids and their attribution are preserved exactly; only the transient bootstrap
 * id is ever mapped, never a backed-up one (R36.15).
 */
export function reconcileBootstrapIdentity(
  bootstrap: BootstrapIdentity,
  backedUp: readonly BackedUpMember[],
): Reconciliation {
  const emailMatches = backedUp.filter((member) => member.emailLc === bootstrap.emailLc);
  if (emailMatches.length > 1) {
    return {
      ok: false,
      conflict: { kind: 'ambiguous-email', emailLc: bootstrap.emailLc, backedUpIds: emailMatches.map((member) => member.id) },
    };
  }

  const intended = emailMatches[0];
  // A backed-up Member that is NOT the intended email match but shares the bootstrap id would be overwritten by the
  // mapping; and when there is no email match at all, any backed-up Member holding the bootstrap id is a collision.
  const idCollision = backedUp.find(
    (member) => member.id === bootstrap.id && (intended === undefined || member.id !== intended.id),
  );
  if (idCollision !== undefined) {
    return {
      ok: false,
      conflict: { kind: 'id-collision', bootstrapId: bootstrap.id, conflictingBackedUpId: idCollision.id },
    };
  }

  if (intended !== undefined) {
    return { ok: true, mapping: { kind: 'matched', fromBootstrapId: bootstrap.id, toBackedUpId: intended.id } };
  }
  return { ok: true, mapping: { kind: 'standalone', bootstrapId: bootstrap.id } };
}
