import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { GuardedBatch } from '@researchforce/db/batch';
import { artifactDerivationInputs, artifactDerivations, derivationFlags } from '@researchforce/db/schema/core';
import { derivationInputSchema, derivationReviewSchema, DERIVATION_KIND_NAMES, DERIVATION_LIMITS, passageIssues, unchangedOriginalIssues } from '@researchforce/domain/derivations';
import type { DerivationEndpoint, DerivationKind, ReviewState } from '@researchforce/domain/derivations';
import { newULID } from '@researchforce/domain/identifiers';
import { cpLength } from '@researchforce/domain/text';
import { isULID } from '@researchforce/domain/types';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import type { FieldIssue } from '../api/errors';
import { parse } from '../api/input';
import { authorize } from '../auth/authorize';
import { readableUnit, resolveTarget } from './citations';
import type { Resolved } from './citations';
import { rowsOf } from './kinds/kind';
import { visibleTo } from './submissions';

const gone = (unit: string): string => `NOT EXISTS (SELECT 1 FROM deletions x WHERE x.unit_id IN (${unit}.id, ${unit}.root_id))`;
/** A graph node is a unit, and the text field of it when the endpoint is a text. */
const nodeOf = (unitId: string, field: string): string => `${unitId}#${field}`;

export interface EndpointView {
  readonly type: 'attachment' | 'text';
  readonly unitId: ULID;
  readonly field?: string;
  readonly rootId: ULID;
  readonly identifier: string;
  readonly title: string;
  readonly sha256: string;
  readonly rev: number | null;
  /** A text endpoint whose record was edited since the derivation recorded it; an Attachment never changes. */
  readonly revisedSince: boolean;
}
export interface ReviewView {
  readonly reviewerId: ULID; readonly reviewerName: string | null; readonly state: 'reviewed' | 'disputed'; readonly note: string | null; readonly reviewedAt: Timestamp;
  readonly passages: readonly { start: number; end: number; note: string | null }[];
}
export interface DerivationView {
  readonly id: ULID;
  readonly kind: DerivationKind;
  readonly kindName: string;
  readonly method: string;
  readonly methodVersion: string | null;
  readonly language: string | null;
  readonly uncertainty: string | null;
  readonly reviewState: ReviewState;
  readonly createdBy: ULID;
  readonly createdByName: string | null;
  readonly createdAt: Timestamp;
  readonly output: EndpointView;
  readonly inputs: readonly EndpointView[];
  /** The stored text of an Attachment output, supplied by hand (R55.5). */
  readonly text: string | null;
  readonly correctsId: ULID | null;
  readonly correctedBy: ULID | null;
  readonly reviews: readonly ReviewView[];
  readonly graphEpoch: number;
}

interface DerivationRow {
  id: ULID; outputType: 'attachment' | 'text'; outputUnitId: ULID; outputField: string; outputRev: number | null; outputSha256: string; kind: DerivationKind; method: string;
  methodVersion: string | null; language: string | null; uncertainty: string | null; derivedText: string | null; createdBy: ULID; createdAt: Timestamp; reviewState: ReviewState;
  correctsId: ULID | null; correctedBy: ULID | null;
}
interface InputRow { derivationId: ULID; position: number; inputType: 'attachment' | 'text'; inputUnitId: ULID; inputField: string; inputRev: number | null; inputSha256: string; goneAt: Timestamp | null }
const DERIVATION_COLUMNS = `d.id, d.output_type AS outputType, d.output_unit_id AS outputUnitId, d.output_field AS outputField, d.output_rev AS outputRev, d.output_sha256 AS outputSha256,
  d.kind, d.method, d.method_version AS methodVersion, d.language, d.uncertainty, d.derived_text AS derivedText, d.created_by AS createdBy, d.created_at AS createdAt,
  d.review_state AS reviewState, d.corrects_id AS correctsId, d.corrected_by AS correctedBy`;

