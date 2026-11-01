import type { Span } from '@researchforce/domain/richtext';
import type {
  ConsentStatus, CreditEntry, DateRange, DisclosureLine, DocumentDate, Level, MemberStatus, PartialDate,
  PublicPresentation, Timestamp, ULID,
} from '@researchforce/domain/types';
import type {
  AttachmentRecord, CorrespondenceParty, CrossLinkRecord, ExternalPartyRecord, KindRecord, MemberRecord, PartyRef,
  ProjectRecord, ProjectionInput, ResearchItemRecord, UnitRecord, ValueRecord,
} from '@researchforce/kernel/input';
import type { ConsentRow, ConsentValues, HoldCoverage, HoldRef } from '@researchforce/kernel/consent';
import type { ConsentState } from '@researchforce/kernel/preview';
import { unitKey } from '@researchforce/kernel/views';
import type { UnitKey } from '@researchforce/kernel/views';
import type { RequestAccountant } from '@researchforce/db/accountant';
import { resolveStoredRows } from './records/field-values';

/**
 * The only code that turns `rf-core` rows into kernel input. It reads a set of Root_Items and everything under them,
 * then assembles the `ProjectionInput` the kernel reads: Projects, units of every kind with their fields, Members and
 * their registered addresses and Licence_Agreements, External_Parties with Do_Not_Name and Generic_Label, configurable
 * values (Rights_Status publication marks), Consent_Status on Correspondence Parties, Cross_Link neighbours, and the
 * `restricted` flag from `research_items.access_level` (R23, R24, R33, R34, R46, R47.9). Large RichText fields are
 * hydrated from the Field_Version store; identities and ids are opaque to the kernel.
 */

const rich = (text: string | null, spans: string | null): { text: string; spans: Span[] } | undefined =>
  text === null ? undefined : { text, spans: spans ? (JSON.parse(spans) as Span[]) : [] };
const storedDate = (value: string | null, approx: number | null): PartialDate | undefined =>
  value === null ? undefined : { value, approx: approx === 1 };
const partyRef = (kind: string | null, id: string | null): PartyRef | undefined =>
  kind === null || id === null ? undefined : { kind: kind as PartyRef['kind'], id };
const flag = (value: number | null): boolean => value === 1;

