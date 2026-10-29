import { describe, expect, it } from 'vitest';
import { asTimestamp } from '../src/types';
import type { ItemKind } from '../src/types';
import { dateBounds, dateCSVFields, datePrecision, dateRange, dateSortKey, endFallsBeforeStart, enteredTimestamp, exportDate, formatDate, formatEnteredTime, formatRecordedTime, isTimeZone, itemDate, localDateRangeToUTC, logDate, metadataDate, partialDate, todayInZone } from '../src/dates';

describe('date precision and calendar rules', () => {
  it.each([
    ['1943-05-05', 'day', '5 May 1943', '1943-05-05'],
    ['1943-05', 'month', 'May 1943', '1943-05-01'],
    ['1943', 'year', '1943', '1943-01-01'],
    ['0001-01-01', 'day', '1 January 0001', '0001-01-01'],
  ] as const)('keeps the recorded precision of %s', (input, precision, display, sort) => {
    const date = partialDate(input, true);
    expect(datePrecision(date)).toBe(precision);
    expect(formatDate(date)).toBe(`c. ${display}`);
    expect(dateSortKey(date)).toBe(sort);
    expect(exportDate(date)).toEqual({ value: input, approx: true });
    expect(dateCSVFields(date)).toEqual({ date: input, approximate: true });
  });

  it.each(['0000', '1943-2', '1943-00', '1943-13', '1900-02-29', '1943-04-31', '1943-05-00', ' 1943', '1943-05-05T00:00Z', '10000'])('rejects invalid or noncanonical dates: %s', (date) => {
    expect(() => partialDate(date)).toThrow(RangeError);
  });

  it('uses Gregorian leap years and overlapping periods when checking ranges', () => {
    expect(dateBounds(partialDate('2000-02')).endExclusive - dateBounds(partialDate('2000-02')).start).toBe(29 * 86_400_000);
    expect(() => partialDate('1944-02-29')).not.toThrow();
    expect(() => dateRange(partialDate('1943-05'), partialDate('1943-04'))).toThrow(RangeError);
    expect(endFallsBeforeStart(partialDate('1943-05'), partialDate('1943'))).toBe(false);
    expect(endFallsBeforeStart(partialDate('1943-05-05'), partialDate('1943-05'))).toBe(false);
    const range = dateRange(partialDate('1943', true), partialDate('1944-05'));
    expect(formatDate(range)).toBe('c. 1943 – May 1944');
    expect(dateSortKey(range)).toBe('1943-01-01');
  });
});

describe('local date filters', () => {
  it.each([
    ['America/New_York', '2026-03-08', '2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z'],
    ['America/New_York', '2026-11-01', '2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z'],
    ['Australia/Lord_Howe', '2026-10-04', '2026-10-03T13:30:00.000Z', '2026-10-04T13:00:00.000Z'],
    ['Asia/Kathmandu', '2026-01-01', '2025-12-31T18:15:00.000Z', '2026-01-01T18:15:00.000Z'],
    ['America/Sao_Paulo', '2018-11-04', '2018-11-04T03:00:00.000Z', '2018-11-05T02:00:00.000Z'],
    ['America/Havana', '2020-11-01', '2020-11-01T04:00:00.000Z', '2020-11-02T05:00:00.000Z'],
    ['Pacific/Apia', '2011-12-30', '2011-12-30T10:00:00.000Z', '2011-12-30T10:00:00.000Z'],
    ['UTC', '0001-01-01', '0001-01-01T00:00:00.000Z', '0001-01-02T00:00:00.000Z'],
    ['UTC', '9999-12-31', '9999-12-31T00:00:00.000Z', '+010000-01-01T00:00:00.000Z'],
  ])('resolves %s on %s, including nonstandard day lengths', (zone, date, start, endExclusive) => {
    expect(localDateRangeToUTC({ start: partialDate(date), end: partialDate(date) }, zone)).toEqual({ start, endExclusive });
  });

  it('supports open endpoints and refuses reversed dates, partial filter dates and invalid zones', () => {
    expect(localDateRangeToUTC({})).toEqual({});
    expect(localDateRangeToUTC({ start: partialDate('1943-05-05') })).toEqual({ start: '1943-05-05T00:00:00.000Z' });
    expect(localDateRangeToUTC({ end: partialDate('1943-05-05') })).toEqual({ endExclusive: '1943-05-06T00:00:00.000Z' });
    expect(() => localDateRangeToUTC({ start: partialDate('1944-01-01'), end: partialDate('1943-12-31') })).toThrow(RangeError);
    expect(() => localDateRangeToUTC({ start: partialDate('1943') })).toThrow(RangeError);
    for (const zone of ['+05:45', '', 'Not/AZone', ' UTC']) expect(isTimeZone(zone)).toBe(false);
    for (const zone of ['UTC', 'Europe/Berlin', 'Asia/Kathmandu']) expect(isTimeZone(zone)).toBe(true);
  });
});

