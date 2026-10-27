import { asTimestamp } from './types';
import type { DateRange, DocumentDate, ItemKind, PartialDate, Timestamp } from './types';

export type DatePrecision = 'year' | 'month' | 'day';
export const APPROXIMATE_MARK = 'c. ';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;
const DAY = 86_400_000;
const pad = (value: number, length = 2): string => String(value).padStart(length, '0');

function utc(year: number, month = 1, day = 1, hour = 0, minute = 0, second = 0): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime();
}

export function daysInMonth(year: number, month: number): number {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) throw new RangeError('Invalid year or month.');
  return new Date(utc(year, month + 1, 0)).getUTCDate();
}

function parts(date: PartialDate): { year: number; month?: number; day?: number } {
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(date.value);
  if (!match || typeof date.approx !== 'boolean') throw new RangeError('Use a year, year-month, or full ISO date and an approximate flag.');
  const year = Number(match[1]);
  const month = match[2] === undefined ? undefined : Number(match[2]);
  const day = match[3] === undefined ? undefined : Number(match[3]);
  if (year < 1 || (month !== undefined && (month < 1 || month > 12)) || (day !== undefined && (day < 1 || day > daysInMonth(year, month!)))) {
    throw new RangeError('The date is not a valid Gregorian date in years 0001 to 9999.');
  }
  return { year, ...(month === undefined ? {} : { month }), ...(day === undefined ? {} : { day }) };
}

export function partialDate(value: string, approx = false): PartialDate {
  const result = { value, approx };
  parts(result);
  return result;
}

export function datePrecision(date: PartialDate): DatePrecision {
  const p = parts(date);
  return p.day !== undefined ? 'day' : p.month !== undefined ? 'month' : 'year';
}

/** Approximation does not invent an uncertainty interval or alter ordering. */
export function dateBounds(date: PartialDate): { start: number; endExclusive: number } {
  const { year, month, day } = parts(date);
  const start = utc(year, month, day);
  const endExclusive = day !== undefined ? start + DAY : month !== undefined ? utc(year, month + 1) : utc(year + 1);
  return { start, endExclusive };
}

export function dateSortKey(date: DocumentDate): string {
  const start = 'start' in date ? date.start : date;
  const p = parts(start);
  return `${pad(p.year, 4)}-${pad(p.month ?? 1)}-${pad(p.day ?? 1)}`;
}

export function endFallsBeforeStart(start: PartialDate, end: PartialDate): boolean {
  return dateBounds(end).endExclusive <= dateBounds(start).start;
}

export function dateRange(start: PartialDate, end: PartialDate): DateRange {
  if (endFallsBeforeStart(start, end)) throw new RangeError('The end date falls entirely before the start date.');
  return { start: { ...start }, end: { ...end } };
}

export function formatDate(date: DocumentDate): string {
  if ('start' in date) return `${formatDate(date.start)} – ${formatDate(date.end)}`;
  const { year, month, day } = parts(date);
  return `${date.approx ? APPROXIMATE_MARK : ''}${day === undefined ? '' : `${day} `}${month === undefined ? '' : `${MONTHS[month - 1]} `}${pad(year, 4)}`;
}

/** Machine date text never gains a day/month. Keep approximation in its own export field. */
export function toISODate(date: PartialDate): string { parts(date); return date.value; }
export function exportDate(date: PartialDate): PartialDate { parts(date); return { value: date.value, approx: date.approx }; }
export function dateCSVFields(date: PartialDate): { date: string; approximate: boolean } {
  return { date: toISODate(date), approximate: date.approx };
}

interface CalendarParts { year: number; month: number; day: number; hour: number; minute: number; second: number; }
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let value = formatters.get(zone);
  if (!value) {
    // Fixed-offset strings are for entered times; a Profile requires an IANA zone.
    if (/^[+-]/.test(zone) || zone.trim() !== zone || zone === '') throw new RangeError('Use a valid IANA time zone.');
    value = new Intl.DateTimeFormat('en-GB-u-ca-gregory-nu-latn', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', era: 'short' });
    if (formatters.size >= 64) formatters.delete(formatters.keys().next().value!);
    formatters.set(zone, value);
  }
  return value;
}

export function isTimeZone(zone: string): boolean {
  try { formatter(zone); return true; } catch { return false; }
}

