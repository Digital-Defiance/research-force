import { expect, it } from 'vitest';
import { formatRecordedTime, localDateRangeToUTC, partialDate } from '@researchforce/domain/dates';
import { asTimestamp } from '@researchforce/domain/types';

it('uses the same date and time-zone rules inside workerd as in the pure package', () => {
  const date = partialDate('2026-03-08');
  expect(localDateRangeToUTC({ start: date, end: date }, 'America/New_York')).toEqual({ start: '2026-03-08T05:00:00.000Z', endExclusive: '2026-03-09T04:00:00.000Z' });
  expect(formatRecordedTime(asTimestamp('2026-01-01T00:00:00.000Z'), 'workspace', 'Asia/Kathmandu')).toBe('1 January 2026 05:45:00 Asia/Kathmandu');
  expect(localDateRangeToUTC({ start: partialDate('0001-01-01') }, 'UTC')).toEqual({ start: '0001-01-01T00:00:00.000Z' });
});
