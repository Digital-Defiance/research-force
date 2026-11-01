import type { Context } from 'hono';
import { z } from 'zod';
import { canRead } from '@researchforce/db/access';
import { localDateRangeToUTC, partialDate, todayInZone } from '@researchforce/domain/dates';
import type { RichText } from '@researchforce/domain/richtext';
import { ITEM_KINDS, isULID } from '@researchforce/domain/types';
import type { CreditEntry, ItemKind, PartialDate, Timestamp, ULID } from '@researchforce/domain/types';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import { richText, rowsOf } from '../records/kinds/kind';
import { viewerZone } from '../activity/feed';
import { dissentReadSql, dissentRowsByItem, nonWithdrawnNotes } from '../dissent/display';
import type { DissentNote, DissentRow } from '../dissent/display';

/** Entries per page of the Project_Log (R43.1). */
export const LOG_PAGE = 50;
const DAY_MS = 86_400_000;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Enter a date as YYYY-MM-DD.');
/** The Project_Log filters; an entry must match every one that is set (R43.4). */
export const logFilterSchema = z.strictObject({
  itemKind: z.enum(ITEM_KINDS).optional(),
  member: z.string().refine(isULID, 'Choose a Member.').optional(),
  specialty: z.string().refine(isULID, 'Choose a Specialty.').optional(),
  from: day.optional(),
  to: day.optional(),
});
export type LogFilter = z.infer<typeof logFilterSchema>;
const FILTER_KEYS = ['itemKind', 'member', 'specialty', 'from', 'to'] as const;

/** The filters in a query string, ignoring empty values. */
export function logFilterFromQuery(query: Readonly<Record<string, string>>): unknown {
  return Object.fromEntries(FILTER_KEYS.flatMap((key) => (query[key] ? [[key, query[key]]] : [])));
}

/** Whether the viewer asked for oldest-first order (R43.2). */
export function reversedFromQuery(query: Readonly<Record<string, string>>): boolean {
  return query['order'] === 'oldest';
}

/** The person fields a Project_Log entry names: ids resolved to display names in a second pass. */
export interface Person { readonly id: ULID; readonly displayName: string | null }
/** A Credit entry as shown: a Member resolved to a Person, or an outside or imported name kept verbatim (R43.3). */
export type CreditDisplay =
  | { readonly member: Person }
  | { readonly outside: { readonly name: string; readonly affiliation?: string } }
  | { readonly imported: string };
/** A Journal_Entry's phase identifier and the dates it records (R43.3). */
export interface JournalPhase {
  readonly phaseId: string | null;
  readonly startDate: PartialDate | null;
  readonly endDate: PartialDate | null;
}
/** The withdrawal mark of a withdrawn Research_Item (R43.3). */
export interface WithdrawalMark { readonly at: Timestamp; readonly by: Person; readonly reason: string | null }
/**
 * A Dissent_Note shown next to the Log_Summary, oldest first by attachment time (R43.3, R42.3). The shared builder in
 * `../dissent/display` produces it, so the Project_Log and every other surface apply the same rules.
 */
export type LogDissent = DissentNote;

/** One Project_Log entry: a Research_Item, or a Deletion record in its place (R43.3, R43.7). */
export type LogEntry = LogItemEntry | LogDeletionEntry;
export interface LogItemEntry {
  readonly type: 'item';
  readonly id: ULID;
  readonly kind: ItemKind;
  readonly identifier: string;
  readonly title: string;
  /** The Log_Date in the viewer's time zone, ordered and shown there (R43.2). */
  readonly logDate: PartialDate;
  readonly owner: Person;
  /** The Credit, members resolved to display names (R43.3). */
  readonly credit: readonly CreditDisplay[];
  readonly statusValueId: ULID | null;
  readonly journal: JournalPhase | null;
  readonly withdrawal: WithdrawalMark | null;
  /** The address of the Research_Item's page (R43.3). */
  readonly link: string;
  /** The Log_Summary in full with its labels, or null for the "no Log Summary recorded" notice (R43.3). */
  readonly logSummary: RichText | null;
  readonly dissent: readonly LogDissent[];
}
export interface LogDeletionEntry {
  readonly type: 'deletion';
  readonly id: ULID;
  readonly kind: ItemKind | null;
  readonly identifier: string | null;
  readonly deletedBy: Person;
  readonly deletedAt: Timestamp;
  readonly reason: string;
  /** The Deletion record's Log_Date: the deletion day in the viewer's time zone (R43.7). */
  readonly logDate: PartialDate;
}

