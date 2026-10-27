// Feature: research-collab-cms, Property 91: Dates and times follow precision and zone rules
import { expect, it } from 'vitest';
import { fc } from '@researchforce/testing/fc';
import { partialDateArb } from '../arbitraries';
import { asTimestamp } from '../../src/types';
import { dateBounds, dateCSVFields, datePrecision, dateSortKey, exportDate, formatDate, formatEnteredTime, formatRecordedTime, localDateRangeToUTC, metadataDate, partialDate, toISODate, todayInZone } from '../../src/dates';

const zones = ['UTC', 'America/Los_Angeles', 'America/New_York', 'Europe/Berlin', 'Asia/Kathmandu', 'Australia/Lord_Howe', 'Pacific/Apia'] as const;
const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

it('preserves precision and entered offsets and uses the correct zone for recorded instants', () => {
  fc.assert(fc.property(
    partialDateArb,
    fc.integer({ min: Date.UTC(1970, 0, 1), max: Date.UTC(2035, 11, 31) }),
    fc.constantFrom(...zones),
    fc.constantFrom('Z', '+05:45', '-07:00', '+12:45', '+00:00'),
    fc.boolean(),
    (date, milliseconds, zone, enteredOffset, fraction) => {
      const fields = date.value.split('-');
      const [year, month, day] = fields;
      const expected = `${date.approx ? 'c. ' : ''}${day === undefined ? '' : `${Number(day)} `}${month === undefined ? '' : `${monthNames[Number(month) - 1]} `}${year}`;
      expect(formatDate(date)).toBe(expected);
      expect(datePrecision(date)).toBe(['year', 'month', 'day'][fields.length - 1]);
      expect(dateSortKey(date)).toBe([year, month ?? '01', day ?? '01'].join('-'));
      expect(toISODate(date)).toBe(date.value);
      expect(exportDate(date)).toEqual(date);
      expect(dateCSVFields(date)).toEqual({ date: date.value, approximate: date.approx });
      // Independent calendar construction also checks Date.UTC's special handling of years 00..99.
      const start = Date.parse(`${year}-${month ?? '01'}-${day ?? '01'}T00:00:00.000Z`);
      expect(dateBounds(date).start).toBe(start);
      const end = new Date(start);
      if (fields.length === 1) end.setUTCFullYear(Number(year) + 1);
      else if (fields.length === 2) end.setUTCMonth(Number(month));
      else end.setUTCDate(end.getUTCDate() + 1);
      expect(dateBounds(date).endExclusive).toBe(end.getTime());

      const instant = asTimestamp(new Date(milliseconds).toISOString());
      const projection = (targetZone: string): string => {
        const values = new Intl.DateTimeFormat('en-US', { timeZone: targetZone, year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(milliseconds);
        const value = (type: Intl.DateTimeFormatPartTypes): string => values.find((part) => part.type === type)!.value;
        return `${value('day')} ${value('month')} ${value('year')} ${value('hour')}:${value('minute')}:${value('second')} ${targetZone}`;
      };
      for (const context of ['workspace', 'member_email'] as const) expect(formatRecordedTime(instant, context, zone)).toBe(projection(zone));
      for (const context of ['public', 'print', 'archive', 'submitter_email', 'metadata'] as const) expect(formatRecordedTime(instant, context, zone)).toBe(projection('UTC'));
      expect(formatRecordedTime(instant, 'workspace')).toBe(projection('UTC'));
      const localDate = new Date(milliseconds).toLocaleDateString('sv-SE', { timeZone: zone });
      expect(todayInZone(instant, zone).value).toBe(localDate);
      const entered = `${instant.slice(0, 19)}${fraction ? '.123400' : ''}${enteredOffset}`;
      const enteredDay = new Date(`${instant.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' });
      expect(formatEnteredTime(entered)).toBe(`${enteredDay} ${entered.slice(11, enteredOffset === 'Z' ? -1 : -6)} UTC${enteredOffset === 'Z' ? '' : enteredOffset}`);
      expect(metadataDate(instant, 'schema.org')).toBe(instant.slice(0, 10));
      expect(metadataDate(instant, 'citation')).toBe(instant.slice(0, 10).replaceAll('-', '/'));

      const range = localDateRangeToUTC({ start: partialDate(localDate), end: partialDate(localDate) }, zone);
      const lo = Date.parse(range.start!);
      const hi = Date.parse(range.endExclusive!);
      expect(milliseconds).toBeGreaterThanOrEqual(lo);
      expect(milliseconds).toBeLessThan(hi);
      // Compare interval membership to Intl's calendar-date result, including exact boundary milliseconds.
      for (const sample of [lo - 1, lo, lo + 1, hi - 1, hi, hi + 1, milliseconds - 86_400_000, milliseconds + 86_400_000]) {
        expect(sample >= lo && sample < hi).toBe(new Date(sample).toLocaleDateString('sv-SE', { timeZone: zone }) === localDate);
      }
    },
  ));
});
