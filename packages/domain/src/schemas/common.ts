import { DEFAULT_RESOURCE_PROFILE } from '../resource-profile';
import { z } from 'zod';
import { asTimestamp, asULID, isULID } from '../types';
import type { MemberStatus, PartialDate, Timestamp, ULID } from '../types';
import { datePrecision, endFallsBeforeStart, enteredTimestamp, partialDate } from '../dates';
import { cpLength, isBlank } from '../text';
import { validateSpans } from '../richtext';
import type { RichText } from '../richtext';
import type { ConfigValue, ValueSetKind } from '../value-sets';
import { accepted } from '../rules';
import type { RuleResult } from '../rules';

export interface ValidationContext {
  readonly now: Timestamp;
  readonly timeZone?: string;
  readonly valueSets: Readonly<Partial<Record<ValueSetKind, readonly ConfigValue[]>>>;
  readonly members: readonly { readonly id: ULID; readonly status: MemberStatus; readonly email?: string; readonly displayName?: string }[];
  readonly roleIds: readonly ULID[];
  readonly projects: readonly { readonly id: ULID; readonly name: string; readonly slug: string }[];
  readonly externalPartyIds: readonly ULID[];
  /** Previous IDs come from the saved record, never from a submitted body. */
  readonly previousSelections?: Readonly<Record<string, readonly ULID[]>>;
}
export type IssuePath = (string | number)[];
export type ReportIssue = (path: IssuePath, message: string) => void;

/** Run independent cross-field checks even if another field has a wrong JSON type. */
export function withChecks<S extends z.ZodType>(schema: S, check: (raw: Record<string, unknown>, report: ReportIssue) => void): z.ZodType<z.output<S>> {
  return z.unknown().transform((raw, ctx) => {
    const parsed = schema.safeParse(raw);
    let failed = !parsed.success;
    if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue({ ...issue });
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) check(raw as Record<string, unknown>, (path, message) => {
      failed = true;
      ctx.addIssue({ code: 'custom', path, message });
    });
    // Return only the strict schema's output, never a merge with unvalidated raw input.
    return failed || !parsed.success ? z.NEVER : parsed.data;
  });
}

/** String lengths count code points. Validation never trims, folds, coerces or truncates text. */
export function textField(maximum?: number, required = false) {
  return z.string().superRefine((value, ctx) => {
    if (required && isBlank(value)) ctx.addIssue({ code: 'custom', message: 'Enter at least one non-whitespace character.' });
    if (maximum !== undefined && cpLength(value) > maximum) ctx.addIssue({ code: 'custom', message: `Use at most ${maximum} Unicode code points.` });
  });
}
export const idSchema: z.ZodType<ULID, string> = z.string().refine(isULID, 'Use a canonical ULID.').transform(asULID);
export const timestampSchema: z.ZodType<Timestamp, string> = z.string().refine((value) => { try { asTimestamp(value); return true; } catch { return false; } }, 'Use an ISO 8601 UTC timestamp with milliseconds.').transform(asTimestamp);
export const partialDateSchema = z.strictObject({ value: z.string(), approx: z.boolean() }).refine((value) => {
  try { partialDate(value.value, value.approx); return true; } catch { return false; }
}, { path: ['value'], message: 'Use a valid ISO date at year, month or day precision.' });
export const fullDateSchema = partialDateSchema.refine((value) => { try { return datePrecision(value) === 'day'; } catch { return false; } }, { path: ['value'], message: 'Use a full calendar date.' });
const documentDateRangeSchema = withChecks(z.strictObject({ start: partialDateSchema, end: partialDateSchema }), (raw, report) => {
    const start = partialDateSchema.safeParse(raw['start']);
    const end = partialDateSchema.safeParse(raw['end']);
    if (start.success && end.success && endFallsBeforeStart(start.data, end.data)) report(['end'], 'The end date falls entirely before the start date.');
});
export const documentDateSchema = z.unknown().transform((input, ctx) => {
  const range = typeof input === 'object' && input !== null && (Object.hasOwn(input, 'start') || Object.hasOwn(input, 'end'));
  const result = (range ? documentDateRangeSchema : partialDateSchema).safeParse(input);
  if (result.success) return result.data;
  for (const issue of result.error.issues) ctx.addIssue({ ...issue });
  return z.NEVER;
});
export const enteredTimeSchema = z.string().refine((value) => { try { enteredTimestamp(value); return true; } catch { return false; } }, 'Enter a valid date and time to the second with an explicit time-zone offset.');