describe('entered dates and recorded times', () => {
  const createdAt = asTimestamp('2026-01-01T00:30:00.000Z');

  it('keeps entered offsets and precision while recorded times follow their output context', () => {
    expect(formatEnteredTime('1943-05-05T23:30:00.123400-07:00')).toBe('5 May 1943 23:30:00.123400 UTC-07:00');
    expect(formatEnteredTime('1943-05-05T23:30:00Z')).toBe('5 May 1943 23:30:00 UTC');
    expect(formatRecordedTime(createdAt, 'workspace', 'America/Los_Angeles')).toBe('31 December 2025 16:30:00 America/Los_Angeles');
    expect(formatRecordedTime(createdAt, 'workspace')).toBe('1 January 2026 00:30:00 UTC');
    for (const context of ['public', 'print', 'archive', 'submitter_email', 'metadata'] as const) expect(formatRecordedTime(createdAt, context, 'America/Los_Angeles')).toBe('1 January 2026 00:30:00 UTC');
    expect(todayInZone(createdAt, 'America/Los_Angeles')).toEqual(partialDate('2025-12-31'));
    expect(metadataDate(createdAt, 'citation')).toBe('2026/01/01');
    expect(metadataDate(createdAt, 'schema.org')).toBe('2026-01-01');
  });

  it.each(['1943-02-29T12:00:00Z', '1943-05-05T24:00:00Z', '1943-05-05T12:60:00Z', '1943-05-05T12:00:60Z', '1943-05-05T12:00:00', '1943-05-05T12:00Z', '1943-05-05T12:00:00+24:00'])('refuses invalid entered times: %s', (value) => {
    expect(() => enteredTimestamp(value)).toThrow(RangeError);
  });

  it('computes each Item_Date and keeps Source Log_Dates tied to creation', () => {
    const entered = partialDate('1943-05', true);
    expect(itemDate({ kind: 'journal_entry', createdAt, startDate: entered })).toEqual(entered);
    expect(itemDate({ kind: 'correspondence', createdAt, date: entered })).toEqual(entered);
    expect(itemDate({ kind: 'archival_request', createdAt, dateSent: entered })).toEqual(entered);
    const documentDate = dateRange(entered, partialDate('1944'));
    expect(itemDate({ kind: 'source', createdAt, documentDate })).toEqual(documentDate);
    expect(logDate({ kind: 'source', createdAt, documentDate }, 'America/Los_Angeles')).toEqual(partialDate('2025-12-31'));
    expect(itemDate({ kind: 'run', createdAt, startTime: '1943-05-05T23:30:00-07:00' }, 'UTC')).toEqual(partialDate('1943-05-05'));
    for (const kind of ['finding', 'hypothesis', 'topic'] satisfies ItemKind[]) expect(logDate({ kind, createdAt }, 'America/Los_Angeles')).toEqual(partialDate('2025-12-31'));
    expect(itemDate({ kind: 'journal_entry', createdAt })).toEqual(partialDate('2026-01-01'));
    expect(logDate({ kind: 'journal_entry', createdAt, startDate: entered })).toEqual(entered);
  });
});