interface ProjectRow {
  id: ULID; name: string; description: string; slug: string; accent: string | null;
  level: Level; disclosureLine: string | null;
}
interface UnitRow {
  id: ULID; unitType: UnitRecord['type']; projectId: ULID; rootId: ULID; parentId: string | null; position: number;
  ownerId: ULID; credit: string; createdAt: Timestamp; level: Level; classification: string | null;
  disclosureLine: string | null; withdrawnAt: string | null; withdrawalReason: string | null;
}
interface ResearchItemRow {
  unit_id: ULID; kind: KindRecord['kind']; item_identifier: string; project_id: ULID; title: string;
  status_value_id: string | null; public_presentation: PublicPresentation;
  public_summary: string | null; public_summary_spans: string | null; log_summary: string | null; log_summary_spans: string | null;
  first_public_at: string | null; access_level: 'whole_team' | 'restricted';
}
interface AttachmentRow {
  unit_id: ULID; item_identifier: string; title: string; file_kind: AttachmentRecord['fileKind']; size_bytes: number; caption: string | null;
  origin: string; uploaded_at: Timestamp; rights_status_id: string; rights_holder: string | null; rights_terms: string | null; supersedes_unit_id: string | null;
}
interface EntrySectionRow { unit_id: ULID; text: string; text_spans: string | null }
interface ReplyRow { unit_id: ULID; text: string; text_spans: string | null; is_group_note: number }
interface DissentRow { unit_id: ULID; author_id: ULID; text: string; text_spans: string | null; attached_at: Timestamp; last_saved_at: Timestamp; concerned_summary: string; concerned_summary_spans: string | null }
interface JournalRow { unit_id: ULID; phase_id: string | null; start_date: string | null; start_date_approx: number; end_date: string | null; end_date_approx: number }
interface FindingRow { unit_id: ULID; claim: string; claim_spans: string | null; scope_caveat: string; scope_caveat_spans: string | null; superseded_by_id: string | null }
interface SourceRow {
  unit_id: ULID; source_kind: 'primary' | 'secondary'; reliability_id: string; doc_date: string | null; doc_date_approx: number; doc_date_end: string | null; doc_date_end_approx: number;
  archive_or_collection: string | null; archival_reference: string | null; recoverer_kind: string | null; recoverer_id: string | null; reliability_note: string | null; reliability_note_spans: string | null;
  rights_status_id: string; rights_holder: string | null; rights_terms: string | null;
}
interface RunRow {
  unit_id: ULID; scope: string; scope_spans: string | null; parameters: string; parameters_spans: string | null; tool_name: string; tool_version: string;
  compute_resource: string; start_time: string; end_time: string | null; outcome_id: string; resume_point: string | null; notes: string | null; notes_spans: string | null;
}
interface RunCountRow { unit_id: ULID; name: string; value: string }
interface HypothesisRow { unit_id: ULID; statement: string; statement_spans: string | null; elimination_scope: string | null; elimination_scope_spans: string | null }
interface CorrespondenceRow { unit_id: ULID; date: string; date_approx: number; channel: string; direction: 'sent' | 'received'; content: string; content_spans: string | null }
interface CorrespondencePartyRow { unit_id: ULID; party_kind: 'member' | 'external'; party_id: string; consent_status: ConsentStatus | null }
interface ArchivalRow {
  unit_id: ULID; archive_kind: string; archive_id: string; contact_kind: string | null; contact_id: string | null; channel: string | null;
  request_text: string; request_text_spans: string | null; date_sent: string | null; date_sent_approx: number; reply_date: string | null; reply_date_approx: number;
  reply_content: string | null; reply_content_spans: string | null;
}
interface TopicRow { unit_id: ULID; body: string; body_spans: string | null }
interface QuestionRow { unit_id: ULID; question: string; introduction: string | null; introduction_spans: string | null; investigation_state: string }
interface JeMemberRow { unit_id: ULID; member_id: ULID }
interface MemberRow { id: ULID; display_name: string | null; email: string; status: MemberStatus; public_profile: number | null; licence_name: string | null }
interface PartyRow { id: ULID; name: string; do_not_name: number; generic_label: string | null }
interface ValueRow { id: ULID; name: string; permits_publication: number | null }
interface LinkRow { id: ULID; origin_id: ULID; target_id: ULID; relation_value_id: string | null }

const map = <T extends { unit_id: ULID }>(rows: readonly T[]): Map<ULID, T> => new Map(rows.map((row) => [row.unit_id, row]));
const group = <T extends { unit_id: ULID }>(rows: readonly T[]): Map<ULID, T[]> => {
  const grouped = new Map<ULID, T[]>();
  for (const row of rows) grouped.set(row.unit_id, [...(grouped.get(row.unit_id) ?? []), row]);
  return grouped;
};

function docDate(start: PartialDate | undefined, end: PartialDate | undefined): DocumentDate | undefined {
  return start && end ? ({ start, end } satisfies DateRange) : start;
}

