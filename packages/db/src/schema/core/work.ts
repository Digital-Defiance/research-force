import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { OUTSIDE_SUBMISSION_TYPES } from '@researchforce/domain/types';
import { flag, oneOf, versioned } from '../columns';

export const OUTBOX_TOPICS = ['publish', 'search', 'mail', 'jobs'] as const;
export const UPLOAD_OWNER_TYPES = ['member', 'outside_session'] as const;
export const UPLOAD_MODES = ['single', 'multipart'] as const;
export const JOB_TYPES = ['journal_import', 'bulk_import', 'public_export', 'internal_backup', 'restore', 'deletion', 'preview'] as const;
export const JOB_STATES = ['queued', 'running', 'paused', 'complete', 'incomplete', 'failed'] as const;
export const IMPORT_ROW_OUTCOMES = ['pending', 'created', 'skipped', 'failed'] as const;
export const EXPORT_TYPES = ['public', 'backup'] as const;
export const EXPORT_STATES = ['running', 'complete', 'incomplete', 'deleted'] as const;
export const OUTSIDE_SESSION_PURPOSES = ['submission', 'response'] as const;
export const OUTSIDE_SUBMISSION_STATES = ['queued', 'more_information_requested', 'accepted', 'rejected'] as const;
export const OUTSIDE_FILE_STATES = ['uploading', 'complete', 'failed', 'deleted'] as const;
export const DECISION_KINDS = ['accepted', 'more_information_requested', 'rejected'] as const;

/** Follow-up work recorded in the same batch as the change that causes it. */
export const outbox = sqliteTable('outbox', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  topic: text('topic', { enum: OUTBOX_TOPICS }).notNull(),
  scope: text('scope').notNull(), // 'root:…', 'member:…', 'party:…', 'site', …
  changeSeq: integer('change_seq').notNull(),
  createdAt: text('created_at').notNull(),
  doneAt: text('done_at'),
}, (t) => [index('outbox_pending').on(t.topic, t.doneAt, t.seq), oneOf('outbox_topic_values', t.topic, OUTBOX_TOPICS)]);

/** Parts of a staged save, moved into place by its commit and deleted after 24 hours otherwise. */
export const stagingRows = sqliteTable('staging_rows', {
  token: text('token').notNull(),
  part: integer('part').notNull(),
  memberId: text('member_id').notNull(),
  payload: text('payload').notNull(),
  createdAt: text('created_at').notNull(),
}, (t) => [primaryKey({ columns: [t.token, t.part] }), index('staging_rows_created').on(t.createdAt)]);

export const uploads = sqliteTable('uploads', {
  id: text('id').primaryKey(),
  groupId: text('group_id'),
  state: text('state', { enum: ['uploading', 'complete', 'attached', 'deleting'] }).notNull().default('uploading'),
  ownerType: text('owner_type', { enum: UPLOAD_OWNER_TYPES }).notNull(),
  ownerId: text('owner_id').notNull(),
  r2Key: text('r2_key').notNull(),
  fileName: text('file_name').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  sha256: text('sha256').notNull(),
  mode: text('mode', { enum: UPLOAD_MODES }).notNull(),
  multipartId: text('multipart_id'),
  createdAt: text('created_at').notNull(),
  completedAt: text('completed_at'),
  attachedAt: text('attached_at'), // set when a completed Submission uses the file (R12.8)
}, (t) => [
  uniqueIndex('uploads_r2_key').on(t.r2Key),
  index('uploads_owner').on(t.ownerType, t.ownerId),
  index('uploads_group').on(t.ownerId, t.groupId),
  oneOf('uploads_state_values', t.state, ['uploading', 'complete', 'attached', 'deleting']),
  index('uploads_abandoned').on(t.attachedAt, t.createdAt),
  oneOf('uploads_owner_values', t.ownerType, UPLOAD_OWNER_TYPES),
  oneOf('uploads_mode_values', t.mode, UPLOAD_MODES),
  check('uploads_multipart_id', sql`(${t.mode} = 'multipart') = (${t.multipartId} IS NOT NULL)`),
]);