export interface LogPage {
  /** The Project whose log this is (R43.6). */
  readonly projectId: ULID;
  readonly order: 'newest' | 'oldest';
  readonly entries: readonly LogEntry[];
  /** The cursor for the next page, or null at the end (R43.1). */
  readonly next: string | null;
}

/** The ordering tuple of an entry in the viewer's time zone: its Log_Date key, instant, and id. */
interface SortTuple { readonly key: string; readonly instant: Timestamp; readonly id: string }
function encodeCursor(tuple: SortTuple): string {
  return Buffer.from(`${tuple.key}\u0000${tuple.instant}\u0000${tuple.id}`, 'utf8').toString('base64url');
}
function decodeCursor(cursor: string): SortTuple {
  const parts = Buffer.from(cursor, 'base64url').toString('utf8').split('\u0000');
  if (parts.length !== 3 || !isULID(parts[2]!)) throw new ApiError('validation', { fields: [{ field: 'cursor', rule: 'Use the value the previous page returned.' }] });
  return { key: parts[0]!, instant: parts[1]! as Timestamp, id: parts[2]! };
}
/** Compare two sort tuples; negative when `a` precedes `b` in oldest-first order. */
function compare(a: SortTuple, b: SortTuple): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : a.instant < b.instant ? -1 : a.instant > b.instant ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
/** Add `days` UTC days to a `YYYY-MM-DD` key, for the one-day reorder window (R43.2). */
function shiftDay(key: string, days: number): string {
  return new Date(Date.parse(`${key}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

interface ItemRow {
  id: ULID; kind: ItemKind; identifier: string; title: string; ownerId: ULID; credit: string;
  statusValueId: ULID | null; logDateKey: string; logDateIsCreation: number; createdAt: Timestamp;
  logSummary: string | null; logSummarySpans: string | null;
  withdrawnAt: Timestamp | null; withdrawnBy: ULID | null; withdrawalReason: string | null;
  phaseId: string | null; startDate: string | null; startDateApprox: number; endDate: string | null; endDateApprox: number;
}
interface DeletionRow {
  id: ULID; kind: ItemKind | null; identifier: string | null; deletedBy: ULID; deletedAt: Timestamp; reason: string;
}
/** A Research_Item entry before names are resolved, carrying the raw Credit and the unresolved persons. */
type RawItemEntry = Omit<LogItemEntry, 'credit'> & { readonly rawCredit: readonly CreditEntry[] };
type RawEntry = RawItemEntry | LogDeletionEntry;
/** An entry carried through the viewer-zone reorder with its viewer-zone sort tuple. */
interface Windowed { readonly tuple: SortTuple; readonly entry: RawEntry }

function storedDate(value: string | null, approx: number): PartialDate | null {
  return value === null ? null : { value, approx: approx === 1 };
}

/** The half-open UTC instant range of the Log_Date filter, refusing an end before the start (R43.8). */
function parseRange(filter: LogFilter, zone: string): { start?: Timestamp; endExclusive?: Timestamp } {
  try {
    return localDateRangeToUTC({
      ...(filter.from === undefined ? {} : { start: partialDate(filter.from) }),
      ...(filter.to === undefined ? {} : { end: partialDate(filter.to) }),
    }, zone);
  } catch (error) {
    const rule = error instanceof RangeError && /precedes/u.test(error.message) ? 'The end date precedes the start date.' : 'Enter real dates as YYYY-MM-DD.';
    throw new ApiError('validation', { fields: [{ field: filter.from !== undefined && filter.to === undefined ? 'from' : 'to', rule }] });
  }
}

/** The viewer-zone Log_Date of a Research_Item: its recorded date, or the creation day in the viewer's zone (R43.2). */
function itemLogDate(row: ItemRow, zone: string): PartialDate {
  return row.logDateIsCreation === 1 ? todayInZone(row.createdAt, zone) : { value: row.logDateKey, approx: false };
}

/** The viewer-zone sort tuple of a Research_Item, by Log_Date then creation time then id (R43.2). */
function itemTuple(row: ItemRow, zone: string): SortTuple {
  return { key: itemLogDate(row, zone).value, instant: row.createdAt, id: row.id };
}
/** The viewer-zone sort tuple of a Deletion record, dated at the deletion (R43.7). */
function deletionTuple(row: DeletionRow, zone: string): SortTuple {
  return { key: todayInZone(row.deletedAt, zone).value, instant: row.deletedAt, id: row.id };
}

function itemEntry(row: ItemRow, zone: string): RawItemEntry {
  const journal: JournalPhase | null = row.kind === 'journal_entry'
    ? { phaseId: row.phaseId, startDate: storedDate(row.startDate, row.startDateApprox), endDate: storedDate(row.endDate, row.endDateApprox) }
    : null;
  return {
    type: 'item', id: row.id, kind: row.kind, identifier: row.identifier, title: row.title,
    logDate: itemLogDate(row, zone), owner: { id: row.ownerId, displayName: null },
    rawCredit: JSON.parse(row.credit) as CreditEntry[], statusValueId: row.statusValueId, journal,
    withdrawal: row.withdrawnAt === null ? null : { at: row.withdrawnAt, by: { id: row.withdrawnBy!, displayName: null }, reason: row.withdrawalReason },
    link: `/items/${row.id}`, logSummary: richText(row.logSummary, row.logSummarySpans) ?? null, dissent: [],
  };
}
function deletionEntry(row: DeletionRow, zone: string): LogDeletionEntry {
  return {
    type: 'deletion', id: row.id, kind: row.kind, identifier: row.identifier, deletedBy: { id: row.deletedBy, displayName: null },
    deletedAt: row.deletedAt, reason: row.reason, logDate: todayInZone(row.deletedAt, zone),
  };
}

const ITEM_COLUMNS = `u.id, ri.kind, ri.item_identifier AS identifier, ri.title, u.owner_id AS ownerId, u.credit,
  ri.status_value_id AS statusValueId, ri.log_date_key AS logDateKey, ri.log_date_is_creation AS logDateIsCreation, u.created_at AS createdAt,
  ri.log_summary AS logSummary, ri.log_summary_spans AS logSummarySpans,
  u.withdrawn_at AS withdrawnAt, u.withdrawn_by AS withdrawnBy, u.withdrawal_reason AS withdrawalReason,
  je.phase_id AS phaseId, je.start_date AS startDate, je.start_date_approx AS startDateApprox, je.end_date AS endDate, je.end_date_approx AS endDateApprox`;

/**
 * The first Project in the Project_Order, which the Project_Log opens when the Member chose no Project (R43.6).
 * Answers not_found when there is no Project.
 */
export async function firstProject(c: Context<ApiEnv>): Promise<ULID> {
  const row = (await c.get('accountant').track(c.env.RF_CORE.prepare('SELECT id FROM projects ORDER BY position LIMIT 1').all<{ id: ULID }>())).results[0];
  if (!row) throw new ApiError('not_found');
  return row.id;
}

/**
 * One page of the Project_Log of `projectId`, ordered by Log_Date then creation time, newest first unless `reversed`
 * (R43.1, R43.2). Every Research_Item the viewer Can_Read, except the Items of an incomplete Submission, and a
 * Deletion record in place of each permanently deleted Research_Item, are gathered in the viewer's time zone: the
 * database orders by the UTC Log_Date key, the page and the entries within one day of its boundaries are read, and the
 * exact time-zone order is applied before the page of 50 is cut, so the boundary is correct in the viewer's zone.
 */
export async function readLog(c: Context<ApiEnv>, projectId: string, filter: LogFilter, reversed: boolean, cursor: string | undefined): Promise<LogPage> {
  if (!isULID(projectId)) throw new ApiError('not_found');
  const after = cursor === undefined ? undefined : decodeCursor(cursor);
  const zone = await viewerZone(c);
  const viewer = c.get('session').member.id;
  const db = c.env.RF_CORE;
  const accountant = c.get('accountant');

  const range = (filter.from !== undefined || filter.to !== undefined) ? parseRange(filter, zone) : {};
  const common: Common = { projectId, viewer, filter, range, reversed };
  const direction = reversed ? 1 : -1;

  // The database orders by the UTC Log_Date key, but a viewer-zone key differs from it by at most one day, so the exact
  // viewer-zone order is applied in the Worker before the page is cut (R43.2). The read has two phases. The spine reads
  // the page's worth of entries in UTC-key order; its farthest UTC key bounds how far the viewer-zone reorder could
  // reach. The fringe then reads every entry within one day of that bound, so no entry the viewer-zone order places on
  // this page is missed, and the page of 50 is cut after the reorder.
  const spine = await accountant.track(db.batch([
    itemStatement(db, common, keyBound(after, reversed, 1), LOG_PAGE + 1),
    deletionStatement(db, common, keyBound(after, reversed, 1), LOG_PAGE + 1),
  ]));
  const spineKeys = [
    ...rowsOf<ItemRow>(spine[0]).map((row) => row.logDateKey),
    ...rowsOf<DeletionRow>(spine[1]).map((row) => row.deletedAt.slice(0, 10)),
  ];
  // The farthest UTC key reached by the spine, extended one day outward for the reorder; without a full page there is no
  // farther entry, so the whole remainder within the cursor is read.
  const fringeBound = spineKeys.length > LOG_PAGE
    ? shiftDay(reversed ? spineKeys.reduce((hi, key) => (key > hi ? key : hi)) : spineKeys.reduce((lo, key) => (key < lo ? key : lo)), direction)
    : undefined;

  const byId = new Map<string, Windowed>();
  const [itemFringe, deletionFringe] = await accountant.track(db.batch([
    itemStatement(db, common, fringeKeyBound(after, fringeBound, reversed), undefined),
    deletionStatement(db, common, fringeKeyBound(after, fringeBound, reversed), undefined),
  ]));
  for (const row of rowsOf<ItemRow>(itemFringe)) byId.set(row.id, { tuple: itemTuple(row, zone), entry: itemEntry(row, zone) });
  for (const row of rowsOf<DeletionRow>(deletionFringe)) byId.set(row.id, { tuple: deletionTuple(row, zone), entry: deletionEntry(row, zone) });

  const windowed = [...byId.values()];
  // Newest first sorts by descending viewer-zone tuple, oldest first by ascending.
  windowed.sort((a, b) => (reversed ? compare(a.tuple, b.tuple) : compare(b.tuple, a.tuple)));
  // Drop everything up to and including the previous page's last entry in the viewer-zone order.
  const beyond = after === undefined ? windowed : windowed.filter((w) => direction * compare(w.tuple, after) > 0);
  const page = beyond.slice(0, LOG_PAGE);
  const next = beyond.length > LOG_PAGE ? encodeCursor(page.at(-1)!.tuple) : null;

  const entries = await resolveNames(c, page.map((w) => w.entry));
  return { projectId, order: reversed ? 'oldest' : 'newest', entries, next };
}

interface Common {
  readonly projectId: string; readonly viewer: string; readonly filter: LogFilter;
  readonly range: { start?: Timestamp; endExclusive?: Timestamp }; readonly reversed: boolean;
}

/** The inclusive UTC-key bound of the spine read, one day beyond the cursor so the reorder window is covered. */
function keyBound(after: SortTuple | undefined, reversed: boolean, slackDays: number): string | undefined {
  return after === undefined ? undefined : shiftDay(after.key, reversed ? -slackDays : slackDays);
}
/** The UTC-key bounds of the fringe read: from the spine's farthest reach, up to one day beyond the cursor. */
function fringeKeyBound(after: SortTuple | undefined, fringeBound: string | undefined, reversed: boolean): { readonly lo?: string | undefined; readonly hi?: string | undefined } {
  const cursor = keyBound(after, reversed, 1);
  // Newest first reads keys at most the cursor bound and at least the fringe bound; oldest first reads the mirror.
  return reversed ? { lo: cursor, hi: fringeBound } : { lo: fringeBound, hi: cursor };
}

/** The Research_Item spine or fringe read: viewer-readable Items of completed Submissions, with the filters and the key window. */
function itemStatement(db: D1Database, common: Common, bound: string | { lo?: string | undefined; hi?: string | undefined } | undefined, limit: number | undefined): D1PreparedStatement {
  const binds: unknown[] = [common.viewer, common.projectId];
  const bind = (value: unknown): string => { binds.push(value); return `?${binds.length}`; };
  const where = [
    `u.unit_type = 'research_item' AND u.project_id = ?2`,
    `EXISTS (SELECT 1 FROM submissions s WHERE s.id = u.submission_id AND s.completed_at IS NOT NULL)`,
    canRead('?1', 'u.id'),
    ...itemFilterClauses(common.filter, common.range, bind),
    ...keyClauses('ri.log_date_key', bound, common.reversed, bind),
  ];
  const order = common.reversed ? 'ASC' : 'DESC';
  return db.prepare(
    `SELECT ${ITEM_COLUMNS} FROM units u JOIN research_items ri ON ri.unit_id = u.id
      LEFT JOIN journal_entries je ON je.unit_id = u.id WHERE ${where.join(' AND ')}
      ORDER BY ri.log_date_key ${order}, u.created_at ${order}, u.id ${order}${limit === undefined ? '' : ` LIMIT ${limit}`}`,
  ).bind(...binds);
}

/** The Deletion spine or fringe read, matching only the kind and date filters (R43.7). */
function deletionStatement(db: D1Database, common: Common, bound: string | { lo?: string | undefined; hi?: string | undefined } | undefined, limit: number | undefined): D1PreparedStatement {
  const binds: unknown[] = [common.projectId];
  const bind = (value: unknown): string => { binds.push(value); return `?${binds.length}`; };
  const dayKey = 'substr(d.deleted_at, 1, 10)';
  const where = [`d.project_id = ?1`, `d.unit_type = 'research_item'`];
  if (common.filter.itemKind !== undefined) where.push(`d.kind = ${bind(common.filter.itemKind)}`);
  // A Deletion record has no Owner or Credit, so a Member or Specialty filter excludes it (R43.7).
  if (common.filter.member !== undefined || common.filter.specialty !== undefined) where.push('1 = 0');
  if (common.filter.from !== undefined) where.push(`d.deleted_at >= ${bind(common.range.start)}`);
  if (common.filter.to !== undefined) where.push(`d.deleted_at < ${bind(common.range.endExclusive)}`);
  where.push(...keyClauses(dayKey, bound, common.reversed, bind));
  const order = common.reversed ? 'ASC' : 'DESC';
  return db.prepare(
    `SELECT d.unit_id AS id, d.kind, d.item_identifier AS identifier, d.deleted_by AS deletedBy, d.deleted_at AS deletedAt, d.reason
      FROM deletions d WHERE ${where.join(' AND ')}
      ORDER BY ${dayKey} ${order}, d.deleted_at ${order}, d.unit_id ${order}${limit === undefined ? '' : ` LIMIT ${limit}`}`,
  ).bind(...binds);
}

/** The UTC-key predicates for a spine read (a single inclusive bound in the page direction) or a fringe read (a lo/hi band). */
function keyClauses(key: string, bound: string | { lo?: string | undefined; hi?: string | undefined } | undefined, reversed: boolean, bind: (value: unknown) => string): string[] {
  if (bound === undefined) return [];
  if (typeof bound === 'string') return [reversed ? `${key} >= ${bind(bound)}` : `${key} <= ${bind(bound)}`];
  const clauses: string[] = [];
  if (bound.lo !== undefined) clauses.push(`${key} >= ${bind(bound.lo)}`);
  if (bound.hi !== undefined) clauses.push(`${key} <= ${bind(bound.hi)}`);
  return clauses;
}

/** The shared kind, Member, Specialty, and Log_Date-range clauses of the Research_Item filter (R43.4). */
function itemFilterClauses(filter: LogFilter, range: { start?: Timestamp; endExclusive?: Timestamp }, bind: (value: unknown) => string): string[] {
  const where: string[] = [];
  if (filter.itemKind !== undefined) where.push(`ri.kind = ${bind(filter.itemKind)}`);
  if (filter.member !== undefined) {
    const member = bind(filter.member);
    where.push(`(u.owner_id = ${member} OR EXISTS (SELECT 1 FROM json_each(u.credit) cj WHERE cj.value ->> '$.member' = ${member}))`);
  }
  if (filter.specialty !== undefined) {
    const specialty = bind(filter.specialty);
    where.push(`EXISTS (SELECT 1 FROM profile_specialties ps WHERE ps.value_id = ${specialty}
      AND (ps.member_id = u.owner_id OR ps.member_id IN (SELECT cj.value ->> '$.member' FROM json_each(u.credit) cj WHERE cj.value ->> '$.member' IS NOT NULL)))`);
  }
  // The Log_Date range is inclusive in the viewer's zone: a recorded date matches as a date string, a creation date as
  // a UTC instant (R43.4). `log_date_is_creation` chooses which form each Research_Item is matched against.
  if (filter.from !== undefined) where.push(`((ri.log_date_is_creation = 0 AND ri.log_date_key >= ${bind(filter.from)}) OR (ri.log_date_is_creation = 1 AND u.created_at >= ${bind(range.start)}))`);
  if (filter.to !== undefined) where.push(`((ri.log_date_is_creation = 0 AND ri.log_date_key <= ${bind(filter.to)}) OR (ri.log_date_is_creation = 1 AND u.created_at < ${bind(range.endExclusive)}))`);
  return where;
}

/** Resolve every Member id in the page's entries to a display name, and gather each item's Dissent_Notes (R43.3). */
async function resolveNames(c: Context<ApiEnv>, entries: readonly RawEntry[]): Promise<readonly LogEntry[]> {
  const itemIds = entries.flatMap((entry) => (entry.type === 'item' ? [entry.id] : []));
  const db = c.env.RF_CORE;
  const people = new Set<string>();
  for (const entry of entries) {
    if (entry.type === 'item') {
      people.add(entry.owner.id);
      if (entry.withdrawal) people.add(entry.withdrawal.by.id);
      for (const credit of entry.rawCredit) if ('member' in credit) people.add(credit.member);
    } else {
      people.add(entry.deletedBy.id);
    }
  }
  const [nameRows, dissentRows] = await c.get('accountant').track(db.batch([
    db.prepare('SELECT member_id AS id, display_name AS displayName FROM profiles WHERE member_id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify([...people])),
    // Non-withdrawn Dissent_Notes of the page's Items, oldest first by attachment time, with the author's display name,
    // built by the shared display builder so the Project_Log follows the same rules as every other surface (R43.3, R42.3, R42.8).
    db.prepare(dissentReadSql(1)).bind(JSON.stringify(itemIds)),
  ]));
  const names = new Map(rowsOf<{ id: ULID; displayName: string }>(nameRows).map((row) => [row.id, row.displayName]));
  const named = (person: Person): Person => ({ id: person.id, displayName: names.get(person.id) ?? null });

  const dissentByItem = dissentRowsByItem(rowsOf<DissentRow>(dissentRows));
  return entries.map((entry): LogEntry => {
    if (entry.type === 'deletion') return { ...entry, deletedBy: named(entry.deletedBy) };
    const { rawCredit, ...rest } = entry;
    return {
      ...rest, owner: named(entry.owner),
      withdrawal: entry.withdrawal ? { ...entry.withdrawal, by: named(entry.withdrawal.by) } : null,
      credit: rawCredit.map((credit): CreditDisplay => ('member' in credit ? { member: named({ id: credit.member, displayName: null }) } : credit)),
      dissent: nonWithdrawnNotes(dissentByItem.get(entry.id) ?? []),
    };
  });
}
