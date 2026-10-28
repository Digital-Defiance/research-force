import type { Fields, SectionValue } from './history';

export interface RestoreInput {
  /** The Item's fields now. */
  readonly current: Fields;
  /** The Item's fields immediately after the chosen point. */
  readonly point: Fields;
  /** Fields that Status_Changes, Withdrawals, and Disclosure_Changes set; they keep their current values. */
  readonly kept: ReadonlySet<string>;
  /** Whether the restoring Member owns the Research_Item; only the Owner restores its Log_Summary. */
  readonly restorerIsOwner: boolean;
}

/**
 * The fields a Restoration saves: every field returns to its value at the point, except the kept fields and, when the
 * restorer is not the Owner or the point had no Log_Summary, the Log_Summary (R22.5, R41.14).
 */
export function restoreFields({ current, point, kept, restorerIsOwner }: RestoreInput): Fields {
  const restored: Record<string, unknown> = {};
  for (const field of new Set([...Object.keys(current), ...Object.keys(point)])) {
    const keep = kept.has(field) || (field === 'logSummary' && (!restorerIsOwner || point['logSummary'] === undefined));
    const value = keep ? current[field] : point[field];
    if (value !== undefined) restored[field] = value;
  }
  return restored;
}

/**
 * The Entry_Sections after restoring one section to its content at the point: a section the Item still has keeps its
 * position, and one removed since the point is added back at its position then, or at the end (R22.5).
 * Throws a RangeError when the section did not exist at the point.
 */
export function restoreSection(current: readonly SectionValue[], point: readonly SectionValue[], id: string): SectionValue[] {
  const at = point.findIndex((section) => section.id === id);
  if (at < 0) throw new RangeError('The Entry Section did not exist at this point.');
  const content = point[at]!.content;
  if (current.some((section) => section.id === id)) return current.map((section) => (section.id === id ? { id, content } : section));
  const next = [...current];
  next.splice(Math.min(at, next.length), 0, { id, content });
  return next;
}

/** Sections the restored list has that the current list does not: the Restoration adds them back as Private (R23.15). */
export function addedBack(current: readonly SectionValue[], restored: readonly SectionValue[]): string[] {
  const now = new Set(current.map((section) => section.id));
  return restored.filter((section) => !now.has(section.id)).map((section) => section.id);
}
