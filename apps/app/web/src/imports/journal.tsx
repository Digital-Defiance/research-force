import { useMemo, useRef, useState } from 'react';
import type { AccessLevel } from '@researchforce/domain/types';
import { useApi } from '../api';
import { useSession } from '../session';
import { ACCESS_LEVEL_NAMES, accessLevelName } from '../access/access';
import type { MemberRow, ProjectRecord } from '../types';
import { Button, LoadState, Notice, SaveFailure, SelectField, useLoad } from '../ui';
import { hashFile, putFile } from '../files/upload';
import type { Digests } from '../files/upload';
import { SINGLE_UPLOAD_BYTES as SINGLE_PUT_BYTES, UPLOAD_PART_BYTES } from '@researchforce/domain/files';
import { readEntryDates, readImportEntries } from './preview';
import type { EntryDates, ImportMetadataEntry, ImportPreview } from './preview';
import type { PreviewRequest, PreviewResult } from './import-worker';

/**
 * The Administrator affordance that starts a journal import into a Project (R26.1, R26.3, R26.11, R26.15, R27.7, R27.8, R47.13).
 * The Member chooses the journal file, the attachment folder, and the metadata JSON; the screen parses, prints, and compares
 * the journal in a Web Worker and shows the report preview, chooses the import's Access_Level with Restricted preselected,
 * hashes and uploads the files, starts the job, and shows its progress and the stored report with the access choice.
 */

/** The statement shown beside the Access_Level choice: who can always read a Restricted import (R47.13). */
const RESTRICTED_STATEMENT = 'The importing Administrator, as Owner, and every Administrator can read Restricted items, whether or not they are on the Access List.';

const LEVEL_OPTIONS = (['restricted', 'whole_team'] as const).map((value) => ({ value, label: ACCESS_LEVEL_NAMES[value] }));

/** The file's SHA-256 and per-part checksums, matching what the job and multipart upload verify against. */
async function fileDigests(file: File): Promise<Digests> {
  const controller = new AbortController();
  return hashFile(file, controller.signal);
}

/** Run the preview compute in a Web Worker so a large journal never blocks the UI thread (R27.7). Tests pass their own `compute`. */
function previewInWorker(request: PreviewRequest): Promise<ImportPreview> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./import-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<PreviewResult>) => {
      worker.terminate();
      if ('error' in event.data) reject(new Error(event.data.error));
      else resolve(event.data.preview);
    };
    worker.onerror = () => { worker.terminate(); reject(new Error('The journal could not be parsed.')); };
    worker.postMessage(request);
  });
}

const range = ([from, to]: readonly [number, number]): string => (from === to ? `line ${from}` : `lines ${from}–${to}`);

/** The report preview the Member reviews before starting the job (R27.7, R27.8, R26.15). */
function PreviewReport({ preview }: { readonly preview: ImportPreview }) {
  return (
    <section className="rf-section" aria-label="Import preview">
      <h2>What this import would do</h2>
      <ul className="rf-list">
        <li>{`Entries with a phase heading: ${preview.entries}${preview.frontMatter ? ' (plus front matter)' : ''}`}</li>
        <li>{`Sections: ${preview.sections}`}</li>
        <li>{`Unassigned spans: ${preview.unassigned.length}`}</li>
        <li>{`Printer comparison: ${preview.comparison.passes ? 'passes' : 'fails'}`}</li>
        <li>{`Entries that print differently: ${preview.comparison.mismatches.length}`}</li>
        <li>{`Attachment metadata entries: ${preview.metadataEntries}`}</li>
      </ul>
      {preview.unassigned.length > 0 && (
        <section className="rf-section" aria-label="Unassigned spans">
          <h3>Unassigned spans</h3>
          <ul className="rf-list">{preview.unassigned.map((item) => <li key={`${item.entry}:${item.lines[0]}`}>{`${item.entry}: ${range(item.lines)}`}</li>)}</ul>
        </section>
      )}
      {preview.parents.length > 0 && (
        <section className="rf-section" aria-label="Attachment parents">
          <h3>Attachments and their parents</h3>
          <ul className="rf-list">{preview.parents.map((item) => <li key={item.fileName}>{`${item.fileName}: ${item.parent ?? 'no entry references it'}`}</li>)}</ul>
        </section>
      )}
      <section className="rf-section" aria-label="Files sent to the Unassigned Attachments Source">
        <h3>Files that will go to the Unassigned Attachments Source</h3>
        {preview.unassignedAttachments.length === 0
          ? <p className="rf-meta">Every attachment is referenced by an entry.</p>
          : <ul className="rf-list">{preview.unassignedAttachments.map((name) => <li key={name}>{name}</li>)}</ul>}
      </section>
      {preview.missing.length > 0 && (
        <Notice tone="warning" title="Metadata entries whose file is not in the chosen folder:">
          <ul className="rf-list">{preview.missing.map((name) => <li key={name}>{name}</li>)}</ul>
        </Notice>
      )}
    </section>
  );
}

