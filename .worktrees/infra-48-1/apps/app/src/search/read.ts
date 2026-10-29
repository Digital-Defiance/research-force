import { resolveStoredRows } from '../records/field-values';
import type { Span } from '@researchforce/domain/richtext';
import type { CreditEntry, ItemKind, Level, ULID } from '@researchforce/domain/types';
import { Body, creditMembers, creditWords } from './documents';
import type { SearchDoc } from './documents';

type Row = Record<string, unknown>;
const text = (row: Row | undefined, key: string): string | null => {
  const value = row?.[key];
  return typeof value === 'string' ? value : null;
};

/** A party's name by kind and id, as a SQL expression over columns `kind` and `id` (Members by display name). */
const partyName = (kind: string, id: string): string =>
  `CASE ${kind} WHEN 'member' THEN (SELECT display_name FROM profiles WHERE member_id = ${id}) ELSE (SELECT name FROM external_parties WHERE id = ${id}) END`;

interface UnitRow {
  id: ULID; type: string; parentId: ULID | null; position: number; createdAt: string; level: Level; withdrawnAt: string | null;
  credit: string; completed: number; projectId: ULID;
}

/**
 * Every document of the Research_Item `rootId`: its own, one for each Entry_Section, Reply, Attachment, and Dissent_Note, read from
 * rf-core as they stand now. Permanently deleted units have no document, and a root that no longer exists has none at all (R21.1, R21.6).
 */
