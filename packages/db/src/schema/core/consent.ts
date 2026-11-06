import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { CONSENT_SOURCES, DUAL_APPROVAL_ACTIONS, DUAL_APPROVAL_STATES } from '@researchforce/domain/consent';
import { CONSENT_ANSWER_CHOICES, CONSENT_REQUEST_KINDS, CONSENT_REQUEST_STATES } from '@researchforce/domain/consent-requests';
import { CONSENT_STATUSES } from '@researchforce/domain/types';
import { oneOf, sequenced } from '../columns';

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

/**
 * An emailed Consent_Request to an External_Party (R51.2 to R51.13). A request names 1 to 50 elements — the
 * Correspondences in which the Party is a Party (a Publication_Consent_Request, `kind` publication) or the
 * Sources and Attachments whose rights it concerns (a Rights_Permission_Request, `kind` rights) — and carries
 * the exact Contact_Email it was sent to, the requesting Administrator, the optional message, and the
 * addressed single-use Consent_Link whose random token lives only as its SHA-256 (`token_hash`). A later
 * Consent_Answer attaches a Change_Link, valid for 12 months, whose token is kept the same way
 * (`change_token_hash`). The request opens Sent, becomes Answered, Cancelled, or Expired, and is kept
 * unchanged for the Party's life (R51.13); its token hashes are deleted 30 days after the links expire
 * (R51.13), and an expired or cancelled request leaves every status untouched (R51.11). The `preview_digest`
 * is the SHA-256 over every item snapshot's digest, binding the sent request to exactly what was previewed.
 */
