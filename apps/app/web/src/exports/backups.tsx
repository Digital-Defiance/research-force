import { useState } from 'react';
import { useApi } from '../api';
import { useSession } from '../session';
import { hashFile } from '../files/upload';
import { Button, LoadState, Notice, SaveFailure, SelectField, formatDate, useLoad } from '../ui';

/**
 * The Internal_Backup and restore screen (R36.1, R36.2, R36.8). Administrators only: the whole screen is gated on
 * `backup.manage`, the permission every backup and restore route also checks, so a Member who is not an Administrator
 * sees nothing. An Administrator requests a backup through `POST /backups` and sees the held backups listed by
 * `GET /backups`, each with its state, the incomplete report of one that could not include every element, the expiry,
 * and the Download_Links for its volumes (R36.2, R36.6). A restore is requested through `POST /restores`, naming a
 * backup package the server already holds; the Administrator may upload the package file so the browser hashes it
 * (WebCrypto SHA-256 through the shared hashing worker) and sends the digest as a SUPPLEMENTARY `clientHash` — the
 * restore service verifies the package and its authenticated manifest itself (R36.8). Restores are listed by
 * `GET /restores` with their state and the preflight/quarantine report, and a quarantined restore whose gates all pass
 * is released explicitly through `POST /restores/:id/release` (R36.10, R36.16).
 */

/** One Download_Link the route issues per volume: a `/x/` token to an active Administrator, with its expiry (R36.2). */
interface DownloadLink { readonly url: string; readonly expiresAt: string }
/** One held Internal_Backup, as `GET /backups` presents it. */
interface BackupView {
  readonly id: string;
  readonly state: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly expiresAt: string | null;
  readonly incomplete: unknown;
  readonly download: readonly DownloadLink[];
}

/** One preflight problem that blocked a restore before any insertion (R36.8). */
interface PreflightProblem { readonly kind: string; readonly element: string; readonly detail: string }
/** The content-free restore report `GET /restores` carries (R36.8, R36.10, R36.16). */
interface RestoreReport {
  readonly problems?: readonly PreflightProblem[];
  readonly bootstrapConflict?: { readonly reason: string };
  readonly insertConflict?: { readonly table: string; readonly rowKey: string; readonly reason: string };
  readonly suppressionFault?: { readonly element: string };
  readonly counts?: { readonly recreated: number; readonly tablesDone: number; readonly tablesTotal: number };
  readonly blockedBy?: readonly string[];
  readonly suppressed?: readonly string[];
}
/** One restore, as `GET /restores` presents it. */
interface RestoreView {
  readonly id: string;
  readonly sourceExportId: string;
  readonly state: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly releasedAt: string | null;
  readonly releasedBy: string | null;
  readonly report: RestoreReport | null;
}

const BACKUP_STATE_NAMES: Readonly<Record<string, string>> = {
  queued: 'Queued', running: 'Running', complete: 'Complete', incomplete: 'Incomplete', failed: 'Failed', deleted: 'Deleted',
};
const backupStateName = (state: string): string => BACKUP_STATE_NAMES[state] ?? state;

const RESTORE_STATE_NAMES: Readonly<Record<string, string>> = {
  queued: 'Queued', running: 'Running', quarantined: 'Quarantined', released: 'Released', failed: 'Failed', incomplete: 'Stopped before it finished',
};
const restoreStateName = (state: string): string => RESTORE_STATE_NAMES[state] ?? state;

/** A readable name for a release gate still blocking a quarantined restore (R36.16). */
const GATE_NAMES: Readonly<Record<string, string>> = {
  validation: 'Counts, hashes, and references',
  suppressions: 'The independent suppression ledger',
  'disclosure-consent': 'Current credentials, permissions, and consent',
};
const gateName = (gate: string): string => GATE_NAMES[gate] ?? gate;

/** The hex SHA-256 of a file through the shared hashing worker, the supplementary digest the restore route may receive (R36.8). */
async function fileSha256(file: File): Promise<string> {
  const controller = new AbortController();
  return (await hashFile(file, controller.signal)).sha256;
}