/** Build one Research_Item's kind-specific record from its detail rows. */
function kindRecord(row: ResearchItemRow, detail: Detail): KindRecord {
  switch (row.kind) {
    case 'journal_entry': {
      const je = detail.journal.get(row.unit_id);
      const related = detail.jeMembers.get(row.unit_id)?.map((m) => m.member_id);
      return {
        kind: 'journal_entry',
        ...(je?.phase_id ? { phaseId: je.phase_id } : {}),
        ...(je ? spread('startDate', storedDate(je.start_date, je.start_date_approx)) : {}),
        ...(je ? spread('endDate', storedDate(je.end_date, je.end_date_approx)) : {}),
        ...(related?.length ? { relatedMemberIds: related } : {}),
      };
    }
    case 'finding': {
      const finding = detail.findings.get(row.unit_id)!;
      return {
        kind: 'finding', statusValueId: row.status_value_id ?? '', claim: rich(finding.claim, finding.claim_spans) ?? EMPTY,
        scopeCaveat: rich(finding.scope_caveat, finding.scope_caveat_spans) ?? EMPTY,
        ...(finding.superseded_by_id ? { supersededById: finding.superseded_by_id } : {}),
      };
    }
    case 'source': {
      const source = detail.sources.get(row.unit_id)!;
      const documentDate = docDate(storedDate(source.doc_date, source.doc_date_approx), storedDate(source.doc_date_end, source.doc_date_end_approx));
      return {
        kind: 'source', sourceKind: source.source_kind, reliabilityId: source.reliability_id,
        ...spread('documentDate', documentDate),
        ...(source.archive_or_collection ? { archiveOrCollection: source.archive_or_collection } : {}),
        ...(source.archival_reference ? { archivalReference: source.archival_reference } : {}),
        ...spread('recoverer', partyRef(source.recoverer_kind, source.recoverer_id)),
        ...spread('reliabilityNote', rich(source.reliability_note, source.reliability_note_spans)),
        rightsStatusId: source.rights_status_id,
        ...(source.rights_holder ? { rightsHolder: source.rights_holder } : {}),
        ...(source.rights_terms ? { rightsTerms: source.rights_terms } : {}),
      };
    }
    case 'run': {
      const run = detail.runs.get(row.unit_id)!;
      const counts = detail.runCounts.get(row.unit_id)?.map((count) => ({ name: count.name, value: count.value }));
      return {
        kind: 'run', scope: rich(run.scope, run.scope_spans) ?? EMPTY, parameters: rich(run.parameters, run.parameters_spans) ?? EMPTY,
        toolName: run.tool_name, toolVersion: run.tool_version, computeResource: run.compute_resource, startTime: run.start_time,
        ...(run.end_time ? { endTime: run.end_time } : {}), outcomeId: run.outcome_id,
        ...(run.resume_point ? { resumePoint: run.resume_point } : {}),
        ...spread('notes', rich(run.notes, run.notes_spans)),
        ...(counts?.length ? { counts } : {}),
      };
    }
    case 'hypothesis': {
      const hypothesis = detail.hypotheses.get(row.unit_id)!;
      return {
        kind: 'hypothesis', statusValueId: row.status_value_id ?? '', statement: rich(hypothesis.statement, hypothesis.statement_spans) ?? EMPTY,
        ...spread('eliminationScope', rich(hypothesis.elimination_scope, hypothesis.elimination_scope_spans)),
      };
    }
    case 'correspondence': {
      const correspondence = detail.correspondences.get(row.unit_id)!;
      const parties = (detail.correspondenceParties.get(row.unit_id) ?? []).map((party): CorrespondenceParty =>
        party.party_kind === 'member'
          ? { kind: 'member', id: party.party_id }
          : { kind: 'external', id: party.party_id, consent: party.consent_status ?? 'not_asked' });
      return {
        kind: 'correspondence', date: storedDate(correspondence.date, correspondence.date_approx)!, channel: correspondence.channel,
        direction: correspondence.direction, content: rich(correspondence.content, correspondence.content_spans) ?? EMPTY, parties,
      };
    }
    case 'archival_request': {
      const archival = detail.archival.get(row.unit_id)!;
      return {
        kind: 'archival_request', archiveOrDesk: partyRef(archival.archive_kind, archival.archive_id)!,
        ...spread('contact', partyRef(archival.contact_kind, archival.contact_id)),
        ...(archival.channel ? { channel: archival.channel } : {}),
        requestText: rich(archival.request_text, archival.request_text_spans) ?? EMPTY, statusValueId: row.status_value_id ?? '',
        ...spread('dateSent', storedDate(archival.date_sent, archival.date_sent_approx)),
        ...spread('replyDate', storedDate(archival.reply_date, archival.reply_date_approx)),
        ...spread('replyContent', rich(archival.reply_content, archival.reply_content_spans)),
      };
    }
    case 'topic': {
      const topic = detail.topics.get(row.unit_id)!;
      return { kind: 'topic', body: rich(topic.body, topic.body_spans) ?? EMPTY };
    }
    case 'research_question': {
      const question = detail.questions.get(row.unit_id)!;
      return {
        kind: 'research_question', question: question.question,
        ...spread('introduction', rich(question.introduction, question.introduction_spans)),
        ...(question.investigation_state ? { investigationState: question.investigation_state } : {}),
      };
    }
  }
}

const EMPTY = { text: '', spans: [] as Span[] };
/** Omit a key whose value is undefined, so optional record fields stay absent rather than explicitly undefined. */
function spread<K extends string, V>(key: K, value: V | undefined): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

