import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { CONSENT_STATUSES, ITEM_KINDS, LEVELS, UNIT_TYPES } from '@researchforce/domain/types';
import type { CreditEntry, DisclosureLine } from '@researchforce/domain/types';
import { FILE_KIND_EXTENSIONS } from '@researchforce/domain/file-kinds';
import type { FileKind } from '@researchforce/domain/file-kinds';
import { flag, oneOf, spans, versioned } from '../columns';

export const CLASSIFICATION_STATES = ['unclassified', 'classified'] as const;
export const PUBLIC_PRESENTATIONS = ['summary_only', 'full_content'] as const;
export const SOURCE_KINDS = ['primary', 'secondary'] as const;
export const PARTY_KINDS = ['member', 'external'] as const;
export { CONSENT_STATUSES };
export const DIRECTIONS = ['sent', 'received'] as const;
export const SECTION_GROUP_KINDS = ['list', 'table'] as const;
export const REVIEW_STATES = ['needs_review', 'reviewed'] as const;
export const REVIEW_OUTCOMES = ['applied', 'declined'] as const;
export const ADDRESSEE_TYPES = ['member', 'specialty', 'role'] as const;
const FILE_KINDS = Object.keys(FILE_KIND_EXTENSIONS) as [FileKind, ...FileKind[]];

/** Per saved field: the drafting model, its catalog version, and whether the saved text differs from the draft (R44.6). */
export type AiProvenance = Readonly<Record<string, { readonly model: string; readonly version: string; readonly differs: boolean }>>;

/** Every Disclosure_Unit except Projects. Kind-specific fields live in the detail tables below. */
export const units = sqliteTable('units', {
  id: text('id').primaryKey(),
  unitType: text('unit_type', { enum: UNIT_TYPES }).notNull(),
  projectId: text('project_id').notNull(),
  rootId: text('root_id').notNull(),
  parentId: text('parent_id'),
  position: integer('position').notNull().default(0),
  ownerId: text('owner_id').notNull(),
  credit: text('credit', { mode: 'json' }).$type<CreditEntry[]>().notNull(),
  submissionId: text('submission_id').notNull(),
  createdAt: text('created_at').notNull(),
  createdAi: text('created_ai', { mode: 'json' }).$type<AiProvenance>(),
  disclosureLevel: text('disclosure_level', { enum: LEVELS }).notNull().default('private'),
  classificationState: text('classification_state', { enum: CLASSIFICATION_STATES }),
  classifiedBy: text('classified_by'),
  classifiedAt: text('classified_at'),
  disclosureLine: text('disclosure_line', { mode: 'json' }).$type<DisclosureLine>(),
  withdrawnAt: text('withdrawn_at'),
  withdrawnBy: text('withdrawn_by'),
  withdrawalReason: text('withdrawal_reason'),
  ...versioned(),
}, (t) => [
  index('units_root').on(t.rootId, t.unitType),
  index('units_parent').on(t.parentId, t.position),
  index('units_project').on(t.projectId, t.unitType),
  index('units_submission').on(t.submissionId),
  index('units_seq').on(t.updatedSeq),
  index('units_unclassified').on(t.classificationState, t.rootId),
  oneOf('units_type_values', t.unitType, UNIT_TYPES),
  oneOf('units_level_values', t.disclosureLevel, LEVELS),
  oneOf('units_classification_values', t.classificationState, CLASSIFICATION_STATES, true),
  check('units_withheld_line', sql`${t.disclosureLevel} <> 'withheld' OR ${t.disclosureLine} IS NOT NULL`),
  // Unclassified units stay Private until an Administrator classifies them (R26.5).
  check('units_unclassified_private', sql`${t.classificationState} IS NOT 'unclassified' OR ${t.disclosureLevel} = 'private'`),
  check('units_root_shape', sql`(${t.unitType} = 'research_item') = (${t.rootId} = ${t.id} AND ${t.parentId} IS NULL)`),
]);