const range = { s: z.number(), e: z.number() };
const spanSchema = z.discriminatedUnion('k', [
  z.strictObject({ k: z.literal('quote'), ...range, source: z.string() }),
  z.strictObject({ k: z.literal('paraphrase'), ...range, source: z.string() }),
  z.strictObject({ k: z.literal('source_reported'), ...range, source: z.string().optional() }),
  z.strictObject({ k: z.literal('lang'), ...range, lang: z.string() }),
  z.strictObject({ k: z.literal('mention'), ...range, member: idSchema.optional(), specialty: idSchema.optional() }),
]);
export function richTextSchema(maximum?: number, required = false) {
  return withChecks(z.strictObject({ text: textField(maximum, required), spans: z.array(spanSchema).max(DEFAULT_RESOURCE_PROFILE.chosen.logical.spansPerField) }), (raw, report) => {
    if (typeof raw['text'] !== 'string' || !Array.isArray(raw['spans'])) return;
    // A malformed span must not suppress independent errors in the other, structurally valid spans.
    const indices: number[] = [];
    const spans = raw['spans'].flatMap((span, index) => {
      const parsed = spanSchema.safeParse(span);
      if (!parsed.success) return [];
      indices.push(index);
      return [parsed.data];
    });
    for (const issue of validateSpans({ text: raw['text'], spans } as RichText)) {
      const index = indices[issue.spanIndex]!;
      report(['spans', index], issue.message.replace(/^Span \d+/, `Span ${index + 1}`));
    }
  });
}
export const logSummarySchema = richTextSchema(2000, true);
export const optionalLogSummarySchema = richTextSchema(2000).optional();

export function distinctIds<S extends z.ZodType<ULID>>(schema: S, minimum = 0, maximum?: number) {
  let values = z.array(schema).min(minimum, `Choose at least ${minimum} distinct entries.`);
  if (maximum !== undefined) values = values.max(maximum, `Choose at most ${maximum} entries.`);
  return values.superRefine((ids, ctx) => {
    const seen = new Set<ULID>();
    for (const [index, id] of ids.entries()) {
      if (seen.has(id)) ctx.addIssue({ code: 'custom', path: [index], message: 'Choose each entry at most once.' });
      seen.add(id);
    }
  });
}
export function knownId(ids: readonly ULID[], label: string) {
  const available = new Set(ids);
  return idSchema.refine((id) => available.has(id), `Choose an existing ${label}.`);
}
export function selectedValue(context: ValidationContext, set: ValueSetKind, field: string) {
  const available = new Map((context.valueSets[set] ?? []).map((value) => [value.id, value]));
  const previous = new Set(context.previousSelections?.[field] ?? []);
  return idSchema.superRefine((id, ctx) => {
    const value = available.get(id);
    if (!value) ctx.addIssue({ code: 'custom', message: `Choose a value from the ${set} set.` });
    else if (value.retired && !previous.has(id)) ctx.addIssue({ code: 'custom', message: 'A retired value cannot be newly selected.' });
  });
}

/** Consistent field paths, including nested union failures and each unknown submitted key. */
export function validate<S extends z.ZodType>(schema: S, input: unknown): RuleResult<z.output<S>> {
  const result = schema.safeParse(input);
  if (result.success) return accepted(result.data);
  const issues: { code: string; field: string; message: string }[] = [];
  const append = (entries: readonly z.core.$ZodIssue[], prefix: PropertyKey[] = []): void => {
    for (const issue of entries) {
      const path = [...prefix, ...issue.path];
      if (issue.code === 'invalid_union' && issue.errors.length > 0) { for (const branch of issue.errors) append(branch, path); continue; }
      if (issue.code === 'unrecognized_keys') { for (const key of issue.keys) issues.push({ code: issue.code, field: [...path, key].join('.'), message: 'This field is not accepted here.' }); continue; }
      issues.push({ code: issue.code, field: path.join('.') || '$', message: issue.message });
    }
  };
  append(result.error.issues);
  const seen = new Set<string>();
  return { ok: false, issues: issues.filter((issue) => {
    const key = JSON.stringify([issue.field, issue.message]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }) };
}

export function validDate(value: unknown): PartialDate | undefined {
  const result = partialDateSchema.safeParse(value);
  return result.success ? result.data : undefined;
}