/** The counts and lists of the stored import report once the job completes (R26.11, R27.8). */
function FinalReport({ report, accessLevel, printedUrl }: { readonly report: JournalImportReport; readonly accessLevel: AccessLevel; readonly printedUrl?: string }) {
  const entrySection = (title: string, rows: readonly ReportEntry[]) => rows.length > 0 && (
    <section className="rf-section" aria-label={title}>
      <h3>{title}</h3>
      <ul className="rf-list">{rows.map((row) => <li key={`${row.importKey}:${row.lines[0]}`}>{`${row.title} (${row.importKey}, ${range(row.lines)})`}{row.reason ? ` — ${row.reason}` : ''}</li>)}</ul>
    </section>
  );
  const fileSection = (title: string, rows: readonly ReportFile[]) => rows.length > 0 && (
    <section className="rf-section" aria-label={title}>
      <h3>{title}</h3>
      <ul className="rf-list">{rows.map((row, index) => <li key={`${row.fileName}:${index}`}>{row.fileName}{row.flagged ? ' — no origin recorded in the source journal' : ''}{row.reason ? ` — ${row.reason}` : ''}</li>)}</ul>
    </section>
  );
  return (
    <section className="rf-section" aria-label="Import report">
      <h2>Import report</h2>
      <Notice tone="success" title="The import finished." />
      <p>{`Access level for this import: ${accessLevelName(accessLevel)}.`}</p>
      <ul className="rf-list">
        <li>{`Entries created: ${report.entries.created.length}`}</li>
        <li>{`Entries skipped: ${report.entries.skipped.length}`}</li>
        <li>{`Entries failed: ${report.entries.failed.length}`}</li>
        <li>{`Sections: ${report.counts.sections}`}</li>
        <li>{`Attachments created: ${report.counts.attachments}`}</li>
        <li>{`Printer comparison: ${report.comparison.passes ? 'passes' : 'fails'}`}</li>
      </ul>
      {entrySection('Entries created', report.entries.created)}
      {entrySection('Entries skipped', report.entries.skipped)}
      {entrySection('Entries failed', report.entries.failed)}
      {fileSection('Files created', report.files.created)}
      {fileSection('Files kept unassigned', report.files.unassigned)}
      {fileSection('Files skipped', report.files.skipped)}
      {fileSection('Files failed', report.files.failed)}
      {report.comparison.mismatches.length > 0 && (
        <section className="rf-section" aria-label="Entries that print differently">
          <h3>Entries that print differently</h3>
          <ul className="rf-list">{report.comparison.mismatches.map((item) => <li key={`${item.importKey}:${item.lines[0]}`}>{`${item.title} (${item.importKey}, ${range(item.lines)})`}</li>)}</ul>
        </section>
      )}
      {printedUrl !== undefined && <p><a href={`/api/v1${printedUrl}`}>Download the printed Journal (Markdown)</a></p>}
    </section>
  );
}