export const researchItems = sqliteTable('research_items', {
  unitId: text('unit_id').primaryKey(),
  kind: text('kind', { enum: ITEM_KINDS }).notNull(),
  itemIdentifier: text('item_identifier').notNull(),
  projectId: text('project_id').notNull(),
  title: text('title').notNull(),
  statusValueId: text('status_value_id'),
  itemDateKey: text('item_date_key').notNull(),
  logDateKey: text('log_date_key').notNull(),
  logDateIsCreation: flag('log_date_is_creation'),
  logSummary: text('log_summary'),
  logSummarySpans: spans('log_summary_spans'),
  publicSummary: text('public_summary'),
  publicSummarySpans: spans('public_summary_spans'),
  publicPresentation: text('public_presentation', { enum: PUBLIC_PRESENTATIONS }).notNull().default('summary_only'),
  firstPublicAt: text('first_public_at'),
  importKey: text('import_key'),
  importRowKey: text('import_row_key'), // decides concurrent Bulk_Imports of one Row_Key (R37.6)
}, (t) => [
  uniqueIndex('research_items_identifier').on(t.itemIdentifier),
  uniqueIndex('research_items_import_row_key').on(t.importRowKey).where(sql`${t.importRowKey} IS NOT NULL`),
  index('research_items_log').on(t.projectId, t.logDateKey),
  index('research_items_kind').on(t.kind, t.projectId),
  index('research_items_import_key').on(t.projectId, t.importKey),
  oneOf('research_items_kind_values', t.kind, ITEM_KINDS),
  oneOf('research_items_presentation_values', t.publicPresentation, PUBLIC_PRESENTATIONS),
]);

export const journalEntries = sqliteTable('journal_entries', {
  unitId: text('unit_id').primaryKey(),
  phaseId: text('phase_id'),
  headingText: text('heading_text'),
  headingRaw: text('heading_raw'),
  startDate: text('start_date'),
  startDateApprox: flag('start_date_approx'),
  endDate: text('end_date'),
  endDateApprox: flag('end_date_approx'),
  trailing: text('trailing').notNull().default(''),
});

export const jeMembers = sqliteTable('je_members', {
  unitId: text('unit_id').notNull(),
  memberId: text('member_id').notNull(),
  position: integer('position').notNull(),
}, (t) => [primaryKey({ columns: [t.unitId, t.memberId] }), index('je_members_member').on(t.memberId)]);

/** Each section's text is the exact source slice; separators keep the Journal_Printer byte-exact (R27). */
export const entrySections = sqliteTable('entry_sections', {
  unitId: text('unit_id').primaryKey(),
  text: text('text').notNull(),
  textSpans: spans('text_spans'),
  sepBefore: text('sep_before'),
  groupKind: text('group_kind', { enum: SECTION_GROUP_KINDS }),
  groupId: integer('group_id'),
  srcLineStart: integer('src_line_start'),
  srcLineEnd: integer('src_line_end'),
  unassigned: flag('unassigned'),
}, (t) => [
  oneOf('entry_sections_group_values', t.groupKind, SECTION_GROUP_KINDS, true),
  check('entry_sections_group_pair', sql`(${t.groupKind} IS NULL) = (${t.groupId} IS NULL)`),
]);

export const findings = sqliteTable('findings', {
  unitId: text('unit_id').primaryKey(),
  claim: text('claim').notNull(),
  claimSpans: spans('claim_spans'),
  scopeCaveat: text('scope_caveat').notNull(),
  scopeCaveatSpans: spans('scope_caveat_spans'),
  supersededById: text('superseded_by_id'), // the designated superseding Finding while Superseded (R5.4)
});