export const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey(),
  type: text('type', { enum: JOB_TYPES }).notNull(),
  state: text('state', { enum: JOB_STATES }).notNull(),
  requestedBy: text('requested_by'),
  params: text('params', { mode: 'json' }),
  cursor: text('cursor', { mode: 'json' }),
  progress: text('progress', { mode: 'json' }),
  reportKey: text('report_key'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  finishedAt: text('finished_at'),
}, (t) => [
  index('jobs_state').on(t.type, t.state),
  oneOf('jobs_type_values', t.type, JOB_TYPES),
  oneOf('jobs_state_values', t.state, JOB_STATES),
]);

export const importRows = sqliteTable('import_rows', {
  jobId: text('job_id').notNull(),
  rowNumber: integer('row_number').notNull(),
  rowKey: text('row_key').notNull(),
  outcome: text('outcome', { enum: IMPORT_ROW_OUTCOMES }).notNull().default('pending'),
  reason: text('reason'),
  unitId: text('unit_id'),
}, (t) => [
  primaryKey({ columns: [t.jobId, t.rowNumber] }),
  index('import_rows_outcome').on(t.jobId, t.outcome),
  oneOf('import_rows_outcome_values', t.outcome, IMPORT_ROW_OUTCOMES),
]);

export const exportPackages = sqliteTable('exports', {
  id: text('id').primaryKey(),
  type: text('type', { enum: EXPORT_TYPES }).notNull(),
  scopeProjectId: text('scope_project_id'), // NULL: every Public or Withheld Project
  scheduled: flag('scheduled'),
  requestedBy: text('requested_by'),
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at'),
  state: text('state', { enum: EXPORT_STATES }).notNull(),
  incomplete: text('incomplete', { mode: 'json' }), // missing or mismatched files
  volumes: text('volumes', { mode: 'json' }).$type<string[]>(),
  unitIndexKey: text('unit_index_key'),
  staleness: text('staleness', { mode: 'json' }),
  deliveredAt: text('delivered_at'), // first full download by an Administrator (R36.7)
  expiresAt: text('expires_at'),
}, (t) => [
  index('exports_type').on(t.type, t.state, t.startedAt),
  oneOf('exports_type_values', t.type, EXPORT_TYPES),
  oneOf('exports_state_values', t.state, EXPORT_STATES),
  check('exports_backup_unscheduled', sql`${t.type} = 'public' OR (${t.scheduled} = 0 AND ${t.scopeProjectId} IS NULL)`),
]);

export const outsideSessions = sqliteTable('outside_sessions', {
  id: text('id').primaryKey(),
  purpose: text('purpose', { enum: OUTSIDE_SESSION_PURPOSES }).notNull(),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  outsideSubmissionId: text('outside_submission_id'),
}, (t) => [index('outside_sessions_expiry').on(t.expiresAt), oneOf('outside_sessions_purpose_values', t.purpose, OUTSIDE_SESSION_PURPOSES)]);