/** One backup row with its state, incomplete report, expiry, and download links. */
function BackupCard({ record }: { readonly record: BackupView }) {
  return (
    <section className="rf-section" aria-label={`Backup ${record.id}`}>
      <h3>Backup</h3>
      <p className="rf-meta">
        State: <span className="rf-status">{backupStateName(record.state)}</span>. Started {formatDate(record.startedAt)}
        {record.finishedAt === null ? '' : `; finished ${formatDate(record.finishedAt)}`}
        {record.expiresAt === null ? '' : `; expires ${formatDate(record.expiresAt)}`}.
      </p>
      {record.incomplete !== null && (
        <Notice tone="warning" title="This backup could not include every element.">
          <p>Each missing element and mismatched file was reported to the requesting administrator.</p>
        </Notice>
      )}
      {record.download.length > 0 && (
        <section className="rf-section" aria-label={`Download links for backup ${record.id}`}>
          <h4>Download</h4>
          <ul className="rf-list">
            {record.download.map((link, index) => (
              <li key={link.url}><a href={link.url}>{`Volume ${index + 1}`}</a>{` (link expires ${formatDate(link.expiresAt)})`}</li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}

/** The content-free report of a failed, stopped, or quarantined restore (R36.8, R36.10, R36.16). */
function RestoreReportView({ report }: { readonly report: RestoreReport }) {
  return (
    <>
      {report.counts !== undefined && (
        <p className="rf-meta">{`Recreated ${report.counts.recreated} rows across ${report.counts.tablesDone} of ${report.counts.tablesTotal} tables.`}</p>
      )}
      {report.problems !== undefined && report.problems.length > 0 && (
        <section className="rf-section" aria-label="Preflight problems">
          <h4>Preflight problems</h4>
          <ul className="rf-list">{report.problems.map((problem, index) => <li key={index}>{`${problem.kind} (${problem.element}): ${problem.detail}`}</li>)}</ul>
        </section>
      )}
      {report.bootstrapConflict !== undefined && <p className="rf-meta">{`Bootstrap identity conflict: ${report.bootstrapConflict.reason}`}</p>}
      {report.insertConflict !== undefined && <p className="rf-meta">{`Insert conflict in ${report.insertConflict.table} (${report.insertConflict.rowKey}): ${report.insertConflict.reason}`}</p>}
      {report.suppressionFault !== undefined && <p className="rf-meta">{`Suppression ledger fault: ${report.suppressionFault.element}`}</p>}
      {report.blockedBy !== undefined && report.blockedBy.length > 0 && (
        <section className="rf-section" aria-label="Release is blocked by">
          <h4>Release is blocked by</h4>
          <ul className="rf-list">{report.blockedBy.map((gate) => <li key={gate}>{gateName(gate)}</li>)}</ul>
        </section>
      )}
    </>
  );
}

/** One restore row with its state, report, and, for a quarantined restore whose gates pass, the explicit release action. */
function RestoreCard({ record, onRelease, busy }: { readonly record: RestoreView; readonly onRelease: (id: string) => void; readonly busy: boolean }) {
  const canRelease = record.state === 'quarantined' && (record.report?.blockedBy === undefined || record.report.blockedBy.length === 0);
  return (
    <section className="rf-section" aria-label={`Restore ${record.id}`}>
      <h3>Restore</h3>
      <p className="rf-meta">
        State: <span className="rf-status">{restoreStateName(record.state)}</span>. From backup {record.sourceExportId}. Started {formatDate(record.startedAt)}
        {record.finishedAt === null ? '' : `; finished ${formatDate(record.finishedAt)}`}.
      </p>
      {record.releasedAt !== null && <p className="rf-meta">{`Released ${formatDate(record.releasedAt)}.`}</p>}
      {record.state === 'quarantined' && (
        <Notice tone="warning" title="This restore is contained until it is released.">
          <p>The restored material stays out of the public site and the publisher stays paused until you release it.</p>
        </Notice>
      )}
      {record.report !== null && <RestoreReportView report={record.report} />}
      {record.state === 'quarantined' && (
        <div className="rf-actions">
          <Button variant="primary" disabled={busy || !canRelease} onClick={() => onRelease(record.id)}>Release this restore</Button>
        </div>
      )}
    </section>
  );
}

export function BackupsScreen() {
  const session = useSession();
  const client = useApi();

  const backups = useLoad<{ backups: BackupView[] }>(session.can('backup.manage') ? '/backups' : undefined);
  const restores = useLoad<{ restores: RestoreView[] }>(session.can('backup.manage') ? '/restores' : undefined);

  const [sourceExportId, setSourceExportId] = useState('');
  const [packageFile, setPackageFile] = useState<File | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [backupRequested, setBackupRequested] = useState(false);
  const [restoreRequested, setRestoreRequested] = useState(false);

  // Backups and restores are for Administrators only; the gate matches every backup and restore route (R36.2, R36.8).
  if (!session.can('backup.manage')) return <Notice tone="warning" title="This page does not exist, or you cannot see it." />;
  if (backups.data === undefined || restores.data === undefined) return <LoadState error={backups.error ?? restores.error} />;

  const completeBackups = backups.data.backups.filter((backup) => backup.state === 'complete');

  const requestBackup = async () => {
    setBusy(true); setFailure(undefined); setBackupRequested(false);
    try {
      await client.post('/backups', {});
      setBackupRequested(true);
      backups.reload();
    } catch (error) { setFailure(error); }
    finally { setBusy(false); }
  };

  const requestRestore = async () => {
    if (sourceExportId === '') return;
    setBusy(true); setFailure(undefined); setRestoreRequested(false);
    try {
      // The browser hash is supplementary; the server self-verifies the package and its authenticated manifest (R36.8).
      const clientHash = packageFile === undefined ? undefined : await fileSha256(packageFile);
      await client.post('/restores', { sourceExportId, ...(clientHash === undefined ? {} : { clientHash }) });
      setRestoreRequested(true);
      restores.reload();
    } catch (error) { setFailure(error); }
    finally { setBusy(false); }
  };

  const release = async (id: string) => {
    setBusy(true); setFailure(undefined);
    try {
      await client.post(`/restores/${id}/release`, {});
      restores.reload();
    } catch (error) { setFailure(error); }
    finally { setBusy(false); }
  };

  return (
    <div className="rf-stack">
      <h1>Backups and restores</h1>
      <p className="rf-meta">A full backup of everything that an administrator can restore, so research can be recovered independently of platform time travel.</p>
      <SaveFailure error={failure} />

      <section className="rf-section" aria-label="Request a backup">
        <h2>Request a backup</h2>
        <p className="rf-meta">A requested staging package is kept for seven days; the independent scheduled recovery points are retained separately.</p>
        <div className="rf-actions"><Button variant="primary" disabled={busy} onClick={() => void requestBackup()}>Request the backup</Button></div>
        {backupRequested && <Notice tone="success" title="The backup was requested. It appears below once it starts." />}
      </section>

      <section className="rf-section" aria-label="Backups">
        <h2>Backups</h2>
        {backups.data.backups.length === 0
          ? <p className="rf-meta">There are no backups yet.</p>
          : backups.data.backups.map((record) => <BackupCard key={record.id} record={record} />)}
      </section>

      <section className="rf-section" aria-label="Restore a backup">
        <h2>Restore a backup</h2>
        <p className="rf-meta">Restore into an empty workspace. The restored material stays contained until you release it.</p>
        <SelectField
          label="Backup package"
          value={sourceExportId}
          placeholder="Choose a complete backup"
          options={completeBackups.map((backup) => ({ value: backup.id, label: `${backup.id} (started ${formatDate(backup.startedAt)})` }))}
          onChange={setSourceExportId}
          required
        />
        <p className="rf-field__hint">The browser hashes the chosen file and sends the checksum as a supplementary check. The server verifies the package itself.</p>
        <label className="rf-field">
          <span className="rf-field__label">Package file (optional)</span>
          <input type="file" onChange={(event) => { setPackageFile(event.target.files?.[0]); event.target.value = ''; }} />
        </label>
        {packageFile !== undefined && <p className="rf-meta">{`Package: ${packageFile.name}`}</p>}
        <div className="rf-actions"><Button variant="primary" disabled={busy || sourceExportId === ''} onClick={() => void requestRestore()}>Start the restore</Button></div>
        {restoreRequested && <Notice tone="success" title="The restore was requested. It appears below once it starts." />}
      </section>

      <section className="rf-section" aria-label="Restores">
        <h2>Restores</h2>
        {restores.data.restores.length === 0
          ? <p className="rf-meta">There are no restores yet.</p>
          : restores.data.restores.map((record) => <RestoreCard key={record.id} record={record} onRelease={(id) => void release(id)} busy={busy} />)}
      </section>
    </div>
  );
}