export const consentRequests = sqliteTable('consent_requests', {
  id: text('id').primaryKey(),
  /** The External_Party the request was sent to. */
  partyId: text('party_id').notNull(),
  /** The requesting Administrator, to whom the resulting Revisions and Notification_Events are attributed (R51.7). */
  requestedBy: text('requested_by').notNull(),
  /** Which kind of request: a Publication_Consent_Request or a Rights_Permission_Request (R51.2). */
  kind: text('kind', { enum: CONSENT_REQUEST_KINDS }).notNull(),
  /** The exact Contact_Email the request was sent to; kept as the evidence of where the ask went (R51.4, R51.7). */
  contactEmail: text('contact_email').notNull(),
  /** The optional message of at most 2,000 characters the Administrator included (R51.2). */
  message: text('message'),
  /**
   * SHA-256 of the random Consent_Link token; the token itself travels only in the email (R51.4). Nulled 30
   * days after the links expire, when `tokens_deleted_at` is set, so no token hash is retained past then
   * while the request row stays for the Party's life (R51.13).
   */
  tokenHash: text('token_hash'),
  /** SHA-256 of the Change_Link token, set when a Consent_Answer is recorded; null until then, and nulled again when the tokens are deleted (R51.8, R51.13). */
  changeTokenHash: text('change_token_hash'),
  /** SHA-256 over the ordered item snapshot digests, binding the sent request to the previewed content (R51.2, R51.9). */
  previewDigest: text('preview_digest').notNull(),
  state: text('state', { enum: CONSENT_REQUEST_STATES }).notNull().default('sent'),
  sentAt: text('sent_at').notNull(),
  /** When the Consent_Link expires (sending plus 30 days) (R51.4, R51.11). */
  expiresAt: text('expires_at').notNull(),
  /** When the Change_Link expires (the answer plus 12 months); null until a Consent_Answer is recorded (R51.8, R51.10). */
  changeExpiresAt: text('change_expires_at'),
  /** When the one reminder was sent at 14 days; null until then (R51.11). */
  remindedAt: text('reminded_at'),
  answeredAt: text('answered_at'),
  cancelledAt: text('cancelled_at'),
  expiredAt: text('expired_at'),
  /** When the Consent_Link and Change_Link token hashes were deleted, 30 days after the links expired (R51.13). */
  tokensDeletedAt: text('tokens_deleted_at'),
  ...sequenced(),
}, (t) => [
  index('consent_requests_party').on(t.partyId, t.sentAt),
  index('consent_requests_state').on(t.state, t.sentAt),
  // The Consent_Link and Change_Link are looked up by their token hash alone, so each is unique while present;
  // a deleted hash is null and drops out of the index (R51.5, R51.10, R51.13).
  uniqueIndex('consent_requests_token').on(t.tokenHash).where(sql`${t.tokenHash} IS NOT NULL`),
  uniqueIndex('consent_requests_change_token').on(t.changeTokenHash).where(sql`${t.changeTokenHash} IS NOT NULL`),
  oneOf('consent_requests_kind_values', t.kind, CONSENT_REQUEST_KINDS),
  oneOf('consent_requests_state_values', t.state, CONSENT_REQUEST_STATES),
  check('consent_requests_token_hash', sql`${t.tokenHash} IS NULL OR length(${t.tokenHash}) = 64`),
  check('consent_requests_change_token_hash', sql`${t.changeTokenHash} IS NULL OR length(${t.changeTokenHash}) = 64`),
  check('consent_requests_preview_digest', sql`length(${t.previewDigest}) = 64`),
  // A Change_Link and its expiry arrive together, exactly when the request has been answered — until the tokens
  // are deleted, when both hashes are nulled and `change_expires_at` is kept as the record of the link's life
  // (R51.8, R51.13).
  check('consent_requests_change_pair', sql`${t.tokensDeletedAt} IS NOT NULL OR ((${t.changeTokenHash} IS NULL) = (${t.changeExpiresAt} IS NULL) AND (${t.changeTokenHash} IS NULL OR ${t.answeredAt} IS NOT NULL))`),
  // Deleting the tokens nulls both hashes together with their stamp: `tokens_deleted_at` is set exactly when the
  // Consent_Link token hash is gone, and no Change_Link hash then remains either (R51.13).
  check('consent_requests_tokens_deleted', sql`(${t.tokensDeletedAt} IS NULL) = (${t.tokenHash} IS NOT NULL) AND (${t.tokensDeletedAt} IS NULL OR ${t.changeTokenHash} IS NULL)`),
  // The state and its stamp agree: a non-Sent state carries exactly its own time (R51.11, R51.12).
  check('consent_requests_state_stamp', sql`(${t.state} = 'answered') = (${t.answeredAt} IS NOT NULL) AND (${t.state} = 'cancelled') = (${t.cancelledAt} IS NOT NULL) AND (${t.state} = 'expired') = (${t.expiredAt} IS NOT NULL)`),
]);

/**
 * One named element of a Consent_Request, with the stored snapshot of exactly what the Consent_Page showed
 * for it and that snapshot's SHA-256 (R51.2, R51.5, R51.7, R51.9). For a Publication_Consent_Request the
 * snapshot is the Correspondence's Public_View under the proposed values plus how the Party would be named;
 * for a Rights_Permission_Request it is the public fields and the document's stable identity, size, and
 * SHA-256, but never the file bytes (R51.16). The snapshot is the evidence of what the person saw and bounds
 * what their later Consent_Answer can cover (R51.9); `answer_id` names the Consent_Answer that answered this
 * item, if any.
 */
