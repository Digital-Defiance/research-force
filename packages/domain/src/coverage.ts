import { z } from 'zod';
import { idSchema, textField } from './schemas/common';
import { asULID } from './types';
import type { ULID } from './types';

/**
 * R56.3, R56.4: search scopes with exact integer, range and set semantics, and coverage computed only where it is sound. Every number is a
 * decimal integer written as text, so a key space of any size is exact; the arithmetic uses BigInt.
 */
export const COVERAGE_LIMITS = Object.freeze({
  dimensions: 4, setMembers: 1000, memberCodePoints: 200, entries: 100, intervals: 100, assumptions: 20, assumptionCodePoints: 500, digits: 80,
  genericTextCodePoints: 2000, nameCodePoints: 100, descriptionCodePoints: 1000, pieces: 10_000, work: 1_000_000, versions: 1000,
});
export const COVERAGE_STATES = ['attempted', 'completed', 'excluded', 'unknown'] as const;
export type CoverageState = typeof COVERAGE_STATES[number];
export const COVERAGE_STATE_NAMES: Readonly<Record<CoverageState, string>> = Object.freeze({
  attempted: 'Attempted', completed: 'Completed', excluded: 'Excluded', unknown: 'Unknown',
});
/** The Run_Outcomes that mean the run finished: Complete and Clean negative. In progress, Partial, Suspended and Stopped never prove an elimination (R56.4). */
export const FINISHED_RUN_OUTCOME_IDS: ReadonlySet<ULID> = new Set(['0000000000000000000000R002', '0000000000000000000000R003'].map(asULID));

const wholeNumber = z.string().regex(/^(?:0|[1-9][0-9]{0,79})$/u, 'Use a whole number of up to 80 digits, without a sign, a decimal point or leading zeros.');

const dimensionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('integer'), name: textField(COVERAGE_LIMITS.nameCodePoints, true), min: wholeNumber, max: wholeNumber }),
  z.strictObject({ kind: z.literal('set'), name: textField(COVERAGE_LIMITS.nameCodePoints, true), members: z.array(textField(COVERAGE_LIMITS.memberCodePoints, true)).min(1).max(COVERAGE_LIMITS.setMembers) }),
]);
export type Dimension = z.output<typeof dimensionSchema>;

/** A project-defined search-scope schema. A new description of the same name is the next version; a version is never changed. */
export const scopeSchemaInput = z.strictObject({
  name: textField(COVERAGE_LIMITS.nameCodePoints, true),
  description: textField(COVERAGE_LIMITS.descriptionCodePoints, true).optional(),
  dimensions: z.array(dimensionSchema).min(1).max(COVERAGE_LIMITS.dimensions),
  expectedVersion: z.int().min(0),
});
export type ScopeSchemaInput = z.output<typeof scopeSchemaInput>;

const rangeSchema = z.strictObject({ from: wholeNumber, to: wholeNumber });
const regionValue = z.union([z.array(rangeSchema).min(1).max(COVERAGE_LIMITS.intervals), z.array(textField(COVERAGE_LIMITS.memberCodePoints, true)).min(1).max(COVERAGE_LIMITS.setMembers)]);
export const entrySchema = z.strictObject({ state: z.enum(COVERAGE_STATES), region: z.record(z.string(), regionValue) });
export type EntryInput = z.output<typeof entrySchema>;

/** A scope is structured (a schema version and its entries) or a generic text, which stays valid but cannot be compared (R56.3). */
export const scopeInput = z.strictObject({
  rev: z.int().min(1),
  packageVersion: z.int().min(1),
  schema: z.strictObject({ id: idSchema, version: z.int().min(1) }).optional(),
  text: textField(COVERAGE_LIMITS.genericTextCodePoints, true).optional(),
  assumptions: z.array(textField(COVERAGE_LIMITS.assumptionCodePoints, true)).max(COVERAGE_LIMITS.assumptions).default([]),
  entries: z.array(entrySchema).max(COVERAGE_LIMITS.entries).default([]),
});
export type ScopeInput = z.output<typeof scopeInput>;

export interface Issue { readonly field: string; readonly rule: string }

/** A schema's dimensions must be well formed: unique names, and for an integer dimension a minimum that is not above its maximum. */
export function schemaIssues(input: Pick<ScopeSchemaInput, 'dimensions'>): Issue[] {
  const issues: Issue[] = [];
  const names = new Set<string>();
  input.dimensions.forEach((dimension, index) => {
    if (names.has(dimension.name)) issues.push({ field: `dimensions.${index}.name`, rule: 'Name each dimension once.' });
    names.add(dimension.name);
    if (dimension.kind === 'integer' && BigInt(dimension.min) > BigInt(dimension.max)) issues.push({ field: `dimensions.${index}`, rule: 'The minimum is above the maximum.' });
    if (dimension.kind === 'set' && new Set(dimension.members).size !== dimension.members.length) issues.push({ field: `dimensions.${index}.members`, rule: 'Name each member once.' });
  });
  return issues;
}

