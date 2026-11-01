import type { RichText } from '@researchforce/domain/richtext';
import { wordDiff } from '@researchforce/domain/compare';
import type { WordPart } from '@researchforce/domain/compare';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import { richText, rowsOf } from '../records/kinds/kind';

/** The person fields a Dissent_Note names: an id resolved to a display name, or null while no Profile is found. */
export interface Person { readonly id: ULID; readonly displayName: string | null }

/**
 * A Dissent_Note shown next to the Log_Summary it concerns, oldest first by attachment time (R42.3, R43.3). The viewer
 * renders `lastSavedAt` in their own time zone; the API returns the instant. `aboutEarlierWording` is set while the
 * current Log_Summary differs from the snapshot the author's last save recorded, and `comparison` then carries the
 * word-level diff from that snapshot to the current wording, the same marking the item history uses (R42.9, R22.4).
 */
export interface DissentNote {
  readonly id: ULID;
  /** The note unit's current Revision, the `rev` its author's editor and withdraw form send back (R42.16). */
  readonly rev: number;
  readonly author: Person;
  readonly text: RichText;
  readonly lastSavedAt: Timestamp;
  /** The note was written about an earlier Log_Summary wording (R42.9). */
  readonly aboutEarlierWording: boolean;
  /** The snapshot↔current word comparison, present only while `aboutEarlierWording` is set (R42.9). */
  readonly comparison?: EarlierWordingComparison;
}

/** The word comparison a note's earlier-wording mark links to: the recorded wording, the current wording, and the words added and removed (R42.9, R22.4). */
export interface EarlierWordingComparison {
  /** The Log_Summary wording the note's last save recorded (R42.7). */
  readonly concernedSummary: RichText;
  /** The Log_Summary wording as it now stands. */
  readonly currentSummary: RichText | null;
  readonly words: readonly WordPart[];
}

/** A withdrawn Dissent_Note, shown only on the item page and in history with its withdrawal date and reason (R42.8). */
export interface WithdrawnDissentNote extends DissentNote {
  readonly withdrawnAt: Timestamp;
  readonly withdrawnBy: Person;
  readonly withdrawalReason: string | null;
}

/** A Deletion record shown in a permanently deleted note's place wherever notes are shown (R42.11). */
export interface DissentDeletion {
  readonly id: ULID;
  readonly deletedBy: Person;
  readonly deletedAt: Timestamp;
  readonly reason: string;
}

/**
 * The full display of an item's Dissent_Notes, for the item page and item history (R42.3, R42.8, R42.11): the
 * non-withdrawn notes oldest first, then the withdrawn notes with their date and reason, then the Deletion record in
 * the place of each permanently deleted note. `count` is the number of non-withdrawn notes, so an excerpt surface can
 * show the count with a link instead of the notes themselves (R42.10).
 */
export interface DissentDisplay {
  readonly notes: readonly DissentNote[];
  readonly withdrawn: readonly WithdrawnDissentNote[];
  readonly deletions: readonly DissentDeletion[];
  readonly count: number;
}

/** The count of an item's non-withdrawn Dissent_Notes with a link to them on the item page, for an excerpt surface (R42.10). */
export interface DissentExcerpt {
  readonly count: number;
  /** The address of the item page, where the notes are shown in full (R42.10). */
  readonly link: string;
}

/** The link to a Research_Item's page, where its Dissent_Notes are shown in full (R42.10). */
export function itemDissentLink(itemId: ULID): string {
  return `/items/${itemId}`;
}

/** Whether a note's snapshot differs from the current Log_Summary, so the earlier-wording mark applies (R42.9). */
function differs(concerned: RichText | undefined, current: RichText | undefined): boolean {
  return JSON.stringify(concerned ?? null) !== JSON.stringify(current ?? null);
}

/** The one row the dissent reads join: a note, its author's name, and the Log_Summary it concerns next to the current one. */
export interface DissentRow {
  readonly id: ULID;
  readonly rev: number;
  readonly itemId: ULID;
  readonly authorId: ULID;
  readonly authorName: string | null;
  readonly text: string;
  readonly spans: string | null;
  readonly lastSavedAt: Timestamp;
  readonly concernedSummary: string;
  readonly concernedSpans: string | null;
  readonly logSummary: string | null;
  readonly logSummarySpans: string | null;
  readonly withdrawnAt: Timestamp | null;
  readonly withdrawnBy: ULID | null;
  readonly withdrawalReason: string | null;
}

/** A permanently deleted note's Deletion record, with the acting Administrator's name. */
export interface DissentDeletionRow {
  readonly id: ULID;
  readonly itemId: ULID;
  readonly deletedBy: ULID;
  readonly deletedByName: string | null;
  readonly deletedAt: Timestamp;
  readonly reason: string;
}

/** The non-withdrawn note a row describes, with its earlier-wording mark and comparison (R42.3, R42.9). */
function noteOf(row: DissentRow): DissentNote {
  const concerned = richText(row.concernedSummary, row.concernedSpans);
  const current = richText(row.logSummary, row.logSummarySpans);
  const aboutEarlierWording = differs(concerned, current);
  return {
    id: row.id, rev: row.rev, author: { id: row.authorId, displayName: row.authorName }, text: richText(row.text, row.spans)!,
    lastSavedAt: row.lastSavedAt, aboutEarlierWording,
    ...(aboutEarlierWording
      ? { comparison: { concernedSummary: concerned ?? { text: '', spans: [] }, currentSummary: current ?? null, words: wordDiff(concerned?.text ?? '', current?.text ?? '') } }
      : {}),
  };
}

