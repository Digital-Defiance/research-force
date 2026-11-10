import { JOB_HANDLERS } from '../do/jobs';
import type { JobHandler } from '../do/jobs';
import type { Env } from '../env';
const hexOf = (bytes: ArrayBuffer): string => Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
/** The hex SHA-256 of the stored object, streamed on Workers so a large file never sits in memory; null when it cannot be read. */
async function storedSha256(object: R2ObjectBody): Promise<string | null> {
  try {
    const DigestStreamCtor = (crypto as unknown as { DigestStream?: new (algorithm: string) => WritableStream<Uint8Array> & { digest: Promise<ArrayBuffer> } }).DigestStream;
    if (DigestStreamCtor !== undefined && object.body !== undefined) {
      const stream = new DigestStreamCtor('SHA-256');
      await object.body.pipeTo(stream);
      return hexOf(await stream.digest);
    }
    return hexOf(await crypto.subtle.digest('SHA-256', await object.arrayBuffer()));
  } catch {
    return null;
  }
}
async function discard(env: Env, upload: { id: string; r2Key: string }): Promise<void> {
  await env.RF_CORE.prepare("UPDATE uploads SET state = 'deleting' WHERE id = ?1 AND state = 'complete' AND attached_at IS NULL").bind(upload.id).run();
  await env.RF_PRIVATE_BUCKET.delete(upload.r2Key);
  await env.RF_CORE.batch([env.RF_CORE.prepare('DELETE FROM upload_parts WHERE upload_id = ?1').bind(upload.id), env.RF_CORE.prepare("DELETE FROM uploads WHERE id = ?1 AND state = 'deleting'").bind(upload.id)]);
}
/**
 * Whole-file SHA-256 check for a multipart upload, which R2 cannot do itself. One slice streams the object and compares size and
 * SHA-256 with the declared values. A match marks the upload verified; a mismatch or an unreadable object deletes the object and
 * the upload, so an unverified hash is never attached. Running again after a match, or after the upload is gone, changes nothing.
 */
export const uploadVerifyJob: JobHandler = {
  async slice({ env, job, now }) {
    const uploadId = (job.params as { uploadId?: unknown }).uploadId;
    const done = (outcome: 'complete' | 'incomplete') => ({ cursor: null, progress: outcome, done: true, outcome } as const);
    if (typeof uploadId !== 'string') return done('incomplete');
    const upload = await env.RF_CORE.prepare("SELECT id, r2_key AS r2Key, size_bytes AS sizeBytes, sha256 FROM uploads WHERE id = ?1 AND state = 'complete' AND hash_verified_at IS NULL")
      .bind(uploadId).first<{ id: string; r2Key: string; sizeBytes: number; sha256: string }>();
    if (!upload) return done('complete');
    const object = await env.RF_PRIVATE_BUCKET.get(upload.r2Key);
    const matches = object !== null && object.size === upload.sizeBytes && await storedSha256(object) === upload.sha256.toLowerCase();
    if (object !== null && !matches && object.bodyUsed === false) await object.body.cancel().catch(() => undefined);
    if (!matches) { await discard(env, upload); return done('incomplete'); }
    await env.RF_CORE.prepare("UPDATE uploads SET hash_verified_at = ?1 WHERE id = ?2 AND state = 'complete' AND hash_verified_at IS NULL").bind(now, upload.id).run();
    return done('complete');
  },
};
JOB_HANDLERS.upload_verify = uploadVerifyJob;