export async function readRootDocuments(db: D1Database, rootId: ULID): Promise<SearchDoc[]> {
  const one = (sqlText: string) => db.prepare(sqlText).bind(rootId);
  const [units, item, journal, finding, source, run, runCounts, hypothesis, correspondence, parties, archival, topic, sections, replies, attachments, dissent] = await db.batch<Row>([
    one(`SELECT u.id, u.unit_type AS type, u.parent_id AS parentId, u.position, u.created_at AS createdAt, u.disclosure_level AS level, u.withdrawn_at AS withdrawnAt,
        u.credit, (s.completed_at IS NOT NULL) AS completed, u.project_id AS projectId
      FROM units u JOIN submissions s ON s.id = u.submission_id
      WHERE u.root_id = ?1 AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = u.id)`),
    one('SELECT * FROM research_items WHERE unit_id = ?1'),
    one('SELECT * FROM journal_entries WHERE unit_id = ?1'),
    one('SELECT * FROM findings WHERE unit_id = ?1'),
    one(`SELECT *, ${partyName('recoverer_kind', 'recoverer_id')} AS recovererName FROM sources WHERE unit_id = ?1`),
    one('SELECT * FROM runs WHERE unit_id = ?1'),
    one('SELECT name FROM run_counts WHERE unit_id = ?1 ORDER BY position'),
    one('SELECT * FROM hypotheses WHERE unit_id = ?1'),
    one('SELECT * FROM correspondences WHERE unit_id = ?1'),
    one(`SELECT ${partyName('party_kind', 'party_id')} AS name FROM correspondence_parties WHERE unit_id = ?1 ORDER BY position`),
    one(`SELECT *, ${partyName('archive_kind', 'archive_id')} AS archiveName, ${partyName('contact_kind', 'contact_id')} AS contactName FROM archival_requests WHERE unit_id = ?1`),
    one('SELECT * FROM topics WHERE unit_id = ?1'),
    one(`SELECT e.unit_id AS id, e.text, e.text_spans AS spans FROM entry_sections e JOIN units u ON u.id = e.unit_id WHERE u.root_id = ?1`),
    one(`SELECT r.unit_id AS id, r.text, r.text_spans AS spans FROM replies r JOIN units u ON u.id = r.unit_id WHERE u.root_id = ?1`),
    one(`SELECT a.unit_id AS id, a.title, a.item_identifier AS identifier, a.caption, a.origin, a.original_name AS fileName,
        EXISTS (SELECT 1 FROM attachments n WHERE n.supersedes_unit_id = a.unit_id) AS superseded
      FROM attachments a JOIN units u ON u.id = a.unit_id WHERE u.root_id = ?1`),
    one(`SELECT d.unit_id AS id, d.text, d.text_spans AS spans FROM dissent_notes d JOIN units u ON u.id = d.unit_id WHERE u.root_id = ?1`),
  ]);
  await resolveStoredRows(db, [item, finding, source, run, hypothesis, correspondence, archival, topic, sections, replies, dissent].flatMap((r) => r?.results ?? []));
  const unitRows = (units!.results as unknown as UnitRow[]);
  const root = unitRows.find((unit) => unit.id === rootId);
  const rootItem = item!.results[0];
  if (root === undefined || rootItem === undefined) return [];

  const credits = new Map<string, CreditEntry[]>(unitRows.map((unit) => [unit.id, JSON.parse(unit.credit) as CreditEntry[]]));
  const members = [...new Set([...credits.values()].flatMap(creditMembers))];
  const named = members.length === 0 ? [] : (await db.prepare('SELECT member_id AS id, display_name AS name FROM profiles WHERE member_id IN (SELECT value FROM json_each(?1))')
    .bind(JSON.stringify(members)).all<{ id: string; name: string }>()).results;
  const names = new Map(named.map((row) => [row.id, row.name]));

  const kind = text(rootItem, 'kind') as ItemKind;
  const base = { rootId, rootKind: kind };
  const docs: SearchDoc[] = [];
  const byId = <T extends Row>(result: D1Result<Row>): Map<string, T> => new Map(result.results.map((row) => [row['id'] as string, row as T]));
  const unitOf = new Map(unitRows.map((unit) => [unit.id, unit]));

  // The Research_Item: identifier, Credit, summaries, and every free-text and name field of its kind.
  const body = new Body();
  body.plain(text(rootItem, 'item_identifier')).plain(creditWords(credits.get(rootId)!, names).join(' '));
  body.rich(text(rootItem, 'public_summary'), rootItem['public_summary_spans'] as string | readonly Span[]).rich(text(rootItem, 'log_summary'), rootItem['log_summary_spans'] as string | readonly Span[]);
  const rich = (row: Row | undefined, field: string) => body.rich(text(row, field), row?.[`${field}_spans`] as string | readonly Span[] | undefined);
  const finding0 = finding!.results[0];
  rich(finding0, 'claim'); rich(finding0, 'scope_caveat');
  body.plain(text(journal!.results[0], 'heading_text'));
  const source0 = source!.results[0];
  body.plain(text(source0, 'archive_or_collection')).plain(text(source0, 'archival_reference')).plain(text(source0, 'recovererName'));
  rich(source0, 'reliability_note');
  body.plain(text(source0, 'rights_holder')).plain(text(source0, 'rights_terms'));
  const run0 = run!.results[0];
  rich(run0, 'scope'); rich(run0, 'parameters');
  body.plain(text(run0, 'tool_name')).plain(text(run0, 'tool_version')).plain(text(run0, 'compute_resource')).plain(text(run0, 'resume_point'));
  rich(run0, 'notes');
  for (const count of runCounts!.results) body.plain(text(count, 'name'));
  const hypothesis0 = hypothesis!.results[0];
  rich(hypothesis0, 'statement'); rich(hypothesis0, 'elimination_scope');
  const correspondence0 = correspondence!.results[0];
  body.plain(text(correspondence0, 'channel'));
  rich(correspondence0, 'content');
  for (const party of parties!.results) body.plain(text(party, 'name'));
  const archival0 = archival!.results[0];
  body.plain(text(archival0, 'archiveName')).plain(text(archival0, 'contactName')).plain(text(archival0, 'channel'));
  rich(archival0, 'request_text'); rich(archival0, 'reply_content');
  rich(topic!.results[0], 'body');
  const superseded = finding0 !== undefined && finding0['superseded_by_id'] !== null && finding0['superseded_by_id'] !== undefined;
  docs.push({
    ...base, unitId: rootId, resultUnitId: rootId, projectId: root.projectId, unitType: 'research_item', level: root.level, createdAt: root.createdAt,
    completed: root.completed === 1, withdrawn: root.withdrawnAt !== null, superseded, title: text(rootItem, 'title') ?? '', body: body.text, spans: body.spans,
    credits: creditMembers(credits.get(rootId)!),
  });

  // Entry_Sections take the Credit and creation time of their Journal_Entry (R21.5).
  const own = (id: string) => unitOf.get(id as ULID);
  const child = (id: string, type: string, parts: { title?: string; body: Body; superseded?: boolean }, owner: UnitRow, creditOf: ULID): void => {
    docs.push({
      ...base, unitId: id as ULID, resultUnitId: type === 'dissent_note' ? rootId : id as ULID, projectId: owner.projectId, unitType: type, level: owner.level,
      createdAt: type === 'entry_section' ? root.createdAt : owner.createdAt, completed: owner.completed === 1, withdrawn: owner.withdrawnAt !== null,
      superseded: parts.superseded ?? false, title: parts.title ?? '', body: parts.body.text, spans: parts.body.spans, credits: creditMembers(credits.get(creditOf)!),
    });
  };
  for (const [id, row] of byId<{ id: string; text: string; spans: string }>(sections!)) {
    const unit = own(id); if (unit) child(id, 'entry_section', { body: new Body().rich(row.text, row.spans) }, unit, rootId);
  }
  for (const [id, row] of byId<{ id: string; text: string; spans: string }>(replies!)) {
    const unit = own(id); if (unit) child(id, 'reply', { body: new Body().rich(row.text, row.spans) }, unit, id as ULID);
  }
  for (const [id, row] of byId<{ id: string; title: string; identifier: string; caption: string | null; origin: string; fileName: string; superseded: number }>(attachments!)) {
    const unit = own(id);
    if (unit) child(id, 'attachment', { title: row.title, body: new Body().plain(row.identifier).plain(row.caption).plain(row.origin).plain(row.fileName), superseded: row.superseded === 1 }, unit, id as ULID);
  }
  for (const [id, row] of byId<{ id: string; text: string; spans: string }>(dissent!)) {
    const unit = own(id); if (unit) child(id, 'dissent_note', { body: new Body().rich(row.text, row.spans) }, unit, id as ULID);
  }
  return docs;
}

/** The Research_Items whose units belong to a Submission, for the event that completes it. */
export async function rootsOfSubmission(db: D1Database, submissionId: string): Promise<ULID[]> {
  const { results } = await db.prepare('SELECT DISTINCT root_id AS id FROM units WHERE submission_id = ?1').bind(submissionId).all<{ id: ULID }>();
  return results.map((row) => row.id);
}

/** The Research_Item a unit belongs to, whether or not the unit still exists (a deleted unit's root is kept in `deletions`). */
export async function rootOfUnit(db: D1Database, unitId: string): Promise<ULID | null> {
  const row = await db.prepare('SELECT root_id AS id FROM units WHERE id = ?1 UNION ALL SELECT root_id FROM deletions WHERE unit_id = ?1 LIMIT 1').bind(unitId).first<{ id: ULID }>();
  return row?.id ?? null;
}