/**
 * The canonical builder every surface reuses, from the note rows of one item, oldest first by attachment time (the
 * query orders them). Non-withdrawn notes carry the earlier-wording mark and comparison (R42.9); withdrawn notes carry
 * their date and reason, for the item page and history only (R42.8); Deletion records stand in a deleted note's place
 * (R42.11). `count` is the non-withdrawn count, for an excerpt surface's count and link (R42.10).
 */
export function buildDissentDisplay(rows: readonly DissentRow[], deletionRows: readonly DissentDeletionRow[] = []): DissentDisplay {
  const notes: DissentNote[] = [];
  const withdrawn: WithdrawnDissentNote[] = [];
  for (const row of rows) {
    if (row.withdrawnAt === null) notes.push(noteOf(row));
    else {
      // Only the author withdraws a Dissent_Note (R42.5), so the withdrawer's display name is the author's resolved name.
      const withdrawnBy: Person = { id: row.withdrawnBy!, displayName: row.withdrawnBy === row.authorId ? row.authorName : null };
      withdrawn.push({ ...noteOf(row), withdrawnAt: row.withdrawnAt, withdrawnBy, withdrawalReason: row.withdrawalReason });
    }
  }
  const deletions = deletionRows.map((row): DissentDeletion => ({ id: row.id, deletedBy: { id: row.deletedBy, displayName: row.deletedByName }, deletedAt: row.deletedAt, reason: row.reason }));
  return { notes, withdrawn, deletions, count: notes.length };
}

/** Group dissent rows by their item id, for a read that gathers several items' notes at once (R43.3). */
export function dissentRowsByItem(rows: readonly DissentRow[]): Map<ULID, DissentRow[]> {
  const byItem = new Map<ULID, DissentRow[]>();
  for (const row of rows) {
    const list = byItem.get(row.itemId) ?? [];
    list.push(row);
    byItem.set(row.itemId, list);
  }
  return byItem;
}

/** The non-withdrawn notes of each item, oldest first, as the Project_Log and previews show them (R42.3, R43.3). The default surfaces omit withdrawn and deleted notes. */
export function nonWithdrawnNotes(rows: readonly DissentRow[]): DissentNote[] {
  return rows.filter((row) => row.withdrawnAt === null).map(noteOf);
}

/** The count of an item's non-withdrawn notes with a link to the item page, for an excerpt surface (R42.10). */
export function dissentExcerpt(itemId: ULID, rows: readonly DissentRow[]): DissentExcerpt {
  return { count: rows.filter((row) => row.withdrawnAt === null).length, link: itemDissentLink(itemId) };
}

/**
 * The SQL that reads an item's Dissent_Notes with the Log_Summary each concerns next to the current one, oldest first
 * by attachment time (R42.3, R43.3). `withWithdrawn` keeps the withdrawn notes too, for the item page and history; the
 * default drops them, for the Project_Log, previews, Publication_Requests, and the Owner's editor (R42.8). The named
 * SQL parameter `?${itemsParam}` binds a JSON array of the item ids whose notes to read.
 */
export function dissentReadSql(itemsParam: number, options: { readonly withWithdrawn?: boolean } = {}): string {
  const withdrawnClause = options.withWithdrawn ? '' : ' AND u.withdrawn_at IS NULL';
  return `SELECT dn.unit_id AS id, u.rev, u.root_id AS itemId, dn.author_id AS authorId, ap.display_name AS authorName, dn.text, dn.text_spans AS spans,
      dn.last_saved_at AS lastSavedAt, dn.concerned_summary AS concernedSummary, dn.concerned_summary_spans AS concernedSpans,
      ri.log_summary AS logSummary, ri.log_summary_spans AS logSummarySpans,
      u.withdrawn_at AS withdrawnAt, u.withdrawn_by AS withdrawnBy, u.withdrawal_reason AS withdrawalReason
    FROM units u JOIN dissent_notes dn ON dn.unit_id = u.id JOIN research_items ri ON ri.unit_id = u.root_id
      LEFT JOIN profiles ap ON ap.member_id = dn.author_id
    WHERE u.unit_type = 'dissent_note' AND u.root_id IN (SELECT value FROM json_each(?${itemsParam}))${withdrawnClause}
      AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = u.id)
    ORDER BY dn.attached_at, u.id`;
}

/** The SQL that reads the Deletion records of permanently deleted Dissent_Notes of the given items, for the item page and history (R42.11). */
export function dissentDeletionSql(itemsParam: number): string {
  return `SELECT d.unit_id AS id, d.root_id AS itemId, d.deleted_by AS deletedBy, p.display_name AS deletedByName, d.deleted_at AS deletedAt, d.reason
    FROM deletions d LEFT JOIN profiles p ON p.member_id = d.deleted_by
    WHERE d.unit_type = 'dissent_note' AND d.root_id IN (SELECT value FROM json_each(?${itemsParam}))
    ORDER BY d.deleted_at, d.unit_id`;
}

/** Read a single item's full Dissent_Note display from the two prepared results (R42.3, R42.8, R42.11). */
export function readItemDissent(noteResult: D1Result | undefined, deletionResult: D1Result | undefined): DissentDisplay {
  return buildDissentDisplay(rowsOf<DissentRow>(noteResult), rowsOf<DissentDeletionRow>(deletionResult));
}
