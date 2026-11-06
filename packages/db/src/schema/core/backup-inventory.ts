import { CONSENT_BACKUP_TABLES } from './consent';
import { MODERATION_BACKUP_TABLES } from './work';

/**
 * The AUTHORITATIVE TABLE INVENTORY the Internal_Backup captures, and the explicit set it leaves out, declared once
 * beside the schema (R36.1, R36.13, R36.14, R60.1; design "Internal_Backup and independent recovery": "Back up every
 * authoritative research/identity/policy table ... Rebuildable flags, views, notifications/events, mail batches,
 * sessions, raw outbox, transient stages, and network counters stay out").
 *
 * R60.1 is explicit that "No new table is implicitly safe because an older root route was checked." So the inventory
 * is DECLARED, not derived at runtime: every table in rf-core is named here as either BACKED UP or EXCLUDED (with its
 * reason), and the `backup-inventory` guard test fails if the live `sqlite_master` ever holds a table this file does
 * not account for. Adding a table to the schema therefore forces a reviewed decision here. Per-table column exclusions
 * for single-use token-hash secrets live beside their own schema ({@link CONSENT_BACKUP_TABLES},
 * {@link MODERATION_BACKUP_TABLES}); this module folds them in so the backup job consumes one list.
 *
 * The backup job (task 38.4, `apps/app/src/jobs/backup.ts`) pages each {@link BackupTableEntry} in snapshot order,
 * selecting every column except the entry's `excludeColumns`, and records each table's exact row count and digest. It
 * never reads an {@link EXCLUDED_BACKUP_TABLES} table, so a derived flag, a notification, a mail batch, a session, a
 * transient stage, a raw-outbox row, a network counter, or a pending external send is never copied into a package and
 * never replayed by a restore.
 */

/** One authoritative table the backup captures, with any single-use-secret columns it must omit (R36.1, R51.13). */
export interface BackupTableEntry {
  readonly table: string;
  /** Columns omitted from the backed-up row image (single-use token hashes); empty for most tables. */
  readonly excludeColumns: readonly string[];
}

/**
 * The authoritative tables backed up, grouped by the inventory R36.1/R60.1 names, in a stable snapshot order. Each
 * table is captured whole except the per-table `excludeColumns` the schema declares beside it. The groups are purely
 * for the reviewer; the backup job flattens them through {@link BACKUP_TABLES}.
 */
