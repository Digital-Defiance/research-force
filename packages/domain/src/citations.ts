import { z } from 'zod';
import type { FileKind } from './file-kinds';
import { cpLength } from './text';
import { idSchema, textField } from './schemas/common';

/** R54.2: at most 1,000 Evidence_Citations in a record, locator text of at most 1,000 characters, and bounded numbers. */
export const CITATION_LIMITS = Object.freeze({ perRecord: 1000, locatorCodePoints: 1000, sectionCodePoints: 200, pageMax: 100_000, fieldKeyCodePoints: 100 });
export const CITATION_ROLES = ['supports', 'contradicts', 'background', 'method'] as const;
export type CitationRole = typeof CITATION_ROLES[number];
export const CITATION_ROLE_NAMES: Readonly<Record<CitationRole, string>> = Object.freeze({ supports: 'Supports', contradicts: 'Contradicts', background: 'Background', method: 'Method' });
export const LOCATOR_TYPES = ['page', 'folio', 'section', 'text_range', 'image_region', 'unresolved'] as const;
export type LocatorType = typeof LOCATOR_TYPES[number];

const pageNumber = z.int().min(1).max(CITATION_LIMITS.pageMax);
const folioSchema = z.strictObject({ number: pageNumber, side: z.enum(['r', 'v']).optional() });
const unit = z.number().min(0).max(1);

/** The typed locators of R54.2. A text range counts UTF-16 code units of the cited text version, like every other span (R11). */
export const locatorSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('page'), from: pageNumber, to: pageNumber.optional() }),
  z.strictObject({ type: z.literal('folio'), from: folioSchema, to: folioSchema.optional() }),
  z.strictObject({ type: z.literal('section'), section: textField(CITATION_LIMITS.sectionCodePoints, true), paragraph: pageNumber.optional() }),
  z.strictObject({ type: z.literal('text_range'), start: z.int().min(0), end: z.int().min(1) }),
  z.strictObject({ type: z.literal('image_region'), page: pageNumber.optional(), x: unit, y: unit, width: unit, height: unit }),
  z.strictObject({ type: z.literal('unresolved'), text: textField(CITATION_LIMITS.locatorCodePoints, true) }),
]).superRefine((locator, ctx) => {
  const report = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  switch (locator.type) {
    case 'page':
      if (locator.to !== undefined && locator.to < locator.from) report(['to'], 'The last page precedes the first.');
      break;
    case 'folio':
      if (locator.to !== undefined && folioOrder(locator.to) < folioOrder(locator.from)) report(['to'], 'The last folio precedes the first.');
      break;
    case 'text_range':
      if (locator.end <= locator.start) report(['end'], 'The end of the range must come after its start.');
      break;
    case 'image_region':
      if (locator.width <= 0) report(['width'], 'The region needs a width above zero.');
      if (locator.height <= 0) report(['height'], 'The region needs a height above zero.');
      if (locator.x + locator.width > 1 + 1e-9) report(['width'], 'The region extends beyond the right edge.');
      if (locator.y + locator.height > 1 + 1e-9) report(['height'], 'The region extends beyond the bottom edge.');
      break;
    default:
  }
});
export type Locator = z.output<typeof locatorSchema>;

/** Folios run in order by number, the recto before the verso. */
const folioOrder = (folio: { number: number; side?: 'r' | 'v' | undefined }): number => folio.number * 2 + (folio.side === 'v' ? 1 : 0);

/** What an Evidence_Citation points at: a Source, an exact Attachment, or one field of a record at one text version (R54.2). */
export const citationTargetSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('source'), unitId: idSchema }),
  z.strictObject({ type: z.literal('attachment'), unitId: idSchema }),
  z.strictObject({ type: z.literal('text'), unitId: idSchema, field: textField(CITATION_LIMITS.fieldKeyCodePoints, true) }),
]);
export type CitationTarget = z.output<typeof citationTargetSchema>;

export const citationInputSchema = z.strictObject({
  citingUnitId: idSchema,
  citingField: textField(CITATION_LIMITS.fieldKeyCodePoints, true),
  target: citationTargetSchema,
  role: z.enum(CITATION_ROLES),
  locator: locatorSchema,
  /** The content hash the citing Member saw; the citation is refused if the target has changed since. */
  expectedHash: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
});
export type CitationInput = z.output<typeof citationInputSchema>;

