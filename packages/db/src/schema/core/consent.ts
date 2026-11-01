import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { CONSENT_SOURCES, DUAL_APPROVAL_ACTIONS, DUAL_APPROVAL_STATES } from '@researchforce/domain/consent';
import { oneOf } from '../columns';

/**
 * A Consenting_Member's Publication_Consent for the exact proposed values of one Disclosure_Unit
 * (R23.17 to R23.24). A consent is signed off against a canonical snapshot of the resulting Public_View:
 * its SHA-256, the content revisions, immutable file identities, and the prospective-public ancestor
 * evaluation, so a change to any of those dependencies invalidates it and a new snapshot and approval
 * are needed (R23.23, R23.24). A change is covered only when it applies the consented values or narrower
 * ones; the apply records the actual material digest and `used_at`, and a withdrawn or used consent no
 * longer covers anything (R23.20). A consent is written by a Member's own Publication_Request, by that
 * Member approving a Publication_Proposal, or by a Dual_Approval on behalf of a Revoked Member (`source`).
 */
export const publicationConsents = sqliteTable('publication_consents', {
  id: text('id').primaryKey(),
  /** The Disclosure_Unit the consent is for; its Consenting_Member is `member_id`. */
  unitId: text('unit_id').notNull(),
  /** The Root_Item the unit belongs to, for read-access checks and backup/export scoping. */
  rootId: text('root_id').notNull(),
  /** The Consenting_Member whose consent this is (R23.18). */
  memberId: text('member_id').notNull(),
  /** The exact consented values: Disclosure_Level and any Public_Summary, Public_Presentation, and Disclosure_Line. */
  values: text('values_json', { mode: 'json' }).notNull(),
  /** SHA-256 of the canonical approved Public_View the consent signed off (R23.23). */
  approvedViewHash: text('approved_view_hash').notNull(),
  /** The change sequence of the approved snapshot, so a later edit to a dependency is detectable. */
  approvedSnapshotVersion: integer('approved_snapshot_version').notNull(),
  /** SHA-256 of the bounded dependency manifest: content revisions, file identities, and projection inputs (R23.23). */
  dependencyManifestHash: text('dependency_manifest_hash').notNull(),
  /** How the consent was given: a Publication_Request, an approved Publication_Proposal, or a Dual_Approval. */
  source: text('source', { enum: CONSENT_SOURCES }).notNull(),
  /** The Publication_Request, Publication_Proposal, or Dual_Approval that produced the consent. */
  sourceId: text('source_id').notNull(),
  givenAt: text('given_at').notNull(),
  /** Set when the Member withdrew the consent before it was used; a withdrawn consent covers nothing. */
  withdrawnAt: text('withdrawn_at'),
  /** Set when a save applied the consent; the apply also records the actual material digest. */
  usedAt: text('used_at'),
  updatedSeq: integer('updated_seq').notNull(),
  actorId: text('actor_id'),
}, (t) => [
  index('publication_consents_unit').on(t.unitId, t.givenAt),
  index('publication_consents_member').on(t.memberId, t.givenAt),
  index('publication_consents_root').on(t.rootId),
  index('publication_consents_source').on(t.sourceId),
  oneOf('publication_consents_source_values', t.source, CONSENT_SOURCES),
  check('publication_consents_view_hash', sql`length(${t.approvedViewHash}) = 64`),
  check('publication_consents_dependency_hash', sql`length(${t.dependencyManifestHash}) = 64`),
  // A consent is used at most once, and never both withdrawn and used.
  check('publication_consents_spent', sql`${t.withdrawnAt} IS NULL OR ${t.usedAt} IS NULL`),
]);

/**
 * A Confidentiality_Hold on an Item (R48.1). A hold covers the Item and its whole subtree — every
 * Entry_Section, Attachment, Reply, and Dissent_Note under it, found through `units.root_id` and
 * `parent_id` — and no save may widen the Public_View of a covered unit while the hold is neither lifted
 * nor overridden (R48.2, R48.4). At most one such active hold per Member per Item (the partial unique
 * index). The placer or the Owner may lift it with an optional note; two Administrators may override it
 * through a Dual_Approval; neither lifting nor overriding changes any Disclosure_Level (R48.6, R48.7).
 * Each placement, lift, and override writes an `access_change` Revision and is kept for the Item's life.
 */
export const confidentialityHolds = sqliteTable('confidentiality_holds', {
  id: text('id').primaryKey(),
  /** The Item the hold is placed on; its subtree is covered. */
  unitId: text('unit_id').notNull(),
  /** The Root_Item the held Item belongs to, for read-access checks and backup/export scoping. */
  rootId: text('root_id').notNull(),
  /** The Member who placed the hold (R48.1). */
  memberId: text('member_id').notNull(),
  /** Why the Item is held, 1 to 2,000 characters, shown with the hold to everyone who can read the Item (R48.1, R48.5). */
  note: text('note').notNull(),
  placedAt: text('placed_at').notNull(),
  /** The placer or the Owner who lifted the hold; null while the hold is active or was overridden instead (R48.6). */
  liftedBy: text('lifted_by'),
  liftedAt: text('lifted_at'),
  /** The optional note given on lifting (R48.6). */
  liftNote: text('lift_note'),
  /** The approved Dual_Approval that overrode the hold; null unless it was overridden rather than lifted (R48.9). */
  overrideId: text('override_id'),
  updatedSeq: integer('updated_seq').notNull(),
  actorId: text('actor_id'),
}, (t) => [
  // One active hold per Member per Item: a hold neither lifted nor overridden (R48.1).
  uniqueIndex('confidentiality_holds_active').on(t.unitId, t.memberId).where(sql`${t.liftedAt} IS NULL AND ${t.overrideId} IS NULL`),
  index('confidentiality_holds_unit').on(t.unitId),
  index('confidentiality_holds_root').on(t.rootId),
  index('confidentiality_holds_member').on(t.memberId, t.placedAt),
  // A hold is lifted or overridden, never both; a lift names its Member and time together.
  check('confidentiality_holds_resolution', sql`${t.liftedAt} IS NULL OR ${t.overrideId} IS NULL`),
  check('confidentiality_holds_lift_pair', sql`(${t.liftedBy} IS NULL) = (${t.liftedAt} IS NULL)`),
]);