export const consentRequestItems = sqliteTable('consent_request_items', {
  id: text('id').primaryKey(),
  requestId: text('request_id').notNull(),
  /** The Disclosure_Unit (a Correspondence, Source, or Attachment) this item names. */
  unitId: text('unit_id').notNull(),
  /** The Root_Item the unit belongs to, for read-access checks and backup/export scoping. */
  rootId: text('root_id').notNull(),
  /** The element's position in the request, 0-based, so the Consent_Page shows them in a stable order. */
  position: integer('position').notNull(),
  /** The exact proposed values the request asked about, as canonical JSON (Disclosure_Level and any Public_Summary, Public_Presentation, Disclosure_Line). */
  proposedValues: text('proposed_values_json', { mode: 'json' }).notNull(),
  /** The stored Consent_Page snapshot for this element (no file bytes) (R51.5, R51.16). */
  snapshot: text('snapshot_json', { mode: 'json' }).notNull(),
  /** SHA-256 of the canonical snapshot, so a change to any dependency is detectable (R51.7, R51.9). */
  snapshotHash: text('snapshot_hash').notNull(),
  /** The Consent_Answer that answered this item; null until one is recorded (R51.9). */
  answerId: text('answer_id'),
  ...sequenced(),
}, (t) => [
  uniqueIndex('consent_request_items_position').on(t.requestId, t.position),
  uniqueIndex('consent_request_items_unit').on(t.requestId, t.unitId),
  index('consent_request_items_root').on(t.rootId),
  index('consent_request_items_unit_lookup').on(t.unitId),
  check('consent_request_items_position', sql`${t.position} >= 0 AND ${t.position} < 50`),
  check('consent_request_items_snapshot_hash', sql`length(${t.snapshotHash}) = 64`),
]);

/**
 * An append-only Consent_Answer: the choice a person gave for one named element of a Consent_Request, with
 * the time, the optional comment and Generic_Label, and a copy and SHA-256 digest of the content the
 * Consent_Page showed for that element (R51.6, R51.7). A single submission writes one row per answered item,
 * all sharing the submission's `answered_at` and comment; the rows are never edited and are kept for the
 * Party's life (R51.13). The choice is drawn from the element's kind — named/unnamed/refused for a
 * Correspondence, granted/refused for a Source or Attachment (R51.6).
 */
export const consentAnswers = sqliteTable('consent_answers', {
  id: text('id').primaryKey(),
  requestId: text('request_id').notNull(),
  /** The `consent_request_items` row this answer is for. */
  itemId: text('item_id').notNull(),
  /** The Disclosure_Unit the answered item named, for lookups on the element's page (R51.13). */
  unitId: text('unit_id').notNull(),
  rootId: text('root_id').notNull(),
  /** The choice given for this element (R51.6). */
  choice: text('choice', { enum: CONSENT_ANSWER_CHOICES }).notNull(),
  /** The Generic_Label given with a "do not name me" answer, 1 to 100 characters; null otherwise (R51.6, R51.7). */
  genericLabel: text('generic_label'),
  /** The optional comment of at most 2,000 characters, shared by every answer of one submission (R51.6). */
  comment: text('comment'),
  /** The resulting Consent_Status or Rights_Status this answer set, for display and the coverage check (R51.7, R51.9). */
  resultStatus: text('result_status'),
  /** A copy of the snapshot content the Consent_Page showed for this element, as the evidence of what was seen (R51.7). */
  seenSnapshot: text('seen_snapshot_json', { mode: 'json' }).notNull(),
  /** SHA-256 of the seen snapshot (R51.7). */
  seenSnapshotHash: text('seen_snapshot_hash').notNull(),
  answeredAt: text('answered_at').notNull(),
  ...sequenced(),
}, (t) => [
  index('consent_answers_request').on(t.requestId, t.answeredAt),
  uniqueIndex('consent_answers_item').on(t.itemId),
  index('consent_answers_unit').on(t.unitId, t.answeredAt),
  index('consent_answers_root').on(t.rootId),
  oneOf('consent_answers_choice_values', t.choice, CONSENT_ANSWER_CHOICES),
  // A withdrawal is recorded in `consent_withdrawals`; a Consent_Answer never carries the withdrawn choice.
  check('consent_answers_choice', sql`${t.choice} <> 'withdrawn'`),
  // A Generic_Label belongs only to a "do not name me" answer (R51.6).
  check('consent_answers_label', sql`${t.genericLabel} IS NULL OR ${t.choice} = 'unnamed'`),
  check('consent_answers_seen_hash', sql`length(${t.seenSnapshotHash}) = 64`),
  oneOf('consent_answers_result_values', t.resultStatus, CONSENT_STATUSES, true),
]);

