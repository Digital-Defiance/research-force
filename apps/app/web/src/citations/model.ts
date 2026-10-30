import { CITATION_ROLE_NAMES, CITATION_ROLES } from '@researchforce/domain/citations';
import type { CitationRole, Locator, LocatorType } from '@researchforce/domain/citations';

/** The shapes the citation routes answer with (R54.6). */
export interface CitationRow {
  readonly id: string;
  readonly citingUnitId: string;
  readonly citingField: string;
  readonly target: { readonly type: 'source' | 'attachment' | 'text'; readonly unitId: string; readonly field?: string };
  readonly role: CitationRole;
  readonly locator: Locator;
  readonly locatorLabel: string;
  readonly state: 'current' | 'earlier_version';
  readonly retiredAt: string | null;
  readonly citing: { readonly rootId: string; readonly identifier: string; readonly title: string; readonly kind: string };
  readonly targetRecord: { readonly rootId: string; readonly identifier: string; readonly title: string; readonly kind: string };
  readonly targetLabel: string;
}
export interface CitationPage { readonly citations: readonly CitationRow[]; readonly next: string | null }
export interface EvidenceWarning { readonly citationId: string; readonly kind: 'unresolved' | 'earlier_version' | 'rights_not_covered'; readonly message: string }
export interface LegacyReference { readonly field: string; readonly kind: string; readonly source: string; readonly text: string }

export const ROLE_OPTIONS = CITATION_ROLES.map((role) => ({ value: role, label: CITATION_ROLE_NAMES[role] }));
export const LOCATOR_OPTIONS: readonly { readonly value: LocatorType; readonly label: string }[] = [
  { value: 'page', label: 'Page or pages' }, { value: 'folio', label: 'Folio' }, { value: 'section', label: 'Section or paragraph' },
  { value: 'text_range', label: 'Stretch of text' }, { value: 'image_region', label: 'Region of an image' }, { value: 'unresolved', label: 'Not yet resolved (in words)' },
];

/** What the form collects for a locator, all as the Member typed it. */
export interface LocatorDraft {
  readonly type: LocatorType;
  readonly from: string; readonly to: string; readonly section: string; readonly paragraph: string;
  readonly start: string; readonly end: string; readonly page: string; readonly x: string; readonly y: string; readonly width: string; readonly height: string; readonly text: string;
}
export const EMPTY_DRAFT: LocatorDraft = { type: 'page', from: '', to: '', section: '', paragraph: '', start: '', end: '', page: '', x: '', y: '', width: '', height: '', text: '' };

const whole = (value: string): number | undefined => (/^\d{1,9}$/u.test(value.trim()) ? Number(value.trim()) : undefined);
const real = (value: string): number | undefined => (/^\d*\.?\d+$/u.test(value.trim()) ? Number(value.trim()) : undefined);
const folio = (value: string): { number: number; side?: 'r' | 'v' } | undefined => {
  const match = /^(\d{1,6})\s*([rv])?$/iu.exec(value.trim());
  return match === null ? undefined : { number: Number(match[1]), ...(match[2] === undefined ? {} : { side: match[2].toLowerCase() as 'r' | 'v' }) };
};

/** A locator from the form's text, or the reason it cannot be built; the Worker validates it again against the cited record. */
export function buildLocator(draft: LocatorDraft): Locator | string {
  switch (draft.type) {
    case 'page': {
      const from = whole(draft.from);
      const to = draft.to.trim() === '' ? undefined : whole(draft.to);
      if (from === undefined) return 'Enter the page as a whole number.';
      if (draft.to.trim() !== '' && to === undefined) return 'Enter the last page as a whole number.';
      return to === undefined ? { type: 'page', from } : { type: 'page', from, to };
    }
    case 'folio': {
      const from = folio(draft.from);
      const to = draft.to.trim() === '' ? undefined : folio(draft.to);
      if (from === undefined) return 'Enter the folio as a number, optionally with r or v, such as 4v.';
      if (draft.to.trim() !== '' && to === undefined) return 'Enter the last folio as a number, optionally with r or v.';
      return to === undefined ? { type: 'folio', from } : { type: 'folio', from, to };
    }
    case 'section': {
      if (draft.section.trim() === '') return 'Name the section.';
      const paragraph = draft.paragraph.trim() === '' ? undefined : whole(draft.paragraph);
      if (draft.paragraph.trim() !== '' && paragraph === undefined) return 'Enter the paragraph as a whole number.';
      return paragraph === undefined ? { type: 'section', section: draft.section.trim() } : { type: 'section', section: draft.section.trim(), paragraph };
    }
    case 'text_range': {
      const start = whole(draft.start);
      const end = whole(draft.end);
      if (start === undefined || end === undefined) return 'Enter where the stretch starts and ends, in UTF-16 code units.';
      return { type: 'text_range', start, end };
    }
    case 'image_region': {
      const [x, y, width, height] = [real(draft.x), real(draft.y), real(draft.width), real(draft.height)];
      if (x === undefined || y === undefined || width === undefined || height === undefined) return 'Enter the region as fractions of the image between 0 and 1.';
      const page = draft.page.trim() === '' ? undefined : whole(draft.page);
      if (draft.page.trim() !== '' && page === undefined) return 'Enter the page as a whole number.';
      return { type: 'image_region', ...(page === undefined ? {} : { page }), x, y, width, height };
    }
    case 'unresolved':
      return draft.text.trim() === '' ? 'Say where the passage is, in words.' : { type: 'unresolved', text: draft.text.trim() };
  }
}