/** Network addresses are never stored here; Budget keeps only hashed counts (R46.20). */
export const outsideSubmissions = sqliteTable('outside_submissions', {
  id: text('id').primaryKey(),
  reference: text('reference').notNull(),
  type: text('type', { enum: OUTSIDE_SUBMISSION_TYPES }).notNull(),
  projectId: text('project_id'), // NULL means the General_Choice
  message: text('message').notNull(),
  name: text('name').notNull(),
  email: text('email'), // erased 90 to 91 days after a rejection or an accepted Removal_Request
  affiliation: text('affiliation'),
  pageRef: text('page_ref'),
  licenceAgreed: text('licence_agreed'), // the Content_Licence name agreed to; NULL for Removal_Requests
  receivedAt: text('received_at').notNull(),
  state: text('state', { enum: OUTSIDE_SUBMISSION_STATES }).notNull().default('queued'),
  emailEraseAfter: text('email_erase_after'),
  emailErasedAt: text('email_erased_at'),
  filesDeletedAt: text('files_deleted_at'),
  // The highest Response_Target reminder threshold (days since receipt) already reminded, so the hourly sweep
  // creates each (submission, threshold) Reminder once even across repeated runs; NULL means none yet (R46.25).
  responseTargetRemindedDay: integer('response_target_reminded_day'),
  // When this accepted Outside_Submission's Submitter_Contact next falls due for a Contact_Review: the acceptance
  // time (or the last Keep Contact_Review) plus 12 months, set only on accepting a non-Removal_Request (R32.19).
  // NULL means no review is scheduled — a rejected, removed, or still-queued Outside_Submission, or one whose email
  // has been erased so there is no longer a Submitter_Contact to review (R32.20).
  contactReviewDueAt: text('contact_review_due_at'),
  // The day index (days since the epoch) on which the Contact_Review sweep last reminded about this Outside_Submission,
  // so the once-a-day "became due" Reminder and the every-30-days overdue repeat each go out once across hourly runs;
  // NULL means it has become due but has not yet been reminded (R32.19, R32.21). Cleared to NULL on a Keep Contact_Review
  // when a new due date is set, so the next cycle reminds afresh.
  contactReviewRemindedDay: integer('contact_review_reminded_day'),
  ...versioned(),
}, (t) => [
  uniqueIndex('outside_submissions_reference').on(t.reference),
  index('outside_submissions_queue').on(t.state, t.receivedAt),
  index('outside_submissions_erase').on(t.emailEraseAfter).where(sql`${t.emailErasedAt} IS NULL`),
  // Contact_Review candidates: a scheduled due date whose email is still held, newest-reminded tracked for idempotency (R32.19).
  index('outside_submissions_contact_review').on(t.contactReviewDueAt).where(sql`${t.contactReviewDueAt} IS NOT NULL AND ${t.emailErasedAt} IS NULL`),
  oneOf('outside_submissions_type_values', t.type, OUTSIDE_SUBMISSION_TYPES),
  oneOf('outside_submissions_state_values', t.state, OUTSIDE_SUBMISSION_STATES),
  check('outside_submissions_email_erasure', sql`${t.emailErasedAt} IS NULL OR ${t.email} IS NULL`),
  check('outside_submissions_licence', sql`(${t.type} = 'removal_request') = (${t.licenceAgreed} IS NULL)`),
]);

export const CONTACT_REVIEW_ACTIONS = ['keep', 'erase'] as const;
export const SUBMITTER_CORRECTION_KINDS = ['attribution', 'contact'] as const;

/**
 * An append-only Contact_Review: the yearly decision an Administrator records for an accepted Outside_Submission
 * whose Submitter_Contact is still held — Keep it for another 12 months with a reason, or Erase it (R32.19, R32.20).
 * Rows are never updated: each review records its choice, the reason, the Administrator, and the time, so the whole
 * sequence of reviews is the history. A Keep moves the Outside_Submission's `contact_review_due_at` 12 months on; an
 * Erase schedules the Submitter_Contact's erasure within 24 hours. Both keep the Submitter_Attribution and the
 * submitted text (R32.20). The raw migration adds the trigger that refuses an UPDATE or DELETE.
 */
export const contactReviews = sqliteTable('contact_reviews', {
  id: text('id').primaryKey(),
  outsideSubmissionId: text('outside_submission_id').notNull(),
  action: text('action', { enum: CONTACT_REVIEW_ACTIONS }).notNull(),
  /** 1 to 1,000 characters for a Keep; NULL for an Erase, which needs no reason (R32.20). */
  reason: text('reason'),
  adminId: text('admin_id').notNull(),
  at: text('at').notNull(),
}, (t) => [
  index('contact_reviews_submission').on(t.outsideSubmissionId, t.at),
  oneOf('contact_reviews_action_values', t.action, CONTACT_REVIEW_ACTIONS),
  // A Keep carries a reason; an Erase carries none (R32.20).
  check('contact_reviews_reason', sql`(${t.action} = 'keep') = (${t.reason} IS NOT NULL)`),
]);

/**
 * An append-only Submitter correction: an Administrator's correction, at any time, of the Submitter_Attribution
 * (the name and affiliation) or the Submitter_Contact (the email), or an erasure of the Submitter_Contact, with a
 * reason (R32.22). Rows are never updated: each records the acting Administrator, the time, the reason, the new
 * values, and the previous values — except that a previous erased Submitter_Contact is not kept (`prev_email` is
 * NULL for a contact erasure). A corrected Submitter_Attribution is rewritten into the Credit of every Item created
 * from the Outside_Submission, each with a Minor_Edit Revision (R32.22). The raw migration adds the append-only
 * trigger.
 */