interface Detail {
  readonly journal: Map<ULID, JournalRow>;
  readonly jeMembers: Map<ULID, JeMemberRow[]>;
  readonly findings: Map<ULID, FindingRow>;
  readonly sources: Map<ULID, SourceRow>;
  readonly runs: Map<ULID, RunRow>;
  readonly runCounts: Map<ULID, RunCountRow[]>;
  readonly hypotheses: Map<ULID, HypothesisRow>;
  readonly correspondences: Map<ULID, CorrespondenceRow>;
  readonly correspondenceParties: Map<ULID, CorrespondencePartyRow[]>;
  readonly archival: Map<ULID, ArchivalRow>;
  readonly topics: Map<ULID, TopicRow>;
  readonly questions: Map<ULID, QuestionRow>;
}

function unitRecord(row: UnitRow, items: Map<ULID, ResearchItemRow>, attachments: Map<ULID, AttachmentRow>, sections: Map<ULID, EntrySectionRow>, replies: Map<ULID, ReplyRow>, dissent: Map<ULID, DissentRow>, detail: Detail): UnitRecord | undefined {
  const base = {
    id: row.id, ...(row.parentId === null ? {} : { parentId: row.parentId }), position: row.position, ownerId: row.ownerId,
    credit: JSON.parse(row.credit) as CreditEntry[], createdAt: row.createdAt, level: row.level, unclassified: row.classification === 'unclassified',
    ...spread('disclosureLine', row.disclosureLine ? (JSON.parse(row.disclosureLine) as DisclosureLine) : undefined),
    ...(row.withdrawnAt === null ? {} : { withdrawal: { at: row.withdrawnAt as Timestamp, reason: row.withdrawalReason ?? '' } }),
  } as const;
  switch (row.unitType) {
    case 'research_item': {
      const item = items.get(row.id);
      if (!item) return undefined;
      return { ...base, type: 'research_item', item: { ...kindRecord(item, detail), ...sharedItem(item) } as ResearchItemRecord };
    }
    case 'attachment': {
      const file = attachments.get(row.id);
      if (!file) return undefined;
      const attachment: AttachmentRecord = {
        identifier: file.item_identifier, title: file.title, fileKind: file.file_kind, sizeBytes: file.size_bytes,
        ...(file.caption === null ? {} : { caption: file.caption }), origin: file.origin, uploadedAt: file.uploaded_at,
        rightsStatusId: file.rights_status_id, ...(file.rights_holder ? { rightsHolder: file.rights_holder } : {}),
        ...(file.rights_terms ? { rightsTerms: file.rights_terms } : {}), ...(file.supersedes_unit_id ? { supersedesId: file.supersedes_unit_id } : {}),
      };
      return { ...base, type: 'attachment', attachment };
    }
    case 'entry_section': {
      const section = sections.get(row.id);
      return section ? { ...base, type: 'entry_section', text: rich(section.text, section.text_spans) ?? EMPTY } : undefined;
    }
    case 'reply': {
      const reply = replies.get(row.id);
      return reply ? { ...base, type: 'reply', text: rich(reply.text, reply.text_spans) ?? EMPTY, isGroupNote: flag(reply.is_group_note) } : undefined;
    }
    case 'dissent_note': {
      const note = dissent.get(row.id);
      return note
        ? {
          ...base, type: 'dissent_note', text: rich(note.text, note.text_spans) ?? EMPTY, authorId: note.author_id, attachedAt: note.attached_at,
          lastSavedAt: note.last_saved_at, concernedSummary: rich(note.concerned_summary, note.concerned_summary_spans) ?? EMPTY,
        }
        : undefined;
    }
    default: return undefined;
  }
}

/** The fields the kernel reads from the shared `research_items` columns, independent of the kind-specific record. */
function sharedItem(row: ResearchItemRow): Partial<ResearchItemRecord> {
  const summary = rich(row.public_summary, row.public_summary_spans);
  const logSummary = rich(row.log_summary, row.log_summary_spans);
  return {
    projectId: row.project_id, identifier: row.item_identifier, title: row.title, presentation: row.public_presentation,
    ...(summary ? { publicSummary: summary } : {}), ...(logSummary ? { logSummary } : {}),
    ...(row.first_public_at === null ? {} : { firstPublicAt: row.first_public_at as Timestamp }),
    ...(row.access_level === 'restricted' ? { restricted: true } : {}),
  };
}

