import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../api';
import { ApiFailure, useApi } from '../api';
import { newULID } from '@researchforce/domain/identifiers';
import { UPLOAD_PART_BYTES } from '@researchforce/domain/files';
import { cpLength, isBlank } from '@researchforce/domain/text';
import { Button, Notice, TextField } from '../ui';

export interface FileDraft { key: string; file: File; uploadId?: string; state: 'uploading' | 'failed' | 'complete'; percent: number; error?: string | undefined; title: string; caption: string; origin: string }
export interface FileSelection { uploadId: string; metadata: { title: string; caption?: string; origin: string } }
export function metadataReasons(file: Pick<FileDraft, 'title' | 'caption' | 'origin'>): string[] {
  return [isBlank(file.title) || cpLength(file.title) > 255 ? 'Title must contain 1 to 255 characters.' : '', cpLength(file.caption) > 2000 ? 'Caption must contain at most 2,000 characters.' : '',
    isBlank(file.origin) || cpLength(file.origin) > 5000 ? 'Origin must contain 1 to 5,000 characters.' : ''].filter(Boolean);
}
export function readiness(files: readonly FileDraft[]): string[] {
  return files.flatMap((file) => [file.state === 'uploading' ? 'The file is still uploading.' : file.state === 'failed' ? file.error ?? 'The upload failed.' : '', ...metadataReasons(file)]
    .filter(Boolean).map((reason) => `${file.file.name}: ${reason}`));
}
export function selectedFiles(files: readonly FileDraft[]): FileSelection[] {
  return files.map((file) => ({ uploadId: file.uploadId!, metadata: { title: file.title, origin: file.origin, ...(file.caption === '' ? {} : { caption: file.caption }) } }));
}
interface Digests { sha256: string; parts: string[] }
function hashFile(file: File, signal: AbortSignal): Promise<Digests> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./hash-worker.ts', import.meta.url), { type: 'module' });
    const abort = () => { worker.terminate(); reject(new Error('Upload cancelled.')); };
    signal.addEventListener('abort', abort, { once: true });
    const done = () => { worker.terminate(); signal.removeEventListener('abort', abort); };
    worker.onmessage = (event: MessageEvent<Digests & { error?: string }>) => { done(); if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data); };
    worker.onerror = () => { done(); reject(new Error('The file could not be read for its checksum.')); };
    worker.postMessage(file);
  });
}
/** R2 receives bytes directly; browsers supply Content-Length themselves. A stalled request fails after 60 seconds. */
export function putFile(url: string, headers: Record<string, string>, bytes: Blob, signal: AbortSignal, progress: (n: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let transferred = 0;
    let lastProgress = Date.now();
    const finish = () => { clearInterval(timer); signal.removeEventListener('abort', abort); };
    const fail = (message: string) => { finish(); reject(new Error(message)); };
    const abort = () => { xhr.abort(); fail('Upload cancelled.'); };
    const timer = setInterval(() => { progress(transferred); if (Date.now() - lastProgress >= 60_000) { fail('No bytes were transferred for 60 seconds.'); xhr.abort(); } }, 1000);
    xhr.open('PUT', url);
    for (const [name, value] of Object.entries(headers)) if (name.toLowerCase() !== 'content-length') xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => { if (event.loaded > transferred) { transferred = event.loaded; lastProgress = Date.now(); } progress(transferred); };
    xhr.onerror = () => fail('R2 reported a transfer error.');
    xhr.onabort = () => fail('The transfer was interrupted.');
    xhr.onload = () => { finish(); if (xhr.status >= 200 && xhr.status < 300) { progress(bytes.size); resolve(xhr.getResponseHeader('ETag') ?? ''); } else reject(new Error(`R2 refused the file (${xhr.status}).`)); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort(); else xhr.send(bytes);
  });
}
interface UploadStart { id: string; mode: 'single' | 'multipart'; url: string | null; headers: Record<string, string> }
async function transfer(client: ApiClient, file: File, groupId: string, signal: AbortSignal, update: (values: Partial<FileDraft>) => void): Promise<void> {
  const hashes = await hashFile(file, signal);
  if (signal.aborted) return;
  const start = await client.post<UploadStart>('/uploads', { groupId, fileName: file.name, sizeBytes: file.size, sha256: hashes.sha256 });
  update({ uploadId: start.id });
  const percentage = (bytes: number) => update({ percent: file.size === 0 ? 100 : Math.min(100, Math.floor(bytes / file.size * 100)) });
  const parts: { partNumber: number; etag: string }[] = [];
  if (start.mode === 'single') await putFile(start.url!, start.headers, file, signal, percentage);
  else for (const [i, sha256] of hashes.parts.entries()) {
    if (signal.aborted) return;
    const signed = await client.post<{ url: string; headers: Record<string, string> }>(`/uploads/${start.id}/parts`, { partNumber: i + 1, sha256 });
    const etag = await putFile(signed.url, signed.headers, file.slice(i * UPLOAD_PART_BYTES, (i + 1) * UPLOAD_PART_BYTES), signal, (bytes) => percentage(i * UPLOAD_PART_BYTES + bytes));
    parts.push({ partNumber: i + 1, etag });
  }
  if (signal.aborted) return;
  await client.post(`/uploads/${start.id}/complete`, parts.length === 0 ? {} : { parts });
  update({ state: 'complete', percent: 100 });
}
export function useUploads() {
  const client = useApi();
  const [files, setFiles] = useState<FileDraft[]>([]);
  const [refusals, setRefusals] = useState<string[]>([]);
  const [limit, setLimit] = useState<number | undefined>();
  const groupId = useRef(newULID(new Date().toISOString() as import('@researchforce/domain/types').Timestamp));
  const active = useRef(new Map<string, AbortController>());
  const currentFiles = useRef(files); currentFiles.current = files;
  useEffect(() => { let current = true; client.get<{ maximumBytes: number }>('/uploads/limits').then((result) => { if (current) setLimit(result.maximumBytes); }, () => { if (current) setRefusals(['Upload limits could not be retrieved. Reload the page to try again.']); });
    return () => { current = false; for (const controller of active.current.values()) controller.abort(); }; }, [client]);
  // Recheck completed uploads until the Submission uses them; the hourly sweeper can remove a long-open draft.
  useEffect(() => { const timer = setInterval(() => { for (const file of currentFiles.current) if (file.state === 'complete' && file.uploadId) {
    void client.get(`/uploads/${file.uploadId}`).catch((error: unknown) => { if (error instanceof ApiFailure && error.status === 404) update(file.key, { state: 'failed', error: 'The unfinished Submission expired. Retry or remove this file.' }); });
  } }, 30_000); return () => clearInterval(timer); }, [client]);
  function update(key: string, values: Partial<FileDraft>) { setFiles((list) => list.map((file) => file.key === key ? { ...file, ...values } : file)); }
  async function run(file: FileDraft) {
    const controller = new AbortController(); active.current.set(file.key, controller);
    update(file.key, { state: 'uploading', percent: 0, error: undefined });
    try { await transfer(client, file.file, groupId.current, controller.signal, (values) => update(file.key, values)); }
    catch (error) { if (!controller.signal.aborted) update(file.key, { state: 'failed', error: error instanceof ApiFailure ? error.fields.map((field) => field.rule).join(' ') || 'The upload failed. Retry or remove the file.' : error instanceof Error ? error.message : 'The upload failed.' }); }
    finally { if (active.current.get(file.key) === controller) active.current.delete(file.key); }
  }
  const remove = (file: FileDraft) => { active.current.get(file.key)?.abort(); active.current.delete(file.key); setFiles((list) => list.filter((entry) => entry.key !== file.key)); if (file.uploadId) void client.delete(`/uploads/${file.uploadId}`).catch(() => undefined); };
  const retry = async (file: FileDraft) => { active.current.get(file.key)?.abort(); if (file.uploadId) { try { await client.delete(`/uploads/${file.uploadId}`); } catch { /* The sweeper may have removed it. */ } } void run(file); };
  const add = (chosen: readonly File[]) => {
    const accepted: FileDraft[] = []; const rejected: string[] = [];
    for (const file of chosen) {
      if (limit === undefined) rejected.push(`${file.name}: Upload limits are not available yet.`);
      else if (files.length + accepted.length >= 100) rejected.push(`${file.name}: A Submission can contain at most 100 files.`);
      else if (file.size > limit) rejected.push(`${file.name}: The file exceeds the limit of ${limit} bytes.`);
      else accepted.push({ key: newULID(new Date().toISOString() as import('@researchforce/domain/types').Timestamp), file, state: 'uploading', percent: 0, title: file.name, caption: '', origin: '' });
    }
    setRefusals(rejected); setFiles((list) => [...list, ...accepted]); for (const file of accepted) void run(file);
  };
  return { files, add, remove, retry, update, refusals, limit, reasons: readiness(files), selected: () => selectedFiles(files) };
}
export type UploadsState = ReturnType<typeof useUploads>;
export function UploadFields({ uploads }: { readonly uploads: UploadsState }) {
  return <section className="rf-section" aria-label="Files"><h2>Files</h2>
    <label className="rf-field"><span className="rf-field__label">Add files</span><input type="file" multiple disabled={uploads.limit === undefined} onChange={(event) => { uploads.add(Array.from(event.target.files ?? [])); event.target.value = ''; }} /></label>
    {uploads.refusals.map((reason) => <Notice key={reason} tone="warning" title={reason} />)}
    {uploads.files.map((file) => <fieldset className="rf-stack" key={file.key}><legend>{file.file.name}</legend>
      <p role="status">{file.state === 'failed' ? `Failed: ${file.error}` : file.state === 'complete' ? 'Upload complete' : `${file.percent}% uploaded`}</p>
      <progress aria-label={`Upload progress for ${file.file.name}`} max={100} value={file.percent} />
      <TextField label="Title" required value={file.title} onChange={(title) => uploads.update(file.key, { title })} />
      <TextField label="Caption" multiline value={file.caption} onChange={(caption) => uploads.update(file.key, { caption })} />
      <TextField label="Origin" required multiline value={file.origin} onChange={(origin) => uploads.update(file.key, { origin })} />
      <div className="rf-actions">{file.state === 'failed' && <Button onClick={() => void uploads.retry(file)}>Retry</Button>}<Button variant="quiet" onClick={() => uploads.remove(file)}>Remove file</Button></div>
    </fieldset>)}
    {uploads.reasons.length > 0 && <Notice title="Files are not ready to submit"><ul>{uploads.reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul></Notice>}
  </section>;
}