export const sources = sqliteTable('sources', {
  unitId: text('unit_id').primaryKey(),
  sourceKind: text('source_kind', { enum: SOURCE_KINDS }).notNull(),
  reliabilityId: text('reliability_id').notNull(),
  // A single date leaves the end empty; a range sets both (R6.7).
  docDate: text('doc_date'),
  docDateApprox: flag('doc_date_approx'),
  docDateEnd: text('doc_date_end'),
  docDateEndApprox: flag('doc_date_end_approx'),
  archiveOrCollection: text('archive_or_collection'),
  archivalReference: text('archival_reference'),
  recovererKind: text('recoverer_kind', { enum: PARTY_KINDS }),
  recovererId: text('recoverer_id'),
  reliabilityNote: text('reliability_note'),
  reliabilityNoteSpans: spans('reliability_note_spans'),
  rightsStatusId: text('rights_status_id').notNull(),
  rightsHolder: text('rights_holder'),
  rightsTerms: text('rights_terms'),
}, (t) => [
  oneOf('sources_kind_values', t.sourceKind, SOURCE_KINDS),
  oneOf('sources_recoverer_values', t.recovererKind, PARTY_KINDS, true),
  check('sources_recoverer_pair', sql`(${t.recovererKind} IS NULL) = (${t.recovererId} IS NULL)`),
  check('sources_range_start', sql`${t.docDateEnd} IS NULL OR ${t.docDate} IS NOT NULL`),
  index('sources_recoverer').on(t.recovererId),
]);

export const runs = sqliteTable('runs', {
  unitId: text('unit_id').primaryKey(),
  scope: text('scope').notNull(),
  scopeSpans: spans('scope_spans'),
  parameters: text('parameters').notNull(),
  parametersSpans: spans('parameters_spans'),
  toolName: text('tool_name').notNull(),
  toolVersion: text('tool_version').notNull(),
  computeResource: text('compute_resource').notNull(),
  startTime: text('start_time').notNull(), // as entered, with its offset and fractional precision
  startKey: text('start_key').notNull(), // UTC sort key
  endTime: text('end_time'),
  outcomeId: text('outcome_id').notNull(),
  resumePoint: text('resume_point'),
  notes: text('notes'),
  notesSpans: spans('notes_spans'),
});

/** Counts stay decimal digit strings and are never converted to numbers (R7.2, R7.9). */
export const runCounts = sqliteTable('run_counts', {
  unitId: text('unit_id').notNull(),
  position: integer('position').notNull(),
  name: text('name').notNull(),
  value: text('value').notNull(),
}, (t) => [
  primaryKey({ columns: [t.unitId, t.position] }),
  uniqueIndex('run_counts_name').on(t.unitId, t.name),
  check('run_counts_digits', sql`typeof(${t.value}) = 'text' AND length(${t.value}) BETWEEN 1 AND 30 AND ${t.value} NOT GLOB '*[^0-9]*'`),
  check('run_counts_position_range', sql`${t.position} BETWEEN 0 AND 19`),
]);

export const hypotheses = sqliteTable('hypotheses', {
  unitId: text('unit_id').primaryKey(),
  statement: text('statement').notNull(),
  statementSpans: spans('statement_spans'),
  eliminationScope: text('elimination_scope'),
  eliminationScopeSpans: spans('elimination_scope_spans'),
});

export const correspondences = sqliteTable('correspondences', {
  unitId: text('unit_id').primaryKey(),
  date: text('date').notNull(),
  dateApprox: flag('date_approx'),
  channel: text('channel').notNull().default(''),
  direction: text('direction', { enum: DIRECTIONS }).notNull(),
  content: text('content').notNull().default(''),
  contentSpans: spans('content_spans'),
}, (t) => [oneOf('correspondences_direction_values', t.direction, DIRECTIONS)]);

/** One Consent_Status per External_Party per Correspondence, independent of other Correspondences (R34.1). */
export const correspondenceParties = sqliteTable('correspondence_parties', {
  unitId: text('unit_id').notNull(),
  position: integer('position').notNull(),
  partyKind: text('party_kind', { enum: PARTY_KINDS }).notNull(),
  partyId: text('party_id').notNull(),
  consentStatus: text('consent_status', { enum: CONSENT_STATUSES }),
}, (t) => [
  primaryKey({ columns: [t.unitId, t.position] }),
  uniqueIndex('correspondence_parties_party').on(t.unitId, t.partyKind, t.partyId),
  index('correspondence_parties_by_party').on(t.partyId),
  oneOf('correspondence_parties_kind_values', t.partyKind, PARTY_KINDS),
  oneOf('correspondence_parties_consent_values', t.consentStatus, CONSENT_STATUSES, true),
  check('correspondence_parties_consent_external', sql`(${t.consentStatus} IS NOT NULL) = (${t.partyKind} = 'external')`),
]);

