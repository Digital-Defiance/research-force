import { useState } from 'react';
import { useApi } from '../api';
import { useSession } from '../session';
import { Button, LoadState, Notice, SaveFailure, SelectField, formatDate, useLoad } from '../ui';

/**
 * The Public_Archive_Export screen (R35.1, R35.7, R35.9, R35.10). An Administrator (`export.manage`) requests an
 * export with its Export_Scope — one Project, or the whole public archive — through `POST /exports`, and every
 * authenticated active Member sees the held exports listed by `GET /exports`, newest first, each with its state, the
 * staleness labels of a package that holds material no longer public, the missing or mismatched files of an incomplete
 * one, the Download_Links for its volumes, and, for an Administrator, a deletion offer on a labelled package
 * (`DELETE /exports/:id`). The screen only reads and offers what the route returns; the server decides each request.
 */

/** One Download_Link the route issues per volume: a `/x/` token to an active Member, with its expiry (R35.9). */
interface DownloadLink { readonly url: string; readonly expiresAt: string }
/** A file an incomplete export is missing or whose stored size or checksum did not match (R35.7). */
interface ManifestMiss { readonly path: string; readonly reason: 'missing' | 'size' | 'checksum' }
/** Why a held package is labelled as holding material that is no longer public, with the affected element named (R35.10). */
type LabelReason =
  | { readonly kind: 'unit_withdrawn'; readonly key: string }
  | { readonly kind: 'unit_removed'; readonly key: string }
  | { readonly kind: 'party_do_not_name'; readonly partyId: string }
  | { readonly kind: 'member_email'; readonly email: string };
/** The Export_Scope of a package: one Project, or the whole public archive (R35.1). */
type ExportScope = { readonly kind: 'archive' } | { readonly kind: 'project'; readonly projectId: string };
/** One held Public_Archive_Export, as `GET /exports` presents it. */
interface ExportView {
  readonly id: string;
  readonly scope: ExportScope;
  readonly scheduled: boolean;
  readonly state: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly expiresAt: string | null;
  readonly incomplete: readonly ManifestMiss[] | null;
  readonly labels: readonly LabelReason[];
  readonly staleLabel: boolean;
  readonly canDelete: boolean;
  readonly download: readonly DownloadLink[];
}

/** A readable name for an export's state. */
const STATE_NAMES: Readonly<Record<string, string>> = {
  queued: 'Queued', running: 'Running', complete: 'Complete', incomplete: 'Incomplete', failed: 'Failed', deleted: 'Deleted',
};
const stateName = (state: string): string => STATE_NAMES[state] ?? state;

/** The reason a file is listed against an incomplete export (R35.7). */
const MISS_REASONS: Readonly<Record<ManifestMiss['reason'], string>> = {
  missing: 'missing from the package', size: 'the wrong size', checksum: 'a checksum that does not match',
};

/** One label line naming the affected element of a stale package (R35.10). */
function labelLine(label: LabelReason): string {
  switch (label.kind) {
    case 'unit_withdrawn': return `A unit exported as public is now withheld: ${label.key}`;
    case 'unit_removed': return `A unit is no longer published: ${label.key}`;
    case 'party_do_not_name': return `An external party is now marked do not name: ${label.partyId}`;
    case 'member_email': return `The package holds a now-registered member address: ${label.email}`;
  }
}