interface Described { readonly rootId: ULID; readonly identifier: string; readonly title: string; readonly rev: number }
/** The units among `ids` the Member can read now, with their records; an unreadable or deleted unit is simply absent (R55.4). */
async function describeUnits(c: Context<ApiEnv>, ids: readonly string[]): Promise<Map<string, Described>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const result = await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT u.id, u.root_id AS rootId, ri.item_identifier AS identifier, ri.title, r.rev
      FROM units u JOIN units r ON r.id = u.root_id JOIN research_items ri ON ri.unit_id = r.id
      WHERE u.id IN (SELECT value FROM json_each(?1)) AND ${visibleTo('u', '?2')} AND ${gone('u')}`,
  ).bind(JSON.stringify(unique), c.get('session').member.id).all<{ id: string; rootId: ULID; identifier: string; title: string; rev: number }>());
  return new Map(result.results.map((row) => [row.id, { rootId: row.rootId, identifier: row.identifier, title: row.title, rev: row.rev }]));
}

const endpoint = (described: Described, side: { type: 'attachment' | 'text'; unitId: ULID; field: string; sha256: string; rev: number | null }): EndpointView => ({
  type: side.type, unitId: side.unitId, ...(side.field === '' ? {} : { field: side.field }), rootId: described.rootId, identifier: described.identifier, title: described.title,
  sha256: side.sha256, rev: side.rev, revisedSince: side.type === 'text' && side.rev !== null && side.rev !== described.rev,
});

/**
 * The derivations among `rows` the Member may see: the output must be readable, and an input is listed only while it is readable too. A
 * derivation whose inputs are all unreadable is not shown at all, so following a provenance path never reveals what it was made from (R55.4).
 */
async function views(c: Context<ApiEnv>, rows: readonly DerivationRow[]): Promise<DerivationView[]> {
  if (rows.length === 0) return [];
  const db = c.env.RF_CORE;
  const ids = JSON.stringify(rows.map((row) => row.id));
  const [inputs, reviews, passages, epoch] = await c.get('accountant').track(db.batch([
    db.prepare('SELECT derivation_id AS derivationId, position, input_type AS inputType, input_unit_id AS inputUnitId, input_field AS inputField, input_rev AS inputRev, input_sha256 AS inputSha256, gone_at AS goneAt FROM artifact_derivation_inputs WHERE derivation_id IN (SELECT value FROM json_each(?1)) ORDER BY derivation_id, position').bind(ids),
    db.prepare('SELECT r.derivation_id AS derivationId, r.reviewer_id AS reviewerId, p.display_name AS reviewerName, r.state, r.note, r.reviewed_at AS reviewedAt FROM derivation_reviews r LEFT JOIN profiles p ON p.member_id = r.reviewer_id WHERE r.derivation_id IN (SELECT value FROM json_each(?1)) ORDER BY r.derivation_id, r.reviewed_at, r.reviewer_id').bind(ids),
    db.prepare('SELECT derivation_id AS derivationId, reviewer_id AS reviewerId, start_offset AS start, end_offset AS end, note FROM derivation_flags WHERE derivation_id IN (SELECT value FROM json_each(?1)) ORDER BY derivation_id, reviewer_id, position').bind(ids),
    db.prepare("SELECT v FROM counters WHERE k = 'derivation'"),
  ]));
  const inputRows = rowsOf<InputRow>(inputs).filter((input) => input.goneAt === null);
  const described = await describeUnits(c, [...rows.map((row) => row.outputUnitId), ...inputRows.map((input) => input.inputUnitId)]);
  const names = await creatorNames(c, rows.map((row) => row.createdBy));
  const graphEpoch = rowsOf<{ v: number }>(epoch)[0]?.v ?? 0;
  const reviewRows = rowsOf<{ derivationId: ULID; reviewerId: ULID; reviewerName: string | null; state: 'reviewed' | 'disputed'; note: string | null; reviewedAt: Timestamp }>(reviews);
  const passageRows = rowsOf<{ derivationId: ULID; reviewerId: ULID; start: number; end: number; note: string | null }>(passages);
  return rows.flatMap((row): DerivationView[] => {
    const output = described.get(row.outputUnitId);
    if (!output) return [];
    const readableInputs = inputRows.filter((input) => input.derivationId === row.id && described.has(input.inputUnitId))
      .map((input) => endpoint(described.get(input.inputUnitId)!, { type: input.inputType, unitId: input.inputUnitId, field: input.inputField, sha256: input.inputSha256, rev: input.inputRev }));
    if (readableInputs.length === 0) return [];
    return [{
      id: row.id, kind: row.kind, kindName: DERIVATION_KIND_NAMES[row.kind], method: row.method, methodVersion: row.methodVersion, language: row.language, uncertainty: row.uncertainty,
      reviewState: row.reviewState, createdBy: row.createdBy, createdByName: names.get(row.createdBy) ?? null, createdAt: row.createdAt,
      output: endpoint(output, { type: row.outputType, unitId: row.outputUnitId, field: row.outputField, sha256: row.outputSha256, rev: row.outputRev }), inputs: readableInputs,
      text: row.derivedText, correctsId: row.correctsId, correctedBy: row.correctedBy, graphEpoch,
      reviews: reviewRows.filter((review) => review.derivationId === row.id).map(({ derivationId: _derivation, ...review }) => ({
        ...review, passages: passageRows.filter((passage) => passage.derivationId === row.id && passage.reviewerId === review.reviewerId).map((passage) => ({ start: passage.start, end: passage.end, note: passage.note })),
      })),
    }];
  });
}
async function creatorNames(c: Context<ApiEnv>, ids: readonly string[]): Promise<Map<string, string>> {
  const found = await c.get('accountant').track(c.env.RF_CORE.prepare('SELECT member_id AS id, display_name AS name FROM profiles WHERE member_id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify([...new Set(ids)])).all<{ id: string; name: string }>());
  return new Map(found.results.map((row) => [row.id, row.name]));
}

async function loadRows(c: Context<ApiEnv>, where: string, ...params: unknown[]): Promise<DerivationRow[]> {
  return (await c.get('accountant').track(c.env.RF_CORE.prepare(`SELECT ${DERIVATION_COLUMNS} FROM artifact_derivations d WHERE ${where}`).bind(...params).all<DerivationRow>())).results;
}

/** The derivation `id` if its output and at least one input are readable now, else a 404 that does not say what is hidden (R55.4). */
export async function readDerivation(c: Context<ApiEnv>, id: string): Promise<DerivationView> {
  if (!isULID(id)) throw new ApiError('not_found');
  const found = (await views(c, await loadRows(c, 'd.id = ?1', id)))[0];
  if (!found) throw new ApiError('not_found');
  return found;
}

export interface DerivationPage { readonly derivations: readonly DerivationView[]; readonly next: string | null }
/**
 * The derivations of one output (with every earlier version of it), or made from one input, or recorded in one Project, a page at a time.
 * A derivation the Member cannot see on both ends is absent, and no total is given (R55.3, R55.4).
 */
export async function listDerivations(c: Context<ApiEnv>, query: { readonly outputUnitId?: string; readonly inputUnitId?: string; readonly after?: string; readonly limit?: number }): Promise<DerivationPage> {
  const limit = Math.min(Math.max(1, query.limit ?? DERIVATION_LIMITS.page), DERIVATION_LIMITS.page);
  const viewer = c.get('session').member.id;
  const conditions = ['1 = 1'];
  const params: unknown[] = [viewer];
  const add = (condition: string, value: unknown) => { params.push(value); conditions.push(condition.replace('?', `?${params.length}`)); };
  if (query.outputUnitId !== undefined) { if (!isULID(query.outputUnitId)) throw new ApiError('not_found'); add('d.output_unit_id = ?', query.outputUnitId); }
  if (query.inputUnitId !== undefined) {
    if (!isULID(query.inputUnitId)) throw new ApiError('not_found');
    add('d.corrected_by IS NULL AND EXISTS (SELECT 1 FROM artifact_derivation_inputs i WHERE i.derivation_id = d.id AND i.input_unit_id = ? AND i.gone_at IS NULL)', query.inputUnitId);
  }
  if (query.outputUnitId === undefined && query.inputUnitId === undefined) throw new ApiError('validation', { fields: [{ field: 'outputUnitId', rule: 'Name the output or an input.' }] });
  if (query.after !== undefined) add('d.id > ?', query.after);
  const rows = (await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT ${DERIVATION_COLUMNS} FROM artifact_derivations d JOIN units o ON o.id = d.output_unit_id
      WHERE ${conditions.join(' AND ')} AND ${visibleTo('o', '?1')} AND ${gone('o')} ORDER BY d.id LIMIT ${limit + 1}`,
  ).bind(...params).all<DerivationRow>())).results;
  const page = rows.slice(0, limit);
  return { derivations: await views(c, page), next: rows.length > limit ? page.at(-1)!.id : null };
}