/** The dependency rows a change's preview token is bound to: every unit under the loaded roots, the roots' Projects, and the External_Parties and Members a view may name. */
export interface Dependency { readonly table: string; readonly id: string; readonly updatedSeq: number }

export interface LoadedInput {
  readonly input: ProjectionInput;
  /** Every loaded row with its `updated_seq`, so a preview token can detect a later change (R23.14). */
  readonly dependencies: readonly Dependency[];
  /**
   * The consent, Confidentiality_Hold, and dependency data the Owner-consent and hold gates read, present
   * when `withConsent` is set (R23.17, R48.2, R48.4). Absent for projection-only loads such as the Publisher.
   */
  readonly consent?: ConsentState;
}

interface ConsentRowRaw {
  id: ULID; unit_id: ULID; member_id: ULID; values_json: string;
  approved_view_hash: string; dependency_manifest_hash: string; withdrawn_at: string | null; used_at: string | null;
}
interface HoldRowRaw { id: ULID; unit_id: ULID; member_id: ULID; note: string; placed_at: string }

const dialectEach = (ids: readonly string[]): string => JSON.stringify([...new Set(ids)]);

/**
 * Load the kernel input for a set of Root_Items (Research_Items) and everything under them. The caller supplies the
 * roots a change set touches, including linked neighbours. Projects are the roots' Projects plus any Project named in
 * a Project-level change. Returns the input and the dependency rows, each with its `updated_seq`.
 */
