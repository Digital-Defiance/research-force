import type { Context } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { GuardedBatch } from '@researchforce/db/batch';
import { uploads } from '@researchforce/db/schema/core';
import { SINGLE_UPLOAD_BYTES, UPLOAD_PART_BYTES } from '@researchforce/domain/files';
import { newULID } from '@researchforce/domain/identifiers';
import { SETTINGS } from '@researchforce/domain/settings';
import type { Timestamp } from '@researchforce/domain/types';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import { parse } from '../api/input';
import { authorize } from '../auth/authorize';
import type { Env } from '../env';
import { checksum64, compositeChecksum, hex, presign, s3Request } from './s3';

const shaSchema = z.string().regex(/^[a-f0-9]{64}$/);
const startSchema = z.strictObject({ groupId: z.ulid(), fileName: z.string().min(1).max(4096), sizeBytes: z.int().nonnegative(), sha256: shaSchema });
export type UploadRow = typeof uploads.$inferSelect;
const live = sql`state IN ('uploading', 'complete')`;
function fail(fileName: string, rule: string): never { throw new ApiError('validation', { fields: [{ field: 'files', rule: `${fileName}: ${rule}` }] }); }
export async function uploadLimit(c: Context<ApiEnv>): Promise<number> {
  const setting = await c.get('accountant').track(c.env.RF_CORE.prepare("SELECT value FROM settings WHERE key = 'attachmentSizeLimit'").all<{ value: string }>());
  return setting.results[0] ? JSON.parse(setting.results[0].value) as number : SETTINGS.attachmentSizeLimit.default;
}
export async function loadUpload(c: Context<ApiEnv>, id: string): Promise<UploadRow> {
  const row = await c.get('accountant').track(c.env.RF_CORE.prepare(`SELECT id, group_id AS groupId, state, owner_type AS ownerType, owner_id AS ownerId,
    r2_key AS r2Key, file_name AS fileName, size_bytes AS sizeBytes, sha256, mode, multipart_id AS multipartId, created_at AS createdAt,
    completed_at AS completedAt, attached_at AS attachedAt FROM uploads WHERE id = ?1 AND owner_type = 'member' AND owner_id = ?2 AND state <> 'deleting'`)
    .bind(id, c.get('session').member.id).all<UploadRow>());
  if (!row.results[0]) throw new ApiError('not_found');
  return row.results[0];
}
export async function startUpload(c: Context<ApiEnv>, body: unknown) {
  await authorize(c, [{ permission: 'attachment.upload' }]);
  const input = parse(startSchema, body);
  const limit = await uploadLimit(c);
  if (input.sizeBytes > limit) fail(input.fileName, `The file exceeds the limit of ${limit} bytes.`);
  const actor = c.get('session').member.id;
  const now = c.get('now');
  const id = newULID(now);
  const r2Key = `files/${id}`;
  const mode = input.sizeBytes > SINGLE_UPLOAD_BYTES ? 'multipart' : 'single';
  const count = await c.get('accountant').track(c.env.RF_CORE.prepare('SELECT count(*) AS n FROM uploads WHERE owner_id = ?1 AND group_id = ?2 AND state <> \'deleting\'').bind(actor, input.groupId).all<{ n: number }>());
  if (count.results[0]!.n >= 100) fail(input.fileName, 'A Submission can contain at most 100 files.');
  let multipartId: string | null = null;
  if (mode === 'multipart') {
    const result = await s3Request(c.env, 'POST', r2Key, { uploads: '' }, { 'x-amz-checksum-algorithm': 'SHA256' });
    multipartId = /<UploadId>([^<]+)<\/UploadId>/.exec(await result.text())?.[1] ?? null;
    if (!multipartId) throw new Error('R2 did not return a multipart upload id.');
  }
  const headers = { 'content-length': String(input.sizeBytes), 'x-amz-checksum-sha256': checksum64(input.sha256), 'if-none-match': '*' };
  const url = mode === 'single' ? await presign(c.env, 'PUT', r2Key, headers, {}, new Date(now)) : null;
  try {
    await new GuardedBatch(c.env.RF_CORE, { id: actor, now })
      .guard('upload_limit', sql`(SELECT count(*) FROM uploads WHERE owner_id = ${actor} AND group_id = ${input.groupId} AND state <> 'deleting') < 100`)
      .insert(uploads, { id, ...input, r2Key, ownerType: 'member', ownerId: actor, mode, multipartId, createdAt: now }).commit(c.get('accountant'));
  } catch (error) {
    if (multipartId) await c.env.RF_PRIVATE_BUCKET.resumeMultipartUpload(r2Key, multipartId).abort();
    throw error;
  }
  return { id, mode, partBytes: UPLOAD_PART_BYTES, url, headers: mode === 'single' ? headers : {}, expiresAt: new Date(new Date(now).getTime() + 900_000).toISOString() };
}
const partSchema = z.strictObject({ partNumber: z.int().positive(), sha256: shaSchema });
export async function signPart(c: Context<ApiEnv>, id: string, body: unknown) {
  await authorize(c, [{ permission: 'attachment.upload' }]);
  const input = parse(partSchema, body);
  const row = await loadUpload(c, id);
  if (row.mode !== 'multipart' || row.state !== 'uploading' || input.partNumber > Math.ceil(row.sizeBytes / UPLOAD_PART_BYTES)) fail(row.fileName, 'Choose an unfinished multipart upload and a valid part number.');
  const sizeBytes = Math.min(UPLOAD_PART_BYTES, row.sizeBytes - (input.partNumber - 1) * UPLOAD_PART_BYTES);
  await new GuardedBatch(c.env.RF_CORE, { id: c.get('session').member.id, now: c.get('now') })
    .guard('upload_ready', sql`EXISTS (SELECT 1 FROM uploads WHERE id = ${id} AND state = 'uploading')`)
    .run(sql`INSERT INTO upload_parts(upload_id, part_number, sha256, size_bytes) VALUES (${id}, ${input.partNumber}, ${input.sha256}, ${sizeBytes})
      ON CONFLICT(upload_id, part_number) DO UPDATE SET sha256 = excluded.sha256, size_bytes = excluded.size_bytes`)
    .commit(c.get('accountant'));
  const headers = { 'content-length': String(sizeBytes), 'x-amz-checksum-sha256': checksum64(input.sha256) };
  return { url: await presign(c.env, 'PUT', row.r2Key, headers, { uploadId: row.multipartId!, partNumber: String(input.partNumber) }, new Date(c.get('now'))), headers };
}
const completeSchema = z.strictObject({ parts: z.array(z.strictObject({ partNumber: z.int().positive(), etag: z.string().regex(/^[a-fA-F0-9"-]+$/).max(128) })).max(10_000).optional() });
export async function completeUpload(c: Context<ApiEnv>, id: string, body: unknown) {
  await authorize(c, [{ permission: 'attachment.upload' }]);
  const input = parse(completeSchema, body);
  const row = await loadUpload(c, id);
  if (row.state === 'complete') return { id, completedAt: row.completedAt };
  if (row.state !== 'uploading') fail(row.fileName, 'This upload was already submitted.');
  let expected = checksum64(row.sha256);
  const storedBefore = row.mode === 'multipart' ? await c.env.RF_PRIVATE_BUCKET.head(row.r2Key) : null;
  if (row.mode === 'multipart') {
    const parts = await c.get('accountant').track(c.env.RF_CORE.prepare('SELECT part_number AS partNumber, sha256 FROM upload_parts WHERE upload_id = ?1 ORDER BY part_number').bind(id).all<{ partNumber: number; sha256: string }>());
    const count = Math.ceil(row.sizeBytes / UPLOAD_PART_BYTES);
    const requested = input.parts;
    if (!requested || parts.results.length !== count || requested.length !== count || requested.some((part, i) => part.partNumber !== i + 1 || parts.results[i]?.partNumber !== i + 1)) fail(row.fileName, 'Every part must complete once, in order.');
    expected = await compositeChecksum(parts.results.map((part) => part.sha256));
    const xml = `<CompleteMultipartUpload>${requested.map((part, i) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${part.etag.replaceAll('"', '&quot;')}</ETag><ChecksumSHA256>${checksum64(parts.results[i]!.sha256)}</ChecksumSHA256></Part>`).join('')}</CompleteMultipartUpload>`;
    if (!storedBefore) {
      const completed = await s3Request(c.env, 'POST', row.r2Key, { uploadId: row.multipartId! }, { 'content-type': 'application/xml' }, xml);
      if (/<Error[>\s]/.test(await completed.text())) fail(row.fileName, 'R2 could not complete the multipart upload.');
    }
  }
  const object = storedBefore ?? await c.env.RF_PRIVATE_BUCKET.head(row.r2Key);
  let actual = object?.checksums.sha256 ? checksum64(hex(object.checksums.sha256)) : null;
  // Multipart SHA-256 is composite and is exposed by S3 HEAD rather than the binding's full-object checksum.
  if (object && (row.mode === 'multipart' || actual === null)) {
    actual = (await s3Request(c.env, 'HEAD', row.r2Key, {}, { 'x-amz-checksum-mode': 'ENABLED' })).headers.get('x-amz-checksum-sha256');
  }
  if (!object || object.size !== row.sizeBytes || actual !== expected) {
    fail(row.fileName, 'The stored file size or SHA-256 checksum does not match. Retry or remove this file.');
  }
  const now = c.get('now');
  await new GuardedBatch(c.env.RF_CORE, { id: c.get('session').member.id, now })
    .guard('upload_ready', sql`EXISTS (SELECT 1 FROM uploads WHERE id = ${id} AND state = 'uploading')`)
    .update(uploads, { completedAt: now, state: 'complete' }, eq(uploads.id, id)).commit(c.get('accountant'));
  return { id, completedAt: now };
}
async function abortMultipart(bucket: R2Bucket, row: { r2Key: string; multipartId: string | null }): Promise<void> {
  if (!row.multipartId) return;
  try { await bucket.resumeMultipartUpload(row.r2Key, row.multipartId).abort(); }
  catch (error) {
    if (await bucket.head(row.r2Key)) return;
    if (error instanceof Error && /NoSuchUpload|does not exist|not found/i.test(error.message)) return;
    throw error;
  }
}
/** Claim before touching R2. A simultaneous Submission either wins the transaction or fails its upload guard. */
export async function sweepUploads(env: Env, now: Timestamp): Promise<number> {
  const cutoff = new Date(new Date(now).getTime() - 86_400_000).toISOString();
  const due = await env.RF_CORE.prepare(`UPDATE uploads SET state = 'deleting' WHERE owner_type = 'member' AND created_at < ?1 AND attached_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM attachments a JOIN units u ON u.id = a.unit_id JOIN submissions s ON s.id = u.submission_id WHERE a.r2_key = uploads.r2_key AND s.completed_at IS NOT NULL)
    RETURNING id, r2_key AS r2Key, multipart_id AS multipartId, mode`).bind(cutoff).all<{ id: string; r2Key: string; multipartId: string | null; mode: string }>();
  for (const row of due.results) {
    await abortMultipart(env.RF_PRIVATE_BUCKET, row);
    await env.RF_PRIVATE_BUCKET.delete(row.r2Key);
    await env.RF_CORE.batch([env.RF_CORE.prepare('DELETE FROM upload_parts WHERE upload_id = ?1').bind(row.id), env.RF_CORE.prepare("DELETE FROM uploads WHERE id = ?1 AND state = 'deleting'").bind(row.id)]);
  }
  return due.results.length;
}
export async function removeUpload(c: Context<ApiEnv>, id: string): Promise<void> {
  const row = await loadUpload(c, id);
  if (row.attachedAt !== null) fail(row.fileName, 'This file already belongs to a Submission.');
  await new GuardedBatch(c.env.RF_CORE, { id: c.get('session').member.id, now: c.get('now') })
    .guard('upload_ready', sql`EXISTS (SELECT 1 FROM uploads WHERE id = ${id} AND attached_at IS NULL)`)
    .update(uploads, { state: 'deleting' }, and(eq(uploads.id, id), live)!).commit(c.get('accountant'));
  await abortMultipart(c.env.RF_PRIVATE_BUCKET, row);
  await c.env.RF_PRIVATE_BUCKET.delete(row.r2Key);
  await c.env.RF_CORE.batch([c.env.RF_CORE.prepare('DELETE FROM upload_parts WHERE upload_id = ?1').bind(id), c.env.RF_CORE.prepare('DELETE FROM uploads WHERE id = ?1').bind(id)]);
}