interface Endpoints {
  readonly output: Resolved & { readonly ownerId: ULID; readonly kind: string | null };
  readonly inputs: readonly Resolved[];
}

/** Resolve a text or Attachment endpoint as the Member can read it now, naming the failing field in a refusal. */
async function resolveEndpoint(c: Context<ApiEnv>, side: DerivationEndpoint, prefix: string): Promise<Resolved> {
  try {
    return await resolveTarget(c, side.type === 'attachment' ? { type: 'attachment', unitId: side.unitId as ULID } : { type: 'text', unitId: side.unitId as ULID, field: side.field });
  } catch (error) {
    if (!(error instanceof ApiError) || error.extra.fields === undefined) throw error;
    throw new ApiError('validation', { fields: error.extra.fields.map((issue) => ({ field: issue.field.replace(/^target\./u, `${prefix}.`), rule: issue.rule })) });
  }
}


async function endpoints(c: Context<ApiEnv>, input: ReturnType<typeof parseInput>): Promise<Endpoints> {
  const unit = await readableUnit(c, input.output.unitId, 'output.unitId');
  // Recording a derivation edits the provenance of its output, so it needs the Permission to edit the record that holds the output.
  await authorize(c, [{ permission: 'item.edit', target: { type: 'research_item', ownerId: unit.ownerId, ...(unit.kind === null ? {} : { itemKind: unit.kind as never }), field: 'content' } }]);
  const output = await resolveEndpoint(c, input.output, 'output');
  const seen = new Set<string>();
  const inputs: Resolved[] = [];
  const issues: FieldIssue[] = [];
  for (const [index, side] of input.inputs.entries()) {
    const key = nodeOf(side.unitId, side.type === 'text' ? side.field : '');
    if (seen.has(key)) issues.push({ field: `inputs.${index}`, rule: 'Name each input once.' });
    seen.add(key);
    if (nodeOf(side.unitId, side.type === 'text' ? side.field : '') === nodeOf(input.output.unitId, input.output.type === 'text' ? input.output.field : '')) {
      issues.push({ field: `inputs.${index}`, rule: 'An artifact cannot be derived from itself.' });
    }
    inputs.push(await resolveEndpoint(c, side, `inputs.${index}`));
  }
  if (issues.length > 0) throw new ApiError('validation', { fields: issues });
  return { output: { ...output, ownerId: unit.ownerId, kind: unit.kind }, inputs };
}
const parseInput = (body: unknown) => parse(derivationInputSchema, body);

