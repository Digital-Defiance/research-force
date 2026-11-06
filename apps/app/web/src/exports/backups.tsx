import { useState } from 'react';
import { useApi } from '../api';
import { useSession } from '../session';
import { hashFile } from '../files/upload';
import { Button, LoadState, Notice, SaveFailure, SelectField, TextField, useLoad } from '../ui';

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
  readonly offsiteConfirmedAt?: string | null;
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

/** A short date in the viewer's own time zone, e.g. "Nov 6, 2026, 2:28 PM PST". Falls back to the raw value if unparseable. */
function whenLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** One finished backup: when it was taken, how long it is kept, and its download links (R36.2). */
function BackupCard({ record, onConfirm, busy }: { readonly record: BackupView; readonly onConfirm: (id: string, fingerprint: string) => Promise<void>; readonly busy: boolean }) {
  const [fingerprint, setFingerprint] = useState('');
  return (
    <section className="rf-section" aria-label={`Backup ${record.id}`}>
      <h3>{`Backup from ${whenLabel(record.startedAt)}`}</h3>
      <p className="rf-meta">
        <span className="rf-status">{backupStateName(record.state)}</span>
        {record.expiresAt === null ? '' : ` · kept until ${whenLabel(record.expiresAt)}`}
      </p>
      {record.download.length > 0 && (
        <section className="rf-section rf-nested" aria-label={`Download links for backup ${record.id}`}>
          <h4>Download</h4>
          <ul className="rf-list">
            {record.download.map((link, index) => (
              <li key={link.url}><a href={link.url}>{record.download.length === 1 ? 'Download this backup' : `Download part ${index + 1}`}</a>{` (link works until ${whenLabel(link.expiresAt)}; reload the page for a new one)`}</li>
            ))}
          </ul>
        </section>
      )}
      {record.state === 'complete' && (
        <section className="rf-section rf-nested" aria-label={`Offsite copy for backup ${record.id}`}>
          <h4>Offsite copy</h4>
          {record.offsiteConfirmedAt != null
            ? <p className="rf-meta">{`Confirmed ${whenLabel(record.offsiteConfirmedAt)}. This backup counts as a safe recovery point.`}</p>
            : (
              <>
                <p className="rf-meta">After you save the download somewhere safe, run the verify tool on it and paste the fingerprint it prints. Until then this backup is not counted as a recovery point.</p>
                <TextField label="Fingerprint from the verify tool" value={fingerprint} onChange={setFingerprint} />
                <div className="rf-actions"><Button variant="primary" disabled={busy || fingerprint.trim() === ''} onClick={() => void onConfirm(record.id, fingerprint)}>Confirm the offsite copy</Button></div>
              </>
            )}
        </section>
      )}
    </section>
  );
}

/** One backup that could not include everything or did not finish: a single quiet line, never a download. */
function FailedBackupRow({ record }: { readonly record: BackupView }) {
  return (
    <li aria-label={`Backup ${record.id}`}>
      <span className="rf-status">{backupStateName(record.state)}</span>
      {` ${whenLabel(record.startedAt)}`}
      {record.incomplete !== null && <> · <span className="rf-meta">This backup could not include every element.</span></>}
    </li>
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
function RestoreCard({ record, sourceLabel, onRelease, busy }: { readonly record: RestoreView; readonly sourceLabel: string; readonly onRelease: (id: string) => void; readonly busy: boolean }) {
  const canRelease = record.state === 'quarantined' && (record.report?.blockedBy === undefined || record.report.blockedBy.length === 0);
  return (
    <section className="rf-section" aria-label={`Restore ${record.id}`}>
      <h3>{`Restore from ${sourceLabel}`}</h3>
      <p className="rf-meta">
        <span className="rf-status">{restoreStateName(record.state)}</span>
        {` · started ${whenLabel(record.startedAt)}`}
        {record.finishedAt === null ? '' : `, finished ${whenLabel(record.finishedAt)}`}
      </p>
      {record.releasedAt !== null && <p className="rf-meta">{`Released ${whenLabel(record.releasedAt)}.`}</p>}
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
  const otherBackups = backups.data.backups.filter((backup) => backup.state !== 'complete');
  const backupLabels = new Map(backups.data.backups.map((backup) => [backup.id, whenLabel(backup.startedAt)] as const));

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

  const confirmOffsite = async (id: string, fingerprint: string) => {
    setBusy(true); setFailure(undefined);
    try {
      await client.post(`/backups/${id}/confirm-offline`, { fingerprint });
      backups.reload();
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
      <p className="rf-meta">A backup is a full, encrypted copy of everything. Take one, download it, and keep the file somewhere safe outside this service.</p>
      <SaveFailure error={failure} />

      <section className="rf-section" aria-label="Request a backup">
        <h2>Request a backup</h2>
        <p className="rf-meta">Backups are also taken automatically. A backup you request here is kept for seven days.</p>
        <div className="rf-actions"><Button variant="primary" disabled={busy} onClick={() => void requestBackup()}>Request the backup</Button></div>
        {backupRequested && <Notice tone="success" title="The backup was requested. It appears below once it starts." />}
      </section>

      <section className="rf-section" aria-label="Backups">
        <h2>Backups</h2>
        {backups.data.backups.length === 0 && <p className="rf-meta">There are no backups yet.</p>}
        {completeBackups.map((record) => <BackupCard key={record.id} record={record} onConfirm={confirmOffsite} busy={busy} />)}
        {otherBackups.length > 0 && (
          <details>
            <summary>{`Backups that did not finish (${otherBackups.length})`}</summary>
            <ul className="rf-list">{otherBackups.map((record) => <FailedBackupRow key={record.id} record={record} />)}</ul>
          </details>
        )}
      </section>

      <section className="rf-section" aria-label="Restore a backup">
        <h2>Restore a backup</h2>
        <p className="rf-meta">Only for an empty, new workspace. A restore into a workspace that already has data is refused. Restored material stays contained until you release it.</p>
        <SelectField
          label="Backup package"
          value={sourceExportId}
          placeholder="Choose a complete backup"
          options={completeBackups.map((backup) => ({ value: backup.id, label: `Backup from ${whenLabel(backup.startedAt)}` }))}
          onChange={setSourceExportId}
          required
        />
        <p className="rf-field__hint">Optional. If you choose your downloaded file, the browser sends its checksum as an extra check. The server always verifies the backup itself.</p>
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
          : restores.data.restores.map((record) => <RestoreCard key={record.id} record={record} sourceLabel={backupLabels.get(record.sourceExportId) ?? 'an earlier backup'} onRelease={(id) => void release(id)} busy={busy} />)}
      </section>
    </div>
  );
}