type LineRange = readonly [number, number];
interface ReportEntry { readonly importKey: string; readonly title: string; readonly lines: LineRange; readonly reason?: string }
interface ReportFile { readonly fileName: string; readonly reason?: string; readonly flagged?: boolean }
/** The stored import report shape, mirroring the backend `JournalImportReport` (R26.11, R27.8). */
interface JournalImportReport {
  readonly counts: { readonly entries: number; readonly sections: number; readonly attachments: number };
  readonly entries: { readonly created: readonly ReportEntry[]; readonly skipped: readonly ReportEntry[]; readonly failed: readonly ReportEntry[] };
  readonly files: { readonly created: readonly ReportFile[]; readonly unassigned: readonly ReportFile[]; readonly skipped: readonly ReportFile[]; readonly failed: readonly ReportFile[] };
  readonly comparison: { readonly passes: boolean; readonly mismatches: readonly { readonly title: string; readonly importKey: string; readonly lines: LineRange }[] };
  readonly printed: string;
}
interface JobStatusView { readonly state: string; readonly progress?: unknown; readonly report?: JournalImportReport; readonly printedUrl?: string }

/** One line of the metadata JSON mapped onto the request's `AttachmentImportMeta`, with the stored key and checksum the upload produced (R26.2, R26.3). */
interface AttachmentBody {
  readonly sitePath: string; readonly fileName: string; readonly title: string; readonly fileKind?: string;
  readonly sizeBytes: number; readonly sizeLabel?: string; readonly sha256: string; readonly r2Key: string;
  readonly caption?: string; readonly origin?: string; readonly creditingContributor: string;
}

export interface JournalImportScreenOptions {
  /** Injected in tests so the preview can be computed without a real Worker; defaults to the Web Worker. */
  readonly compute?: (request: PreviewRequest) => Promise<ImportPreview>;
}