/** The nodes reachable from `node` by the inputs of active derivations, for the cycle check and for provenance. */
const reach = (start: string) => sql`WITH RECURSIVE reach(n) AS (
    SELECT i.input_unit_id || '#' || i.input_field FROM artifact_derivation_inputs i JOIN artifact_derivations d ON d.id = i.derivation_id
      WHERE d.output_unit_id || '#' || d.output_field = ${start} AND d.corrected_by IS NULL AND i.gone_at IS NULL
    UNION SELECT i.input_unit_id || '#' || i.input_field FROM artifact_derivation_inputs i JOIN artifact_derivations d ON d.id = i.derivation_id
      JOIN reach r ON d.output_unit_id || '#' || d.output_field = r.n WHERE d.corrected_by IS NULL AND i.gone_at IS NULL)`;

/**
 * Record a derivation of an output from its inputs, each at the exact version and hash the Member can read now, or a correction of an earlier
 * one. The batch checks again, as it commits, that no endpoint changed or went away, that no artifact has two current derivations, and that
 * the graph has no cycle (R55.1, R55.2).
 */
export async function createDerivation(c: Context<ApiEnv>, body: unknown): Promise<DerivationView> {
  const input = parseInput(body);
  const { output, inputs } = await endpoints(c, input);
  const issues: FieldIssue[] = [];
  if (input.text !== undefined && input.output.type === 'text') issues.push({ field: 'text', rule: 'The text of a text output is the field itself; name an Attachment to store a transcript for.' });
  if (input.text !== undefined && cpLength(input.text) > DERIVATION_LIMITS.derivedTextCodePoints) issues.push({ field: 'text', rule: `The text can have at most ${DERIVATION_LIMITS.derivedTextCodePoints} characters.` });
  issues.push(...unchangedOriginalIssues(output.hash, inputs.map((resolved) => resolved.hash)));
  const expected = input.expectedHashes;
  if (expected?.output !== undefined && expected.output !== output.hash) issues.push({ field: 'output', rule: 'The output changed after you chose it. Review it and record the derivation again.' });
  expected?.inputs?.forEach((hash, index) => { if (inputs[index] !== undefined && inputs[index]!.hash !== hash) issues.push({ field: `inputs.${index}`, rule: 'This input changed after you chose it. Review it and record the derivation again.' }); });
  let before: DerivationView | undefined;
  if (input.correctionOf !== undefined) {
    before = await readDerivation(c, input.correctionOf);
    if (before.correctedBy !== null) throw new ApiError('conflict', { details: { rule: 'This derivation was already corrected; correct the newer one.' } });
    const sameOutput = before.output.unitId === output.unitId && (before.output.field ?? '') === (output.field ?? '');
    if (sameOutput && before.output.sha256 === output.hash) issues.push({ field: 'output', rule: 'A correction has a new output: a new version of the file or a new revision of the text.' });
    if (!sameOutput && before.output.type !== input.output.type) issues.push({ field: 'output', rule: 'A correction has the same kind of output as the derivation it corrects.' });
  }
  if (issues.length > 0) throw new ApiError('validation', { fields: issues });

  const outputField = output.field ?? '';
  const node = nodeOf(output.unitId, outputField);
  const cyclic = (await c.get('accountant').track(c.env.RF_CORE.prepare(
    `WITH RECURSIVE reach(n) AS (SELECT value FROM json_each(?2) UNION SELECT i.input_unit_id || '#' || i.input_field FROM artifact_derivation_inputs i JOIN artifact_derivations d ON d.id = i.derivation_id
        JOIN reach r ON d.output_unit_id || '#' || d.output_field = r.n WHERE d.corrected_by IS NULL AND i.gone_at IS NULL AND d.id IS NOT ?3)
      SELECT 1 AS n FROM reach WHERE n = ?1 LIMIT 1`,
  ).bind(node, JSON.stringify(inputs.map((resolved) => nodeOf(resolved.unitId, resolved.field ?? ''))), input.correctionOf ?? null).all())).results.length > 0;
  if (cyclic) throw new ApiError('validation', { fields: [{ field: 'inputs', rule: 'An artifact cannot be derived, directly or through others, from itself.' }] });

  const id = newULID(c.get('now'));
  const batch = new GuardedBatch(c.env.RF_CORE, { id: c.get('session').member.id, now: c.get('now') });
  const edges = [output, ...inputs].map((resolved) => ({ id: resolved.unitId, rev: resolved.type === 'text' ? resolved.rev : null, root: resolved.rootId }));
  // Every endpoint still exists, and a text endpoint is still at the revision whose hash was read (R55.1).
  batch.guard('rev', sql`NOT EXISTS (SELECT 1 FROM json_each(${JSON.stringify(edges)}) j WHERE NOT EXISTS (SELECT 1 FROM units u WHERE u.id = j.value ->> '$.id'
      AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id IN (u.id, u.root_id))
      AND (j.value ->> '$.rev' IS NULL OR (SELECT rev FROM units r WHERE r.id = u.root_id) = j.value ->> '$.rev')))`);
  if (input.correctionOf !== undefined) {
    batch.guard('derivation_tip', sql`EXISTS (SELECT 1 FROM artifact_derivations WHERE id = ${input.correctionOf} AND corrected_by IS NULL)`);
    batch.update(artifactDerivations, { correctedBy: id, correctedAt: batch.actor.now }, sql`id = ${input.correctionOf}`);
  }
  batch.guard('derivation_tip', sql`NOT EXISTS (SELECT 1 FROM artifact_derivations WHERE output_unit_id = ${output.unitId} AND output_field = ${outputField} AND corrected_by IS NULL)`);
  batch.insert(artifactDerivations, {
    id, outputType: output.type as 'attachment' | 'text', outputUnitId: output.unitId, outputField, outputRev: output.type === 'text' ? output.rev : null, outputSha256: output.hash,
    kind: input.kind, method: input.method, methodVersion: input.methodVersion ?? null, language: input.language ?? null, uncertainty: input.uncertainty ?? null,
    derivedText: input.text ?? null, createdBy: batch.actor.id!, createdAt: batch.actor.now, reviewState: 'unreviewed', correctsId: input.correctionOf ?? null,
  });
  batch.bulkInsert(artifactDerivationInputs, inputs.map((resolved, position) => ({
    derivationId: id, position, inputType: resolved.type as 'attachment' | 'text', inputUnitId: resolved.unitId, inputField: resolved.field ?? '', inputRev: resolved.type === 'text' ? resolved.rev : null, inputSha256: resolved.hash,
  })));
  // After the writes, so the check sees the graph as this transaction leaves it: no artifact is derived from itself.
  batch.guard('derivation_cycle', sql`NOT EXISTS (${reach(node)} SELECT 1 FROM reach WHERE n = ${node})`);
  batch.run(sql`UPDATE counters SET v = v + 1 WHERE k = 'derivation'`);
  batch.outboxMany('search', [output.rootId, ...inputs.map((resolved) => resolved.rootId)].map((root) => `unit:${root}`));
  batch.outboxMany('publish', [output.rootId, ...inputs.map((resolved) => resolved.rootId)].map((root) => `unit:${root}`));
  await batch.commit(c.get('accountant'));
  return readDerivation(c, id);
}