const INVENTORY_GROUPS: Readonly<Record<string, readonly BackupTableEntry[]>> = Object.freeze({
  // Identity, Roles, Profiles, and the configurable/policy value sets (R36.1: Members, Roles, Member_Statuses,
  // Profiles, the configurable value set, the workspace-wide configurable setting; R47.15 Access_Levels/Access_Lists).
  identity: freezeEntries([
    'members', 'roles', 'role_permissions', 'profiles', 'licence_agreements', 'profile_specialties',
    'profile_affiliations', 'notification_prefs', 'muted_projects', 'config_values', 'methods_terms', 'settings',
  ]),
  // Policy_Pages and Policy_Sections with their history (R36.11).
  policy: freezeEntries(['policy_pages', 'policy_sections']),
  // Every Project, Item, Entry_Section, kind-specific detail, Dissent_Note, Cross_Link, Review_Request, identity, and
  // External_Party, plus the Access_List rows of Restricted Research_Items (R36.1, R47.1, R47.15).
  research: freezeEntries([
    'projects', 'units', 'access_grants', 'research_items', 'journal_entries', 'je_members', 'entry_sections',
    'findings', 'sources', 'runs', 'run_counts', 'hypotheses', 'correspondences', 'correspondence_parties',
    'archival_requests', 'topics', 'research_questions', 'question_groups', 'question_entries', 'replies',
    'attachments', 'dissent_notes', 'identifiers', 'deletions', 'external_parties', 'cross_links',
    'review_requests', 'review_addressees',
  ]),
  // The immutable logical-field versions and their fragments/spans, whose digests the manifest records (design
  // "Chunk-aware readers"). The field READ-LEASE and GC-permit tables are transient, so they are excluded below.
  fields: freezeEntries(['field_versions', 'text_fragments', 'span_manifest_parts', 'field_current', 'field_references']),
  // Source bibliography and the Evidence_Citation graph (R60.1 citation objects).
  evidence: freezeEntries(['source_bibliography', 'source_creators', 'source_identifiers', 'evidence_citations']),
  // Decision_Records and their alternatives, participants, evidence, acknowledgements, and immutable events (R60.1).
  decisions: freezeEntries(['decisions', 'decision_alternatives', 'decision_participants', 'decision_evidence', 'decision_acknowledgements', 'decision_events']),
  // Work_Items with their assignees, dependency edges, outcomes, and immutable events, and the Research_Question
  // lifecycle rows (assessments, their evidence, uncertainties, next actions) (R60.1 work/decision relationships).
  work: freezeEntries([
    'work_items', 'work_assignees', 'work_dependencies', 'work_outcomes', 'work_outcome_results', 'work_events',
    'question_assessments', 'question_assessment_evidence', 'question_uncertainties', 'question_next_actions',
  ]),
  // Compute_Packages: configuration, environment, artifacts, scopes/schemas, and reproduction attempts (R60.1).
  compute: freezeEntries(['compute_packages', 'compute_artifacts', 'compute_configuration', 'compute_environment', 'scope_schemas', 'compute_scopes', 'compute_scope_entries', 'reproduction_attempts']),
  // Artifact derivations with their inputs, reviews, and reviewer flags (R60.1 derivation objects).
  derivations: freezeEntries(['artifact_derivations', 'artifact_derivation_inputs', 'derivation_reviews', 'derivation_flags']),
  // Research_Releases with their captured artifacts and approvals; release manifests go in backups (R59.5, R60.1).
  releases: freezeEntries(['research_releases', 'release_artifacts', 'release_approvals']),
  // Author-scoped durable drafts and their immutable events (R57; R60.1 "personal drafts ... follow their explicit
  // exceptions"). Drafts are personal data, present only in encrypted backups and personal export.
  drafts: freezeEntries(['saved_drafts', 'draft_events']),
  // Edit_Proposals and their immutable events (R57, R60.1 proposal objects).
  proposals: freezeEntries(['edit_proposals', 'edit_proposal_events']),
  // Author-scoped personal navigation: Bookmarks, Saved_Searches, and Follows (R58; R60.1 navigation exception). No
  // result snapshot is stored, so these carry only the Member's own targets/queries.
  navigation: freezeEntries(['bookmarks', 'saved_searches', 'follows']),
  // Confidentiality_Holds, Dual_Approvals, and the Publication_Consent and emailed Consent_Request evidence, each kept
  // for the element's/Party's life (R48.11, R49.7, R51.13). The emailed-consent tables come from `CONSENT_BACKUP_TABLES`
  // (consent_requests, consent_request_items, consent_answers, consent_withdrawals), whose token-hash columns are
  // OMITTED per that list — single-use secrets a restore must never resurrect (R51.13).
  accessEvidence: freezeEntries(
    ['confidentiality_holds', 'dual_approvals', 'publication_consents', ...CONSENT_BACKUP_TABLES.map((entry) => entry.table)],
    CONSENT_BACKUP_TABLES,
  ),
  // Permission_Evidence with its covered identities, named uses, and withdrawals (R51.9, R51.13, R60.1).
  permissionEvidence: freezeEntries(['permission_evidence', 'permission_evidence_items', 'permission_evidence_uses', 'permission_evidence_withdrawals']),
  // The scholarly Revision history, the Submission records, and the Activity_Feed with its tags (R22.1 immutable
  // history; R36.1). The Activity_Feed is authoritative history, unlike the rebuildable Notification feed.
  history: freezeEntries(['revisions', 'submissions', 'activity', 'activity_tags']),
  // Accepted Outside_Submissions with their Moderation_Decisions, Response texts, and the Contact_Review / Submitter
  // correction history that comes from `MODERATION_BACKUP_TABLES` (R36.1 "Outside_Submission with the
  // Outside_Submission's Moderation_Decisions"; R32.19–R32.22). The Submitter-contact erasure is never stored in the
  // first place, so nothing is excluded.
  moderation: freezeEntries(
    ['outside_submissions', 'outside_responses', 'moderation_decisions', ...MODERATION_BACKUP_TABLES.map((entry) => entry.table)],
    MODERATION_BACKUP_TABLES,
  ),
  // The retained idempotency RESULT IDENTITIES only (R60.2, R60.8): the actor-scoped key, request digest, and the
  // committed result's resource IDs — never a request or response body. These let a status query reconcile a lost
  // response after a restore without repeating an external action or duplicating an Item.
  idempotency: freezeEntries(['idempotency_results']),
});

/** The flat authoritative inventory the backup job pages, in a stable order (R36.1). */
export const BACKUP_TABLES: readonly BackupTableEntry[] = Object.freeze(Object.values(INVENTORY_GROUPS).flat());

/**
 * The rf-core tables the Internal_Backup deliberately EXCLUDES, each with the reason category R36.1/R60.1 names. A
 * restore never recreates these: they are rebuildable from the authoritative rows, are transient, or hold single-use
 * secrets or pending external sends that must never replay. The guard test asserts this set and {@link BACKUP_TABLES}
 * together cover every real table, so a table is never silently dropped (R60.1).
 */