/**
 * An append-only withdrawal through a Change_Link (R51.10). A person who answered may later withdraw one or
 * more elements: each withdrawn row sets the element's consent to Refused or its Rights_Status to Restricted,
 * applies the same downgrades and notifications as a refusal, and leaves the Party's Do_Not_Name flag on. The
 * rows are never edited and are kept for the Party's life (R51.13); `item_id` names the answered item being
 * withdrawn.
 */
export const consentWithdrawals = sqliteTable('consent_withdrawals', {
  id: text('id').primaryKey(),
  requestId: text('request_id').notNull(),
  /** The `consent_request_items` row whose earlier Consent_Answer is being withdrawn. */
  itemId: text('item_id').notNull(),
  unitId: text('unit_id').notNull(),
  rootId: text('root_id').notNull(),
  /** The optional comment of at most 2,000 characters, shared by every withdrawal of one submission (R51.6, R51.10). */
  comment: text('comment'),
  withdrawnAt: text('withdrawn_at').notNull(),
  ...sequenced(),
}, (t) => [
  index('consent_withdrawals_request').on(t.requestId, t.withdrawnAt),
  index('consent_withdrawals_item').on(t.itemId, t.withdrawnAt),
  index('consent_withdrawals_unit').on(t.unitId, t.withdrawnAt),
  index('consent_withdrawals_root').on(t.rootId),
]);

/** Refuses a widening apply whose stale, withdrawn, or used consent no longer covers the resulting material (R23.23, R23.24). */
export const guardConsentValid = sqliteTable('_g_consent_valid', { x: integer('x').notNull() });

/** Refuses a second answer or withdrawal through a Consent_Link or Change_Link that is unknown, expired, cancelled, or already used (R51.6, R51.12). */
export const guardConsentLinkOpen = sqliteTable('_g_consent_link_open', { x: integer('x').notNull() });

/** Refuses a widening of any unit covered by a Confidentiality_Hold that is neither lifted nor overridden (R48.4). */
export const guardHoldFree = sqliteTable('_g_hold_free', { x: integer('x').notNull() });

/** Refuses a decision on a Dual_Approval that is not open, or whose effect or preconditions no longer match (R49.4). */
export const guardDualOpen = sqliteTable('_g_dual_open', { x: integer('x').notNull() });

/** Refuses an approval unless its decider is a different currently Active Administrator from the proposer (R49.3, R49.8). */
export const guardDualDistinct = sqliteTable('_g_dual_distinct', { x: integer('x').notNull() });

/**
 * The emailed-consent tables the Internal_Backup includes, and the columns it must omit (R51.13).
 *
 * R51.13 requires every Consent_Request, Consent_Answer, and withdrawal to be included in each Internal_Backup.
 * They are kept for the External_Party's life, so the backup carries the full rows — except the Consent_Link
 * and Change_Link token hashes, which are single-use secrets a restore must never resurrect and which are in
 * any case deleted 30 days after the links expire (R51.13). The Internal_Backup job of task 38.4 is not yet
 * implemented; it MUST consume this list so these tables are backed up and the named token-hash columns are
 * excluded. Add any later emailed-consent table here rather than to the backup job itself, so the exclusion
 * of secrets stays beside the schema that declares them.
 */
export const CONSENT_BACKUP_TABLES: readonly { readonly table: string; readonly excludeColumns: readonly string[] }[] = Object.freeze([
  Object.freeze({ table: 'consent_requests', excludeColumns: Object.freeze(['token_hash', 'change_token_hash']) }),
  Object.freeze({ table: 'consent_request_items', excludeColumns: Object.freeze([]) }),
  Object.freeze({ table: 'consent_answers', excludeColumns: Object.freeze([]) }),
  Object.freeze({ table: 'consent_withdrawals', excludeColumns: Object.freeze([]) }),
]);