/**
 * A Dual_Approval: a proposal by one Active Administrator for one of the three actions that override a
 * Member's protection, applied only when a second, different Active Administrator approves it in the same
 * save (R49.1 to R49.4). The proposal records its action, the exact target and effect and their canonical
 * digests, and the content/dependency manifest it was approved against, so the guarded approval can
 * confirm the effect and preconditions still match; a changed effect, lifted hold, restored Owner, or
 * ineligible proposer lapses it (R49.4, R49.8). Both reasons and both Administrators are immutable
 * history, kept for as long as the element the approval concerns exists (R49.7).
 */
export const dualApprovals = sqliteTable('dual_approvals', {
  id: text('id').primaryKey(),
  /** Which overriding action this authorizes: a Hold_Override, a Revoked-Owner access widen, or a consent on behalf. */
  action: text('action', { enum: DUAL_APPROVAL_ACTIONS }).notNull(),
  /** The element the action concerns (the held Item, the restricted Research_Item, or the consented unit), for history and backup scoping. */
  targetId: text('target_id').notNull(),
  rootId: text('root_id').notNull(),
  /** The exact target the proposal names, as canonical JSON. */
  target: text('target_json', { mode: 'json' }).notNull(),
  /** The exact effect the proposal would apply, as canonical JSON. */
  effect: text('effect_json', { mode: 'json' }).notNull(),
  /** SHA-256 of the canonical effect, so a changed effect lapses the proposal (R49.8). */
  effectHash: text('effect_hash').notNull(),
  /** SHA-256 of the approved content/dependency manifest, where the action binds to one (a consent on behalf). */
  dependencyManifestHash: text('dependency_manifest_hash'),
  state: text('state', { enum: DUAL_APPROVAL_STATES }).notNull().default('open'),
  proposedBy: text('proposed_by').notNull(),
  proposedAt: text('proposed_at').notNull(),
  /** Why the action is proposed, 1 to 2,000 characters; immutable (R49.2, R49.7). */
  proposalReason: text('proposal_reason').notNull(),
  /** The second Administrator who decided the proposal; null while it is open. */
  decidedBy: text('decided_by'),
  decidedAt: text('decided_at'),
  /** The reason given on approval, decline, or withdrawal; immutable (R49.3, R49.5, R49.7). */
  decisionReason: text('decision_reason'),
  updatedSeq: integer('updated_seq').notNull(),
  actorId: text('actor_id'),
}, (t) => [
  index('dual_approvals_open').on(t.state, t.proposedAt),
  index('dual_approvals_target').on(t.targetId, t.proposedAt),
  index('dual_approvals_root').on(t.rootId),
  oneOf('dual_approvals_action_values', t.action, DUAL_APPROVAL_ACTIONS),
  oneOf('dual_approvals_state_values', t.state, DUAL_APPROVAL_STATES),
  check('dual_approvals_effect_hash', sql`length(${t.effectHash}) = 64`),
  check('dual_approvals_dependency_hash', sql`${t.dependencyManifestHash} IS NULL OR length(${t.dependencyManifestHash}) = 64`),
  // A proposal is decided exactly when it carries its decider; an open one carries none, and a decider and time arrive together.
  check('dual_approvals_decided_pair', sql`(${t.state} = 'open') = (${t.decidedBy} IS NULL) AND (${t.decidedBy} IS NULL) = (${t.decidedAt} IS NULL)`),
  // On an approval or decline the decider is a second, different Administrator; only a withdrawal, which the proposer
  // makes on their own open proposal, records the proposer as its own decider (R49.3, R49.5, R49.8).
  check('dual_approvals_distinct', sql`${t.decidedBy} IS NULL OR ${t.state} = 'withdrawn' OR ${t.decidedBy} <> ${t.proposedBy}`),
]);

/** Refuses a widening apply whose stale, withdrawn, or used consent no longer covers the resulting material (R23.23, R23.24). */
export const guardConsentValid = sqliteTable('_g_consent_valid', { x: integer('x').notNull() });

/** Refuses a widening of any unit covered by a Confidentiality_Hold that is neither lifted nor overridden (R48.4). */
export const guardHoldFree = sqliteTable('_g_hold_free', { x: integer('x').notNull() });

/** Refuses a decision on a Dual_Approval that is not open, or whose effect or preconditions no longer match (R49.4). */
export const guardDualOpen = sqliteTable('_g_dual_open', { x: integer('x').notNull() });

/** Refuses an approval unless its decider is a different currently Active Administrator from the proposer (R49.3, R49.8). */
export const guardDualDistinct = sqliteTable('_g_dual_distinct', { x: integer('x').notNull() });
