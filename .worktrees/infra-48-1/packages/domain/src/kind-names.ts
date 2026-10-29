import type { ItemKind } from './types';

/** The kind of a Research_Item as public pages and search results name it. */
export const ITEM_KIND_NAMES: Readonly<Record<ItemKind, string>> = {
  journal_entry: 'Journal entry', finding: 'Finding', source: 'Source', run: 'Run', hypothesis: 'Hypothesis',
  correspondence: 'Correspondence', archival_request: 'Archival request', topic: 'Topic',
};