export const archivalRequests = sqliteTable('archival_requests', {
  unitId: text('unit_id').primaryKey(),
  archiveKind: text('archive_kind', { enum: PARTY_KINDS }).notNull(),
  archiveId: text('archive_id').notNull(),
  contactKind: text('contact_kind', { enum: PARTY_KINDS }),
  contactId: text('contact_id'),
  channel: text('channel'),
  requestText: text('request_text').notNull(),
  requestTextSpans: spans('request_text_spans'),
  dateSent: text('date_sent'),
  dateSentApprox: flag('date_sent_approx'),
  replyDate: text('reply_date'),
  replyDateApprox: flag('reply_date_approx'),
  replyContent: text('reply_content'),
  replyContentSpans: spans('reply_content_spans'),
  followUpRemindedAt: text('follow_up_reminded_at'),
}, (t) => [
  oneOf('archival_requests_archive_values', t.archiveKind, PARTY_KINDS),
  oneOf('archival_requests_contact_values', t.contactKind, PARTY_KINDS, true),
  check('archival_requests_contact_pair', sql`(${t.contactKind} IS NULL) = (${t.contactId} IS NULL)`),
  index('archival_requests_archive').on(t.archiveId),
  index('archival_requests_contact').on(t.contactId),
]);

export const topics = sqliteTable('topics', {
  unitId: text('unit_id').primaryKey(),
  body: text('body').notNull(),
  bodySpans: spans('body_spans'),
});

export const replies = sqliteTable('replies', {
  unitId: text('unit_id').primaryKey(),
  text: text('text').notNull(),
  textSpans: spans('text_spans'),
  isGroupNote: flag('is_group_note'),
});

export const attachments = sqliteTable('attachments', {
  unitId: text('unit_id').primaryKey(),
  itemIdentifier: text('item_identifier').notNull(),
  title: text('title').notNull(),
  fileKind: text('file_kind', { enum: FILE_KINDS }).notNull(),
  originalName: text('original_name').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  sizeLabel: text('size_label'),
  sha256: text('sha256').notNull(),
  r2Key: text('r2_key').notNull(),
  caption: text('caption'),
  origin: text('origin').notNull(),
  uploadedAt: text('uploaded_at').notNull(),
  rightsStatusId: text('rights_status_id').notNull(),
  rightsHolder: text('rights_holder'),
  rightsTerms: text('rights_terms'),
  chainId: text('chain_id').notNull(),
  supersedesUnitId: text('supersedes_unit_id'),
}, (t) => [
  uniqueIndex('attachments_identifier').on(t.itemIdentifier),
  // One successor per Attachment keeps each Version_Chain linear (R13.3).
  uniqueIndex('attachments_supersedes').on(t.supersedesUnitId),
  index('attachments_chain').on(t.chainId),
  index('attachments_rights').on(t.rightsStatusId),
  oneOf('attachments_kind_values', t.fileKind, FILE_KINDS),
  check('attachments_size', sql`${t.sizeBytes} >= 0`),
]);

export const dissentNotes = sqliteTable('dissent_notes', {
  unitId: text('unit_id').primaryKey(),
  authorId: text('author_id').notNull(),
  text: text('text').notNull(),
  textSpans: spans('text_spans'),
  attachedAt: text('attached_at').notNull(),
  lastSavedAt: text('last_saved_at').notNull(),
  // The Log_Summary wording the note was written about (R42.7, R42.9).
  concernedSummary: text('concerned_summary').notNull(),
  concernedSummarySpans: spans('concerned_summary_spans'),
}, (t) => [index('dissent_notes_author').on(t.authorId)]);

/** The registry of issued Item_Identifiers; rows are never deleted, so no identifier is reissued (R15.6). */
export const identifiers = sqliteTable('identifiers', {
  identifierLc: text('identifier_lc').primaryKey(),
  identifier: text('identifier').notNull(),
  unitId: text('unit_id').notNull(),
  issuedAt: text('issued_at').notNull(),
}, (t) => [index('identifiers_unit').on(t.unitId)]);

