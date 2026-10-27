import { fc } from '@researchforce/testing/fc';
import { partialDate } from '../src/dates';

// Scalar values exclude isolated UTF-16 surrogates; include combining marks explicitly.
export const scalarArb = fc.oneof(
  fc.constantFrom('a', 'é', 'e', '\u0301', 'ß', '“', '\r', '\n', '😀', '𐀀', ' ', '\u2003'),
  fc.integer({ min: 0, max: 0x10ffff }).filter((point) => point < 0xd800 || point > 0xdfff).map((point) => String.fromCodePoint(point)),
);
export const scalarTextArb = fc.array(scalarArb, { maxLength: 24 }).map((characters) => characters.join(''));
export const partialDateArb = fc.record({
  year: fc.integer({ min: 1, max: 9999 }), month: fc.integer({ min: 1, max: 12 }),
  day: fc.integer({ min: 1, max: 28 }), precision: fc.integer({ min: 1, max: 3 }), approx: fc.boolean(),
}).map(({ year, month, day, precision, approx }) => {
  const fields = [String(year).padStart(4, '0'), String(month).padStart(2, '0'), String(day).padStart(2, '0')];
  return partialDate(fields.slice(0, precision).join('-'), approx);
});