/** The target as the records layer resolved it, which decides what a locator may say. */
export type LocatorTarget =
  | { readonly type: 'source' }
  | { readonly type: 'attachment'; readonly fileKind: FileKind }
  | { readonly type: 'text'; readonly text: string };
export interface LocatorIssue { readonly field: string; readonly rule: string }

const DOCUMENT_FILES: ReadonlySet<FileKind> = new Set(['pdf', 'image']);
const isHigh = (unitValue: number) => unitValue >= 0xd800 && unitValue <= 0xdbff;
const isLow = (unitValue: number) => unitValue >= 0xdc00 && unitValue <= 0xdfff;
/** Whether an offset falls between the two halves of a surrogate pair. */
export function splitsCodePoint(text: string, offset: number): boolean {
  return offset > 0 && offset < text.length && isHigh(text.charCodeAt(offset - 1)) && isLow(text.charCodeAt(offset));
}

/** Why a locator cannot describe `target` (R54.3): wrong type for the target, a range outside the text, or a cut inside a code point. */
export function locatorIssues(locator: Locator, target: LocatorTarget): LocatorIssue[] {
  const issues: LocatorIssue[] = [];
  const refuse = (field: string, rule: string) => issues.push({ field: `locator.${field}`, rule });
  switch (locator.type) {
    case 'unresolved': break;
    case 'page': case 'folio':
      if (target.type === 'text') refuse('type', 'A page or folio locator describes a document, not a text.');
      else if (target.type === 'attachment' && !DOCUMENT_FILES.has(target.fileKind)) refuse('type', 'A page or folio locator needs a PDF or an image.');
      break;
    case 'section': break;
    case 'text_range':
      if (target.type !== 'text') refuse('type', 'A text range describes a text.');
      else {
        if (locator.end > target.text.length) refuse('end', `The range ends beyond the text, which has ${target.text.length} UTF-16 code units.`);
        for (const edge of ['start', 'end'] as const) {
          if (locator[edge] <= target.text.length && splitsCodePoint(target.text, locator[edge])) refuse(edge, 'The range cuts a character in two.');
        }
      }
      break;
    case 'image_region':
      if (target.type !== 'attachment' || !DOCUMENT_FILES.has(target.fileKind)) refuse('type', 'An image region describes an image or a PDF Attachment.');
      else if (locator.page !== undefined && target.fileKind !== 'pdf') refuse('page', 'Only a PDF has pages.');
      break;
  }
  return issues;
}

/** How a locator reads wherever a citation is shown (R54.4). */
export function locatorLabel(locator: Locator): string {
  const range = (from: string, to: string | undefined) => (to === undefined || to === from ? from : `${from}–${to}`);
  const folio = (value: { number: number; side?: 'r' | 'v' | undefined }) => `${value.number}${value.side ?? ''}`;
  switch (locator.type) {
    case 'page': return `p. ${range(String(locator.from), locator.to === undefined ? undefined : String(locator.to))}`;
    case 'folio': return `fol. ${range(folio(locator.from), locator.to === undefined ? undefined : folio(locator.to))}`;
    case 'section': return locator.paragraph === undefined ? `§ ${locator.section}` : `§ ${locator.section}, para. ${locator.paragraph}`;
    case 'text_range': return `characters ${locator.start}–${locator.end}`;
    case 'image_region': {
      const percent = (value: number) => `${Math.round(value * 1000) / 10}%`;
      return `${locator.page === undefined ? '' : `p. ${locator.page}, `}region at ${percent(locator.x)}, ${percent(locator.y)}, ${percent(locator.width)} by ${percent(locator.height)}`;
    }
    case 'unresolved': return `${locator.text} (unresolved)`;
  }
}

/** The 1,000-character bound counts code points, like every other text bound (R54.2). */
export const locatorTextLength = (locator: Locator): number => (locator.type === 'unresolved' ? cpLength(locator.text) : locator.type === 'section' ? cpLength(locator.section) : 0);

/** How a citation relates to the current state of its target. */
export type CitationState = 'current' | 'earlier_version';
export const citationState = (citedHash: string, currentHash: string | undefined): CitationState => (currentHash !== undefined && currentHash === citedHash ? 'current' : 'earlier_version');