export const submitterCorrections = sqliteTable('submitter_corrections', {
  id: text('id').primaryKey(),
  outsideSubmissionId: text('outside_submission_id').notNull(),
  kind: text('kind', { enum: SUBMITTER_CORRECTION_KINDS }).notNull(),
  /** Whether a `contact` correction erased the Submitter_Contact rather than replacing it (R32.22). */
  erased: flag('erased'),
  /** The corrected name, for an `attribution` correction; NULL for a `contact` correction. */
  newName: text('new_name'),
  /** The corrected affiliation, for an `attribution` correction; NULL when the affiliation is cleared or for a `contact` correction. */
  newAffiliation: text('new_affiliation'),
  /** The corrected email, for a `contact` correction that replaced it; NULL for an erasure or an `attribution` correction. */
  newEmail: text('new_email'),
  /** The previous name, kept for an `attribution` correction (R32.22). */
  prevName: text('prev_name'),
  /** The previous affiliation, kept for an `attribution` correction when one was set. */
  prevAffiliation: text('prev_affiliation'),
  /** The previous email, kept for a `contact` correction that replaced it; NEVER kept for an erasure (R32.22). */
  prevEmail: text('prev_email'),
  adminId: text('admin_id').notNull(),
  /** 1 to 1,000 characters (R32.22). */
  reason: text('reason').notNull(),
  at: text('at').notNull(),
}, (t) => [
  index('submitter_corrections_submission').on(t.outsideSubmissionId, t.at),
  oneOf('submitter_corrections_kind_values', t.kind, SUBMITTER_CORRECTION_KINDS),
  // An erasure is a contact correction; an attribution correction never erases.
  check('submitter_corrections_erased', sql`${t.erased} = 0 OR ${t.kind} = 'contact'`),
  // An erased Submitter_Contact is not kept, so no new or previous email is recorded for it (R32.22).
  check('submitter_corrections_erase_values', sql`${t.erased} = 0 OR (${t.newEmail} IS NULL AND ${t.prevEmail} IS NULL)`),
  // An attribution correction records a name and no email; a contact correction records no name or affiliation. An
  // erased Submitter_Contact keeps no email either way, so a contact correction may hold no email (R32.22).
  check('submitter_corrections_shape', sql`
    (${t.kind} = 'attribution' AND ${t.newEmail} IS NULL AND ${t.prevEmail} IS NULL)
    OR (${t.kind} = 'contact' AND ${t.newName} IS NULL AND ${t.newAffiliation} IS NULL AND ${t.prevName} IS NULL AND ${t.prevAffiliation} IS NULL)`),
]);

/**
 * The moderation tables the Internal_Backup includes, and the columns it must omit (R32.19 to R32.22, R46.19).
 *
 * The Contact_Reviews and Submitter corrections of an accepted Outside_Submission are its history, kept as long as
 * the Outside_Submission exists, so the backup carries the full rows. They hold no single-use secret, so nothing is
 * excluded — the one personal datum a correction deliberately drops, a previously erased Submitter_Contact, is never
 * stored in the first place (`prev_email` is NULL for an erasure), so a restore cannot resurrect it. The Internal_Backup
 * job of task 38.4 is not yet implemented; it MUST consume this list so these tables are backed up. Add any later
 * moderation table here rather than to the backup job itself, so the table list stays beside the schema that declares it.
 */
export const MODERATION_BACKUP_TABLES: readonly { readonly table: string; readonly excludeColumns: readonly string[] }[] = Object.freeze([
  Object.freeze({ table: 'contact_reviews', excludeColumns: Object.freeze([]) }),
  Object.freeze({ table: 'submitter_corrections', excludeColumns: Object.freeze([]) }),
]);

export const outsideFiles = sqliteTable('outside_files', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  outsideSubmissionId: text('outside_submission_id'),
  responseId: text('response_id'),
  r2Key: text('r2_key').notNull(),
  fileName: text('file_name').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  sha256: text('sha256').notNull(),
  state: text('state', { enum: OUTSIDE_FILE_STATES }).notNull().default('uploading'),
  createdAt: text('created_at').notNull(),
  deletedAt: text('deleted_at'),
}, (t) => [
  uniqueIndex('outside_files_r2_key').on(t.r2Key),
  index('outside_files_session').on(t.sessionId),
  index('outside_files_submission').on(t.outsideSubmissionId),
  oneOf('outside_files_state_values', t.state, OUTSIDE_FILE_STATES),
]);

