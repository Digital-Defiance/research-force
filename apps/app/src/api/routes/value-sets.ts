import { Hono } from 'hono';
import type { Context } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { GuardedBatch, GuardViolation } from '@researchforce/db/batch';
import { configValues, methodsTerms } from '@researchforce/db/schema/core';
import type { METHODS_TERM_GROUPS } from '@researchforce/db/schema/core';
import { newULID } from '@researchforce/domain/identifiers';
import type { RuleResult } from '@researchforce/domain/rules';
import type { ULID } from '@researchforce/domain/types';
import { changeValueSet, publicDescriptionIssue, VALUE_SET_KINDS } from '@researchforce/domain/value-sets';
import type { ConfigValue, ValueSet, ValueSetKind, ValueSetOperation } from '@researchforce/domain/value-sets';
import { authorize, authorizeRead } from '../../auth/authorize';
import type { PermissionCheck } from '../../auth/authorize';
import { rowsOf } from '../../records/kinds/kind';
import type { ApiEnv } from '../app';
import { ApiError, isUniqueViolation } from '../errors';
import type { FieldIssue } from '../errors';
import { accept, parse, readJson } from '../input';

export interface ValueRecord {
  readonly id: ULID; readonly set: ValueSetKind; readonly name: string; readonly retired: boolean; readonly locked: boolean; readonly position: number;
  readonly publicDescription: string | null; readonly permitsPublication?: boolean; readonly rev: number;
}
export interface MethodsTermRecord {
  readonly key: string; readonly group: typeof METHODS_TERM_GROUPS[number]; readonly name: string; readonly position: number; readonly publicDescription: string; readonly rev: number;
}
interface ValueRow extends Omit<ValueRecord, 'set' | 'retired' | 'locked' | 'permitsPublication'> { setKey: ValueSetKind; retired: number; locked: number; permitsPublication: number | null }
type TermRow = Omit<MethodsTermRecord, 'group'> & { groupKey: MethodsTermRecord['group'] };

const VALUE_COLUMNS = 'id, set_key AS setKey, name, retired, locked, position, public_description AS publicDescription, permits_publication AS permitsPublication, rev';
const TERM_COLUMNS = 'key, group_key AS groupKey, name, position, public_description AS publicDescription, rev';
const SET_PATHS: ReadonlyMap<string, ValueSetKind> = new Map(VALUE_SET_KINDS.map((kind) => [kind.replaceAll('_', '-'), kind]));

const addSchema = z.strictObject({ name: z.string(), publicDescription: z.string().optional(), permitsPublication: z.boolean().optional() });
const editSchema = z.strictObject({
  rev: z.int().min(1), name: z.string().optional(), retired: z.literal(true).optional(), permitsPublication: z.boolean().optional(), publicDescription: z.string().nullable().optional(),
});
const describeSchema = z.strictObject({ rev: z.int().min(1), publicDescription: z.string() });

function record({ setKey, retired, locked, permitsPublication, ...row }: ValueRow): ValueRecord {
  return { ...row, set: setKey, retired: retired === 1, locked: locked === 1, ...(permitsPublication === null ? {} : { permitsPublication: permitsPublication === 1 }) };
}
const term = ({ groupKey, ...row }: TermRow): MethodsTermRecord => ({ ...row, group: groupKey });
function domainSet(kind: ValueSetKind, values: readonly ValueRecord[]): ValueSet {
  return {
    kind, values: values.map((value): ConfigValue => ({
      id: value.id, name: value.name, retired: value.retired,
      ...(value.publicDescription === null ? {} : { publicDescription: value.publicDescription }),
      ...(value.permitsPublication === undefined ? {} : { permitsPublication: value.permitsPublication }),
    })),
  };
}
function setOf(c: Context<ApiEnv>): ValueSetKind {
  const kind = SET_PATHS.get(c.req.param('set') ?? '');
  if (!kind) throw new ApiError('not_found');
  return kind;
}