/** One interval of whole numbers, both ends included. */
export type Interval = readonly [bigint, bigint];
/** A box holds, for each dimension in order, the intervals it covers. A set member is its place in the schema's list of members. */
export type Box = readonly (readonly Interval[])[];

/** Intervals in order, with those that overlap or touch joined. */
function normalise(intervals: readonly Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const out: [bigint, bigint][] = [];
  for (const [from, to] of sorted) {
    const last = out.at(-1);
    if (last && from <= last[1] + 1n) { if (to > last[1]) last[1] = to; } else out.push([from, to]);
  }
  return out;
}
const lengthOf = (intervals: readonly Interval[]): bigint => intervals.reduce((total, [from, to]) => total + (to - from + 1n), 0n);
function intersectIntervals(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  let i = 0; let j = 0;
  while (i < a.length && j < b.length) {
    const from = a[i]![0] > b[j]![0] ? a[i]![0] : b[j]![0];
    const to = a[i]![1] < b[j]![1] ? a[i]![1] : b[j]![1];
    if (from <= to) out.push([from, to]);
    if (a[i]![1] < b[j]![1]) i += 1; else j += 1;
  }
  return out;
}
function subtractIntervals(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const [from, to] of a) {
    let start = from;
    for (const [bf, bt] of b) {
      if (bt < start || bf > to) continue;
      if (bf > start) out.push([start, bf - 1n]);
      start = bt + 1n;
      if (start > to) break;
    }
    if (start <= to) out.push([start, to]);
  }
  return out;
}

export class CoverageTooComplex extends Error {
  constructor() { super('The scopes are too fragmented to compare exactly.'); this.name = 'CoverageTooComplex'; }
}

const volume = (box: Box): bigint => box.reduce((total, dimension) => total * lengthOf(dimension), 1n);
function intersectBoxes(a: Box, b: Box): Box | null {
  const out: Interval[][] = [];
  for (let index = 0; index < a.length; index += 1) {
    const part = intersectIntervals(a[index]!, b[index]!);
    if (part.length === 0) return null;
    out.push(part);
  }
  return out;
}
/** The part of `a` that `b` does not cover, as boxes that do not overlap. */
function subtractBox(a: Box, b: Box): Box[] {
  if (intersectBoxes(a, b) === null) return [a];
  const pieces: Box[] = [];
  const rest: Interval[][] = a.map((dimension) => [...dimension]);
  for (let index = 0; index < a.length; index += 1) {
    const outside = subtractIntervals(rest[index]!, b[index]!);
    if (outside.length > 0) pieces.push(rest.map((dimension, at) => (at === index ? outside : dimension)));
    rest[index] = intersectIntervals(rest[index]!, b[index]!);
  }
  return pieces;
}

/** The boxes joined into boxes that do not overlap, covering exactly the same points. */
export function unionBoxes(boxes: readonly Box[]): Box[] {
  let accepted: Box[] = [];
  let work = 0;
  for (const box of boxes) {
    let pieces: Box[] = [box.map((dimension) => normalise(dimension))];
    for (const existing of accepted) {
      work += pieces.length;
      if (work > COVERAGE_LIMITS.work) throw new CoverageTooComplex();
      pieces = pieces.flatMap((piece) => subtractBox(piece, existing));
      if (pieces.length + accepted.length > COVERAGE_LIMITS.pieces) throw new CoverageTooComplex();
    }
    accepted = [...accepted, ...pieces];
  }
  return accepted;
}
export function intersectUnions(a: readonly Box[], b: readonly Box[]): Box[] {
  if (a.length * b.length > COVERAGE_LIMITS.work) throw new CoverageTooComplex();
  const parts: Box[] = [];
  for (const left of a) for (const right of b) {
    const common = intersectBoxes(left, right);
    if (common !== null) parts.push(common);
    if (parts.length > COVERAGE_LIMITS.pieces) throw new CoverageTooComplex();
  }
  return unionBoxes(parts);
}
export const countBoxes = (boxes: readonly Box[]): bigint => boxes.reduce((total, box) => total + volume(box), 0n);