export const EXCLUDED_BACKUP_TABLES: Readonly<Record<string, string>> = Object.freeze({
  // Derived New_Flags / Updated_Flags and per-Member view marks — recomputed from the authoritative rows (R36.4).
  flags: 'derived New_Flags/Updated_Flags, rebuilt from the authoritative rows',
  views: 'derived per-Member view marks, rebuilt from the authoritative rows',
  // Notifications and Notification_Events — rebuildable; a restore sets no New_Flags and creates no events (R36.4).
  notification_events: 'rebuildable Notification_Events; a restore creates none (R36.4)',
  notifications: 'rebuildable Notifications; a restore creates none (R36.4)',
  // Mail queues: email batches and the outgoing-email queue — a restore never replays a pending external send.
  email_batches: 'mail queue (notification email batches); never replayed on restore',
  outgoing_emails: 'mail queue (invitations and Submitter emails); never replayed on restore',
  // Sessions — authentication state Access re-establishes; never carried in a backup.
  sessions: 'authentication sessions; re-established by Access, never backed up',
  // Transient staging and upload bookkeeping — in-flight saves and uploads, not authoritative records.
  staging_rows: 'transient staged-save parts (deleted after 24h)',
  uploads: 'transient upload bookkeeping; the attached file lives in R2 and its Attachment row is backed up',
  upload_parts: 'transient multipart upload bookkeeping',
  // The raw outbox and the external-operation ledger — follow-up/pending external work, never replayed after restore.
  outbox: 'raw follow-up outbox; a restore re-derives its own follow-up and never replays pending work',
  external_operations: 'pending external-operation ledger; a restore never replays a pending external send',
  // The audited, content-free failure aggregate (task 67.3) — operational metadata (counts by kind/detail, no bodies),
  // kept past the 90-day per-failure horizon; a restore re-derives its own operational state (R60.1, R60.8).
  operation_failure_aggregates: 'the audited content-free failure aggregate (counts by kind/detail); operational metadata, never snapshotted',
  // Network / sequence counters — rebuilt by the restore, never a research row.
  counters: 'network/sequence counters (change, epoch, freeze_generation), rebuilt by the restore',
  // Job and export bookkeeping — the running snapshot/export control rows, not authoritative research.
  jobs: 'job control/checkpoint bookkeeping; transient',
  import_rows: 'per-row Bulk_Import outcome bookkeeping; transient',
  exports: 'export/backup package bookkeeping; transient staging',
  // The Internal_Backup freeze lease, file pins, and audit — the backup mechanism itself, never snapshotted.
  write_freeze_leases: 'the backup write-freeze lease bookkeeping; never snapshotted',
  backup_file_pins: 'the backup per-file retention pins; never snapshotted',
  freeze_audit: 'the backup freeze audit trail (operational metadata); never snapshotted',
  // The independent recovery-point lifecycle and the independently-carried suppression ledger (task 58.2) — backup
  // mechanism bookkeeping about the packages themselves, never snapshotted research rows.
  backup_points: 'the independent recovery-point / copy / verification bookkeeping; never snapshotted',
  suppression_generations: 'the minimal authenticated suppression ledger carried independently (ids/generations, no bodies)',
  backup_alert_state: 'the independent RPO-age alert de-duplication marker (operational state); never snapshotted',
  usage_alert_state: 'the per-allowance usage-alert crossing de-duplication marker (operational state); never snapshotted',
  // The restore-owned checkpoints (task 58.4) — the restore mechanism's own resumable bookkeeping about the package it
  // is applying (restore_id/table/key/payload_hash), never a snapshotted research row (R36.4, R60.1).
  restore_checkpoints: 'the restore-owned insert-or-verify checkpoints; restore-mechanism bookkeeping, never snapshotted',
  // The requested-restore lifecycle rows (task 38.5) — the restore mechanism's own quarantine/release bookkeeping
  // about the package it is applying, never a snapshotted research row (R36.4, R60.1).
  restores: 'the requested-restore lifecycle / quarantine-release bookkeeping; restore-mechanism bookkeeping, never snapshotted',
  // Transient field read-leases, GC permits, and the field-backfill cursor — schema/migration state, not content.
  field_read_leases: 'transient field-version read leases',
  _field_gc_permits: 'transient field-version GC permits',
  field_backfill_state: 'transient field-backfill migration cursor; not authoritative content',
  // Transient public-submission session/file/link rows — single-use tokens and in-flight public uploads.
  outside_sessions: 'transient public Outside_Submission / Response_Link sessions',
  outside_files: 'transient Outside_Submission upload bookkeeping; files live in R2',
  response_links: 'single-use Response_Link token hashes; never resurrected (R32.14)',
  // The revision-snapshot side table holds packed Revision prev images keyed by Revision id; the Revisions themselves
  // are backed up and a restore re-derives the snapshot, so the packed copy is not independently backed up.
  revision_field_snapshots: 'packed Revision prev images, re-derived from the backed-up Revisions',
});

/**
 * Assemble a table's backup entry with any single-use-secret columns to omit, folding in a declared-beside-schema
 * exclusion list ({@link CONSENT_BACKUP_TABLES} / {@link MODERATION_BACKUP_TABLES}) where one names the table.
 */
function freezeEntries(
  tables: readonly string[],
  columnSource: readonly { readonly table: string; readonly excludeColumns: readonly string[] }[] = [],
): readonly BackupTableEntry[] {
  return Object.freeze(tables.map((table) => {
    const declared = columnSource.find((entry) => entry.table === table);
    return Object.freeze({ table, excludeColumns: Object.freeze([...(declared?.excludeColumns ?? [])]) });
  }));
}
