/** A Question_Group as the form holds it: an entry keeps a label so that a Member sees what they chose (R50.1). */
export interface EntryValue { readonly targetId: string; readonly label?: string }
export interface GroupValue { readonly id?: string; readonly heading: string; readonly entries: readonly EntryValue[] }
export interface EntryDetail { readonly kind: string; readonly title: string; readonly identifier: string | null; readonly status?: string }

export const MAX_GROUPS = 20;
export const MAX_ENTRIES = 200;

/** The label an entry shows: its kind, Item_Identifier, and title. */
export function entryLabel(detail: EntryDetail, kindName: (kind: string) => string): string {
  return `${kindName(detail.kind)}${detail.identifier === null ? '' : ` ${detail.identifier}`}: ${detail.title}`;
}

/** The stored groups as the form holds them, with the label of each entry the Member can read. */
export function groupsFromItem(stored: unknown, details: unknown, kindName: (kind: string) => string): GroupValue[] {
  const known = (details ?? {}) as Readonly<Record<string, EntryDetail>>;
  return ((stored ?? []) as readonly { id?: string; heading: string; entries: readonly { targetId: string }[] }[]).map((group) => ({
    ...(group.id === undefined ? {} : { id: group.id }), heading: group.heading,
    entries: group.entries.map((entry) => (known[entry.targetId] === undefined ? { targetId: entry.targetId } : { targetId: entry.targetId, label: entryLabel(known[entry.targetId]!, kindName) })),
  }));
}

/** The request body's groups: identifiers and targets only. */
export function groupsToApi(groups: readonly GroupValue[]): unknown {
  return groups.length === 0 ? undefined : groups.map((group) => ({
    ...(group.id === undefined ? {} : { id: group.id }), heading: group.heading, entries: group.entries.map((entry) => ({ targetId: entry.targetId })),
  }));
}

/** `items` with the element at `from` moved to `to`. */
export function moved<T>(items: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return [...items];
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

/** Every target already chosen in any group, since an entry appears at most once (R50.1). */
export const chosenTargets = (groups: readonly GroupValue[]): Set<string> => new Set(groups.flatMap((group) => group.entries.map((entry) => entry.targetId)));
