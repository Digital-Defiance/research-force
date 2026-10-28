import type { Context } from 'hono';
import type { GuardedBatch } from '@researchforce/db/batch';
import type { ItemDateInput } from '@researchforce/domain/dates';
import type { RichText, Span } from '@researchforce/domain/richtext';
import type { ResearchItemInput } from '@researchforce/domain/schemas/items';
import type { AccessLevel, CreditEntry, DisclosureLine, ItemKind, Level, PartialDate, Timestamp, ULID } from '@researchforce/domain/types';
import type { ApiEnv } from '../../api/app';
import type { FieldIssue } from '../../api/errors';
import type { LinkInput } from '../links';
import type { FieldChange, FieldClass } from '../pipeline';

/** A Research_Item's fields in the shape its schema accepts. */
export type ItemInput = ResearchItemInput;
export type ItemFields = Record<string, unknown>;

/** The stored `units` and `research_items` columns every kind shares. */
export interface BaseRow {
  readonly id: ULID; readonly kind: ItemKind; readonly identifier: string; readonly projectId: ULID; readonly ownerId: ULID;
  readonly credit: readonly CreditEntry[]; readonly submissionId: ULID; readonly createdAt: Timestamp; readonly rev: number;
  readonly disclosureLevel: Level; readonly classificationState: 'unclassified' | 'classified' | null; readonly disclosureLine: DisclosureLine | null;
  readonly publicPresentation: 'summary_only' | 'full_content';
  readonly withdrawnAt: Timestamp | null; readonly withdrawnBy: ULID | null; readonly withdrawalReason: string | null;
  readonly title: string; readonly statusValueId: ULID | null; readonly logSummary: RichText | null;
  readonly accessLevel: AccessLevel;
}
/** A unit under the Research_Item that the item response describes, such as an Entry_Section. */
export interface ChildUnit {
  readonly id: ULID; readonly type: 'entry_section' | 'reply'; readonly position: number; readonly rev: number;
  readonly level: Level; readonly unclassified: boolean;
}
export interface NewItem {
  readonly id: ULID; readonly projectId: ULID; readonly ownerId: ULID; readonly credit: readonly CreditEntry[];
  readonly submissionId: ULID; readonly now: Timestamp;
}
/** What a kind's rules need about one save. */
export interface SaveContext {
  readonly id: ULID;
  readonly before?: ItemFields;
  readonly after: ItemFields;
  readonly base?: BaseRow;
  /** Links the same save records, whose ends the batch has written before the kind's guards run. */
  readonly links: readonly LinkInput[];
  readonly statusReason?: string | undefined;
  readonly mark?: { readonly mark: 'minor_edit' | 'correction' } | undefined;
}
export interface KindRules {
  readonly issues: readonly FieldIssue[];
  /** Guards and automatic consequences, added after the save's writes and links (design "Automatic consequences"). */
  readonly write?: (batch: GuardedBatch) => void;
  /** Field changes the save makes automatically, recorded in its Revisions. */
  readonly changes?: readonly FieldChange[];
  /** Columns of the item's own unit row that the save changes automatically. */
  readonly unit?: { readonly disclosureLevel: Level; readonly disclosureLine: DisclosureLine };
}

export interface KindAdapter {
  readonly kind: ItemKind;
  /** The Revision class of each editable kind field for this save; content fields take the edit's mark. */
  classes(before: ItemFields | undefined, after: ItemFields): Readonly<Record<string, FieldClass>>;
  /** Statements that read the kind's own rows of unit `?1`, run in the item's read batch. */
  load(db: D1Database, id: string): D1PreparedStatement[];
  /** The kind's fields in the schema's input shape, from the results of `load`. */
  read(results: readonly D1Result[], base: BaseRow): { readonly fields: ItemFields; readonly children?: readonly ChildUnit[] };
  /** The kind's dated field for the Item_Date and Log_Date (R43.2). */
  dates(fields: ItemFields): Omit<ItemDateInput, 'createdAt'>;
  /** Writes of a new Item's kind rows. */
  insert(batch: GuardedBatch, item: NewItem, fields: ItemFields): void;
  /** Writes of an edit's changed kind fields. */
  update(batch: GuardedBatch, item: BaseRow, before: ItemFields, after: ItemFields, changed: ReadonlySet<string>, now: Timestamp): void;
  /** Fix up an edit's merged fields before validation, such as dropping a field that the new status no longer carries. */
  adjust?(merged: Record<string, unknown>, patch: Readonly<Record<string, unknown>>, before: ItemFields): void;
  /** Data checks, guards, and automatic consequences of a submission or edit. */
  rules?(c: Context<ApiEnv>, save: SaveContext): Promise<KindRules>;
  /** Fields whose changes the generic diff does not express, such as Entry_Sections. */
  diff?(before: ItemFields, after: ItemFields): FieldChange[];
}

export function richText(text: string | null, spans: string | readonly Span[] | null): RichText | undefined {
  if (text === null) return undefined;
  return { text, spans: typeof spans === 'string' ? JSON.parse(spans) as Span[] : [...(spans ?? [])] };
}
export function richColumns(value: unknown): { readonly text: string | null; readonly spans: Span[] } {
  const rich = value as RichText | undefined;
  return rich === undefined ? { text: null, spans: [] } : { text: rich.text, spans: [...rich.spans] };
}
export function storedDate(value: string | null, approx: number | boolean | null): PartialDate | undefined {
  return value === null ? undefined : { value, approx: approx === 1 || approx === true };
}
export function dateColumns(value: unknown): { readonly value: string | null; readonly approx: boolean } {
  const date = value as PartialDate | undefined;
  return date === undefined ? { value: null, approx: false } : { value: date.value, approx: date.approx };
}
/** Drop undefined values so a record compares equal to its submitted form. */
export function defined(fields: ItemFields): ItemFields {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}
export function rowsOf<T>(result: D1Result | undefined): T[] {
  return (result as D1Result<T> | undefined)?.results ?? [];
}
export function classesOf(fields: readonly string[], fieldClass: FieldClass, overrides: Readonly<Record<string, FieldClass>> = {}): Readonly<Record<string, FieldClass>> {
  return { ...Object.fromEntries(fields.map((field) => [field, fieldClass])), ...overrides };
}