/**
 * Record the Member's own review of a derivation and the passages of its text they find uncertain. The reviewer is not the one who recorded
 * the derivation, and a passage names UTF-16 offsets of the exact text the derivation recorded (R55.3).
 */
export async function reviewDerivation(c: Context<ApiEnv>, id: string, body: unknown): Promise<DerivationView> {
  const input = parse(derivationReviewSchema, body);
  const derivation = await readDerivation(c, id);
  const reviewer = c.get('session').member.id;
  await authorize(c, [{ permission: 'derivation.review', target: { type: 'derivation_review', memberId: reviewer } }]);
  const issues: FieldIssue[] = [];
  if (derivation.createdBy === reviewer) issues.push({ field: 'state', rule: 'Another Member reviews a derivation; you recorded this one.' });
  if (derivation.correctedBy !== null) throw new ApiError('conflict', { details: { rule: 'This derivation was corrected; review its correction.' } });
  if (input.passages.length > 0) {
    let text: string | undefined;
    if (derivation.output.type === 'attachment') text = derivation.text ?? undefined;
    else {
      const current = await resolveEndpoint(c, { type: 'text', unitId: derivation.output.unitId, field: derivation.output.field ?? '' }, 'output');
      if (current.hash !== derivation.output.sha256) issues.push({ field: 'passages', rule: 'The text changed after this derivation recorded it; record a correction, then mark passages in that.' });
      else text = current.locatorTarget.type === 'text' ? current.locatorTarget.text : undefined;
    }
    if (text === undefined) { if (issues.length === 0) issues.push({ field: 'passages', rule: 'This derivation has no stored text to mark.' }); } else issues.push(...passageIssues(input.passages, text));
  }
  if (issues.length > 0) throw new ApiError('validation', { fields: issues });

  const batch = new GuardedBatch(c.env.RF_CORE, { id: reviewer, now: c.get('now') });
  batch.guard('derivation_tip', sql`EXISTS (SELECT 1 FROM artifact_derivations WHERE id = ${derivation.id} AND corrected_by IS NULL)`);
  batch.run(sql`INSERT INTO derivation_reviews (derivation_id, reviewer_id, state, note, reviewed_at) VALUES (${derivation.id}, ${reviewer}, ${input.state}, ${input.note ?? null}, ${batch.actor.now})
    ON CONFLICT (derivation_id, reviewer_id) DO UPDATE SET state = excluded.state, note = excluded.note, reviewed_at = excluded.reviewed_at`);
  batch.run(sql`DELETE FROM derivation_flags WHERE derivation_id = ${derivation.id} AND reviewer_id = ${reviewer}`);
  batch.bulkInsert(derivationFlags, input.passages.map((passage, position) => ({
    derivationId: derivation.id, reviewerId: reviewer, position, startOffset: passage.start, endOffset: passage.end, note: passage.note ?? null,
  })));
  batch.update(artifactDerivations, {}, sql`id = ${derivation.id}`);
  batch.run(sql`UPDATE artifact_derivations SET review_state = CASE
      WHEN EXISTS (SELECT 1 FROM derivation_reviews r WHERE r.derivation_id = ${derivation.id} AND r.reviewer_id <> created_by AND r.state = 'disputed') THEN 'disputed'
      WHEN EXISTS (SELECT 1 FROM derivation_reviews r WHERE r.derivation_id = ${derivation.id} AND r.reviewer_id <> created_by) THEN 'reviewed' ELSE 'unreviewed' END
    WHERE id = ${derivation.id}`);
  await batch.commit(c.get('accountant'));
  return readDerivation(c, id);
}

