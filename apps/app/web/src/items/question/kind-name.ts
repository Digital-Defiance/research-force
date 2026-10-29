import { ITEM_KIND_NAMES } from '@researchforce/domain/kind-names';
import { ITEM_KINDS } from '@researchforce/domain/types';
import type { ItemKind } from '@researchforce/domain/types';

/** The name of an entry's kind, which is a Research_Item kind or `attachment`. */
export const kindName = (kind: string): string => ((ITEM_KINDS as readonly string[]).includes(kind) ? ITEM_KIND_NAMES[kind as ItemKind] : kind === 'attachment' ? 'Attachment' : kind);
