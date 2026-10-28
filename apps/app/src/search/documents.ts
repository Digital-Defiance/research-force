import type { LabelKind } from '@researchforce/domain/label-marks';
import { isLabelSpan } from '@researchforce/domain/label-marks';
import type { Span } from '@researchforce/domain/richtext';
import type { CreditEntry, ItemKind, Level, ULID } from '@researchforce/domain/types';

/** A label over part of a document's body, in UTF-16 offsets of the body (R21.7). */
export interface DocSpan { readonly k: LabelKind; readonly s: number; readonly e: number; readonly source?: string }

/** One row of `search_docs`, with the Members its Credit names. */
export interface SearchDoc {
  readonly unitId: ULID;
  /** The unit a result links to: the document's own, or a Dissent_Note's Research_Item. */
  readonly resultUnitId: ULID;
  readonly rootId: ULID;
  readonly rootKind: ItemKind;
  readonly projectId: ULID;
  readonly unitType: string;
  readonly level: Level;
  readonly createdAt: string;
  readonly completed: boolean;
  readonly withdrawn: boolean;
  readonly superseded: boolean;
  readonly title: string;
  readonly body: string;
  readonly spans: readonly DocSpan[];
  readonly credits: readonly ULID[];
}

/** The text of a document under construction, with the label spans of the rich text added to it. */
export class Body {
  #text = '';
  readonly spans: DocSpan[] = [];
  get text(): string { return this.#text; }

  /** Add a plain field; nothing is added for an empty one. */
  plain(value: string | null | undefined): this {
    if (value === null || value === undefined || value.trim() === '') return this;
    this.#text += (this.#text === '' ? '' : '\n') + value;
    return this;
  }

  /** Add a rich field and its Quote, Paraphrase, and Source_Reported labels at their place in the body. */
  rich(value: string | null | undefined, spans: readonly Span[] | string | null | undefined): this {
    if (value === null || value === undefined || value.trim() === '') return this;
    const offset = this.#text === '' ? 0 : this.#text.length + 1;
    this.plain(value);
    const parsed: readonly Span[] = typeof spans === 'string' ? JSON.parse(spans) as Span[] : spans ?? [];
    for (const span of parsed) {
      if (isLabelSpan(span)) this.spans.push({ k: span.k, s: offset + span.s, e: offset + span.e, ...(span.source === undefined ? {} : { source: span.source }) });
    }
    return this;
  }
}

/** The words a Credit entry contributes to the document of an Item it credits: names and affiliations (R21.1). */
export function creditWords(credit: readonly CreditEntry[], names: ReadonlyMap<string, string>): string[] {
  return credit.flatMap((entry): string[] => {
    if ('member' in entry) return [names.get(entry.member) ?? ''];
    if ('outside' in entry) return [entry.outside.name, entry.outside.affiliation ?? ''];
    return [entry.imported];
  }).filter((word) => word !== '');
}

export const creditMembers = (credit: readonly CreditEntry[]): ULID[] => credit.flatMap((entry) => ('member' in entry ? [entry.member] : []));