function inZone(instant: number, zone: string): CalendarParts {
  const fields = Object.fromEntries(formatter(zone).formatToParts(instant).map((p) => [p.type, p.value]));
  return { year: fields['era'] === 'BC' ? 1 - Number(fields['year']) : Number(fields['year']), month: Number(fields['month']), day: Number(fields['day']), hour: Number(fields['hour']), minute: Number(fields['minute']), second: Number(fields['second']) };
}
function key(p: Pick<CalendarParts, 'year' | 'month' | 'day'>): number { return p.year * 10_000 + p.month * 100 + p.day; }
function iso(p: Pick<CalendarParts, 'year' | 'month' | 'day'>): string { return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`; }
function offsetAt(instant: number, zone: string): number {
  const p = inZone(instant, zone);
  return utc(p.year, p.month, p.day, p.hour, p.minute, p.second) - Math.floor(instant / 1000) * 1000;
}

export function todayInZone(instant: Timestamp, zone = 'UTC'): PartialDate {
  return partialDate(iso(inZone(Date.parse(asTimestamp(instant)), zone)));
}

/** First instant of the local date; a wholly skipped date has an empty interval. */
function localDayBoundary(p: Pick<CalendarParts, 'year' | 'month' | 'day'>, zone: string): number {
  const nominal = utc(p.year, p.month, p.day);
  const target = key({ year: p.year, month: p.month, day: p.day });
  const offsets = new Set<number>();
  const candidates: number[] = [];
  let previous = nominal - 3 * DAY;
  let previousOffset = offsetAt(previous, zone);
  offsets.add(previousOffset);
  // Enumerate nearby offset periods, including historical second offsets and date-line jumps.
  for (let sample = previous + DAY / 4; sample <= nominal + 3 * DAY; sample += DAY / 4) {
    const offset = offsetAt(sample, zone);
    offsets.add(offset);
    if (offset !== previousOffset) {
      let lo = previous;
      let hi = sample;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (offsetAt(mid, zone) === previousOffset) lo = mid; else hi = mid;
      }
      if (key(inZone(hi - 1, zone)) < target && key(inZone(hi, zone)) >= target) candidates.push(hi);
    }
    previous = sample;
    previousOffset = offset;
  }
  for (const offset of offsets) {
    const candidate = nominal - offset;
    const actual = inZone(candidate, zone);
    if (key(actual) === target && actual.hour === 0 && actual.minute === 0 && actual.second === 0) candidates.push(candidate);
  }
  if (candidates.length === 0) throw new RangeError('Could not resolve the start of the local date.');
  return Math.min(...candidates);
}

export interface UTCDateRange { readonly start?: Timestamp; readonly endExclusive?: Timestamp; }
/** Inclusive local dates become a half-open UTC interval, including DST-short/long days. */
export function localDateRangeToUTC(range: { start?: PartialDate; end?: PartialDate }, zone = 'UTC'): UTCDateRange {
  formatter(zone);
  for (const date of [range.start, range.end]) if (date && datePrecision(date) !== 'day') throw new RangeError('Date filters require day precision.');
  if (range.start && range.end && range.end.value < range.start.value) throw new RangeError('The end date precedes the start date.');
  const fullParts = (date: PartialDate): Pick<CalendarParts, 'year' | 'month' | 'day'> => {
    const p = parts(date);
    return { year: p.year, month: p.month!, day: p.day! };
  };
  const start = range.start === undefined ? undefined : asTimestamp(new Date(localDayBoundary(fullParts(range.start), zone)).toISOString());
  let endExclusive: Timestamp | undefined;
  if (range.end) {
    const next = new Date(dateBounds(range.end).endExclusive);
    // An exclusive boundary can enter year 10000 without changing the entered date.
    endExclusive = asTimestamp(new Date(localDayBoundary({ year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() }, zone)).toISOString());
  }
  return { ...(start === undefined ? {} : { start }), ...(endExclusive === undefined ? {} : { endExclusive }) };
}

export type RecordedTimeContext = 'workspace' | 'member_email' | 'public' | 'print' | 'archive' | 'submitter_email' | 'metadata';
export function formatRecordedTime(instant: Timestamp, context: RecordedTimeContext, profileZone?: string): string {
  asTimestamp(instant);
  const zone = (context === 'workspace' || context === 'member_email') ? profileZone ?? 'UTC' : 'UTC';
  const p = inZone(Date.parse(instant), zone);
  const label = formatter(zone).resolvedOptions().timeZone === 'UTC' ? 'UTC' : zone;
  return `${formatDate(partialDate(iso(p)))} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)} ${label}`;
}

/** Validate without converting the entered offset or fractional-second precision. */
export function enteredTimestamp(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new RangeError('Enter a date and time to the second with a time zone.');
  partialDate(match[1]!);
  if (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59 || (match[6] !== 'Z' && (Number(match[6]!.slice(1, 3)) > 23 || Number(match[6]!.slice(4)) > 59)) || !Number.isFinite(Date.parse(value))) {
    throw new RangeError('The entered time or offset is invalid.');
  }
  return value;
}

export function formatEnteredTime(value: string): string {
  enteredTimestamp(value);
  const offset = value.endsWith('Z') ? 'Z' : value.slice(-6);
  const time = value.slice(11, offset === 'Z' ? -1 : -6);
  return `${formatDate(partialDate(value.slice(0, 10)))} ${time} UTC${offset === 'Z' ? '' : offset}`;
}

export function metadataDate(instant: Timestamp, format: 'citation' | 'schema.org'): string {
  const date = asTimestamp(instant).split('T')[0]!;
  return format === 'citation' ? date.replaceAll('-', '/') : date;
}

export type ItemDateInput = { readonly createdAt: Timestamp } & (
  | { readonly kind: 'journal_entry'; readonly startDate?: PartialDate }
  | { readonly kind: 'source'; readonly documentDate?: DocumentDate }
  | { readonly kind: 'run'; readonly startTime?: string }
  | { readonly kind: 'correspondence'; readonly date?: PartialDate }
  | { readonly kind: 'archival_request'; readonly dateSent?: PartialDate }
  | { readonly kind: Extract<ItemKind, 'finding' | 'hypothesis' | 'topic'> }
);

export function itemDate(item: ItemDateInput, zone = 'UTC'): DocumentDate {
  switch (item.kind) {
    case 'journal_entry': return item.startDate ?? todayInZone(item.createdAt, zone);
    case 'source': return item.documentDate ?? todayInZone(item.createdAt, zone);
    case 'run': return item.startTime === undefined ? todayInZone(item.createdAt, zone) : partialDate(enteredTimestamp(item.startTime).slice(0, 10));
    case 'correspondence': return item.date ?? todayInZone(item.createdAt, zone);
    case 'archival_request': return item.dateSent ?? todayInZone(item.createdAt, zone);
    default: return todayInZone(item.createdAt, zone);
  }
}

export function logDate(item: ItemDateInput, zone = 'UTC'): PartialDate {
  if (item.kind === 'source') return todayInZone(item.createdAt, zone);
  const value = itemDate(item, zone);
  return 'start' in value ? value.start : value;
}
