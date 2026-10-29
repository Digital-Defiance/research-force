import { useEffect, useRef, useState } from 'react';
import { clearUnsent, readUnsent, writeUnsent } from '../persist';
import type { ApiClient } from '../api';
import { ApiFailure, useApi } from '../api';
import { newULID } from '@researchforce/domain/identifiers';
import { UPLOAD_PART_BYTES } from '@researchforce/domain/files';
import { cpLength, isBlank } from '@researchforce/domain/text';
import { Button, Notice, TextField } from '../ui';

/** `file` is absent after a reload: the browser does not keep a chosen File, so an unfinished transfer needs the Member to choose it again (R28.10). */
export interface FileDraft { key: string; file?: File | undefined; name: string; size: number; sha256?: string | undefined; uploadId?: string | undefined; attempt: number; state: 'uploading' | 'failed' | 'complete'; percent: number; error?: string | undefined; title: string; caption: string; origin: string }
export interface FileSelection { uploadId: string; metadata: { title: string; caption?: string; origin: string } }
interface StoredUploads { groupId: string; files: Omit<FileDraft, 'file'>[] }
export function metadataReasons(file: Pick<FileDraft, 'title' | 'caption' | 'origin'>): string[] {
  return [isBlank(file.title) || cpLength(file.title) > 255 ? 'Title must contain 1 to 255 characters.' : '', cpLength(file.caption) > 2000 ? 'Caption must contain at most 2,000 characters.' : '',
    isBlank(file.origin) || cpLength(file.origin) > 5000 ? 'Origin must contain 1 to 5,000 characters.' : ''].filter(Boolean);
}
export function readiness(files: readonly FileDraft[]): string[] {
  return files.flatMap((file) => [file.state === 'uploading' ? 'The file is still uploading.' : file.state === 'failed' ? file.error ?? 'The upload failed.' : '', ...metadataReasons(file)]
    .filter(Boolean).map((reason) => `${file.name}: ${reason}`));
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
/** Each attempt starts under its own operation key, so a lost start response is reconciled instead of leaving two uploads behind. */
const startKey = (draft: Pick<FileDraft, 'key' | 'attempt'>) => `upload-start-${draft.key}-${draft.attempt}`;
async function startUpload(client: ApiClient, draft: FileDraft, groupId: string, sha256: string): Promise<UploadStart> {
  try {
    return await client.request<UploadStart>('POST', '/uploads', { groupId, fileName: draft.name, sizeBytes: draft.size, sha256 }, undefined, { key: startKey(draft) });
  } catch (error) {
    // The upload exists but its signed URL was lost with the response: remove it and the caller starts a new attempt.
    const id = error instanceof ApiFailure && error.code === 'committed' ? (error.details as { resource?: Record<string, string> } | undefined)?.resource?.['id'] : undefined;
    if (id) await client.delete(`/uploads/${id}`).catch(() => undefined);
    if (error instanceof ApiFailure && error.code === 'committed') throw new Error('The upload started but the answer was lost. Retry the file.');
    throw error;
  }
}
async function transfer(client: ApiClient, draft: FileDraft, file: File, groupId: string, signal: AbortSignal, update: (values: Partial<FileDraft>) => void, known?: Digests): Promise<void> {
  const hashes = known ?? await hashFile(file, signal);
  if (signal.aborted) return;
  update({ sha256: hashes.sha256 });
  const start = await startUpload(client, draft, groupId, hashes.sha256);
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
  // A lost completion response is answered from the Worker's record, then confirmed against the upload itself.
  await client.request('POST', `/uploads/${start.id}/complete`, parts.length === 0 ? {} : { parts }, undefined, { key: `upload-complete-${start.id}`,
    committed: async () => { const state = await client.get<{ state: string }>(`/uploads/${start.id}`); if (state.state !== 'complete') throw new Error('The upload was not completed.'); } });
  update({ state: 'complete', percent: 100 });
}
const INTERRUPTED = 'The page was reloaded before this file finished uploading. Select the file again to continue.';
const EXPIRED = 'The unfinished Submission expired. Select the file again, or remove it.';
function restore(scope: string | undefined): StoredUploads | undefined {
  const stored = scope === undefined ? undefined : readUnsent<StoredUploads>(`uploads:${scope}`);
  if (!stored || !Array.isArray(stored.files) || typeof stored.groupId !== 'string') return undefined;
  const files = stored.files.filter((file) => typeof file.key === 'string' && typeof file.name === 'string').map((file): Omit<FileDraft, 'file'> => ({ ...file, attempt: file.attempt ?? 0,
    ...(file.state === 'uploading' ? { state: 'failed' as const, error: INTERRUPTED } : {}) }));
  return files.length === 0 ? undefined : { groupId: stored.groupId, files };
}
/** The Files of one form. With a `scope`, their metadata, IDs and progress stay in this tab's storage until the form is sent or discarded (R28.10). */
export function useUploads(scope?: string) {
  const client = useApi();
  const [restored] = useState(() => restore(scope));
  const [files, setFiles] = useState<FileDraft[]>(() => restored?.files ?? []);
  const [refusals, setRefusals] = useState<string[]>([]);
  const [limit, setLimit] = useState<number | undefined>();
  const [attempted, setAttempted] = useState(0);
  const groupId = useRef(restored?.groupId ?? newULID(new Date().toISOString() as import('@researchforce/domain/types').Timestamp));
  const active = useRef(new Map<string, AbortController>());
  const currentFiles = useRef(files); currentFiles.current = files;
  const wasRestored = useRef(restored !== undefined);
  useEffect(() => { if (scope === undefined) return; if (files.length === 0) clearUnsent(`uploads:${scope}`);
    else writeUnsent(`uploads:${scope}`, { groupId: groupId.current, files: files.map(({ file: _file, ...rest }) => rest) } satisfies StoredUploads); }, [files, scope]);
  useEffect(() => { let current = true; client.get<{ maximumBytes: number }>('/uploads/limits').then((result) => { if (current) setLimit(result.maximumBytes); }, () => { if (current) setRefusals(['Upload limits could not be retrieved. Reload the page to try again.']); });
    return () => { current = false; for (const controller of active.current.values()) controller.abort(); }; }, [client]);
  // A restored upload is checked against the server: one that finished, or that the sweeper removed, is settled without the local File.
  async function recheck(file: FileDraft, interrupted: boolean) {
    try {
      const upload = await client.get<{ state: string }>(`/uploads/${file.uploadId}`);
      if (upload.state === 'complete') update(file.key, { state: 'complete', percent: 100, error: undefined });
      else update(file.key, { state: 'failed', error: interrupted ? INTERRUPTED : EXPIRED });
    } catch (error) { if (error instanceof ApiFailure && error.code === 'not_found') update(file.key, { state: 'failed', error: interrupted ? INTERRUPTED : EXPIRED }); }
  }
  useEffect(() => { if (!wasRestored.current) return; wasRestored.current = false;
    for (const file of currentFiles.current) if (file.uploadId && (file.state === 'complete' || file.error === INTERRUPTED)) void recheck(file, file.state !== 'complete'); }, [client]);
  // Recheck completed uploads until the Submission uses them; the hourly sweeper can remove a long-open draft.
  useEffect(() => { const timer = setInterval(() => { for (const file of currentFiles.current) if (file.state === 'complete' && file.uploadId) void recheck(file, false); }, 30_000); return () => clearInterval(timer); }, [client]);
  function update(key: string, values: Partial<FileDraft>) { setFiles((list) => list.map((file) => file.key === key ? { ...file, ...values } : file)); }
  async function run(file: FileDraft, known?: Digests) {
    if (!file.file) return;
    const controller = new AbortController(); active.current.set(file.key, controller);
    update(file.key, { state: 'uploading', percent: 0, error: undefined });
    try { await transfer(client, file, file.file, groupId.current, controller.signal, (values) => update(file.key, values), known); }
    catch (error) { if (!controller.signal.aborted) update(file.key, { state: 'failed', error: error instanceof ApiFailure ? error.fields.map((field) => field.rule).join(' ') || 'The upload failed. Retry or remove the file.' : error instanceof Error ? error.message : 'The upload failed.' }); }
    finally { if (active.current.get(file.key) === controller) active.current.delete(file.key); }
  }
  const remove = (file: FileDraft) => { active.current.get(file.key)?.abort(); active.current.delete(file.key); setFiles((list) => list.filter((entry) => entry.key !== file.key)); if (file.uploadId) void client.delete(`/uploads/${file.uploadId}`).catch(() => undefined); };
  const retry = async (file: FileDraft, known?: Digests) => {
    active.current.get(file.key)?.abort();
    if (file.uploadId) { try { await client.delete(`/uploads/${file.uploadId}`); } catch { /* The sweeper may have removed it. */ } }
    const next = { ...file, attempt: file.attempt + 1, uploadId: undefined };
    update(file.key, { attempt: next.attempt, uploadId: undefined, file: file.file }); await run(next, known);
  };
  /** Choose the File of a restored entry again. It must be the same file: same name and size, and the same SHA-256 once that was known. */
  const reselect = async (file: FileDraft, chosen: File) => {
    const refuse = (error: string) => update(file.key, { state: 'failed', error });
    if (chosen.name !== file.name || chosen.size !== file.size) return refuse(`That is not the same file. Choose ${file.name} (${file.size} bytes).`);
    const controller = new AbortController(); active.current.set(file.key, controller);
    let digests: Digests;
    update(file.key, { state: 'uploading', percent: 0, error: undefined });
    try { digests = await hashFile(chosen, controller.signal); } catch (error) { active.current.delete(file.key); return controller.signal.aborted ? undefined : refuse(error instanceof Error ? error.message : 'The file could not be read.'); }
    active.current.delete(file.key);
    if (file.sha256 !== undefined && digests.sha256 !== file.sha256) return refuse(`That file’s contents differ from the one first chosen. Choose the original ${file.name}.`);
    await retry({ ...file, file: chosen }, digests);
  };
  const add = (chosen: readonly File[]) => {
    const accepted: FileDraft[] = []; const rejected: string[] = [];
    for (const file of chosen) {
      if (limit === undefined) rejected.push(`${file.name}: Upload limits are not available yet.`);
      else if (files.length + accepted.length >= 100) rejected.push(`${file.name}: A Submission can contain at most 100 files.`);
      else if (file.size > limit) rejected.push(`${file.name}: The file exceeds the limit of ${limit} bytes.`);
      else accepted.push({ key: newULID(new Date().toISOString() as import('@researchforce/domain/types').Timestamp), file, name: file.name, size: file.size, attempt: 0, state: 'uploading', percent: 0, title: file.name, caption: '', origin: '' });
    }
    setRefusals(rejected); setFiles((list) => [...list, ...accepted]); for (const file of accepted) void run(file);
  };
  /** The form was sent: its uploads now belong to the Submission, so this tab forgets them. */
  const sent = () => { for (const controller of active.current.values()) controller.abort(); setFiles([]); if (scope !== undefined) clearUnsent(`uploads:${scope}`); };
  /** The form was discarded: unfinished and unused uploads are removed from the server as well. */
  const discard = () => { for (const file of currentFiles.current) remove(file); if (scope !== undefined) clearUnsent(`uploads:${scope}`); };
  /** Whether submission is blocked; a blocked attempt, such as Enter in a field, moves focus to the reasons. */
  const guard = (): boolean => { if (readiness(currentFiles.current).length === 0) return false; setAttempted((n) => n + 1); return true; };
  return { files, add, remove, retry, reselect, update, refusals, limit, attempted, guard, sent, discard, restored: restored !== undefined, reasons: readiness(files), selected: () => selectedFiles(files) };
}
export type UploadsState = ReturnType<typeof useUploads>;
export function UploadFields({ uploads }: { readonly uploads: UploadsState }) {
  const reasons = useRef<HTMLDivElement>(null);
  useEffect(() => { if (uploads.attempted > 0) reasons.current?.focus(); }, [uploads.attempted]);
  return <section className="rf-section" aria-label="Files"><h2>Files</h2>
    <label className="rf-field"><span className="rf-field__label">Add files</span><input type="file" multiple disabled={uploads.limit === undefined} onChange={(event) => { uploads.add(Array.from(event.target.files ?? [])); event.target.value = ''; }} /></label>
    {uploads.restored && uploads.files.length > 0 && <Notice title="Your files were restored after a reload. Files that had not finished uploading need to be selected again." />}
    {uploads.refusals.map((reason) => <Notice key={reason} tone="warning" title={reason} />)}
    {uploads.files.map((file) => <fieldset className="rf-stack" key={file.key}><legend>{file.name}</legend>
      <p role="status">{file.state === 'failed' ? `Failed: ${file.error}` : file.state === 'complete' ? 'Upload complete' : `${file.percent}% uploaded`}</p>
      <progress aria-label={`Upload progress for ${file.name}`} max={100} value={file.percent} />
      <TextField label="Title" required value={file.title} onChange={(title) => uploads.update(file.key, { title })} />
      <TextField label="Caption" multiline value={file.caption} onChange={(caption) => uploads.update(file.key, { caption })} />
      <TextField label="Origin" required multiline value={file.origin} onChange={(origin) => uploads.update(file.key, { origin })} />
      <div className="rf-actions">
        {file.state === 'failed' && file.file && <Button onClick={() => void uploads.retry(file)}>Retry</Button>}
        {file.state === 'failed' && !file.file && <label className="rf-field"><span className="rf-field__label">{`Select ${file.name} again`}</span>
          <input type="file" onChange={(event) => { const chosen = event.target.files?.[0]; if (chosen) void uploads.reselect(file, chosen); event.target.value = ''; }} /></label>}
        <Button variant="quiet" onClick={() => uploads.remove(file)}>Remove file</Button>
      </div>
    </fieldset>)}
    {uploads.reasons.length > 0 && <div ref={reasons} tabIndex={-1}><Notice title="Files are not ready to submit"><ul>{uploads.reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul></Notice></div>}
  </section>;
}