export const outsideResponses = sqliteTable('outside_responses', {
  id: text('id').primaryKey(),
  outsideSubmissionId: text('outside_submission_id').notNull(),
  responseLinkHash: text('response_link_hash').notNull(),
  message: text('message').notNull(),
  receivedAt: text('received_at').notNull(),
}, (t) => [index('outside_responses_submission').on(t.outsideSubmissionId, t.receivedAt)]);

/** Decisions are appended and never updated (R32.13); the raw migration adds the trigger that enforces it. */
export const moderationDecisions = sqliteTable('moderation_decisions', {
  id: text('id').primaryKey(),
  outsideSubmissionId: text('outside_submission_id').notNull(),
  kind: text('kind', { enum: DECISION_KINDS }).notNull(),
  final: integer('final', { mode: 'boolean' }).notNull(),
  adminId: text('admin_id').notNull(),
  at: text('at').notNull(),
  text: text('text').notNull(), // the confirmed email text or statement for the Submitter
  createdUnitIds: text('created_unit_ids', { mode: 'json' }).$type<string[]>(),
  changedRefs: text('changed_refs', { mode: 'json' }), // what an accepted Removal_Request changed (R46.23)
  submissionId: text('submission_id'),
}, (t) => [
  index('moderation_decisions_submission').on(t.outsideSubmissionId, t.at),
  // At most one final decision; the decision_open guard reports the conflict by name (R32.16).
  uniqueIndex('moderation_decisions_final').on(t.outsideSubmissionId).where(sql`${t.final} = 1`),
  oneOf('moderation_decisions_kind_values', t.kind, DECISION_KINDS),
  check('moderation_decisions_finality', sql`${t.final} = (${t.kind} <> 'more_information_requested')`),
]);

/** Only token hashes are stored; the token itself travels in the Submitter's email (R32.14). */
export const responseLinks = sqliteTable('response_links', {
  tokenHash: text('token_hash').primaryKey(),
  outsideSubmissionId: text('outside_submission_id').notNull(),
  decisionId: text('decision_id').notNull(),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  usedAt: text('used_at'),
}, (t) => [index('response_links_submission').on(t.outsideSubmissionId), index('response_links_expiry').on(t.expiresAt)]);

/**
 * Guard tables never hold rows. A guard inserts NULL into one when its condition fails, and the
 * NOT NULL violation aborts the whole batch and names the rule (see batch.ts).
 */
const guardTable = <N extends string>(name: N) => sqliteTable(name, { x: integer('x').notNull() });
export const guardRev = guardTable('_g_rev');
export const guardEvidence = guardTable('_g_evidence');
export const guardSuperseding = guardTable('_g_superseding');
export const guardLastAdmin = guardTable('_g_last_admin');
export const guardChainTip = guardTable('_g_chain_tip');
export const guardDecisionOpen = guardTable('_g_decision_open');
export const guardPreviewFresh = guardTable('_g_preview_fresh');
export const guardLogSummaryOwner = guardTable('_g_log_summary_owner');
export const guardDissentUnique = guardTable('_g_dissent_unique');
export const guardFrozen = guardTable('_g_frozen');
export const guardReplyParent = guardTable('_g_reply_parent');
export const guardReviewEligible = guardTable('_g_review_eligible');
export const guardReviewerEligible = guardTable('_g_reviewer_eligible');
export const guardReviewOpen = guardTable('_g_review_open');
export const guardAccessOwner = guardTable('_g_access_owner');

/** Persisted before signing; R2 verifies each part's Content-MD5 and completion compares the composite ETag of the ordered MD5 digests. */
export const uploadParts = sqliteTable('upload_parts', {
  uploadId: text('upload_id').notNull(), partNumber: integer('part_number').notNull(),
  sha256: text('sha256').notNull(), md5: text('md5'), sizeBytes: integer('size_bytes').notNull(),
}, (t) => [primaryKey({ columns: [t.uploadId, t.partNumber] }), check('upload_parts_number', sql`${t.partNumber} > 0`), check('upload_parts_size', sql`${t.sizeBytes} > 0`)]);

export const guardUploadReady = guardTable('_g_upload_ready');
export const guardUploadLimit = guardTable('_g_upload_limit');