export async function loadProjectionInput(
  db: D1Database,
  roots: readonly string[],
  now: Timestamp,
  options: { readonly projectIds?: readonly string[]; readonly track?: RequestAccountant['track']; readonly withConsent?: boolean } = {},
): Promise<LoadedInput> {
  const track: RequestAccountant['track'] = options.track ?? ((promise) => promise);
  const rootJson = dialectEach(roots);
  const extraProjects = dialectEach(options.projectIds ?? []);

  // Every unit under the roots, with its kind detail rows, plus the Cross_Link neighbours those units touch.
  const [unitRows, itemRows, attachmentRows, sectionRows, replyRows, dissentRows] = await track(db.batch([
    db.prepare(`SELECT id, unit_type AS unitType, project_id AS projectId, root_id AS rootId, parent_id AS parentId, position, owner_id AS ownerId,
        credit, created_at AS createdAt, disclosure_level AS level, classification_state AS classification, disclosure_line AS disclosureLine,
        withdrawn_at AS withdrawnAt, withdrawal_reason AS withdrawalReason, updated_seq AS updatedSeq
      FROM units WHERE root_id IN (SELECT value FROM json_each(?1)) AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = units.id)`).bind(rootJson),
    db.prepare(`SELECT unit_id, kind, item_identifier, project_id, title, status_value_id, public_presentation, public_summary, public_summary_spans,
        log_summary, log_summary_spans, first_public_at, access_level FROM research_items WHERE unit_id IN (SELECT value FROM json_each(?1))`).bind(rootJson),
    db.prepare(`SELECT unit_id, item_identifier, title, file_kind, size_bytes, caption, origin, uploaded_at, rights_status_id, rights_holder, rights_terms, supersedes_unit_id
      FROM attachments WHERE unit_id IN (SELECT id FROM units WHERE root_id IN (SELECT value FROM json_each(?1)))`).bind(rootJson),
    db.prepare('SELECT unit_id, text, text_spans FROM entry_sections WHERE unit_id IN (SELECT id FROM units WHERE root_id IN (SELECT value FROM json_each(?1)))').bind(rootJson),
    db.prepare('SELECT unit_id, text, text_spans, is_group_note FROM replies WHERE unit_id IN (SELECT id FROM units WHERE root_id IN (SELECT value FROM json_each(?1)))').bind(rootJson),
    db.prepare('SELECT unit_id, author_id, text, text_spans, attached_at, last_saved_at, concerned_summary, concerned_summary_spans FROM dissent_notes WHERE unit_id IN (SELECT id FROM units WHERE root_id IN (SELECT value FROM json_each(?1)))').bind(rootJson),
  ]));

  const [journalRows, jeMemberRows, findingRows, sourceRows, runRows, runCountRows, hypothesisRows, correspondenceRows, correspondencePartyRows, archivalRows, topicRows, questionRows] = await track(db.batch([
    db.prepare('SELECT unit_id, phase_id, start_date, start_date_approx, end_date, end_date_approx FROM journal_entries WHERE unit_id IN (SELECT value FROM json_each(?1))').bind(rootJson),
    db.prepare('SELECT unit_id, member_id FROM je_members WHERE unit_id IN (SELECT value FROM json_each(?1)) ORDER BY position').bind(rootJson),
    db.prepare('SELECT unit_id, claim, claim_spans, scope_caveat, scope_caveat_spans, superseded_by_id FROM findings WHERE unit_id IN (SELECT value FROM json_each(?1))').bind(rootJson),
    db.prepare(`SELECT unit_id, source_kind, reliability_id, doc_date, doc_date_approx, doc_date_end, doc_date_end_approx, archive_or_collection, archival_reference,
        recoverer_kind, recoverer_id, reliability_note, reliability_note_spans, rights_status_id, rights_holder, rights_terms FROM sources WHERE unit_id IN (SELECT value FROM json_each(?1))`).bind(rootJson),
    db.prepare(`SELECT unit_id, scope, scope_spans, parameters, parameters_spans, tool_name, tool_version, compute_resource, start_time, end_time, outcome_id, resume_point, notes, notes_spans
      FROM runs WHERE unit_id IN (SELECT value FROM json_each(?1))`).bind(rootJson),
    db.prepare('SELECT unit_id, name, value FROM run_counts WHERE unit_id IN (SELECT value FROM json_each(?1)) ORDER BY position').bind(rootJson),
    db.prepare('SELECT unit_id, statement, statement_spans, elimination_scope, elimination_scope_spans FROM hypotheses WHERE unit_id IN (SELECT value FROM json_each(?1))').bind(rootJson),
    db.prepare('SELECT unit_id, date, date_approx, channel, direction, content, content_spans FROM correspondences WHERE unit_id IN (SELECT value FROM json_each(?1))').bind(rootJson),
    db.prepare('SELECT unit_id, party_kind, party_id, consent_status FROM correspondence_parties WHERE unit_id IN (SELECT value FROM json_each(?1)) ORDER BY position').bind(rootJson),
    db.prepare(`SELECT unit_id, archive_kind, archive_id, contact_kind, contact_id, channel, request_text, request_text_spans, date_sent, date_sent_approx, reply_date, reply_date_approx, reply_content, reply_content_spans
      FROM archival_requests WHERE unit_id IN (SELECT value FROM json_each(?1))`).bind(rootJson),
    db.prepare('SELECT unit_id, body, body_spans FROM topics WHERE unit_id IN (SELECT value FROM json_each(?1))').bind(rootJson),
    db.prepare('SELECT unit_id, question, introduction, introduction_spans, investigation_state FROM research_questions WHERE unit_id IN (SELECT value FROM json_each(?1))').bind(rootJson),
  ]));

  const units = (unitRows as D1Result<UnitRow & { updatedSeq: number }>).results;
  const unitIds = units.map((unit) => unit.id);
  const unitJson = dialectEach(unitIds);

  const [projectRows, linkRows, memberRows, partyRows, valueRows] = await track(db.batch([
    db.prepare(`SELECT id, name, short_description AS description, slug, accent, disclosure_level AS level, disclosure_line AS disclosureLine, updated_seq AS updatedSeq
      FROM projects WHERE id IN (SELECT DISTINCT root_id FROM units WHERE root_id IN (SELECT value FROM json_each(?1))) OR id IN (SELECT value FROM json_each(?2))
        OR id IN (SELECT project_id FROM research_items WHERE unit_id IN (SELECT value FROM json_each(?1)))`).bind(rootJson, extraProjects),
    db.prepare(`SELECT id, origin_id, target_id, relation_value_id FROM cross_links
      WHERE removed_at IS NULL AND (origin_id IN (SELECT value FROM json_each(?1)) OR target_id IN (SELECT value FROM json_each(?1)))`).bind(unitJson),
    db.prepare('SELECT m.id, p.display_name AS display_name, m.email, m.status, p.public_profile, p.licence_name FROM members m LEFT JOIN profiles p ON p.member_id = m.id'),
    db.prepare('SELECT id, name, do_not_name, generic_label FROM external_parties'),
    db.prepare('SELECT id, name, permits_publication FROM config_values'),
  ]));

  // Link neighbours outside the loaded roots are referenced by the kernel's projection only as their own targets; we
  // include the neighbour units so the projection can render a withheld/link target when the neighbour is loaded.
  const links = (linkRows as D1Result<LinkRow>).results;

  const detail: Detail = {
    journal: map((journalRows as D1Result<JournalRow>).results),
    jeMembers: group((jeMemberRows as D1Result<JeMemberRow>).results),
    findings: map((findingRows as D1Result<FindingRow>).results),
    sources: map((sourceRows as D1Result<SourceRow>).results),
    runs: map((runRows as D1Result<RunRow>).results),
    runCounts: group((runCountRows as D1Result<RunCountRow>).results),
    hypotheses: map((hypothesisRows as D1Result<HypothesisRow>).results),
    correspondences: map((correspondenceRows as D1Result<CorrespondenceRow>).results),
    correspondenceParties: group((correspondencePartyRows as D1Result<CorrespondencePartyRow>).results),
    archival: map((archivalRows as D1Result<ArchivalRow>).results),
    topics: map((topicRows as D1Result<TopicRow>).results),
    questions: map((questionRows as D1Result<QuestionRow>).results),
  };

  // Hydrate the large RichText fields that live in the Field_Version store rather than the inline columns.
  await resolveStoredRows(db, [
    ...(itemRows as D1Result<Record<string, unknown>>).results, ...(sectionRows as D1Result<Record<string, unknown>>).results,
    ...(replyRows as D1Result<Record<string, unknown>>).results, ...(dissentRows as D1Result<Record<string, unknown>>).results,
    ...(findingRows as D1Result<Record<string, unknown>>).results, ...(sourceRows as D1Result<Record<string, unknown>>).results,
    ...(runRows as D1Result<Record<string, unknown>>).results, ...(hypothesisRows as D1Result<Record<string, unknown>>).results,
    ...(correspondenceRows as D1Result<Record<string, unknown>>).results, ...(archivalRows as D1Result<Record<string, unknown>>).results,
    ...(topicRows as D1Result<Record<string, unknown>>).results, ...(questionRows as D1Result<Record<string, unknown>>).results,
  ]);

  const items = map((itemRows as D1Result<ResearchItemRow>).results);
  const attachments = map((attachmentRows as D1Result<AttachmentRow>).results);
  const sections = map((sectionRows as D1Result<EntrySectionRow>).results);
  const replyMap = map((replyRows as D1Result<ReplyRow>).results);
  const dissentMap = map((dissentRows as D1Result<DissentRow>).results);

  const unitRecords = units.flatMap((row): UnitRecord[] => {
    const record = unitRecord(row, items, attachments, sections, replyMap, dissentMap, detail);
    return record ? [record] : [];
  });

  const projectRecords = (projectRows as D1Result<ProjectRow & { updatedSeq: number }>).results.map((row): ProjectRecord => ({
    id: row.id, name: row.name, description: row.description, slug: row.slug, ...(row.accent === null ? {} : { accent: row.accent }),
    level: row.level, ...(row.disclosureLine ? { disclosureLine: JSON.parse(row.disclosureLine) as DisclosureLine } : {}),
  }));

  const members = (memberRows as D1Result<MemberRow>).results.map((row): MemberRecord => ({
    id: row.id, displayName: row.display_name ?? '', email: row.email, status: row.status, publicProfile: flag(row.public_profile),
    ...(row.licence_name ? { licenceName: row.licence_name } : {}),
  }));
  const parties = (partyRows as D1Result<PartyRow>).results.map((row): ExternalPartyRecord => ({
    id: row.id, name: row.name, doNotName: flag(row.do_not_name), ...(row.generic_label === null ? {} : { genericLabel: row.generic_label }),
  }));
  const values = (valueRows as D1Result<ValueRow>).results.map((row): ValueRecord => ({
    id: row.id, name: row.name, ...(row.permits_publication === null ? {} : { permitsPublication: row.permits_publication === 1 }),
  }));
  const crossLinks = links.map((link): CrossLinkRecord => ({
    id: link.id, originId: link.origin_id, targetId: link.target_id, ...(link.relation_value_id === null ? {} : { relationValueId: link.relation_value_id }),
  }));

  const input: ProjectionInput = { now, projects: projectRecords, units: unitRecords, members, parties, values, links: crossLinks };

  const dependencies: Dependency[] = [
    ...units.map((row): Dependency => ({ table: 'units', id: row.id, updatedSeq: row.updatedSeq })),
    ...(projectRows as D1Result<ProjectRow & { updatedSeq: number }>).results.map((row): Dependency => ({ table: 'projects', id: row.id, updatedSeq: row.updatedSeq })),
  ];

  if (options.withConsent !== true) return { input, dependencies };

  const consent = await loadConsentState(db, unitJson, input, dependencies, track);
  return { input, dependencies, consent };
}