async function loadSet(c: Context<ApiEnv>, kind: ValueSetKind): Promise<ValueRecord[]> {
  const result = await c.get('accountant').track(c.env.RF_CORE.prepare(`SELECT ${VALUE_COLUMNS} FROM config_values WHERE set_key = ?1 ORDER BY position, id`).bind(kind).all<ValueRow>());
  return result.results.map(record);
}
async function loadValue(c: Context<ApiEnv>, kind: ValueSetKind, id: string): Promise<ValueRecord> {
  const value = (await loadSet(c, kind)).find((entry) => entry.id === id);
  if (!value) throw new ApiError('not_found');
  return value;
}
const duplicateName = (cause: unknown) => new ApiError('validation', { fields: [{ field: 'name', rule: 'Names must be unique ignoring letter case, including retired values.' }] }, { cause });

export const valueSetsRoutes = new Hono<ApiEnv>();

/** Every configurable value set in order, with retired values, and the fixed Methods_Terms with their Public_Descriptions. */
valueSetsRoutes.get('/', async (c) => {
  await authorizeRead(c);
  const db = c.env.RF_CORE;
  const [values, terms] = await c.get('accountant').track(db.batch([
    db.prepare(`SELECT ${VALUE_COLUMNS} FROM config_values ORDER BY set_key, position, id`),
    db.prepare(`SELECT ${TERM_COLUMNS} FROM methods_terms ORDER BY group_key, position`),
  ]));
  const valueSets = Object.fromEntries(VALUE_SET_KINDS.map((kind): [ValueSetKind, ValueRecord[]] => [kind, []]));
  for (const row of rowsOf<ValueRow>(values)) valueSets[row.setKey]!.push(record(row));
  return c.json({ valueSets, methodsTerms: rowsOf<TermRow>(terms).map(term) });
});

/** Change the Public_Description of a fixed Methods_Term (R46.12, R46.13). */
valueSetsRoutes.patch('/methods-terms/:key', async (c) => {
  await authorize(c, [{ permission: 'methods.describe' }]);
  const db = c.env.RF_CORE;
  const load = async () => rowsOf<TermRow>(await c.get('accountant').track(db.prepare(`SELECT ${TERM_COLUMNS} FROM methods_terms WHERE key = ?1`).bind(c.req.param('key')).all())).map(term)[0];
  const current = await load();
  if (!current) throw new ApiError('not_found');
  const edit = parse(describeSchema, await readJson(c));
  const issue = publicDescriptionIssue(edit.publicDescription);
  if (issue) throw new ApiError('validation', { fields: [{ field: 'publicDescription', rule: issue }] });
  if (edit.publicDescription === current.publicDescription && edit.rev === current.rev) return c.json({ term: current });
  try {
    await new GuardedBatch(db, { id: c.get('session').member.id, now: c.get('now') })
      .guard('rev', sql`(SELECT rev FROM methods_terms WHERE key = ${current.key}) = ${edit.rev}`)
      .update(methodsTerms, { publicDescription: edit.publicDescription }, eq(methodsTerms.key, current.key))
      .outbox('publish', `value:${current.group}:${current.key}`)
      .commit(c.get('accountant'));
  } catch (error) {
    if (error instanceof GuardViolation && error.code === 'rev') throw new ApiError('conflict', { details: { rev: (await load())!.rev } }, { cause: error });
    throw error;
  }
  return c.json({ term: await load() });
});

/** Add a value at the end of a set; a Methods_Term value needs its Public_Description (R3.3, R33.6, R46.13). */
valueSetsRoutes.post('/:set', async (c) => {
  const kind = setOf(c);
  const input = parse(addSchema, await readJson(c));
  await authorize(c, [{ permission: 'valueSet.manage' }, ...(input.permitsPublication === true ? [{ permission: 'rights.markPublication' as const }] : [])]);
  const now = c.get('now');
  const id = newULID(now);
  const values = await loadSet(c, kind);
  const next = accept(changeValueSet(domainSet(kind, values), {
    kind: 'add', value: {
      id, name: input.name, retired: false,
      ...(input.publicDescription === undefined ? {} : { publicDescription: input.publicDescription }),
      ...(input.permitsPublication === undefined ? {} : { permitsPublication: input.permitsPublication }),
    },
  })).values.at(-1)!;
  try {
    await new GuardedBatch(c.env.RF_CORE, { id: c.get('session').member.id, now })
      .insert(configValues, {
        id, setKey: kind, name: next.name, nameKey: next.name.toLowerCase(), retired: false, locked: false, permitsPublication: next.permitsPublication ?? null,
        position: Math.max(-1, ...values.map((value) => value.position)) + 1, publicDescription: next.publicDescription ?? null,
      })
      .outbox('publish', `value:${kind}:${id}`)
      .commit(c.get('accountant'));
  } catch (error) {
    if (isUniqueViolation(error, 'config_values.set_key')) throw duplicateName(error);
    throw error;
  }
  return c.json({ value: await loadValue(c, kind, id) }, 201);
});

