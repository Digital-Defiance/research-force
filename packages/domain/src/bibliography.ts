import { z } from 'zod';
import { fragmentDigest } from './text-fragments';
import { fullDateSchema, partialDateSchema, textField } from './schemas/common';

/** R54.1: the bibliographic description of a Source, kept apart from the record's Owner and Credit. */
export const BIBLIOGRAPHY_LIMITS = Object.freeze({ creators: 50, identifiers: 20, nameCodePoints: 300, editionCodePoints: 200, valueCodePoints: 500, urlCodePoints: 2000 });
export const CREATOR_ROLES = ['author', 'editor', 'translator', 'compiler', 'addressee', 'photographer', 'issuer', 'other'] as const;
export type CreatorRole = typeof CREATOR_ROLES[number];
export const IDENTIFIER_SCHEMES = ['doi', 'isbn', 'issn', 'ark', 'handle', 'oclc', 'other'] as const;
export type IdentifierScheme = typeof IDENTIFIER_SCHEMES[number];
export const CREATOR_ROLE_NAMES: Readonly<Record<CreatorRole, string>> = Object.freeze({
  author: 'Author', editor: 'Editor', translator: 'Translator', compiler: 'Compiler', addressee: 'Addressee', photographer: 'Photographer', issuer: 'Issuer', other: 'Other',
});

/** A language tag such as `de`, `de-AT`, or `grc-Latn`; the tag is stored as entered, in lower case for the language part. */
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,4}$/u;
/** Absolute http or https addresses only, without spaces; the address is stored as entered. */
const urlSchema = textField(BIBLIOGRAPHY_LIMITS.urlCodePoints, true).regex(/^https?:\/\/[^\s/?#@]+(?::\d{1,5})?(?:[/?#]\S*)?$/iu, 'Use a complete http or https address without spaces.');

export const creatorSchema = z.strictObject({ name: textField(BIBLIOGRAPHY_LIMITS.nameCodePoints, true), role: z.enum(CREATOR_ROLES) });
export const identifierSchema = z.strictObject({ scheme: z.enum(IDENTIFIER_SCHEMES), value: textField(BIBLIOGRAPHY_LIMITS.valueCodePoints, true) });

/**
 * Ordered creators with roles, the publication date at its entered precision, edition, language, persistent identifiers, an external
 * address and the date it was accessed. Spelling is kept exactly as entered (R54.1).
 */
export const bibliographySchema = z.strictObject({
  creators: z.array(creatorSchema).max(BIBLIOGRAPHY_LIMITS.creators).prefault([]),
  publicationDate: partialDateSchema.optional(),
  edition: textField(BIBLIOGRAPHY_LIMITS.editionCodePoints, true).optional(),
  language: z.string().regex(LANGUAGE_TAG, 'Use a language tag such as de or de-AT.').optional(),
  identifiers: z.array(identifierSchema).max(BIBLIOGRAPHY_LIMITS.identifiers).prefault([]),
  url: urlSchema.optional(),
  accessDate: z.string().refine((value) => fullDateSchema.safeParse({ value, approx: false }).success, 'Use a full calendar date such as 2026-10-29.').optional(),
}).superRefine((value, ctx) => {
  const seen = new Set<string>();
  for (const [index, identifier] of value.identifiers.entries()) {
    const key = `${identifier.scheme}\u0000${identifier.value}`;
    if (seen.has(key)) ctx.addIssue({ code: 'custom', path: ['identifiers', index, 'value'], message: 'Each identifier can be listed once.' });
    seen.add(key);
  }
  if (value.accessDate !== undefined && value.url === undefined) ctx.addIssue({ code: 'custom', path: ['accessDate'], message: 'An access date goes with an external address.' });
});
export type Bibliography = z.output<typeof bibliographySchema>;

/** Whether a bibliography holds anything to store. */
export function bibliographyIsEmpty(value: Bibliography | undefined): boolean {
  return value === undefined || (value.creators.length === 0 && value.identifiers.length === 0 && value.publicationDate === undefined && value.edition === undefined
    && value.language === undefined && value.url === undefined && value.accessDate === undefined);
}

/** The citable description of a Source, which an Evidence_Citation to the Source is bound to (R54.2, R54.3). */
export interface CitableSource {
  readonly title: string;
  readonly documentDate?: unknown;
  readonly archiveOrCollection?: string | undefined;
  readonly archivalReference?: string | undefined;
  readonly bibliography?: Bibliography | undefined;
}
/** A digest of everything a citation to a Source relies on; any change to it makes earlier citations refer to an earlier version. */
export function sourceVersionDigest(source: CitableSource): string {
  const { bibliography } = source;
  return fragmentDigest({
    version: 'source-citable-v1', title: source.title, documentDate: source.documentDate ?? null, archiveOrCollection: source.archiveOrCollection ?? null,
    archivalReference: source.archivalReference ?? null,
    bibliography: bibliographyIsEmpty(bibliography) ? null : { ...bibliography, publicationDate: bibliography!.publicationDate ?? null },
  });
}
