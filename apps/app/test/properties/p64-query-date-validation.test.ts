// Feature: research-collab-cms, Property 64: Query and date-range validation
import { describe, expect, it } from 'vitest';
import { localDateRangeToUTC } from '@researchforce/domain/dates';
import { validate } from '@researchforce/domain/schemas/common';
import { ITEM_KINDS, LEVELS, isULID } from '@researchforce/domain/types';
import type { PartialDate } from '@researchforce/domain/types';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { searchParams } from '../../src/search/query';
import { feedMatch } from '../../src/activity/feed';
import { logFilterSchema } from '../../src/projects/log';
import { parse } from '../../src/api/input';
import { ApiError } from '../../src/api/errors';

/**
 * Validates R21.9, R43.8 (and notes R30.11): the search query schema accepts exactly the well-formed queries and
 * filters and refuses the malformed ones with a located field issue, and the shared inclusive Log_Date range parser
 * `localDateRangeToUTC` accepts a valid day-precision range (returning a half-open [start, endExclusive) that bounds the
 * inclusive local interval exactly) and refuses an end before the start and a non-day-precision date, consistently
 * across the surfaces that call it (the search, the Project_Log, and the feed).
 *
 * R30.11 — the CSV preview bounded-streaming/truncation rule — has its own dedicated coverage from task 30.11, so this
 * property does not duplicate it; Property 64's novel contribution is the query and date-range validation above.
 */

/** Several zones: UTC, a +13 summer zone, a +12/+13 date-line zone, a negative-offset zone, and a half-hour zone. */
const ZONES = ['UTC', 'Pacific/Auckland', 'Pacific/Chatham', 'America/Los_Angeles', 'Asia/Kolkata', 'Europe/Berlin'] as const;

/** The local calendar date of a UTC instant in a zone, as YYYY-MM-DD, built independently with Intl. */
function localDate(instant: number, zone: string): string {
  const fields = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB-u-ca-gregory-nu-latn', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hourCycle: 'h23', era: 'short' })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  return `${fields['year']!.padStart(4, '0')}-${fields['month']}-${fields['day']}`;
}
/** The local wall-clock hour:minute:second of a UTC instant in a zone, built independently with Intl. */
function localTime(instant: number, zone: string): string {
  const fields = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB-u-ca-gregory-nu-latn', { timeZone: zone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  return `${fields['hour']}:${fields['minute']}:${fields['second']}`;
}
/** The calendar date one day after a YYYY-MM-DD date, computed purely. */
function dayAfter(day: string): string {
  const next = new Date(`${day}T00:00:00.000Z`).getTime() + 86_400_000;
  return new Date(next).toISOString().slice(0, 10);
}

/** A day-precision date string in a range that straddles DST transitions in the zones above. */
const dayStringArb = fc
  .date({ min: new Date('2020-01-01T00:00:00.000Z'), max: new Date('2030-12-31T00:00:00.000Z'), noInvalidDate: true })
  .map((date) => date.toISOString().slice(0, 10));
/** A date at year or month precision, used to drive the day-precision refusal. */
const coarseDateArb = fc.oneof(
  fc.integer({ min: 2020, max: 2030 }).map((year): PartialDate => ({ value: String(year), approx: false })),
  fc.tuple(fc.integer({ min: 2020, max: 2030 }), fc.integer({ min: 1, max: 12 })).map(([year, month]): PartialDate => ({ value: `${year}-${String(month).padStart(2, '0')}`, approx: false })),
);
const dayDateArb = dayStringArb.map((value): PartialDate => ({ value, approx: false }));

const toMessage = (error: unknown): string => (error instanceof RangeError ? error.message : String(error));