/**
 * The Consenting_Member of a unit (requirements "Consenting_Member", R23.17): the Owner of the unit, where
 * the Owner of an Entry_Section is the Owner of its Journal_Entry and the Owner of a Dissent_Note is its
 * author. Projects have no Consenting_Member.
 */
function consentingMemberFor(units: readonly UnitRecord[]): (key: UnitKey) => string | undefined {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const owner = (unit: UnitRecord | undefined): string | undefined => {
    if (!unit) return undefined;
    if (unit.type === 'dissent_note') return unit.authorId;
    if (unit.type === 'entry_section' && unit.parentId !== undefined) return owner(byId.get(unit.parentId)) ?? unit.ownerId;
    return unit.ownerId;
  };
  return (key) => (key.startsWith('u:') ? owner(byId.get(key.slice(2))) : undefined);
}

/**
 * Which loaded units each active Confidentiality_Hold covers (R48.2): the held Item and its whole subtree,
 * found through each unit's Parent chain. A hold placed on a unit covers every loaded unit whose ancestry,
 * through `parent_id` up to the Root_Item, includes the held unit.
 */
function holdCoverage(units: readonly UnitRecord[], holds: readonly HoldRowRaw[]): HoldCoverage[] {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const held = new Map<string, HoldRef[]>();
  for (const hold of holds) held.set(hold.unit_id, [...(held.get(hold.unit_id) ?? []), { id: hold.id, memberId: hold.member_id, placedAt: hold.placed_at, note: hold.note }]);
  if (held.size === 0) return [];
  const coverage = new Map<UnitKey, HoldRef[]>();
  for (const unit of units) {
    const covering: HoldRef[] = [];
    const seen = new Set<string>();
    for (let current: UnitRecord | undefined = unit; current && !seen.has(current.id); current = current.parentId === undefined ? undefined : byId.get(current.parentId)) {
      seen.add(current.id);
      const direct = held.get(current.id);
      if (direct) covering.push(...direct);
    }
    if (covering.length > 0) coverage.set(unitKey(unit.id), covering);
  }
  return [...coverage].map(([key, list]): HoldCoverage => ({ key, holds: list }));
}

