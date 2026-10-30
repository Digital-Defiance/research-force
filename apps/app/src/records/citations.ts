import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { GuardedBatch } from '@researchforce/db/batch';
import { evidenceCitations } from '@researchforce/db/schema/core';
import { sourceVersionDigest } from '@researchforce/domain/bibliography';
import type { Bibliography } from '@researchforce/domain/bibliography';
import { citationInputSchema, CITATION_LIMITS, locatorIssues, locatorLabel, locatorSchema } from '@researchforce/domain/citations';
import type { CitationRole, CitationState, Locator, LocatorTarget } from '@researchforce/domain/citations';
import { newULID } from '@researchforce/domain/identifiers';
import type { FileKind } from '@researchforce/domain/file-kinds';
import type { RichText } from '@researchforce/domain/richtext';
import { fragmentDigest } from '@researchforce/domain/text-fragments';
import { isULID } from '@researchforce/domain/types';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import type { FieldIssue } from '../api/errors';
import { parse } from '../api/input';
import { authorize } from '../auth/authorize';
import { loadItem } from './items';
import { visibleTo } from './submissions';

type Target = { type: 'source' | 'attachment' | 'text'; unitId: ULID; field?: string };

/** The digest that binds a citation to the exact text it cites; spans and labels do not change what was cited. */
export const textDigest = (text: string): string => fragmentDigest({ version: 'cited-text-v1', text });

/** What a target is right now, resolved for a Member who can read it (R54.2, R54.3). */
interface Resolved {
  readonly type: Target['type'];
  readonly unitId: ULID;
  readonly rootId: ULID;
  readonly field: string | null;
  readonly rev: number | null;
  readonly versionId: string | null;
  readonly hash: string;
  readonly locatorTarget: LocatorTarget;
}

const notReadable = (field: string): ApiError => new ApiError('validation', { fields: [{ field, rule: 'This record does not exist, has been permanently deleted, or cannot be read.' }] });