/** The box a region describes in a schema, or the issues with it. Every dimension is named; leaving one out is not a way to say "all of it". */
export function regionToBox(dimensions: readonly Dimension[], region: Readonly<Record<string, unknown>>, field: string): { box?: Box; issues: Issue[] } {
  const issues: Issue[] = [];
  const known = new Set(dimensions.map((dimension) => dimension.name));
  for (const key of Object.keys(region)) if (!known.has(key)) issues.push({ field: `${field}.${key}`, rule: 'The schema has no such dimension.' });
  const box: Interval[][] = [];
  for (const dimension of dimensions) {
    const value = region[dimension.name];
    const where = `${field}.${dimension.name}`;
    if (value === undefined) { issues.push({ field: where, rule: 'Name every dimension of the schema. To mean all of it, give its whole range.' }); continue; }
    if (dimension.kind === 'integer') {
      const min = BigInt(dimension.min); const max = BigInt(dimension.max);
      const intervals: Interval[] = [];
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'object' || entry === null)) { issues.push({ field: where, rule: 'Give ranges of whole numbers, such as { "from": "0", "to": "99" }.' }); continue; }
      (value as { from: string; to: string }[]).forEach((range, index) => {
        const from = BigInt(range.from); const to = BigInt(range.to);
        if (from > to) issues.push({ field: `${where}.${index}`, rule: 'The range is inverted: it starts above where it ends.' });
        else if (from < min || to > max) issues.push({ field: `${where}.${index}`, rule: `The range is outside the schema’s ${dimension.min} to ${dimension.max}.` });
        else intervals.push([from, to]);
      });
      box.push(normalise(intervals));
    } else {
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) { issues.push({ field: where, rule: 'Give the members of the set.' }); continue; }
      const members = value as string[];
      if (new Set(members).size !== members.length) issues.push({ field: where, rule: 'Name each member once.' });
      const places = members.map((member, index) => ({ at: dimension.members.indexOf(member), index }));
      for (const { at, index } of places) if (at < 0) issues.push({ field: `${where}.${index}`, rule: 'The schema has no such member.' });
      box.push(normalise(places.filter(({ at }) => at >= 0).map(({ at }): Interval => [BigInt(at), BigInt(at)])));
    }
  }
  return issues.length > 0 ? { issues } : { box, issues };
}

/** The issues with a scope's entries and assumptions against its schema. */
export function scopeIssues(input: ScopeInput, dimensions: readonly Dimension[] | undefined): Issue[] {
  const issues: Issue[] = [];
  if (input.schema === undefined) {
    if (input.text === undefined) issues.push({ field: 'text', rule: 'Describe the scope in text, or name a scope schema.' });
    if (input.entries.length > 0) issues.push({ field: 'entries', rule: 'Entries need a scope schema.' });
    return issues;
  }
  if (input.text !== undefined) issues.push({ field: 'text', rule: 'A structured scope is described by its entries, not by text.' });
  if (input.entries.length === 0) issues.push({ field: 'entries', rule: 'Give at least one entry.' });
  if (dimensions === undefined) return issues;
  input.entries.forEach((entry, index) => { issues.push(...regionToBox(dimensions, entry.region, `entries.${index}.region`).issues); });
  return issues;
}

export const boxesOf = (dimensions: readonly Dimension[], entries: readonly EntryInput[], state: CoverageState): Box[] => entries
  .filter((entry) => entry.state === state).map((entry) => regionToBox(dimensions, entry.region, 'region').box!);

/** The number of points in the whole space a schema describes. */
export const universeSize = (dimensions: readonly Dimension[]): bigint => dimensions.reduce(
  (total, dimension) => total * (dimension.kind === 'integer' ? BigInt(dimension.max) - BigInt(dimension.min) + 1n : BigInt(dimension.members.length)), 1n);

export interface BoxView { readonly [dimension: string]: readonly { readonly from: string; readonly to: string }[] | readonly string[] }
/** Boxes as a Member reads them: ranges of whole numbers, and the members of a set. */
export function describeBoxes(dimensions: readonly Dimension[], boxes: readonly Box[]): BoxView[] {
  return boxes.map((box) => Object.fromEntries(dimensions.map((dimension, index) => [
    dimension.name,
    dimension.kind === 'integer' ? box[index]!.map(([from, to]) => ({ from: from.toString(), to: to.toString() }))
      : box[index]!.flatMap(([from, to]) => dimension.members.slice(Number(from), Number(to) + 1)),
  ])));
}

/** Two scopes can be compared only when they use the same version of the same schema; anything else is incomparable, never "nearly" comparable (R56.4). */
export const comparable = (a: { readonly schemaId: string | null; readonly schemaVersion: number | null }, b: { readonly schemaId: string | null; readonly schemaVersion: number | null }): boolean =>
  a.schemaId !== null && a.schemaId === b.schemaId && a.schemaVersion === b.schemaVersion;
