import { logicalMatchStart, logicalTermExpression } from '@researchforce/domain/logical-search';
import { readLogicalDocument } from './logical';
import type { Context } from 'hono';
import { z } from 'zod';
import { canRead } from '@researchforce/db/access';
import { localDateRangeToUTC } from '@researchforce/domain/dates';
import { labelTextFor } from '@researchforce/domain/label-marks';
import type { CreditEntry, ItemKind, Level, Timestamp, ULID } from '@researchforce/domain/types';
import { ITEM_KINDS, LEVELS, isULID } from '@researchforce/domain/types';
import { validateSearchQuery } from '@researchforce/domain/search-text';
import type { QueryTerm } from '@researchforce/domain/search-text';
import { lessPublic } from '@researchforce/kernel/effective';
import { excerpt } from '@researchforce/search-public/excerpt';
import type { Excerpt, ExcerptRun } from '@researchforce/search-public/excerpt';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import { viewerZone } from '../activity/feed';
import { rowsOf } from '../records/kinds/kind';
import type { DocSpan } from './documents';

/** Results per page (R21.2). */
export const SEARCH_PAGE = 20;
/** The alternatives one query term expands to: "ss" also as "ß" (design "Search_Service"). */
export const MAX_ALTERNATIVES = 16;
/** Candidates read from rf-search at a time while Restricted ones are filtered out. */
const CHUNK = 100;
const MAX_ROUNDS = 40;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Enter a date as YYYY-MM-DD.');

export const searchParams = z.strictObject({
  q: z.string(),
  kind: z.enum(ITEM_KINDS).optional(),
  person: z.string().refine(isULID, 'Choose a Member.').optional(),
  specialty: z.string().refine(isULID, 'Choose a Specialty.').optional(),
  level: z.enum(LEVELS).optional(),
  project: z.string().refine(isULID, 'Choose a Project.').optional(),
  from: day.optional(),
  to: day.optional(),
  after: z.string().regex(/^[12]\.\d{1,19}$/u, 'Use the cursor of the previous page.').optional(),
});
export type SearchParams = z.infer<typeof searchParams>;
const KEYS = ['q', 'kind', 'person', 'specialty', 'level', 'project', 'from', 'to', 'after'] as const;

/** The parameters in a query string, ignoring empty values other than the query itself. */
export function paramsFromQuery(query: Readonly<Record<string, string>>): unknown {
  const params: Record<string, string> = { q: query['q'] ?? '' };
  for (const key of KEYS) if (key !== 'q' && query[key]) params[key] = query[key];
  return params;
}

/** The alternatives of a normalized word: each "ss" kept or written "ß", at most 16 in all (R21.3). */
export function alternatives(word: string): string[] {
  const parts = word.split('ss');
  if (parts.length === 1) return [word];
  const list: string[] = [];
  for (let mask = 0; mask < (1 << (parts.length - 1)) && list.length < MAX_ALTERNATIVES; mask++) {
    list.push(parts.reduce((text, part, index) => text + (index === 0 ? '' : (mask >> (index - 1)) & 1 ? 'ß' : 'ss') + part, ''));
  }
  return [...new Set(list)];
}

const quoted = (text: string): string => `"${text.replaceAll('"', '""')}"`;

/** The FTS5 expression for the terms: every word a `"word"*` prefix, every phrase consecutive whole words, all of them required. */
export function matchExpression(terms: readonly QueryTerm[]): string {
  return terms.map((term) => {
    if (term.kind === 'word') return `(${alternatives(term.value).map((alternative) => `${quoted(alternative)}*`).join(' OR ')})`;
    let phrases = [''];
    for (const word of term.words) phrases = phrases.flatMap((phrase) => alternatives(word).map((alternative) => (phrase === '' ? alternative : `${phrase} ${alternative}`))).slice(0, MAX_ALTERNATIVES);
    return `(${phrases.map(quoted).join(' OR ')})`;
  }).join(' AND ');
}

/** Documents whose own title holds every term (group 1), and the others that match (group 2) (R21.8). */
export const titleExpression = (expression: string): string => `{title} : (${expression})`;
export const restExpression = (expression: string): string => `(${expression}) NOT (${titleExpression(expression)})`;