interface UnitRow { id: ULID; unitType: string; rootId: ULID; ownerId: ULID; kind: string | null }
/** A unit the Member can read now, with its Root_Item's kind and Owner (R54.3). */
async function readableUnit(c: Context<ApiEnv>, id: string, field: string): Promise<UnitRow> {
  const found = isULID(id) ? await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT u.id, u.unit_type AS unitType, u.root_id AS rootId, r.owner_id AS ownerId, ri.kind
      FROM units u JOIN units r ON r.id = u.root_id JOIN research_items ri ON ri.unit_id = r.id
      WHERE u.id = ?1 AND ${visibleTo('u', '?2')} AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = u.id OR d.unit_id = u.root_id)`,
  ).bind(id, c.get('session').member.id).all<UnitRow>()) : undefined;
  const unit = found?.results[0];
  if (!unit) throw notReadable(field);
  return unit;
}

async function resolveTarget(c: Context<ApiEnv>, target: Target): Promise<Resolved> {
  const unit = await readableUnit(c, target.unitId, 'target.unitId');
  const refuse = (rule: string): never => { throw new ApiError('validation', { fields: [{ field: 'target.unitId', rule }] }); };
  if (target.type === 'attachment') {
    if (unit.unitType !== 'attachment') return refuse('This is not an Attachment.');
    const row = (await c.get('accountant').track(c.env.RF_CORE.prepare('SELECT sha256, file_kind AS fileKind FROM attachments WHERE unit_id = ?1').bind(unit.id).all<{ sha256: string; fileKind: FileKind }>())).results[0];
    if (!row) return refuse('This is not an Attachment.');
    return { type: 'attachment', unitId: unit.id, rootId: unit.rootId, field: null, rev: null, versionId: null, hash: row.sha256, locatorTarget: { type: 'attachment', fileKind: row.fileKind } };
  }
  const item = await loadItem(c, unit.rootId);
  if (target.type === 'source') {
    if (unit.unitType !== 'research_item' || item.base.kind !== 'source') return refuse('This is not a Source.');
    const fields = item.fields;
    const hash = sourceVersionDigest({
      title: item.base.title, documentDate: fields['documentDate'], archiveOrCollection: fields['archiveOrCollection'] as string | undefined,
      archivalReference: fields['archivalReference'] as string | undefined, bibliography: fields['bibliography'] as Bibliography | undefined,
    });
    return { type: 'source', unitId: unit.id, rootId: unit.rootId, field: null, rev: item.base.rev, versionId: null, hash, locatorTarget: { type: 'source' } };
  }
  const field = target.field ?? '';
  const value = unit.unitType === 'entry_section'
    ? (field === 'content' ? (item.fields['sections'] as readonly { id: string; content: RichText }[] | undefined)?.find((section) => section.id === unit.id)?.content : undefined)
    : unit.unitType === 'research_item'
      ? (field === 'logSummary' ? item.base.logSummary ?? undefined : item.fields[field] as RichText | undefined)
      : undefined;
  if (value === undefined || typeof value !== 'object' || value === null || typeof value.text !== 'string') {
    throw new ApiError('validation', { fields: [{ field: 'target.field', rule: 'This record has no such text field.' }] });
  }
  const version = (await c.get('accountant').track(c.env.RF_CORE.prepare("SELECT version_id AS versionId FROM field_current WHERE owner_type = 'unit' AND owner_id = ?1 AND field_key = ?2").bind(unit.id, field).all<{ versionId: string }>())).results[0];
  return { type: 'text', unitId: unit.id, rootId: unit.rootId, field, rev: item.base.rev, versionId: version?.versionId ?? null, hash: textDigest(value.text), locatorTarget: { type: 'text', text: value.text } };
}

export interface CitationView {
  readonly id: ULID;
  readonly citingUnitId: ULID;
  readonly citingField: string;
  readonly target: { readonly type: Target['type']; readonly unitId: ULID; readonly field?: string };
  readonly role: CitationRole;
  readonly locator: Locator;
  readonly locatorLabel: string;
  readonly contentHash: string;
  readonly targetRev: number | null;
  /** Whether the target still reads as it did when it was cited; an earlier version is never silently re-aimed (R54.3). */
  readonly state: CitationState;
  readonly earlierVersionAt: Timestamp | null;
  readonly createdBy: ULID;
  readonly createdAt: Timestamp;
  readonly retiredAt: Timestamp | null;
  readonly replacedBy: ULID | null;
}
interface CitationRow {
  id: ULID; citingUnitId: ULID; citingRootId: ULID; citingField: string; targetType: Target['type']; targetUnitId: ULID; targetRootId: ULID; targetField: string | null;
  targetRev: number | null; contentHash: string; role: CitationRole; locatorJson: string; createdBy: ULID; createdAt: Timestamp;
  earlierVersionAt: Timestamp | null; retiredAt: Timestamp | null; replacedBy: ULID | null;
}
const COLUMNS = `c.id, c.citing_unit_id AS citingUnitId, c.citing_root_id AS citingRootId, c.citing_field AS citingField, c.target_type AS targetType, c.target_unit_id AS targetUnitId,
  c.target_root_id AS targetRootId, c.target_field AS targetField, c.target_rev AS targetRev, c.content_hash AS contentHash, c.role, c.locator_json AS locatorJson,
  c.created_by AS createdBy, c.created_at AS createdAt, c.earlier_version_at AS earlierVersionAt, c.retired_at AS retiredAt, c.replaced_by AS replacedBy`;

function view(row: CitationRow): CitationView {
  const locator = locatorSchema.parse(JSON.parse(row.locatorJson));
  return {
    id: row.id, citingUnitId: row.citingUnitId, citingField: row.citingField,
    target: { type: row.targetType, unitId: row.targetUnitId, ...(row.targetField === null ? {} : { field: row.targetField }) },
    role: row.role, locator, locatorLabel: locatorLabel(locator), contentHash: row.contentHash, targetRev: row.targetRev,
    state: row.earlierVersionAt === null ? 'current' : 'earlier_version', earlierVersionAt: row.earlierVersionAt,
    createdBy: row.createdBy, createdAt: row.createdAt, retiredAt: row.retiredAt, replacedBy: row.replacedBy,
  };
}

/**
 * The citations among `ids` whose citing and cited units the Member can read now. A citation with an end the Member cannot read is not
 * returned, and nothing about it, its locator, or its count is revealed (R54.5).
 */
export async function readableCitations(c: Context<ApiEnv>, where: { readonly ids?: readonly string[]; readonly citingRootId?: string; readonly targetUnitId?: string; readonly includeRetired?: boolean }): Promise<CitationView[]> {
  const conditions = ['1 = 1'];
  const params: unknown[] = [c.get('session').member.id];
  const add = (condition: string, value: unknown) => { params.push(value); conditions.push(condition.replace('?', `?${params.length}`)); };
  if (where.ids !== undefined) add('c.id IN (SELECT value FROM json_each(?))', JSON.stringify(where.ids));
  if (where.citingRootId !== undefined) add('c.citing_root_id = ?', where.citingRootId);
  if (where.targetUnitId !== undefined) add('c.target_unit_id = ?', where.targetUnitId);
  if (where.includeRetired !== true) conditions.push('c.retired_at IS NULL');
  const result = await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT ${COLUMNS} FROM evidence_citations c JOIN units cu ON cu.id = c.citing_unit_id JOIN units tu ON tu.id = c.target_unit_id
      WHERE ${conditions.join(' AND ')} AND ${visibleTo('cu', '?1')} AND ${visibleTo('tu', '?1')}
        AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id IN (c.citing_unit_id, c.citing_root_id, c.target_unit_id, c.target_root_id))
      ORDER BY c.id LIMIT 1001`,
  ).bind(...params).all<CitationRow>());
  return result.results.map(view);
}