export function JournalImportScreen({ compute = previewInWorker }: JournalImportScreenOptions = {}) {
  const session = useSession();
  const client = useApi();
  const projects = useLoad<{ projects: ProjectRecord[] }>('/projects');
  const members = useLoad<{ members: MemberRow[] }>('/members');

  const [projectId, setProjectId] = useState('');
  const [accessLevel, setAccessLevel] = useState<AccessLevel>('restricted');
  const [journal, setJournal] = useState<File | undefined>(undefined);
  const [folderFiles, setFolderFiles] = useState<readonly File[] | undefined>(undefined);
  const [entries, setEntries] = useState<readonly ImportMetadataEntry[] | undefined>(undefined);
  const [entryDates, setEntryDates] = useState<EntryDates | undefined>(undefined);
  const [preview, setPreview] = useState<ImportPreview | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [metadataError, setMetadataError] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<JobStatusView | undefined>(undefined);
  const [startedLevel, setStartedLevel] = useState<AccessLevel>('restricted');
  const polling = useRef(false);

  const memberById = useMemo(() => new Map((members.data?.members ?? []).map((member) => [member.id, member])), [members.data]);

  if (!session.can('import.run')) return <Notice tone="warning" title="This page does not exist, or you cannot see it." />;
  if (!projects.data || !members.data) return <LoadState error={projects.error ?? members.error} />;

  const readFolderNames = (): string[] | undefined => folderFiles?.map((file) => file.webkitRelativePath || file.name);

  const chooseMetadata = async (file: File) => {
    setMetadataError(undefined);
    try { setEntries(readImportEntries(await file.text())); }
    catch (error) { setEntries(undefined); setMetadataError(error instanceof Error ? error.message : 'The metadata JSON could not be read.'); }
  };

  const chooseEntryDates = async (file: File) => {
    setMetadataError(undefined);
    try { setEntryDates(readEntryDates(await file.text())); }
    catch (error) { setEntryDates(undefined); setMetadataError(error instanceof Error ? error.message : 'The entry dates JSON could not be read.'); }
  };
  const runPreview = async () => {
    if (journal === undefined) return;
    setBusy(true); setFailure(undefined); setPreview(undefined);
    try {
      const metadata = (entries ?? []).map((entry) => ({ sitePath: entry.sitePath, fileName: entry.fileName }));
      setPreview(await compute({ journal: await journal.text(), metadata, ...(readFolderNames() === undefined ? {} : { folderNames: readFolderNames()! }) }));
    } catch (error) { setFailure(error); }
    finally { setBusy(false); }
  };

  /** The file in the chosen folder whose name matches a metadata entry's file name. */
  const fileFor = (entry: ImportMetadataEntry): File | undefined => folderFiles?.find((file) => (file.webkitRelativePath || file.name).split('/').pop() === entry.fileName);

  /** Hash and upload one attachment through the ordinary uploads flow, returning its `AttachmentImportMeta`. */
  const uploadAttachment = async (entry: ImportMetadataEntry, file: File, groupId: string): Promise<AttachmentBody> => {
    // Assumption: the import reads files the normal /uploads flow stored under `files/{uploadId}`; the job then verifies size and sha256 (R26.3).
    // Files over the single-request size go up in parts, like any other upload; the part checksums come from the same hash pass.
    const multipart = file.size > SINGLE_PUT_BYTES;
    const digests = multipart || entry.sha256 === undefined ? await fileDigests(file) : undefined;
    const sha256 = entry.sha256 ?? digests!.sha256;
    const start = await client.post<{ id: string; mode: string; url: string | null; headers: Record<string, string> }>('/uploads', { groupId, fileName: entry.fileName, sizeBytes: file.size, sha256 });
    if (start.mode === 'single' && start.url !== null) {
      await putFile(start.url, start.headers, file, new AbortController().signal, () => undefined);
      await client.post(`/uploads/${start.id}/complete`, {});
    } else {
      const parts = (digests ?? await fileDigests(file)).parts;
      const done: { partNumber: number; etag: string }[] = [];
      const signal = new AbortController().signal;
      for (const [i, partSha] of parts.entries()) {
        const signed = await client.post<{ url: string; headers: Record<string, string> }>(`/uploads/${start.id}/parts`, { partNumber: i + 1, sha256: partSha });
        const etag = await putFile(signed.url, signed.headers, file.slice(i * UPLOAD_PART_BYTES, (i + 1) * UPLOAD_PART_BYTES), signal, () => undefined);
        done.push({ partNumber: i + 1, etag });
      }
      await client.post(`/uploads/${start.id}/complete`, { parts: done });
    }
    const credit = entry.creditingContributor ?? session.me.member.id;
    return {
      sitePath: entry.sitePath, fileName: entry.fileName, title: entry.title ?? entry.fileName, sizeBytes: file.size, sha256,
      r2Key: `files/${start.id}`, creditingContributor: credit,
      ...(entry.fileKind === undefined ? {} : { fileKind: entry.fileKind }),
      ...(entry.sizeLabel === undefined ? {} : { sizeLabel: entry.sizeLabel }),
      ...(entry.caption === undefined ? {} : { caption: entry.caption }),
      ...(entry.origin === undefined ? {} : { origin: entry.origin }),
    };
  };

  const pollJob = async (jobId: string) => {
    if (polling.current) return;
    polling.current = true;
    try {
      for (;;) {
        const view = await client.get<JobStatusView>(`/imports/journal/${jobId}`);
        setStatus(view);
        if (view.state === 'complete' || view.state === 'failed' || view.state === 'incomplete') return;
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    } catch (error) { setFailure(error); }
    finally { polling.current = false; }
  };

  const start = async () => {
    if (journal === undefined || projectId === '') return;
    setBusy(true); setFailure(undefined); setStatus(undefined);
    try {
      const groupId = session.me.member.id;
      const attachments: AttachmentBody[] = [];
      for (const entry of entries ?? []) {
        const file = fileFor(entry);
        if (file === undefined) throw new Error(`The file ${entry.fileName} was not found in the chosen folder.`);
        attachments.push(await uploadAttachment(entry, file, groupId));
      }
      const body = { projectId, journal: await journal.text(), accessLevel, ...(entryDates !== undefined ? { meta: entryDates } : {}), ...(attachments.length > 0 ? { attachments } : {}) };
      const { jobId } = await client.post<{ jobId: string }>('/imports/journal', body);
      setStartedLevel(accessLevel);
      setStatus({ state: 'queued' });
      void pollJob(jobId);
    } catch (error) { setFailure(error); }
    finally { setBusy(false); }
  };

  const creditWarnings = (entries ?? []).filter((entry) => entry.creditingContributor !== undefined && !memberById.has(entry.creditingContributor)).map((entry) => entry.fileName);
  const progress = status?.progress as Record<string, number> | undefined | null;

  return (
    <div className="rf-stack">
      <h1>Import a journal</h1>
      <p className="rf-meta">Import a legacy journal and its attachments into a Project as Journal Entries, Entry Sections, and Attachments.</p>
      <SaveFailure error={failure} />

      <section className="rf-section" aria-label="Import source">
        <h2>Choose the files</h2>
        <SelectField label="Project" value={projectId} placeholder="Choose a Project" options={projects.data.projects.map((project) => ({ value: project.id, label: project.name }))} onChange={setProjectId} required />
        <label className="rf-field"><span className="rf-field__label">Journal file</span>
          <input type="file" accept=".md,text/markdown,text/plain" onChange={(event) => { setJournal(event.target.files?.[0]); setPreview(undefined); event.target.value = ''; }} /></label>
        {journal !== undefined && <p className="rf-meta">{`Journal: ${journal.name}`}</p>}
        <label className="rf-field"><span className="rf-field__label">Attachment folder</span>
          {/* webkitdirectory gives a FileList with webkitRelativePath for every file in the folder. */}
          <input type="file" ref={(node) => { if (node) node.setAttribute('webkitdirectory', ''); }} multiple onChange={(event) => { setFolderFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} /></label>
        {folderFiles !== undefined && <p className="rf-meta">{`Attachment files chosen: ${folderFiles.length}`}</p>}
        <label className="rf-field"><span className="rf-field__label">Attachment metadata (JSON)</span>
          <input type="file" accept=".json,application/json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void chooseMetadata(file); event.target.value = ''; }} /></label>
        {entries !== undefined && <p className="rf-meta">{`Metadata entries: ${entries.length}`}</p>}
        <label className="rf-field"><span className="rf-field__label">Entry dates (JSON, optional)</span>
          <input type="file" accept=".json,application/json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void chooseEntryDates(file); event.target.value = ''; }} /></label>
        {entryDates !== undefined && <p className="rf-meta">{`Entry dates for ${Object.keys(entryDates).length} entries`}</p>}
        {metadataError !== undefined && <Notice tone="danger" title={metadataError} />}
        {creditWarnings.length > 0 && <Notice tone="warning" title="Some metadata entries credit a Member id that is not in this Workspace:"><ul className="rf-list">{creditWarnings.map((name) => <li key={name}>{name}</li>)}</ul></Notice>}
        <div className="rf-actions"><Button onClick={() => void runPreview()} disabled={busy || journal === undefined}>Preview the import</Button></div>
      </section>

      {preview !== undefined && <PreviewReport preview={preview} />}

      <section className="rf-section" aria-label="Who can read this import">
        <h2>Who can read this import</h2>
        <p className="rf-field__hint">{RESTRICTED_STATEMENT}</p>
        <SelectField label="Access level" value={accessLevel} options={LEVEL_OPTIONS} onChange={(value) => setAccessLevel(value as AccessLevel)} />
      </section>

      <section className="rf-section" aria-label="Start the import">
        <h2>Start the import</h2>
        <div className="rf-actions"><Button variant="primary" onClick={() => void start()} disabled={busy || projectId === '' || journal === undefined || status !== undefined}>Start the import</Button></div>
        {status !== undefined && status.state !== 'complete' && (
          <Notice tone="neutral" title={status.state === 'failed' ? 'The import failed.' : status.state === 'incomplete' ? 'The import stopped before it finished.' : 'The import is running.'}>
            {progress != null && <p role="status">{`Entries: ${progress['entries'] ?? 0}; sections: ${progress['sections'] ?? 0}; skipped: ${progress['skipped'] ?? 0}; failed: ${progress['failed'] ?? 0}; attachments: ${progress['attachments'] ?? 0}`}</p>}
          </Notice>
        )}
      </section>

      {status?.state === 'complete' && status.report !== undefined && <FinalReport report={status.report} accessLevel={startedLevel} {...(status.printedUrl === undefined ? {} : { printedUrl: status.printedUrl })} />}
    </div>
  );
}