/**
 * Rename or retire a value, mark a Rights_Status value as permitting publication or not, or change its Public_Description.
 * A rename changes only the displayed name; a retired value stays on every record that holds it (R3.8, R4.6, R6.8, R7.7, R8.8, R10.5).
 */
valueSetsRoutes.patch('/:set/:id', async (c) => {
  const kind = setOf(c);
  const current = await loadValue(c, kind, c.req.param('id'));
  const edit = parse(editSchema, await readJson(c));
  const checks: PermissionCheck[] = [];
  if (edit.name !== undefined || edit.retired !== undefined) checks.push({ permission: 'valueSet.manage' });
  if (edit.permitsPublication !== undefined) checks.push({ permission: 'rights.markPublication' });
  if (edit.publicDescription !== undefined) checks.push({ permission: 'methods.describe' });
  if (checks.length === 0) throw new ApiError('validation', { fields: [{ field: '$', rule: 'Change the name, the retirement, the publication mark, or the Public Description.' }] });
  await authorize(c, checks);

  const operations: ValueSetOperation[] = [];
  if (edit.name !== undefined) operations.push({ kind: 'rename', id: current.id, name: edit.name });
  if (edit.retired) operations.push({ kind: 'retire', id: current.id });
  if (edit.permitsPublication !== undefined) operations.push({ kind: 'mark_publication', id: current.id, permits: edit.permitsPublication });
  if (edit.publicDescription !== undefined) operations.push({ kind: 'describe', id: current.id, publicDescription: edit.publicDescription ?? undefined });
  let set = domainSet(kind, await loadSet(c, kind));
  const issues: FieldIssue[] = [];
  for (const operation of operations) {
    const result: RuleResult<ValueSet> = changeValueSet(set, operation);
    if (result.ok) set = result.value;
    else issues.push(...result.issues.map((issue) => ({ field: issue.field, rule: issue.message })));
  }
  if (issues.length > 0) throw new ApiError('validation', { fields: issues });
  const next = set.values.find((value) => value.id === current.id)!;
  const changes = {
    ...(next.name === current.name ? {} : { name: next.name, nameKey: next.name.toLowerCase() }),
    ...(next.retired === current.retired ? {} : { retired: next.retired }),
    ...((next.permitsPublication ?? null) === (current.permitsPublication ?? null) ? {} : { permitsPublication: next.permitsPublication! }),
    ...((next.publicDescription ?? null) === current.publicDescription ? {} : { publicDescription: next.publicDescription ?? null }),
  };
  if (Object.keys(changes).length === 0 && edit.rev === current.rev) return c.json({ value: current });
  const batch = new GuardedBatch(c.env.RF_CORE, { id: c.get('session').member.id, now: c.get('now') })
    .guard('rev', sql`(SELECT rev FROM config_values WHERE id = ${current.id}) = ${edit.rev}`)
    .update(configValues, changes, eq(configValues.id, current.id));
  // Two Administrators retiring the last two available values at once would otherwise leave none (R3.3).
  if (changes.retired) batch.guard('rev', sql`EXISTS (SELECT 1 FROM config_values WHERE set_key = ${kind} AND retired = 0)`);
  try {
    await batch.outbox('publish', `value:${kind}:${current.id}`).commit(c.get('accountant'));
  } catch (error) {
    if (isUniqueViolation(error, 'config_values.set_key')) throw duplicateName(error);
    if (error instanceof GuardViolation && error.code === 'rev') throw new ApiError('conflict', { details: { rev: (await loadValue(c, kind, current.id)).rev } }, { cause: error });
    throw error;
  }
  return c.json({ value: await loadValue(c, kind, current.id) });
});