/** The citation `id` if both of its ends are readable now, else a 404 that does not say which end is hidden (R54.5). */
export async function readCitation(c: Context<ApiEnv>, id: string): Promise<CitationView> {
  if (!isULID(id)) throw new ApiError('not_found');
  const found = await readableCitations(c, { ids: [id], includeRetired: true });
  if (!found[0]) throw new ApiError('not_found');
  return found[0];
}

interface Plan { readonly input: ReturnType<typeof parseInput>; readonly resolved: Resolved; readonly citingRootId: ULID }
const parseInput = (body: unknown) => parse(citationInputSchema, body);

/** Validate a citation against both ends as they are now, without writing anything (R54.3). */
async function plan(c: Context<ApiEnv>, body: unknown, replacing?: ULID): Promise<Plan> {
  const input = parseInput(body);
  const citing = await readableUnit(c, input.citingUnitId, 'citingUnitId');
  if (citing.unitType !== 'research_item' && citing.unitType !== 'entry_section') {
    throw new ApiError('validation', { fields: [{ field: 'citingUnitId', rule: 'Only a Research Item or one of its Entry Sections can cite.' }] });
  }
  // Citing is part of editing the record that cites; the Member needs the Permission to edit it (design "Permissions").
  await authorize(c, [{ permission: 'item.edit', target: { type: 'research_item', ownerId: citing.ownerId, ...(citing.kind === null ? {} : { itemKind: citing.kind as never }), field: 'content' } }]);
  const resolved = await resolveTarget(c, input.target as Target);
  const issues: FieldIssue[] = [];
  if (input.expectedHash !== undefined && input.expectedHash !== resolved.hash) issues.push({ field: 'expectedHash', rule: 'The cited record changed after you chose it. Review it and cite it again.' });
  issues.push(...locatorIssues(input.locator, resolved.locatorTarget));
  if (issues.length > 0) throw new ApiError('validation', { fields: issues });
  const count = (await c.get('accountant').track(c.env.RF_CORE.prepare(
    'SELECT count(*) AS n FROM evidence_citations WHERE citing_root_id = ?1 AND retired_at IS NULL AND id IS NOT ?2',
  ).bind(citing.rootId, replacing ?? null).all<{ n: number }>())).results[0]!.n;
  if (count >= CITATION_LIMITS.perRecord) throw new ApiError('validation', { fields: [{ field: 'citingUnitId', rule: `A record can hold at most ${CITATION_LIMITS.perRecord} citations.` }] });
  return { input, resolved, citingRootId: citing.rootId };
}

