import type { Context } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { GuardedBatch } from '@researchforce/db/batch';
import { attachments, units } from '@researchforce/db/schema/core';
import type { ValidationContext } from '@researchforce/domain/schemas/common';
import { fileKind } from '@researchforce/domain/file-kinds';
import { newULID } from '@researchforce/domain/identifiers';
import { attachmentMetadataSchema, editMarkSchema } from '@researchforce/domain/schemas/other';
import { isULID } from '@researchforce/domain/types';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import { BUILT_IN_VALUE_IDS } from '@researchforce/domain/value-sets';
import { announceSubmission } from '../activity/flags';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import { parse } from '../api/input';
import { authorize } from '../auth/authorize';
import { validationContext } from '../records/items';
import { commitSave, diffFields } from '../records/pipeline';
import { addSubmission, commitWithIdentifiers, visibleTo } from '../records/submissions';
import type { UploadRow } from './uploads';
import { refuseSuperseded, versionChain, versionConflict } from './versions';

const selection = z.array(z.strictObject({ uploadId: z.ulid(), metadata: z.record(z.string(), z.unknown()) })).max(100);
interface Parent { id: ULID; rootId: ULID; projectId: ULID; ownerId: ULID; unitType: 'research_item' | 'reply'; rightsStatusId: ULID | null; rightsHolder: string | null; rightsTerms: string | null; retired: number | null }
export async function attachmentParent(c: Context<ApiEnv>, id: string): Promise<Parent> {
  const result = isULID(id) ? await c.get('accountant').track(c.env.RF_CORE.prepare(`SELECT u.id, u.root_id AS rootId, u.project_id AS projectId, u.owner_id AS ownerId,
    u.unit_type AS unitType, s.rights_status_id AS rightsStatusId, s.rights_holder AS rightsHolder, s.rights_terms AS rightsTerms, cv.retired
    FROM units u LEFT JOIN sources s ON s.unit_id = u.id LEFT JOIN config_values cv ON cv.id = s.rights_status_id
    WHERE u.id = ?1 AND u.unit_type IN ('research_item', 'reply') AND ${visibleTo('u', '?2')}
      AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = u.id)`)
    .bind(id, c.get('session').member.id).all<Parent>()) : undefined;
  if (!result?.results[0]) throw new ApiError('not_found');
  return result.results[0];
}
function validateMetadata(context: ValidationContext, file: UploadRow, index: number, value: unknown) {
  try { return parse(attachmentMetadataSchema(context), value); }
  catch (error) { if (error instanceof ApiError) throw new ApiError(error.code, { fields: error.extra.fields?.map((field) => ({ field: `files.${index}.metadata.${field.field}`, rule: `${file.fileName}: ${field.rule}` })) ?? [] }); throw error; }
}
export interface AttachmentPlan {
  readonly ids: ULID[];
  write(batch: GuardedBatch, issued: ReadonlyMap<ULID, string>, parent: { id: ULID; rootId: ULID; projectId: ULID }, submissionId: ULID): void;
}
/** Shared by a new Item, a new Reply, and the file-only Submission. No bytes are read while saving. */
export async function prepareAttachments(c: Context<ApiEnv>, raw: unknown, inherited?: Pick<Parent, 'rightsStatusId' | 'rightsHolder' | 'rightsTerms' | 'retired'>, version?: { id: ULID; chainId: string }): Promise<AttachmentPlan> {
  const input = parse(selection, raw ?? []);
  if (input.length > 0) await authorize(c, [{ permission: 'attachment.upload' }]);
  const context = input.length > 0 ? await validationContext(c) : undefined;
  const uploadRows = input.length ? await c.get('accountant').track(c.env.RF_CORE.prepare(`SELECT id, group_id AS groupId, state, owner_type AS ownerType, owner_id AS ownerId,
    r2_key AS r2Key, file_name AS fileName, size_bytes AS sizeBytes, sha256, mode, multipart_id AS multipartId, created_at AS createdAt,
    completed_at AS completedAt, attached_at AS attachedAt FROM uploads WHERE id IN (SELECT value FROM json_each(?1)) AND owner_type = 'member' AND owner_id = ?2`)
    .bind(JSON.stringify(input.map((file) => file.uploadId)), c.get('session').member.id).all<UploadRow>()) : undefined;
  const uploaded = new Map(uploadRows?.results.map((row) => [row.id, row]));
  const seen = new Set<string>();
  const planned: { id: ULID; upload: UploadRow; metadata: z.output<ReturnType<typeof attachmentMetadataSchema>> }[] = [];
  for (const [index, file] of input.entries()) {
    if (seen.has(file.uploadId)) throw new ApiError('validation', { fields: [{ field: `files.${index}`, rule: 'Choose each uploaded file once.' }] });
    seen.add(file.uploadId);
    const upload = uploaded.get(file.uploadId);
    if (!upload) throw new ApiError('validation', { fields: [{ field: `files.${index}`, rule: 'The uploaded file is unavailable. Retry or remove it.' }] });
    if (upload.state !== 'complete' || upload.completedAt === null || upload.attachedAt !== null) throw new ApiError('validation', { fields: [{ field: `files.${index}`, rule: `${upload.fileName}: This upload is incomplete, expired, or already used. Retry or remove it.` }] });
    const defaults = inherited && !version ? { rightsStatusId: inherited.retired === 0 ? inherited.rightsStatusId ?? BUILT_IN_VALUE_IDS.rightsUnknown : BUILT_IN_VALUE_IDS.rightsUnknown,
      ...(inherited.rightsHolder === null ? {} : { rightsHolder: inherited.rightsHolder }), ...(inherited.rightsTerms === null ? {} : { rightsTerms: inherited.rightsTerms }) } : {};
    const metadata = validateMetadata(context!, upload, index, { title: upload.fileName, ...defaults, ...file.metadata,
      ...(version ? { rightsStatusId: BUILT_IN_VALUE_IDS.rightsUnknown } : {}) });
    planned.push({ id: newULID(c.get('now')), upload, metadata });
  }
  const actor = c.get('session').member.id;
  const now = c.get('now');
  return { ids: planned.map((p) => p.id), write(batch, issued, parent, submissionId) {
    if (version) batch.guard('chain_tip', sql`EXISTS (SELECT 1 FROM attachments a JOIN units u ON u.id = a.unit_id WHERE a.unit_id = ${version.id} AND a.chain_id = ${version.chainId} AND u.parent_id = ${parent.id} AND u.root_id = ${parent.rootId} AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = u.id)) AND NOT EXISTS (SELECT 1 FROM attachments WHERE supersedes_unit_id = ${version.id})`);
    if (planned.length === 0) return;
    batch.guard('reply_parent', sql`EXISTS (SELECT 1 FROM units p WHERE p.id = ${parent.id} AND p.root_id = ${parent.rootId} AND p.project_id = ${parent.projectId} AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = p.id OR d.unit_id = p.root_id))`);
    const uploadIds = JSON.stringify(planned.map((p) => p.upload.id));
    batch.guard('upload_ready', sql`(SELECT count(*) FROM uploads WHERE id IN (SELECT value FROM json_each(${uploadIds})) AND owner_id = ${actor} AND state = 'complete' AND attached_at IS NULL) = ${planned.length}`);
    batch.bulkInsert(units, planned.map((p) => ({ id: p.id, unitType: 'attachment' as const, projectId: parent.projectId, rootId: parent.rootId, parentId: parent.id,
      ownerId: actor, credit: [{ member: actor }], submissionId, createdAt: now })));
    batch.bulkInsert(attachments, planned.map((p) => ({ unitId: p.id, itemIdentifier: issued.get(p.id)!, ...p.metadata,
      fileKind: fileKind(p.upload.fileName), originalName: p.upload.fileName, sizeBytes: p.upload.sizeBytes, sha256: p.upload.sha256,
      r2Key: p.upload.r2Key, uploadedAt: p.upload.completedAt!, chainId: version?.chainId ?? p.id, supersedesUnitId: version?.id ?? null })));
    batch.run(sql`UPDATE uploads SET attached_at = ${now}, state = 'attached' WHERE id IN (SELECT value FROM json_each(${uploadIds}))`);
    batch.outbox('search', `root:${parent.rootId}`).outbox('publish', `root:${parent.rootId}`);
  } };
}
export async function addFiles(c: Context<ApiEnv>, body: unknown): Promise<ULID[]> {
  const input = parse(z.strictObject({ parentId: z.ulid().optional(), supersedesId: z.ulid().optional(), files: selection.min(1) }), body);
  const target = input.supersedesId ? await loadAttachment(c, input.supersedesId) : null;
  if (target) {
    await authorize(c, [{ permission: 'item.edit', target: { type: 'attachment', ownerId: target.ownerId as ULID } }]);
    await refuseSuperseded(c, target.chainId, target.id);
    if (input.files.length !== 1) throw new ApiError('validation', { fields: [{ field: 'files', rule: 'A new version contains exactly one file.' }] });
  }
  const parent = await attachmentParent(c, target?.parentId ?? input.parentId ?? '');
  const version = target ? { id: target.id as ULID, chainId: target.chainId } : undefined;
  const plan = await prepareAttachments(c, input.files, parent, version);
  const actor = c.get('session').member.id;
  const now = c.get('now');
  const submissionId = newULID(now);
  try {
    await commitWithIdentifiers(c.env.RF_CORE, { id: actor, now }, plan.ids, (batch, issued) => {
      batch.guard('reply_parent', sql`EXISTS (SELECT 1 FROM units WHERE id = ${parent.id}) AND NOT EXISTS (SELECT 1 FROM deletions WHERE unit_id = ${parent.id})`);
      addSubmission(batch, { id: submissionId, memberId: actor, kind: 'member', now, complete: true });
      plan.write(batch, issued, parent, submissionId);
      announceSubmission(batch, submissionId);
    }, { accountant: c.get('accountant') });
  } catch (error) { if (version) await versionConflict(c, error, version.chainId, version.id); throw error; }
  return plan.ids;
}
export interface AttachmentView {
  id: string; parentId: string; rootId: string; projectId: string; ownerId: string; displayName: string | null; credit: string; rev: number;
  identifier: string; title: string; fileKind: string; originalName: string; sizeBytes: number; caption: string | null; origin: string; uploadedAt: Timestamp;
  rightsStatusId: string; rightsStatus: string; permitsPublication: number; rightsHolder: string | null; rightsTerms: string | null; chainId: string; level: string; flag: 'new' | 'updated' | null;
}
export async function loadAttachment(c: Context<ApiEnv>, id: string): Promise<AttachmentView> {
  const row = isULID(id) ? await c.get('accountant').track(c.env.RF_CORE.prepare(`SELECT u.id, u.parent_id AS parentId, u.root_id AS rootId, u.project_id AS projectId,
    u.owner_id AS ownerId, p.display_name AS displayName, u.credit, u.rev, a.item_identifier AS identifier, a.title, a.file_kind AS fileKind,
    a.original_name AS originalName, a.size_bytes AS sizeBytes, a.caption, a.origin, a.uploaded_at AS uploadedAt, a.rights_status_id AS rightsStatusId,
    cv.name AS rightsStatus, cv.permits_publication AS permitsPublication, a.rights_holder AS rightsHolder, a.rights_terms AS rightsTerms, a.chain_id AS chainId, u.disclosure_level AS level, f.flag
    FROM units u JOIN attachments a ON a.unit_id = u.id JOIN config_values cv ON cv.id = a.rights_status_id LEFT JOIN profiles p ON p.member_id = u.owner_id
    LEFT JOIN flags f ON f.unit_id = u.id AND f.member_id = ?2 WHERE u.id = ?1 AND ${visibleTo('u', '?2')}
    AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = u.id OR d.unit_id = u.root_id)`)
    .bind(id, c.get('session').member.id).all<AttachmentView>()) : undefined;
  if (!row?.results[0]) throw new ApiError('not_found');
  return row.results[0];
}
export async function attachmentResponse(c: Context<ApiEnv>, id: string) {
  const attachment = await loadAttachment(c, id);
  return { attachment: { ...attachment, credit: JSON.parse(attachment.credit) as unknown, permitsPublication: attachment.permitsPublication === 1 }, chain: await versionChain(c, attachment.chainId, id) };
}
export async function listAttachments(c: Context<ApiEnv>, parentId: string) {
  await attachmentParent(c, parentId);
  const rows = await c.get('accountant').track(c.env.RF_CORE.prepare(`SELECT u.id, a.title, a.original_name AS originalName, a.size_bytes AS sizeBytes, f.flag
    FROM units u JOIN attachments a ON a.unit_id = u.id LEFT JOIN flags f ON f.unit_id = u.id AND f.member_id = ?2
    WHERE u.parent_id = ?1 AND ${visibleTo('u', '?2')} AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = u.id) ORDER BY u.id`)
    .bind(parentId, c.get('session').member.id).all<{ id: string; title: string; originalName: string; sizeBytes: number; flag: 'new' | 'updated' | null }>());
  return rows.results;
}
export async function editAttachment(c: Context<ApiEnv>, id: string, body: unknown): Promise<void> {
  const before = await loadAttachment(c, id);
  await authorize(c, [{ permission: 'item.edit', target: { type: 'attachment', ownerId: before.ownerId as ULID } }]);
  const context = await validationContext(c, { rightsStatusId: [before.rightsStatusId as ULID] });
  const input = parse(z.strictObject({ rev: z.int().positive(), metadata: attachmentMetadataSchema(context, true), mark: editMarkSchema }), body);
  const old = { title: before.title, caption: before.caption ?? undefined, origin: before.origin, rightsStatusId: before.rightsStatusId, rightsHolder: before.rightsHolder ?? undefined, rightsTerms: before.rightsTerms ?? undefined };
  // Rights changes on Public files use task 31's disclosure workflow, to ensure publication downgrades are atomic.
  if (before.level === 'public' && ['rightsStatusId', 'rightsHolder', 'rightsTerms'].some((field) => old[field as keyof typeof old] !== input.metadata[field as keyof typeof input.metadata])) throw new ApiError('validation', { fields: [{ field: 'metadata.rightsStatusId', rule: 'Rights changes on a Public Attachment require the disclosure workflow.' }] });
  const fields = diffFields(old, input.metadata, { title: 'content', caption: 'content', origin: 'content', rightsStatusId: 'content', rightsHolder: 'content', rightsTerms: 'content' });
  if (fields.length === 0) return;
  await commitSave(c, { target: { type: 'unit', id, rootId: before.rootId }, startedFrom: input.rev, change: { fields, mark: { mark: input.mark.mark, ...(input.mark.reason === undefined ? {} : { reason: input.mark.reason }) } },
    write(batch) { batch.update(attachments, { ...input.metadata, caption: input.metadata.caption ?? null, rightsHolder: input.metadata.rightsHolder ?? null, rightsTerms: input.metadata.rightsTerms ?? null }, eq(attachments.unitId, id))
      .update(units, {}, and(eq(units.id, id), eq(units.unitType, 'attachment'))!); }, outbox: [['search', `unit:${id}`], ['publish', `unit:${id}`]] });
}