export interface SearchResult {
  /** The unit the result opens: the document's own, or a Dissent_Note's Research_Item. */
  readonly id: ULID;
  readonly rootId: ULID;
  readonly unitType: string;
  /** The Root_Item's kind. */
  readonly kind: ItemKind;
  /** The result's own title, or the Root_Item's for an Entry_Section, Reply, or Dissent_Note. */
  readonly title: string;
  readonly credit: readonly string[];
  readonly createdAt: Timestamp;
  readonly withdrawn: boolean;
  readonly superseded: boolean;
  readonly level: Level;
  readonly effective: Level;
  readonly restricted: boolean;
  /** The viewer's flag on the Item as it stands when the page is read (R18.10). */
  readonly flag: 'new' | 'updated' | null;
  readonly project: { readonly id: ULID; readonly name: string };
  readonly dissent?: { readonly author: string };
  readonly excerpt: Excerpt;
}
export interface SearchPage { readonly results: readonly SearchResult[]; readonly next: string | null }

interface Candidate { key: number; root: ULID; unit: ULID }

/** The label of each character of a text, as runs cut at the label boundaries (R21.7). */
export function runsOf(text: string, spans: readonly DocSpan[]): ExcerptRun[] {
  const cuts = [...new Set([0, text.length, ...spans.flatMap((span) => [span.s, span.e]).filter((at) => at > 0 && at < text.length)])].sort((a, b) => a - b);
  const runs: ExcerptRun[] = [];
  for (let index = 0; index + 1 < cuts.length; index++) {
    const [from, to] = [cuts[index]!, cuts[index + 1]!];
    const span = spans.find((candidate) => candidate.s <= from && to <= candidate.e);
    runs.push({ text: text.slice(from, to), ...(span === undefined ? {} : { label: { kind: span.k, caption: labelTextFor(span.k, span.source) } }) });
  }
  return runs;
}

const START = '\u0001';
const STOP = '\u0002';
const WINDOW = 600;

/** At most 300 characters around the first match of the stored text, highlighted and labelled (R21.7). */
export function excerptOf(body: string, spans: readonly DocSpan[], snippet: string | null, terms: readonly QueryTerm[], position?: number | null): Excerpt {
  let from = 0;
  let to = body.length;
  if (position !== undefined && position !== null) { from = Math.max(0, position - 100); to = Math.min(body.length, position + WINDOW); }
  else if (snippet !== null && snippet.includes(START)) {
    const plain = snippet.replaceAll(START, '').replaceAll(STOP, '');
    const at = body.indexOf(plain);
    if (at >= 0) { from = Math.max(0, at - WINDOW); to = Math.min(body.length, at + plain.length + WINDOW); }
  } else to = Math.min(body.length, WINDOW);
  // Never begin or end between the halves of a surrogate pair.
  if (from > 0 && /[\uDC00-\uDFFF]/u.test(body[from] ?? '')) from -= 1;
  if (to < body.length && /[\uD800-\uDBFF]/u.test(body[to - 1] ?? '')) to += 1;
  const shifted = spans.filter((span) => span.e > from && span.s < to).map((span) => ({ ...span, s: Math.max(span.s, from) - from, e: Math.min(span.e, to) - from }));
  const result = excerpt(runsOf(body.slice(from, to), shifted), terms);
  return { ...result, cutBefore: result.cutBefore || from > 0, cutAfter: result.cutAfter || to < body.length };
}

interface Filter { readonly sql: string; readonly binds: unknown[] }

/** The conditions on `search_docs` (aliased `d`) that the filters set; binds start at `?${first}` (R21.5). */
function filters(params: SearchParams, range: { start?: Timestamp; endExclusive?: Timestamp }, specialtyHolders: readonly string[] | null, first: number): Filter {
  const binds: unknown[] = [];
  const bind = (value: unknown): string => { binds.push(value); return `?${first + binds.length - 1}`; };
  const where = ['d.completed = 1'];
  if (params.kind !== undefined) where.push(`d.root_kind = ${bind(params.kind)}`);
  if (params.level !== undefined) where.push(`d.disclosure_level = ${bind(params.level)}`);
  if (params.project !== undefined) where.push(`d.project_id = ${bind(params.project)}`);
  if (range.start !== undefined) where.push(`d.created_at >= ${bind(range.start)}`);
  if (range.endExclusive !== undefined) where.push(`d.created_at < ${bind(range.endExclusive)}`);
  if (params.person !== undefined) where.push(`EXISTS (SELECT 1 FROM search_credits c WHERE c.doc_key = d.doc_key AND c.member_id = ${bind(params.person)})`);
  if (specialtyHolders !== null) where.push(`EXISTS (SELECT 1 FROM search_credits c WHERE c.doc_key = d.doc_key AND c.member_id IN (SELECT value FROM json_each(${bind(JSON.stringify(specialtyHolders))})))`);
  return { sql: where.join(' AND '), binds };
}