export interface ProvenanceNode { readonly unitId: ULID; readonly field?: string; readonly rootId: ULID; readonly identifier: string; readonly title: string; readonly type: 'attachment' | 'text'; readonly sha256: string }
export interface ProvenanceEdge { readonly derivationId: ULID; readonly from: { unitId: ULID; field?: string }; readonly to: { unitId: ULID; field?: string }; readonly kind: DerivationKind; readonly method: string; readonly reviewState: ReviewState }
export interface Provenance { readonly graphEpoch: number; readonly start: { unitId: ULID; field?: string }; readonly direction: 'sources' | 'derivatives'; readonly nodes: readonly ProvenanceNode[]; readonly edges: readonly ProvenanceEdge[]; readonly truncated: boolean }

const PATH_DEPTH = 25;
const PATH_NODES = 500;
/**
 * The readable path from an artifact back to the originals it was derived from (`sources`), or on to what was derived from it
 * (`derivatives`). An edge is followed only while both its ends are readable, so no node is reached through one the Member cannot read (R55.3, R55.4).
 */
export async function provenance(c: Context<ApiEnv>, unitId: string, field: string, direction: 'sources' | 'derivatives'): Promise<Provenance> {
  if (!isULID(unitId)) throw new ApiError('not_found');
  const viewer = c.get('session').member.id;
  const start = (await describeUnits(c, [unitId])).get(unitId);
  if (!start) throw new ApiError('not_found');
  const db = c.env.RF_CORE;
  const nodes = new Map<string, { unitId: ULID; field: string; type: 'attachment' | 'text'; sha256: string }>();
  const edges: ProvenanceEdge[] = [];
  const seenEdges = new Set<string>();
  let frontier = [nodeOf(unitId, field)];
  const visited = new Set(frontier);
  let truncated = false;
  for (let depth = 0; depth < PATH_DEPTH && frontier.length > 0; depth += 1) {
    const from = direction === 'sources' ? "d.output_unit_id || '#' || d.output_field" : "i.input_unit_id || '#' || i.input_field";
    const rows = (await c.get('accountant').track(db.prepare(
      `SELECT d.id, d.kind, d.method, d.review_state AS reviewState, d.output_type AS outputType, d.output_unit_id AS outputUnitId, d.output_field AS outputField, d.output_sha256 AS outputSha256,
          i.input_type AS inputType, i.input_unit_id AS inputUnitId, i.input_field AS inputField, i.input_sha256 AS inputSha256
        FROM artifact_derivations d JOIN artifact_derivation_inputs i ON i.derivation_id = d.id JOIN units o ON o.id = d.output_unit_id JOIN units n ON n.id = i.input_unit_id
        WHERE d.corrected_by IS NULL AND i.gone_at IS NULL AND ${from} IN (SELECT value FROM json_each(?1))
          AND ${visibleTo('o', '?2')} AND ${gone('o')} AND ${visibleTo('n', '?2')} AND ${gone('n')} ORDER BY d.id, i.position`,
    ).bind(JSON.stringify(frontier), viewer).all<{
      id: ULID; kind: DerivationKind; method: string; reviewState: ReviewState; outputType: 'attachment' | 'text'; outputUnitId: ULID; outputField: string; outputSha256: string;
      inputType: 'attachment' | 'text'; inputUnitId: ULID; inputField: string; inputSha256: string;
    }>())).results;
    const next: string[] = [];
    for (const row of rows) {
      const outputNode = nodeOf(row.outputUnitId, row.outputField);
      const inputNode = nodeOf(row.inputUnitId, row.inputField);
      nodes.set(outputNode, { unitId: row.outputUnitId, field: row.outputField, type: row.outputType, sha256: row.outputSha256 });
      nodes.set(inputNode, { unitId: row.inputUnitId, field: row.inputField, type: row.inputType, sha256: row.inputSha256 });
      const key = `${row.id}|${inputNode}`;
      if (!seenEdges.has(key)) {
        seenEdges.add(key);
        edges.push({ derivationId: row.id, from: { unitId: row.inputUnitId, ...(row.inputField === '' ? {} : { field: row.inputField }) }, to: { unitId: row.outputUnitId, ...(row.outputField === '' ? {} : { field: row.outputField }) }, kind: row.kind, method: row.method, reviewState: row.reviewState });
      }
      const reached = direction === 'sources' ? inputNode : outputNode;
      if (!visited.has(reached)) {
        if (visited.size >= PATH_NODES) { truncated = true; continue; }
        visited.add(reached);
        next.push(reached);
      }
    }
    frontier = next;
  }
  if (frontier.length > 0) truncated = true;
  const described = await describeUnits(c, [...nodes.values()].map((node) => node.unitId));
  const startNode = nodeOf(unitId, field);
  if (!nodes.has(startNode)) nodes.set(startNode, { unitId: unitId as ULID, field, type: field === '' ? 'attachment' : 'text', sha256: '' });
  const epoch = rowsOf<{ v: number }>(await c.get('accountant').track(db.prepare("SELECT v FROM counters WHERE k = 'derivation'").all()))[0]?.v ?? 0;
  return {
    graphEpoch: epoch, start: { unitId: unitId as ULID, ...(field === '' ? {} : { field }) }, direction, truncated, edges,
    nodes: [...nodes.values()].flatMap((node) => {
      const record = described.get(node.unitId);
      return record ? [{ unitId: node.unitId, ...(node.field === '' ? {} : { field: node.field }), rootId: record.rootId, identifier: record.identifier, title: record.title, type: node.type, sha256: node.sha256 }] : [];
    }),
  };
}
