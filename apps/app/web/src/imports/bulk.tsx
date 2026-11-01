import { useMemo, useRef, useState } from 'react';
import type { AccessLevel } from '@researchforce/domain/types';
import { useApi } from '../api';
import { useSession } from '../session';
import { ACCESS_LEVEL_NAMES, accessLevelName } from '../access/access';
import type { ValueSets } from '../types';
import { Button, LoadState, Notice, SaveFailure, SelectField, useLoad } from '../ui';
import { hashFile } from '../files/upload';
import type { BulkPreview, BulkPreviewError, BulkPreviewRequest } from './bulk-preview';
import type { BulkPreviewResult } from './bulk-worker';

/**
 * The Administrator affordance that starts a Bulk_Import into a Project (R37.3, R37.11, R37.17, R47.13). The Member
 * chooses the Project and the import's Access_Level for rows that set no access columns, with Restricted preselected
 * and the statement of who can always read Restricted items; selects the manifest file and the attachment folder; sees
 * a browser-side validation report before the round trip; hashes and uploads the manifest and files inline as base64;
 * starts the job; and watches its progress and the stored report with the access choice.
 *
 * The browser-side report runs the pure Manifest_Parser (`computeBulkPreview`) in a Web Worker — the full semantic
 * validator needs the server catalog and lives server-side, so its result is surfaced from the route's pre-flight
 * `errors`/`notImported` after submit and from the job's stored report (R37.3). The real worker is wrapped so tests
 * target the pure compute through the injected `compute` prop, exactly as the journal import screen (task 36.3) does.
 */

/** The statement shown beside the Access_Level choice: who can always read a Restricted import (R47.13). */
const RESTRICTED_STATEMENT = 'The importing Administrator, as Owner, and every Administrator can read Restricted items, whether or not they are on the Access List.';

const LEVEL_OPTIONS = (['restricted', 'whole_team'] as const).map((value) => ({ value, label: ACCESS_LEVEL_NAMES[value] }));

/** The hex SHA-256 of a file, matching what the job verifies against; the real worker is wrapped so tests target the pure logic. */
async function fileSha256(file: File): Promise<string> {
  const controller = new AbortController();
  return (await hashFile(file, controller.signal)).sha256;
}

/**
 * Encode a file's bytes to base64, the wire form the manifest and each uploaded file travel in, since JSON carries no
 * binary and the `/imports/bulk` route decodes `atob` of this string (R38.1). The bytes are read whole and chunked into
 * the binary string `btoa` wants; the route caps `files` at 50,000 entries, and a very large file is impractical to
 * carry inline this way, but this matches the route's actual base64 contract rather than inventing an upload path.
 */
async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

/** Run the preview compute in a Web Worker so a large manifest never blocks the UI thread (R37.3). Tests pass their own `compute`. */
function previewInWorker(request: BulkPreviewRequest): Promise<BulkPreview> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./bulk-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<BulkPreviewResult>) => {
      worker.terminate();
      if ('error' in event.data) reject(new Error(event.data.error));
      else resolve(event.data.preview);
    };
    worker.onerror = () => { worker.terminate(); reject(new Error('The manifest could not be parsed.')); };
    worker.postMessage(request);
  });
}

/** One row listed in the report: created, skipped, or failed, located by row number, Row_Key, and reason (R37.11). */
interface ReportRow { readonly row: number; readonly rowKey: string; readonly reason?: string }
/** One Attachment listed in the report, located by its row and file name, with the reason it failed (R37.11). */
interface ReportFile { readonly row: number; readonly rowKey: string; readonly fileName: string; readonly reason?: string }
/** One located validation error, mirroring the server's `BulkError` (R37.3). */
interface ValidationError { readonly row: number | null; readonly column: string | number | null; readonly fileName?: string; readonly reason: string }
/** The stored Bulk_Import report shape, mirroring the backend `BulkImportReport` (R37.11). */
interface BulkImportReport {
  readonly counts: { readonly created: number; readonly skipped: number; readonly failed: number; readonly attachments: number };
  readonly accessChoice: AccessLevel;
  readonly rows: { readonly created: readonly ReportRow[]; readonly skipped: readonly ReportRow[]; readonly failed: readonly ReportRow[] };
  readonly files: { readonly created: readonly ReportFile[]; readonly failed: readonly ReportFile[] };
  readonly validation?: { readonly errors: readonly ValidationError[]; readonly notImported: readonly string[] };
}
interface JobStatusView { readonly state: string; readonly progress?: unknown; readonly report?: BulkImportReport }