function writeCitation(batch: GuardedBatch, { input, resolved, citingRootId }: Plan, id: ULID): void {
  const { actor } = batch;
  // Both ends must still be there and the target must still be at the version that was validated (R54.3).
  batch.guard('rev', sql`EXISTS (SELECT 1 FROM units WHERE id = ${input.citingUnitId}) AND NOT EXISTS (SELECT 1 FROM deletions WHERE unit_id IN (${input.citingUnitId}, ${citingRootId}, ${resolved.unitId}, ${resolved.rootId}))
    AND (${resolved.rev} IS NULL OR (SELECT rev FROM units WHERE id = ${resolved.rootId}) = ${resolved.rev})`);
  batch.insert(evidenceCitations, {
    id, citingUnitId: input.citingUnitId, citingRootId, citingField: input.citingField, targetType: resolved.type, targetUnitId: resolved.unitId, targetRootId: resolved.rootId,
    targetField: resolved.field, targetVersionId: resolved.versionId, targetRev: resolved.rev, contentHash: resolved.hash, role: input.role,
    locatorType: input.locator.type, locator: JSON.stringify(input.locator), createdBy: actor.id!, createdAt: actor.now,
  });
  batch.outboxMany('publish', [`unit:${citingRootId}`, `unit:${resolved.rootId}`]);
}

/** Record a citation of one exact version of a Source, Attachment, or text, with a locator valid for it (R54.2, R54.3). */
export async function createCitation(c: Context<ApiEnv>, body: unknown): Promise<CitationView> {
  const planned = await plan(c, body);
  const id = newULID(c.get('now'));
  const batch = new GuardedBatch(c.env.RF_CORE, { id: c.get('session').member.id, now: c.get('now') });
  writeCitation(batch, planned, id);
  await batch.commit(c.get('accountant'));
  return readCitation(c, id);
}

/** Change a citation by retiring it and recording its replacement, so that what was cited is never rewritten (R54.3). */
export async function replaceCitation(c: Context<ApiEnv>, oldId: string, body: unknown): Promise<CitationView> {
  const before = await readCitation(c, oldId);
  if (before.retiredAt !== null) throw new ApiError('conflict', { details: { rule: 'This citation was already replaced or removed.' } });
  const planned = await plan(c, body, before.id);
  if (planned.input.citingUnitId !== before.citingUnitId || planned.input.citingField !== before.citingField) {
    throw new ApiError('validation', { fields: [{ field: 'citingUnitId', rule: 'A replacement cites from the same place as the citation it replaces.' }] });
  }
  const id = newULID(c.get('now'));
  const batch = new GuardedBatch(c.env.RF_CORE, { id: c.get('session').member.id, now: c.get('now') })
    .guard('rev', sql`EXISTS (SELECT 1 FROM evidence_citations WHERE id = ${before.id} AND retired_at IS NULL)`);
  writeCitation(batch, planned, id);
  batch.update(evidenceCitations, { retiredAt: batch.actor.now, retiredBy: batch.actor.id!, replacedBy: id }, sql`id = ${before.id}`);
  await batch.commit(c.get('accountant'));
  return readCitation(c, id);
}