export const deletions = sqliteTable('deletions', {
  unitId: text('unit_id').primaryKey(),
  unitType: text('unit_type', { enum: UNIT_TYPES }).notNull(),
  kind: text('kind', { enum: ITEM_KINDS }),
  itemIdentifier: text('item_identifier'),
  rootId: text('root_id').notNull(),
  projectId: text('project_id').notNull(),
  deletedBy: text('deleted_by').notNull(),
  deletedAt: text('deleted_at').notNull(),
  reason: text('reason').notNull(),
}, (t) => [index('deletions_root').on(t.rootId), index('deletions_project').on(t.projectId, t.deletedAt)]);

export const externalParties = sqliteTable('external_parties', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  nameFold: text('name_fold').notNull(), // case- and diacritic-folded (R9.2)
  doNotName: flag('do_not_name'),
  genericLabel: text('generic_label'),
  createdAt: text('created_at').notNull(),
  ...versioned(),
}, (t) => [
  index('external_parties_fold').on(t.nameFold),
  check('external_parties_label', sql`${t.doNotName} = 0 OR ${t.genericLabel} IS NOT NULL`),
]);

/** The partial unique index over active links is an expression index, so it lives in the raw migration. */
export const crossLinks = sqliteTable('cross_links', {
  id: text('id').primaryKey(),
  originId: text('origin_id').notNull(),
  targetId: text('target_id').notNull(),
  relationValueId: text('relation_value_id'),
  addedBy: text('added_by').notNull(),
  addedAt: text('added_at').notNull(),
  removedBy: text('removed_by'),
  removedAt: text('removed_at'),
}, (t) => [
  index('cross_links_target').on(t.targetId),
  index('cross_links_origin').on(t.originId),
  check('cross_links_not_self', sql`${t.originId} <> ${t.targetId}`),
  check('cross_links_removal_pair', sql`(${t.removedAt} IS NULL) = (${t.removedBy} IS NULL)`),
]);

export const reviewRequests = sqliteTable('review_requests', {
  id: text('id').primaryKey(),
  targetId: text('target_id').notNull(), // an Item, Entry_Section, or other Disclosure_Unit, or a Project for Publication_Requests
  rootId: text('root_id'),
  requesterId: text('requester_id').notNull(),
  note: text('note'),
  createdAt: text('created_at').notNull(),
  state: text('state', { enum: REVIEW_STATES }).notNull().default('needs_review'),
  reviewerId: text('reviewer_id'),
  reviewedAt: text('reviewed_at'),
  reviewNote: text('review_note'),
  isPublicationRequest: flag('is_publication_request'),
  proposal: text('proposal', { mode: 'json' }), // level, Public_Summary, Public_Presentation, Disclosure_Line
  outcome: text('outcome', { enum: REVIEW_OUTCOMES }),
  applied: text('applied', { mode: 'json' }),
  ...versioned(),
}, (t) => [
  index('review_requests_target').on(t.targetId, t.createdAt),
  index('review_requests_root').on(t.rootId),
  index('review_requests_open').on(t.state, t.createdAt),
  oneOf('review_requests_state_values', t.state, REVIEW_STATES),
  oneOf('review_requests_outcome_values', t.outcome, REVIEW_OUTCOMES, true),
  check('review_requests_reviewed', sql`(${t.state} = 'reviewed') = (${t.reviewedAt} IS NOT NULL AND ${t.reviewerId} IS NOT NULL)`),
  check('review_requests_outcome_publication', sql`${t.outcome} IS NULL OR (${t.isPublicationRequest} = 1 AND ${t.state} = 'reviewed')`),
  check('review_requests_proposal', sql`(${t.isPublicationRequest} = 1) = (${t.proposal} IS NOT NULL)`),
]);

export const reviewAddressees = sqliteTable('review_addressees', {
  requestId: text('request_id').notNull(),
  addresseeType: text('addressee_type', { enum: ADDRESSEE_TYPES }).notNull(),
  addresseeId: text('addressee_id').notNull(),
}, (t) => [
  primaryKey({ columns: [t.requestId, t.addresseeType, t.addresseeId] }),
  index('review_addressees_by').on(t.addresseeType, t.addresseeId),
  oneOf('review_addressees_type_values', t.addresseeType, ADDRESSEE_TYPES),
]);