/** The column a located error names, as a readable label. */
const columnLabel = (column: string | number | null): string => (column === null ? '' : typeof column === 'number' ? `column ${column}` : column);

/** The located errors the parser or the server reported, row by row (R37.3). */
function ErrorList({ title, errors }: { readonly title: string; readonly errors: readonly ValidationError[] }) {
  return (
    <section className="rf-section" aria-label={title}>
      <h3>{title}</h3>
      <ul className="rf-list">
        {errors.map((error, index) => (
          <li key={index}>
            {error.row === null ? '' : `Row ${error.row}`}
            {error.column === null ? '' : `${error.row === null ? '' : ', '}${columnLabel(error.column)}`}
            {error.fileName === undefined ? '' : ` (${error.fileName})`}
            {error.row === null && error.column === null && error.fileName === undefined ? '' : ': '}
            {error.reason}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The browser-side report the Administrator reviews before starting the job (R37.3). */
function PreviewReport({ preview }: { readonly preview: BulkPreview }) {
  if (!preview.parsed) {
    return (
      <section className="rf-section" aria-label="Validation preview">
        <h2>What this import would do</h2>
        <Notice tone="neutral" title="This spreadsheet is validated when the import starts." >
          <p>A browser-side report is shown for a CSV manifest; a spreadsheet file is checked by the server once the import starts.</p>
        </Notice>
      </section>
    );
  }
  return (
    <section className="rf-section" aria-label="Validation preview">
      <h2>What this import would do</h2>
      {preview.errors.length === 0
        ? <Notice tone="success" title={`The manifest reads cleanly: ${preview.rows} ${preview.rows === 1 ? 'row' : 'rows'}.`} />
        : <Notice tone="danger" title="The manifest has errors, so nothing would be created." />}
      {preview.errors.length > 0 && <ErrorList title="Manifest errors" errors={preview.errors} />}
      {preview.errors.length === 0 && (
        <section className="rf-section" aria-label="Files no row names">
          <h3>Files that no row names</h3>
          {preview.notImported.length === 0
            ? <p className="rf-meta">Every chosen file is named by a row.</p>
            : <ul className="rf-list">{preview.notImported.map((name) => <li key={name}>{name}</li>)}</ul>}
        </section>
      )}
      <p className="rf-meta">The server checks Members, External Parties, file sizes, version chains, and the per-kind fields when the import starts.</p>
    </section>
  );
}

/** The counts and lists of the stored import report once the job completes (R37.11). */
function FinalReport({ report }: { readonly report: BulkImportReport }) {
  const rowSection = (title: string, rows: readonly ReportRow[]) => rows.length > 0 && (
    <section className="rf-section" aria-label={title}>
      <h3>{title}</h3>
      <ul className="rf-list">{rows.map((row) => <li key={`${row.rowKey}:${row.row}`}>{`Row ${row.row} (${row.rowKey})`}{row.reason ? ` — ${row.reason}` : ''}</li>)}</ul>
    </section>
  );
  const fileSection = (title: string, rows: readonly ReportFile[]) => rows.length > 0 && (
    <section className="rf-section" aria-label={title}>
      <h3>{title}</h3>
      <ul className="rf-list">{rows.map((row, index) => <li key={`${row.fileName}:${index}`}>{`Row ${row.row} (${row.rowKey}): ${row.fileName}`}{row.reason ? ` — ${row.reason}` : ''}</li>)}</ul>
    </section>
  );
  return (
    <section className="rf-section" aria-label="Import report">
      <h2>Import report</h2>
      {report.validation !== undefined
        ? <Notice tone="danger" title="The manifest did not validate, so nothing was created." />
        : <Notice tone="success" title="The import finished." />}
      <p>{`Access level for rows that set none: ${accessLevelName(report.accessChoice)}.`}</p>
      <ul className="rf-list">
        <li>{`Rows created: ${report.counts.created}`}</li>
        <li>{`Rows skipped: ${report.counts.skipped}`}</li>
        <li>{`Rows failed: ${report.counts.failed}`}</li>
        <li>{`Attachments created: ${report.counts.attachments}`}</li>
      </ul>
      {report.validation !== undefined && (
        <>
          <ErrorList title="Validation errors" errors={report.validation.errors} />
          <section className="rf-section" aria-label="Files not imported">
            <h3>Files not imported</h3>
            {report.validation.notImported.length === 0
              ? <p className="rf-meta">No files were listed.</p>
              : <ul className="rf-list">{report.validation.notImported.map((name) => <li key={name}>{name}</li>)}</ul>}
          </section>
        </>
      )}
      {rowSection('Rows created', report.rows.created)}
      {rowSection('Rows skipped', report.rows.skipped)}
      {rowSection('Rows failed', report.rows.failed)}
      {fileSection('Attachments created', report.files.created)}
      {fileSection('Attachments failed', report.files.failed)}
    </section>
  );
}

/** One file to send inline to the route: its name, byte size, checksum, and base64 bytes (R37.13, R38.1). */
interface BulkFileBody { readonly fileName: string; readonly sizeBytes: number; readonly sha256: string; readonly content: string }

export interface BulkImportScreenOptions {
  /** Injected in tests so the preview can be computed without a real Worker; defaults to the Web Worker. */
  readonly compute?: (request: BulkPreviewRequest) => Promise<BulkPreview>;
}

export function BulkImportScreen({ compute = previewInWorker }: BulkImportScreenOptions = {}) {
  const session = useSession();
  const client = useApi();
  const projects = useLoad<{ projects: { id: string; name: string }[] }>('/projects');
  const valueSets = useLoad<{ valueSets: ValueSets }>('/value-sets');

  const [projectId, setProjectId] = useState('');
  const [accessLevel, setAccessLevel] = useState<AccessLevel>('restricted');
  const [manifest, setManifest] = useState<File | undefined>(undefined);
  const [folderFiles, setFolderFiles] = useState<readonly File[] | undefined>(undefined);
  const [preview, setPreview] = useState<BulkPreview | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [status, setStatus] = useState<JobStatusView | undefined>(undefined);
  const polling = useRef(false);

  const currentRightsStatuses = useMemo(
    () => (valueSets.data?.valueSets?.rights_status ?? []).filter((value) => !value.retired).map((value) => value.name),
    [valueSets.data],
  );

  if (!session.can('import.run')) return <Notice tone="warning" title="This page does not exist, or you cannot see it." />;
  if (!projects.data || !valueSets.data) return <LoadState error={projects.error ?? valueSets.error} />;

  /** The manifest format from the file's extension; anything but `.xlsx` is treated as CSV, which the parser decodes. */
  const manifestFormat = (file: File): 'csv' | 'xlsx' => (/\.xlsx$/iu.test(file.name) ? 'xlsx' : 'csv');
  const folderNames = (): string[] => (folderFiles ?? []).map((file) => file.webkitRelativePath || file.name);

  const runPreview = async () => {
    if (manifest === undefined) return;
    setBusy(true); setFailure(undefined); setPreview(undefined);
    try {
      const bytes = new Uint8Array(await manifest.arrayBuffer());
      setPreview(await compute({ format: manifestFormat(manifest), manifest: bytes, folderNames: folderNames(), currentRightsStatuses }));
    } catch (error) { setFailure(error); }
    finally { setBusy(false); }
  };

  const pollJob = async (jobId: string) => {
    if (polling.current) return;
    polling.current = true;
    try {
      for (;;) {
        const view = await client.get<JobStatusView>(`/imports/bulk/${jobId}`);
        setStatus(view);
        if (view.state === 'complete' || view.state === 'failed' || view.state === 'incomplete') return;
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    } catch (error) { setFailure(error); }
    finally { polling.current = false; }
  };

  const start = async () => {
    if (manifest === undefined || projectId === '') return;
    setBusy(true); setFailure(undefined); setStatus(undefined);
    try {
      const files: BulkFileBody[] = [];
      for (const file of folderFiles ?? []) {
        files.push({ fileName: file.name, sizeBytes: file.size, sha256: await fileSha256(file), content: await fileToBase64(file) });
      }
      const body = {
        projectId, accessLevel, manifestFormat: manifestFormat(manifest), manifest: await fileToBase64(manifest),
        ...(files.length > 0 ? { files } : {}),
      };
      const { jobId } = await client.post<{ jobId: string; errors: readonly BulkPreviewError[]; notImported: readonly string[] }>('/imports/bulk', body);
      setStatus({ state: 'queued' });
      void pollJob(jobId);
    } catch (error) { setFailure(error); }
    finally { setBusy(false); }
  };

  const progress = status?.progress as Record<string, number> | undefined | null;

  return (
    <div className="rf-stack">
      <h1>Import a manifest</h1>
      <p className="rf-meta">Import many records and their files into a Project at once from a manifest spreadsheet and a folder of files.</p>
      <SaveFailure error={failure} />

      <section className="rf-section" aria-label="Import source">
        <h2>Choose the files</h2>
        <SelectField label="Project" value={projectId} placeholder="Choose a Project" options={projects.data.projects.map((project) => ({ value: project.id, label: project.name }))} onChange={setProjectId} required />
        <label className="rf-field"><span className="rf-field__label">Manifest file</span>
          <input type="file" accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => { setManifest(event.target.files?.[0]); setPreview(undefined); event.target.value = ''; }} /></label>
        {manifest !== undefined && <p className="rf-meta">{`Manifest: ${manifest.name}`}</p>}
        <label className="rf-field"><span className="rf-field__label">Attachment folder</span>
          {/* webkitdirectory gives a FileList with webkitRelativePath for every file in the folder. */}
          <input type="file" ref={(node) => { if (node) node.setAttribute('webkitdirectory', ''); }} multiple onChange={(event) => { setFolderFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} /></label>
        {folderFiles !== undefined && <p className="rf-meta">{`Files chosen: ${folderFiles.length}`}</p>}
        <div className="rf-actions"><Button onClick={() => void runPreview()} disabled={busy || manifest === undefined}>Check the manifest</Button></div>
      </section>

      {preview !== undefined && <PreviewReport preview={preview} />}

      <section className="rf-section" aria-label="Who can read this import">
        <h2>Who can read this import</h2>
        <p className="rf-meta">This is the access for rows that set no access columns of their own. A row that sets its own access keeps it.</p>
        <p className="rf-field__hint">{RESTRICTED_STATEMENT}</p>
        <SelectField label="Access level" value={accessLevel} options={LEVEL_OPTIONS} onChange={(value) => setAccessLevel(value as AccessLevel)} />
      </section>

      <section className="rf-section" aria-label="Start the import">
        <h2>Start the import</h2>
        <div className="rf-actions"><Button variant="primary" onClick={() => void start()} disabled={busy || projectId === '' || manifest === undefined || status !== undefined}>Start the import</Button></div>
        {status !== undefined && status.state !== 'complete' && (
          <Notice tone="neutral" title={status.state === 'failed' ? 'The import failed.' : status.state === 'incomplete' ? 'The import stopped before it finished.' : 'The import is running.'}>
            {progress != null && <p role="status">{`Created: ${progress['created'] ?? 0}; skipped: ${progress['skipped'] ?? 0}; failed: ${progress['failed'] ?? 0}; attachments: ${progress['attachments'] ?? 0}`}</p>}
          </Notice>
        )}
      </section>

      {status?.state === 'complete' && status.report !== undefined && <FinalReport report={status.report} />}
    </div>
  );
}
