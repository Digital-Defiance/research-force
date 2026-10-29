import { diffWordsWithSpace } from 'diff';
import { sameValue, stableJson } from './history';
import type { Fields, SectionValue } from './history';
import type { RichText, Span } from './richtext';

/** A run of text that both values share, or that only the older (`removed`) or the newer (`added`) value has. */
export interface WordPart { readonly value: string; readonly added?: true; readonly removed?: true }
export interface FieldDifference {
  /** The field name, `sections.{id}` for one Entry_Section's content, or `sections.order`. */
  readonly field: string;
  readonly before: unknown;
  readonly after: unknown;
  /** Added and removed words, for text fields. */
  readonly words?: readonly WordPart[];
  /** Labels, language marks, and Mentions only one of the two values has, for rich-text fields. */
  readonly labels?: { readonly removed: readonly Span[]; readonly added: readonly Span[] };
}

/** The words added and removed between two texts (jsdiff `diffWordsWithSpace`, which returns no empty parts and never two parts of one kind side by side) (R22.4). */
export function wordDiff(before: string, after: string): WordPart[] {
  return diffWordsWithSpace(before, after).map((change) => ({ value: change.value, ...(change.added ? { added: true as const } : change.removed ? { removed: true as const } : {}) }));
}

const isRich = (value: unknown): value is RichText => typeof value === 'object' && value !== null && typeof (value as RichText).text === 'string' && Array.isArray((value as RichText).spans);
const textOf = (value: unknown): string | undefined => (typeof value === 'string' ? value : isRich(value) ? value.text : undefined);
const isSections = (value: unknown): value is readonly SectionValue[] => Array.isArray(value) && value.every((entry) => typeof entry === 'object' && entry !== null && typeof (entry as SectionValue).id === 'string' && isRich((entry as SectionValue).content));

function spanDifference(before: readonly Span[], after: readonly Span[]): FieldDifference['labels'] {
  const keys = (spans: readonly Span[]) => new Set(spans.map(stableJson));
  const old = keys(before);
  const next = keys(after);
  const removed = before.filter((span) => !next.has(stableJson(span)));
  const added = after.filter((span) => !old.has(stableJson(span)));
  return removed.length + added.length === 0 ? undefined : { removed, added };
}

function difference(field: string, before: unknown, after: unknown): FieldDifference {
  const old = textOf(before);
  const next = textOf(after);
  const words = old === undefined && next === undefined ? undefined : wordDiff(old ?? '', next ?? '');
  const labels = spanDifference(isRich(before) ? before.spans : [], isRich(after) ? after.spans : []);
  return { field, before: before ?? null, after: after ?? null, ...(words ? { words } : {}), ...(labels ? { labels } : {}) };
}

function sectionDifferences(before: readonly SectionValue[], after: readonly SectionValue[]): FieldDifference[] {
  const old = new Map(before.map((section) => [section.id, section.content]));
  const next = new Map(after.map((section) => [section.id, section.content]));
  const ids = [...new Set([...before, ...after].map((section) => section.id))];
  const changed = ids.flatMap((id) => (sameValue(old.get(id), next.get(id)) ? [] : [difference(`sections.${id}`, old.get(id), next.get(id))]));
  const order = (list: readonly SectionValue[]) => list.map((section) => section.id);
  return sameValue(order(before), order(after)) ? changed : [{ field: 'sections.order', before: order(before), after: order(after) }, ...changed];
}

/** Each field whose value differs between two points, with both values and the words added and removed (R22.4, R42.9). */
export function compareFields(before: Fields, after: Fields): FieldDifference[] {
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return fields.flatMap((field) => {
    if (sameValue(before[field], after[field])) return [];
    const old = before[field];
    const next = after[field];
    if ((old === undefined || isSections(old)) && (next === undefined || isSections(next))) return sectionDifferences(old ?? [], next ?? []);
    return [difference(field, old, next)];
  });
}
