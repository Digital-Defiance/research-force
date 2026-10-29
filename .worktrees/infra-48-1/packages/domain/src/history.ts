import type { RichText } from './richtext';
import { REVISION_KINDS } from './types';
import type { RevisionKind } from './types';

/** One unit's fields as its history shows them; a missing key means the field had no value. */
export type Fields = Readonly<Record<string, unknown>>;
export interface SectionValue { readonly id: string; readonly content: RichText }
/**
 * An Item as it stood at one point: its own fields, including `sections` for a Journal_Entry, and the unit fields
 * (such as the Disclosure_Level) of each of its Entry_Sections that Revisions of the section have recorded.
 */
export interface HistoryState {
  readonly id: string;
  readonly item: Fields;
  readonly sections: Readonly<Record<string, Fields>>;
}
/** A stored Revision: who and when are not needed to rebuild a state. */
export interface StoredRevision {
  readonly id: string;
  /** The change sequence of the save; every Revision of one save shares it. */
  readonly seq: number;
  readonly targetId: string;
  readonly kind: RevisionKind;
  readonly prev: Readonly<Record<string, unknown>>;
}
/** The point before every Revision. */
export const CREATION = 'creation';
/** `creation` or the id of a Revision; the state after a Revision is the state after the whole save that made it. */
export type HistoryPoint = string;

/** The `sections` value of a Journal_Entry's Revision: the order before the save and the content of each section it changed or removed. */
interface SectionsPrev { readonly order: readonly string[]; readonly content: Readonly<Record<string, RichText>> }
function isSectionsPrev(value: unknown): value is SectionsPrev {
  return typeof value === 'object' && value !== null && Array.isArray((value as SectionsPrev).order) && typeof (value as SectionsPrev).content === 'object';
}

/** JSON with sorted keys, so that two values compare equal whatever their key order. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
export const sameValue = (a: unknown, b: unknown): boolean => stableJson(a ?? null) === stableJson(b ?? null);

/** Oldest first: by save, then in Revision_Kind order within a save, as `revisionsFor` writes them. */
export function inSaveOrder<T extends Pick<StoredRevision, 'id' | 'seq' | 'kind'>>(revisions: readonly T[]): T[] {
  return [...revisions].sort((a, b) => a.seq - b.seq || REVISION_KINDS.indexOf(a.kind) - REVISION_KINDS.indexOf(b.kind) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function undoSections(current: unknown, prev: SectionsPrev): SectionValue[] {
  const byId = new Map(((current ?? []) as readonly SectionValue[]).map((section) => [section.id, section.content]));
  return prev.order.flatMap((id) => {
    const content = prev.content[id] ?? byId.get(id);
    return content === undefined ? [] : [{ id, content }];
  });
}

/** The fields before a Revision, from the fields after it and the previous values it stored (R22.1). */
export function undoFields(fields: Fields, prev: Readonly<Record<string, unknown>>): Fields {
  const before: Record<string, unknown> = { ...fields };
  for (const [key, value] of Object.entries(prev)) {
    if (key === 'sections' && isSectionsPrev(value)) before[key] = undoSections(fields[key], value);
    else if (value === null || value === undefined) delete before[key];
    else before[key] = value;
  }
  return before;
}

/**
 * Undo one Revision. A save that added an Entry_Section created its unit row, so the section's unit fields before
 * that save are unknown, even when a Restoration added back a section removed earlier under the same id.
 */
function undo(state: HistoryState, revision: StoredRevision): HistoryState {
  if (revision.kind === 'deletion') return state;
  if (revision.targetId === state.id) {
    const prev = revision.prev['sections'];
    if (!isSectionsPrev(prev)) return { ...state, item: undoFields(state.item, revision.prev) };
    const before = new Set(prev.order);
    const sections = Object.fromEntries(Object.entries(state.sections).filter(([id]) => before.has(id)));
    return { ...state, item: undoFields(state.item, revision.prev), sections };
  }
  return { ...state, sections: { ...state.sections, [revision.targetId]: undoFields(state.sections[revision.targetId] ?? {}, revision.prev) } };
}

/**
 * The state immediately after `point`, rebuilt from the current state by undoing every later save, newest first
 * (R22.3). Throws a RangeError for a point that is not one of `revisions`.
 */
export function stateAt(current: HistoryState, revisions: readonly StoredRevision[], point: HistoryPoint): HistoryState {
  const ordered = inSaveOrder(revisions);
  let after = Number.NEGATIVE_INFINITY;
  if (point !== CREATION) {
    const revision = ordered.find((entry) => entry.id === point);
    if (!revision) throw new RangeError('This point is not in the history.');
    after = revision.seq;
  }
  let state = current;
  for (const revision of ordered.reverse()) {
    if (revision.seq <= after) break;
    state = undo(state, revision);
  }
  return state;
}

/** The Entry_Sections a history covers: those the Item has now and every one its Revisions name. */
export function sectionIds(current: HistoryState, revisions: readonly StoredRevision[]): Set<string> {
  const ids = new Set(((current.item['sections'] ?? []) as readonly SectionValue[]).map((section) => section.id));
  for (const revision of revisions) {
    const value = revision.targetId === current.id ? revision.prev['sections'] : undefined;
    if (isSectionsPrev(value)) for (const id of value.order) ids.add(id);
  }
  return ids;
}
