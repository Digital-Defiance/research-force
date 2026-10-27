import { expect, it } from 'vitest';
import { newItemIdentifier, newSubmissionReference } from '@researchforce/domain/identifiers';
import { searchTokens } from '@researchforce/domain/search-text';

it('uses native cryptographic randomness and Unicode search folding in workerd', () => {
  const item = newItemIdentifier();
  expect(item.identifier).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){2}$/);
  expect(item.registryKey).toBe(item.identifier.toLowerCase());
  expect(newSubmissionReference()).toMatch(/^RS-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  expect(searchTokens('CAFÉ Straße ẞ ＡＢＣ')).toEqual(['cafe', 'strasse', 'ss', 'abc']);
});