/** Load the active holds and live consents for the loaded units and assemble the gate's ConsentState. */
async function loadConsentState(
  db: D1Database,
  unitJson: string,
  input: ProjectionInput,
  dependencies: readonly Dependency[],
  track: RequestAccountant['track'],
): Promise<ConsentState> {
  const [holdRows, consentRows] = await track(db.batch([
    db.prepare(`SELECT id, unit_id, member_id, note, placed_at FROM confidentiality_holds
      WHERE lifted_at IS NULL AND override_id IS NULL AND unit_id IN (SELECT value FROM json_each(?1))`).bind(unitJson),
    db.prepare(`SELECT id, unit_id, member_id, values_json, approved_view_hash, dependency_manifest_hash, withdrawn_at, used_at
      FROM publication_consents WHERE unit_id IN (SELECT value FROM json_each(?1))`).bind(unitJson),
  ]));

  const holds = holdCoverage(input.units, (holdRows as D1Result<HoldRowRaw>).results);
  const consents = (consentRows as D1Result<ConsentRowRaw>).results.map((row): ConsentRow => ({
    id: row.id, unitKey: unitKey(row.unit_id), memberId: row.member_id,
    values: JSON.parse(row.values_json) as ConsentValues,
    viewHash: row.approved_view_hash, dependencyHash: row.dependency_manifest_hash,
    withdrawn: row.withdrawn_at !== null, used: row.used_at !== null,
  }));
  const consentingMember = consentingMemberFor(input.units);
  const snapshotDependencies = dependencies.map((entry) => ({ table: entry.table, id: entry.id, updatedSeq: entry.updatedSeq }));
  return { consentingMember, consents, holds, dependencies: snapshotDependencies };
}