interface CoreRow {
  documentId: ULID; id: ULID; type: string; rootId: ULID; createdAt: Timestamp; rootCreatedAt: Timestamp; own: Level; withdrawnAt: string | null; credit: string; rootLevel: Level; kind: ItemKind; rootTitle: string;
  access: string; projectId: ULID; projectName: string; projectLevel: Level; ownTitle: string | null; superseded: number; flag: 'new' | 'updated' | null;
}
interface DocRow { key: number; unit: ULID; result: ULID; type: string; level: Level; title: string; body: string; spans: string; titleSnippet: string | null; bodySnippet: string | null }
type Found = Candidate & { readonly group: 1 | 2 };

/** The documents matching in the order of the two groups, readable by the viewer, and the cursor to continue after the last returned. */
async function readableMatches(c: Context<ApiEnv>, params: SearchParams, expression: string, range: { start?: Timestamp; endExclusive?: Timestamp }, holders: readonly string[] | null, terms: readonly QueryTerm[]) {
  const viewer = c.get('session').member.id;
  const accountant = c.get('accountant');
  const filter = filters(params, range, holders, 3);
  const logicalQuery = JSON.stringify({ title: titleExpression(expression), terms: terms.map((term) => ({ title: titleExpression(matchExpression([term])), body: logicalTermExpression(term) })) });
  let group: 1 | 2 = params.after === undefined ? 1 : Number(params.after[0]) as 1 | 2;
  let before: number | null = params.after === undefined ? null : Number(params.after.slice(2));
  const found: Found[] = [];
  let scanned: string | null = null;
  for (let round = 0; round < MAX_ROUNDS && found.length <= SEARCH_PAGE; round++) {
    const match = group === 1 ? titleExpression(expression) : restExpression(expression);
    const condition = group === 1
      ? `EXISTS(SELECT 1 FROM search_fts WHERE rowid=d.doc_key AND search_fts MATCH ?1) AND ?2 IS NOT NULL`
      : `((NOT EXISTS(SELECT 1 FROM logical_search_heads h WHERE h.doc_key=d.doc_key) AND EXISTS(SELECT 1 FROM search_fts WHERE rowid=d.doc_key AND search_fts MATCH ?1))
        OR (EXISTS(SELECT 1 FROM logical_search_heads h WHERE h.doc_key=d.doc_key)
          AND NOT EXISTS(SELECT 1 FROM search_fts WHERE rowid=d.doc_key AND search_fts MATCH json_extract(?2,'$.title'))
          AND NOT EXISTS(SELECT 1 FROM json_each(?2,'$.terms') t WHERE NOT (
            EXISTS(SELECT 1 FROM search_fts WHERE rowid=d.doc_key AND search_fts MATCH (t.value ->> '$.title'))
            OR EXISTS(SELECT 1 FROM logical_search_fts f JOIN logical_search_parts p ON p.id=f.rowid JOIN logical_search_heads h ON h.version_id=p.version_id
              WHERE h.doc_key=d.doc_key AND logical_search_fts MATCH (t.value ->> '$.body'))))))`;
    const rows = rowsOf<Candidate>(await accountant.track(c.env.RF_SEARCH.prepare(
      `SELECT d.doc_key AS key,d.root_id AS root,d.unit_id AS unit FROM search_docs d WHERE ${condition} AND ${filter.sql}${before === null ? '' : ` AND d.doc_key < ?${3 + filter.binds.length}`} ORDER BY d.doc_key DESC LIMIT ${CHUNK}`,
    ).bind(match, logicalQuery, ...filter.binds, ...(before === null ? [] : [before])).all()));
    const roots = [...new Set(rows.map((row) => row.unit))];
    const readable = new Set(roots.length === 0 ? [] : rowsOf<{ id: string }>(await accountant.track(c.env.RF_CORE.prepare(
      `SELECT u.id FROM json_each(?2) j JOIN units u ON u.id=j.value WHERE ${canRead('?1', 'u.root_id')} AND NOT EXISTS(SELECT 1 FROM deletions gone WHERE gone.unit_id=u.id)`,
    ).bind(viewer, JSON.stringify(roots)).all())).map((row) => row.id));
    for (const row of rows) if (readable.has(row.unit)) found.push({ ...row, group });
    if (rows.length < CHUNK) {
      if (group === 2) {
        const page = found.slice(0, SEARCH_PAGE);
        return { found: page, next: found.length > SEARCH_PAGE ? `${page.at(-1)!.group}.${page.at(-1)!.key}` : null as string | null };
      }
      group = 2;
      before = null;
    } else before = rows.at(-1)!.key;
    scanned = `${group}.${before ?? 'x'}`;
  }
  const page = found.slice(0, SEARCH_PAGE);
  const last = page.at(-1);
  if (found.length > SEARCH_PAGE) return { found: page, next: `${last!.group}.${last!.key}` };
  // The rounds ran out before the matches did: continue from where they stopped.
  return { found: page, next: scanned !== null && !scanned.endsWith('.x') ? scanned : null };
}