/** One export row with its state, scope, times, labels, missing files, download links, and deletion offer. */
function ExportCard({ record, onDelete, busy }: { readonly record: ExportView; readonly onDelete: (id: string) => void; readonly busy: boolean }) {
  const scope = record.scope.kind === 'archive' ? 'The whole public archive' : `One project (${record.scope.projectId})`;
  return (
    <section className="rf-section" aria-label={`Export ${record.id}`}>
      <h3>{record.scheduled ? 'Scheduled export' : 'Requested export'}</h3>
      <p className="rf-meta">
        Scope: {scope}. State: <span className="rf-status">{stateName(record.state)}</span>.
      </p>
      <p className="rf-meta">
        Started {formatDate(record.startedAt)}
        {record.finishedAt === null ? '' : `; finished ${formatDate(record.finishedAt)}`}
        {record.expiresAt === null ? '' : `; expires ${formatDate(record.expiresAt)}`}.
      </p>

      {record.staleLabel && (
        <Notice tone="warning" title="This package holds material that is no longer public.">
          <ul className="rf-list">{record.labels.map((label, index) => <li key={index}>{labelLine(label)}</li>)}</ul>
        </Notice>
      )}

      {record.incomplete !== null && record.incomplete.length > 0 && (
        <section className="rf-section" aria-label={`Missing files of export ${record.id}`}>
          <h4>Missing or mismatched files</h4>
          <ul className="rf-list">{record.incomplete.map((miss) => <li key={miss.path}>{`${miss.path} — ${MISS_REASONS[miss.reason]}`}</li>)}</ul>
        </section>
      )}

      {record.download.length > 0 && (
        <section className="rf-section" aria-label={`Download links for export ${record.id}`}>
          <h4>Download</h4>
          <ul className="rf-list">
            {record.download.map((link, index) => (
              <li key={link.url}><a href={link.url}>{`Volume ${index + 1}`}</a>{` (link expires ${formatDate(link.expiresAt)})`}</li>
            ))}
          </ul>
        </section>
      )}

      {record.canDelete && (
        <div className="rf-actions">
          <Button variant="danger" disabled={busy} onClick={() => onDelete(record.id)}>Delete this export</Button>
        </div>
      )}
    </section>
  );
}

export function ExportsScreen() {
  const session = useSession();
  const client = useApi();
  const canManage = session.can('export.manage');
  const projects = useLoad<{ projects: { id: string; name: string }[] }>(canManage ? '/projects' : undefined);
  const exports = useLoad<{ exports: ExportView[] }>('/exports');

  const [scopeProjectId, setScopeProjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [requested, setRequested] = useState(false);

  if (exports.data === undefined) return <LoadState error={exports.error} />;

  const requestExport = async () => {
    setBusy(true); setFailure(undefined); setRequested(false);
    try {
      // An empty scope means the whole public archive; a chosen project limits the export to one Project (R35.1).
      await client.post('/exports', scopeProjectId === '' ? {} : { scopeProjectId });
      setRequested(true);
      exports.reload();
    } catch (error) { setFailure(error); }
    finally { setBusy(false); }
  };

  const deleteExport = async (id: string) => {
    setBusy(true); setFailure(undefined);
    try {
      await client.delete(`/exports/${id}`);
      exports.reload();
    } catch (error) { setFailure(error); }
    finally { setBusy(false); }
  };

  return (
    <div className="rf-stack">
      <h1>Public archive exports</h1>
      <p className="rf-meta">A self-contained package of the public archive in open formats, so the public record survives independently of this platform.</p>
      <SaveFailure error={failure} />

      {canManage && (
        <section className="rf-section" aria-label="Request an export">
          <h2>Request an export</h2>
          <p className="rf-meta">Choose one project, or leave the choice empty to export the whole public archive.</p>
          <SelectField
            label="Export scope"
            value={scopeProjectId}
            placeholder="The whole public archive"
            options={(projects.data?.projects ?? []).map((project) => ({ value: project.id, label: project.name }))}
            onChange={setScopeProjectId}
          />
          <div className="rf-actions"><Button variant="primary" disabled={busy} onClick={() => void requestExport()}>Request the export</Button></div>
          {requested && <Notice tone="success" title="The export was requested. It appears below once it starts." />}
        </section>
      )}

      <section className="rf-section" aria-label="Exports">
        <h2>Exports</h2>
        {exports.data.exports.length === 0
          ? <p className="rf-meta">There are no exports yet.</p>
          : exports.data.exports.map((record) => <ExportCard key={record.id} record={record} onDelete={(id) => void deleteExport(id)} busy={busy} />)}
      </section>
    </div>
  );
}