describe('Property 64: Query and date-range validation', () => {
  it('parses a valid inclusive day range into a half-open interval that bounds the local dates exactly (R43.8)', () => {
    fc.assert(fc.property(dayDateArb, dayDateArb, fc.constantFrom(...ZONES), (a, b, zone) => {
      // Independent model: order the two day-precision dates, then require start <= end.
      const [start, end] = a.value <= b.value ? [a, b] : [b, a];
      const result = localDateRangeToUTC({ start, end }, zone);
      expect(result.start).toBeDefined();
      expect(result.endExclusive).toBeDefined();
      const startMs = Date.parse(result.start!);
      const endMs = Date.parse(result.endExclusive!);
      // The interval is non-empty and half-open.
      expect(startMs).toBeLessThan(endMs);
      // `start` is the first instant of start's local day: that instant lands on start's date at local midnight, and
      // one millisecond earlier lands on the previous local date.
      expect(localDate(startMs, zone)).toBe(start.value);
      expect(localTime(startMs, zone)).toBe('00:00:00');
      expect(localDate(startMs - 1, zone) < start.value).toBe(true);
      // `endExclusive` is the first instant of the local day AFTER end: it lands on (end + 1 day) at local midnight, and
      // one millisecond earlier is still within end's inclusive day.
      expect(localDate(endMs, zone)).toBe(dayAfter(end.value));
      expect(localTime(endMs, zone)).toBe('00:00:00');
      expect(localDate(endMs - 1, zone)).toBe(end.value);
    }), { numRuns: FC_RUNS });
  });

  it('parses an open-ended range: a start alone, an end alone, or neither (R43.8)', () => {
    fc.assert(fc.property(dayDateArb, fc.constantFrom(...ZONES), (date, zone) => {
      const onlyStart = localDateRangeToUTC({ start: date }, zone);
      expect(onlyStart.start).toBeDefined();
      expect(onlyStart.endExclusive).toBeUndefined();
      expect(localDate(Date.parse(onlyStart.start!), zone)).toBe(date.value);

      const onlyEnd = localDateRangeToUTC({ end: date }, zone);
      expect(onlyEnd.start).toBeUndefined();
      expect(onlyEnd.endExclusive).toBeDefined();
      expect(localDate(Date.parse(onlyEnd.endExclusive!), zone)).toBe(dayAfter(date.value));

      expect(localDateRangeToUTC({}, zone)).toEqual({});
    }), { numRuns: FC_RUNS });
  });

  it('refuses an end strictly before the start with the precedes RangeError (R43.8)', () => {
    fc.assert(fc.property(dayDateArb, dayDateArb, fc.constantFrom(...ZONES), (a, b, zone) => {
      fc.pre(a.value !== b.value);
      const [start, end] = a.value < b.value ? [b, a] : [a, b]; // end strictly before start
      expect(() => localDateRangeToUTC({ start, end }, zone)).toThrow(RangeError);
      try {
        localDateRangeToUTC({ start, end }, zone);
        throw new Error('expected a refusal');
      } catch (error) {
        expect(toMessage(error)).toBe('The end date precedes the start date.');
      }
    }), { numRuns: FC_RUNS });
  });

  it('refuses a non-day-precision date with the day-precision RangeError (R43.8)', () => {
    fc.assert(fc.property(coarseDateArb, fc.option(dayDateArb, { nil: undefined }), fc.boolean(), fc.constantFrom(...ZONES), (coarse, day, asStart, zone) => {
      const range = asStart ? { start: coarse, ...(day === undefined ? {} : { end: day }) } : { end: coarse, ...(day === undefined ? {} : { start: day }) };
      try {
        localDateRangeToUTC(range, zone);
        throw new Error('expected a refusal');
      } catch (error) {
        expect(toMessage(error)).toBe('Date filters require day precision.');
      }
    }), { numRuns: FC_RUNS });
  });

  // An input shaped like a searchParams body: each field valid or malformed, so the schema is driven over both.
  const KINDS = [...ITEM_KINDS];
  const validId = '01J0000000000000000000MEM1';
  const idFieldArb = fc.oneof(
    fc.constant(undefined),
    fc.constant(validId),
    fc.constant('01J0000000000000000000MEM2'),
    fc.constant('not-an-id'),
    fc.constant('01J0000000000000000000ILOU'), // I, L, O, U are not Crockford base-32 digits
    fc.constant(''),
  );
  const dateFieldArb = fc.oneof(
    fc.constant(undefined),
    dayStringArb,
    fc.constant('2026-13-40'), // matches the shape but not a real date; the schema only checks the shape
    fc.constant('2026-1-1'),
    fc.constant('not-a-date'),
    fc.constant('20260101'),
  );
  const optional = <T>(arb: fc.Arbitrary<T>): fc.Arbitrary<T | undefined> => fc.oneof(fc.constant(undefined), arb);
  const paramArb = fc.record({
    q: optional(fc.string()),
    kind: fc.oneof(fc.constant(undefined), fc.constantFrom(...KINDS), fc.constant('not_a_kind')),
    level: fc.oneof(fc.constant(undefined), fc.constantFrom(...LEVELS), fc.constant('not_a_level')),
    person: idFieldArb,
    specialty: idFieldArb,
    project: idFieldArb,
    from: dateFieldArb,
    to: dateFieldArb,
    after: fc.oneof(fc.constant(undefined), fc.constant('1.0'), fc.constant('2.123'), fc.constant('x.y'), fc.constant('3.0')),
  });

  /** The independent validity model of the searchParams fields (R21.9). */
  function wellFormed(input: Record<string, unknown>): boolean {
    if (typeof input['q'] !== 'string') return false; // q is required
    if (input['kind'] !== undefined && !KINDS.includes(input['kind'] as (typeof KINDS)[number])) return false;
    if (input['level'] !== undefined && !(LEVELS as readonly string[]).includes(input['level'] as string)) return false;
    for (const key of ['person', 'specialty', 'project'] as const) {
      const value = input[key];
      if (value !== undefined && !(typeof value === 'string' && isULID(value))) return false;
    }
    for (const key of ['from', 'to'] as const) {
      const value = input[key];
      if (value !== undefined && !(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value))) return false;
    }
    const after = input['after'];
    if (after !== undefined && !(typeof after === 'string' && /^[12]\.\d{1,19}$/u.test(after))) return false;
    return true;
  }

  it('accepts exactly the well-formed searchParams and locates a field issue on the malformed ones (R21.9)', () => {
    fc.assert(fc.property(paramArb, (raw) => {
      // Drop undefined keys so the model and the schema see the same object.
      const input = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined));
      const result = validate(searchParams, input);
      expect(result.ok).toBe(wellFormed(input));
      if (!result.ok) {
        // Every issue names a field that exists in the input (or `q` for the missing required query).
        expect(result.issues.length).toBeGreaterThan(0);
        for (const issue of result.issues) expect(issue.field.length).toBeGreaterThan(0);
      }
    }), { numRuns: FC_RUNS });
  });

  it('surfaces the same date-range refusal across the search, the log, and the feed filters (R43.8)', () => {
    // The search, Project_Log, and Activity_Feed all parse the inclusive Log_Date range through the shared
    // `localDateRangeToUTC`; an end before the start is a located 422 on `to` on each surface.
    fc.assert(fc.property(dayStringArb, dayStringArb, fc.constantFrom(...ZONES), (a, b, zone) => {
      fc.pre(a !== b);
      const [from, to] = a < b ? [b, a] : [a, b]; // `to` strictly before `from`

      // The feed drives the shared parser directly and raises the located validation error.
      const feedError = (() => { try { feedMatch({ from, to }, zone); return undefined; } catch (error) { return error; } })();
      expect(feedError).toBeInstanceOf(ApiError);
      expect((feedError as ApiError).code).toBe('validation');
      expect((feedError as ApiError).extra.fields).toEqual([{ field: 'to', rule: 'The end date precedes the start date.' }]);

      // The same from/to parse cleanly as log and search filters (the 422 arises only when the range is parsed, which
      // the route does with the viewer's zone; the schema itself only checks the YYYY-MM-DD shape).
      expect(parse(logFilterSchema, { from, to })).toEqual({ from, to });
      expect(validate(searchParams, { q: 'plover', from, to }).ok).toBe(true);

      // And the shared parser agrees from the search's own call site shape.
      expect(() => localDateRangeToUTC({ start: { value: from, approx: false }, end: { value: to, approx: false } }, zone)).toThrow('The end date precedes the start date.');
    }), { numRuns: FC_RUNS });
  });
});
