import { REVIEW_STATE_NAMES } from '@researchforce/domain/derivations';
import type { DerivationKind, ReviewState } from '@researchforce/domain/derivations';

/** The shapes the derivation routes answer with (R55.3, R55.4). */
export interface EndpointRow {
  readonly type: 'attachment' | 'text'; readonly unitId: string; readonly field?: string; readonly rootId: string; readonly identifier: string; readonly title: string;
  readonly sha256: string; readonly rev: number | null; readonly revisedSince: boolean;
}
export interface ReviewRow {
  readonly reviewerId: string; readonly reviewerName: string | null; readonly state: 'reviewed' | 'disputed'; readonly note: string | null; readonly reviewedAt: string;
  readonly passages: readonly { readonly start: number; readonly end: number; readonly note: string | null }[];
}
export interface DerivationRow {
  readonly id: string; readonly kind: DerivationKind; readonly kindName: string; readonly method: string; readonly methodVersion: string | null; readonly language: string | null;
  readonly uncertainty: string | null; readonly reviewState: ReviewState; readonly createdBy: string; readonly createdByName: string | null; readonly createdAt: string;
  readonly output: EndpointRow; readonly inputs: readonly EndpointRow[]; readonly text: string | null; readonly correctsId: string | null; readonly correctedBy: string | null;
  readonly reviews: readonly ReviewRow[];
}
export interface DerivationPage { readonly derivations: readonly DerivationRow[]; readonly next: string | null }

export const reviewStateName = (state: ReviewState): string => REVIEW_STATE_NAMES[state];
export const REVIEW_CHOICES = [{ value: 'reviewed', label: 'Reviewed: I checked it and agree' }, { value: 'disputed', label: 'Disputed: I found a problem' }];

/** What a Member sees of one endpoint: the record's title, and the field when it is one text of the record. */
export const endpointLabel = (endpoint: EndpointRow): string => (endpoint.type === 'text' ? `${endpoint.title} · ${endpoint.field ?? ''}` : endpoint.title);

export interface Piece { readonly kind: 'same' | 'removed' | 'added'; readonly text: string }
const TOKEN_LIMIT = 1500;

/**
 * The words of an earlier derived text against its correction, as the passages kept, removed and added, for the corrected-text comparison (R55.2).
 * Whitespace is kept as written. Past 1,500 words on either side nothing is compared word by word: the two are shown as a removal and an addition.
 */
export function compareTexts(before: string, after: string): readonly Piece[] {
  const a = before.split(/(\s+)/u).filter((token) => token !== '');
  const b = after.split(/(\s+)/u).filter((token) => token !== '');
  if (a.length > TOKEN_LIMIT || b.length > TOKEN_LIMIT) return [...(before === '' ? [] : [{ kind: 'removed' as const, text: before }]), ...(after === '' ? [] : [{ kind: 'added' as const, text: after }])];
  const table: number[][] = Array.from({ length: a.length + 1 }, () => Array.from<number>({ length: b.length + 1 }).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) for (let j = b.length - 1; j >= 0; j -= 1) table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  const pieces: Piece[] = [];
  const push = (kind: Piece['kind'], text: string) => {
    const last = pieces.at(-1);
    if (last?.kind === kind) pieces[pieces.length - 1] = { kind, text: last.text + text }; else pieces.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { push('same', a[i]!); i += 1; j += 1; } else if (table[i + 1]![j]! >= table[i]![j + 1]!) { push('removed', a[i]!); i += 1; } else { push('added', b[j]!); j += 1; }
  }
  for (; i < a.length; i += 1) push('removed', a[i]!);
  for (; j < b.length; j += 1) push('added', b[j]!);
  return pieces;
}

/** The words a reviewer flagged, cut from the derived text by the offsets the Worker already checked. */
export const flaggedText = (text: string | null, passage: { readonly start: number; readonly end: number }): string | undefined => (text === null ? undefined : text.slice(passage.start, passage.end));