/** Remove a citation from use. The row stays, with the removing Member and time, so that history keeps what was cited. */
export async function retireCitation(c: Context<ApiEnv>, id: string): Promise<CitationView> {
  const before = await readCitation(c, id);
  const citing = await readableUnit(c, before.citingUnitId, 'citingUnitId');
  await authorize(c, [{ permission: 'item.edit', target: { type: 'research_item', ownerId: citing.ownerId, ...(citing.kind === null ? {} : { itemKind: citing.kind as never }), field: 'content' } }]);
  if (before.retiredAt !== null) return before;
  const batch = new GuardedBatch(c.env.RF_CORE, { id: c.get('session').member.id, now: c.get('now') })
    .guard('rev', sql`EXISTS (SELECT 1 FROM evidence_citations WHERE id = ${before.id} AND retired_at IS NULL)`)
    .update(evidenceCitations, { retiredAt: c.get('now'), retiredBy: c.get('session').member.id }, sql`id = ${before.id}`);
  await batch.commit(c.get('accountant'));
  return readCitation(c, id);
}

/**
 * Mark the citations of a target whose content no longer matches the content they cite, in the batch that changes it. They keep citing the
 * earlier version; nothing is retargeted (R54.3). A null hash marks every citation of the target, as when an Attachment gets a successor.
 */
export function markEarlierVersions(batch: GuardedBatch, target: Target, currentHash: string | null): void {
  batch.update(evidenceCitations, { earlierVersionAt: batch.actor.now },
    sql`target_unit_id = ${target.unitId} AND target_type = ${target.type} AND ${target.field ?? null} IS target_field AND earlier_version_at IS NULL AND retired_at IS NULL
      AND (${currentHash} IS NULL OR content_hash <> ${currentHash})`);
}

/**
 * Mark the citations of Entry_Sections whose text changed. A section with its text is compared by digest; one without, as in a staged save
 * whose text stays in D1, is marked when it was changed at all (a change of labels alone marks it too, which errs toward warning).
 */
export function markChangedSections(batch: GuardedBatch, sections: readonly { readonly id: string; readonly text?: string }[]): void {
  if (sections.length === 0) return;
  for (let at = 0; at < sections.length; at += 500) {
    const current = JSON.stringify(sections.slice(at, at + 500).map((section) => ({ id: section.id, hash: section.text === undefined ? null : textDigest(section.text) })));
    batch.update(evidenceCitations, { earlierVersionAt: batch.actor.now },
      sql`target_type = 'text' AND target_field = 'content' AND earlier_version_at IS NULL AND retired_at IS NULL
        AND EXISTS (SELECT 1 FROM json_each(${current}) j WHERE j.value ->> '$.id' = target_unit_id AND (j.value ->> '$.hash' IS NULL OR j.value ->> '$.hash' <> content_hash))`);
  }
}

/** What a save of Research_Item `kind` changes for the citations of its Source description and text fields (R54.3). */
export function markChangedTargets(batch: GuardedBatch, item: { readonly id: ULID; readonly kind: string }, after: Readonly<Record<string, unknown>>, changed: ReadonlySet<string>): void {
  if (item.kind === 'source') {
    const citable = ['title', 'documentDate', 'archiveOrCollection', 'archivalReference', 'bibliography'];
    if (citable.some((field) => changed.has(field))) {
      markEarlierVersions(batch, { type: 'source', unitId: item.id }, sourceVersionDigest({
        title: after['title'] as string, documentDate: after['documentDate'], archiveOrCollection: after['archiveOrCollection'] as string | undefined,
        archivalReference: after['archivalReference'] as string | undefined, bibliography: after['bibliography'] as Bibliography | undefined,
      }));
    }
  }
  for (const field of changed) {
    const value = after[field] as { text?: unknown } | undefined | null;
    if (field === 'sections') continue;
    if (value === null || value === undefined || (typeof value === 'object' && typeof value.text === 'string')) {
      markEarlierVersions(batch, { type: 'text', unitId: item.id, field }, textDigest(value?.text as string | undefined ?? ''));
    }
  }
}