/**
 * Run a search for the viewer. Matches are filtered with `canRead` on each document's Research_Item before they are counted or paged, so
 * no result, count, or excerpt reveals a Restricted Research_Item (R21.2 to R21.5, R21.8, R47.4).
 */
export async function runSearch(c: Context<ApiEnv>, params: SearchParams): Promise<SearchPage> {
  const dates = {
    ...(params.from === undefined ? {} : { start: { value: params.from, approx: false } }), ...(params.to === undefined ? {} : { end: { value: params.to, approx: false } }),
  };
  const checked = validateSearchQuery(params.q, dates);
  if (!checked.ok) throw new ApiError('validation', { fields: checked.issues.map((issue) => ({ field: issue.field === 'start' ? 'from' : issue.field === 'end' ? 'to' : issue.field, rule: issue.message })) });
  const terms = checked.value;
  const accountant = c.get('accountant');
  const core = c.env.RF_CORE;
  const range = localDateRangeToUTC(dates, await viewerZone(c));
  const holders = params.specialty === undefined ? null
    : rowsOf<{ id: string }>(await accountant.track(core.prepare('SELECT member_id AS id FROM profile_specialties WHERE value_id = ?1').bind(params.specialty).all())).map((row) => row.id);
  const expression = matchExpression(terms);
  const { found, next } = await readableMatches(c, params, expression, range, holders, terms);
  if (found.length === 0) return { results: [], next };

  const keys = JSON.stringify(found.map((row) => row.key));
  const docs = rowsOf<DocRow>(await accountant.track(c.env.RF_SEARCH.prepare(
    `SELECT d.doc_key AS key,d.unit_id AS unit,d.result_unit_id AS result,d.disclosure_level AS level,d.unit_type AS type,d.title,d.body,d.spans,
      (SELECT snippet(search_fts,0,char(1),char(2),'',64) FROM search_fts WHERE rowid=d.doc_key AND search_fts MATCH ?1) AS titleSnippet,
      (SELECT snippet(search_fts,1,char(1),char(2),'',64) FROM search_fts WHERE rowid=d.doc_key AND search_fts MATCH ?1) AS bodySnippet
      FROM search_docs d WHERE d.doc_key IN(SELECT value FROM json_each(?2))`,
  ).bind(expression, keys).all()));
  const byKey = new Map(docs.map((doc) => [doc.key, doc]));
  const units = JSON.stringify([...new Set(docs.map((doc) => doc.unit))]);
  const info = rowsOf<CoreRow>(await accountant.track(core.prepare(
    `SELECT source.id AS documentId,u.id, u.unit_type AS type, u.root_id AS rootId, u.created_at AS createdAt, u.disclosure_level AS own, u.withdrawn_at AS withdrawnAt, u.credit,
        ru.disclosure_level AS rootLevel, ru.created_at AS rootCreatedAt, ri.kind, ri.title AS rootTitle, ri.access_level AS access, pr.id AS projectId, pr.name AS projectName, pr.disclosure_level AS projectLevel,
        a.title AS ownTitle, EXISTS (SELECT 1 FROM attachments n WHERE n.supersedes_unit_id = u.id) AS superseded,
        (SELECT f.flag FROM flags f WHERE f.member_id = ?2 AND f.unit_id = CASE WHEN u.unit_type = 'entry_section' THEN u.root_id ELSE u.id END) AS flag
      FROM json_each(?1) j JOIN units source ON source.id=j.value JOIN units u ON u.id=CASE WHEN source.unit_type='dissent_note' THEN source.root_id ELSE source.id END JOIN units ru ON ru.id = u.root_id JOIN research_items ri ON ri.unit_id = u.root_id
        JOIN projects pr ON pr.id = u.project_id LEFT JOIN attachments a ON a.unit_id = u.id
      WHERE ${canRead('?2', 'source.root_id')} AND NOT EXISTS(SELECT 1 FROM deletions gone WHERE gone.unit_id=source.id OR gone.unit_id=source.root_id)`,
  ).bind(units, c.get('session').member.id).all()));
  const byUnit = new Map(info.map((row) => [row.documentId, row]));
  const dissenters = JSON.stringify(docs.filter((doc) => doc.type === 'dissent_note').map((doc) => doc.unit));
  const authors = new Map(rowsOf<{ id: string; author: string }>(await accountant.track(core.prepare(
    'SELECT dn.unit_id AS id, p.display_name AS author FROM dissent_notes dn JOIN profiles p ON p.member_id = dn.author_id WHERE dn.unit_id IN (SELECT value FROM json_each(?1))',
  ).bind(dissenters).all())).map((row) => [row.id, row.author] as const));
  const creditors = [...new Set(info.flatMap((row) => (JSON.parse(row.credit) as CreditEntry[]).flatMap((entry) => ('member' in entry ? [entry.member] : []))))];
  const names = new Map(creditors.length === 0 ? [] : rowsOf<{ id: string; name: string }>(await accountant.track(core.prepare(
    'SELECT member_id AS id, display_name AS name FROM profiles WHERE member_id IN (SELECT value FROM json_each(?1))',
  ).bind(JSON.stringify(creditors)).all())).map((row) => [row.id, row.name] as const));

  const results: SearchResult[] = [];
  for (const candidate of found) {
    const doc = byKey.get(candidate.key);
    const row = doc === undefined ? undefined : byUnit.get(doc.unit);
    if (doc === undefined || row === undefined) continue; // removed since it was indexed
    const logical = await readLogicalDocument(c.env.RF_SEARCH, doc.key);
    const restricted = row.access === 'restricted';
    const own = doc.level;
    const titleMatched = doc.titleSnippet?.includes('\u0001') === true && doc.bodySnippet?.includes('\u0001') !== true;
    results.push({
      id: row.id, rootId: row.rootId, unitType: doc.type, kind: row.kind, title: row.type === 'research_item' ? row.rootTitle : row.ownTitle ?? row.rootTitle,
      credit: (JSON.parse(row.credit) as CreditEntry[]).map((entry) => ('member' in entry ? names.get(entry.member) ?? '' : 'outside' in entry ? entry.outside.name : entry.imported)).filter((name) => name !== ''),
      createdAt: row.type === 'entry_section' ? row.rootCreatedAt : row.createdAt,
      withdrawn: row.withdrawnAt !== null, superseded: row.superseded === 1, level: own, effective: restricted ? 'not_published' : lessPublic(lessPublic(own, row.rootLevel), row.projectLevel),
      restricted, flag: row.flag, project: { id: row.projectId, name: row.projectName },
      ...(authors.has(doc.unit) ? { dissent: { author: authors.get(doc.unit)! } } : {}),
      excerpt: titleMatched ? excerptOf(doc.title, [], doc.titleSnippet, terms) : excerptOf(logical?.text ?? doc.body, logical ? logical.spans as DocSpan[] : JSON.parse(doc.spans) as DocSpan[], doc.bodySnippet, terms, logical ? logicalMatchStart(logical.text, terms) : undefined),
    });
  }
  return { results, next };
}
