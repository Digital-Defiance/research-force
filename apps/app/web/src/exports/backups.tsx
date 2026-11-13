import { useEffect, useState } from 'react';
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
  /** Whether an Administrator requested it or the schedule started it. */
  readonly trigger?: 'requested' | 'scheduled';
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly expiresAt: string | null;
  readonly incomplete: unknown;
  readonly offsiteConfirmedAt?: string | null;
  readonly download: readonly DownloadLink[];
  /** Whether a complete backup's download is built (`ready`), still being built (`preparing`), or gave up (`failed`) (R36.2). */
  readonly package?: 'ready' | 'preparing' | 'failed' | null;
  /** Whether the stored copy is being checked against its fingerprint (`verifying`), matched (`verified`), or stopped on a fault (`failed`) (R36.12). */
  readonly verification?: 'none' | 'verifying' | 'verified' | 'failed';
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
/** How often the list reloads while a backup is queued or running. */
const BACKUP_REFRESH_MS = 10_000;
const isInProgress = (backup: BackupView): boolean => backup.state === 'queued' || backup.state === 'running';
/** A complete backup whose download is still being built; the list reloads until it is ready. */
const isPreparing = (backup: BackupView): boolean => backup.state === 'complete' && backup.package === 'preparing';
/** A complete backup whose stored copy is still being checked after the fingerprint was submitted; the list reloads until it settles. */
const isVerifying = (backup: BackupView): boolean => backup.state === 'complete' && backup.verification === 'verifying';
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
        {triggerName(record) === undefined ? '' : ` · ${triggerName(record)}`}
        {record.expiresAt === null ? '' : ` · kept until ${whenLabel(record.expiresAt)}`}
      </p>
      {isPreparing(record) && <p className="rf-meta" role="status">Your download is being prepared. This page checks again every few seconds.</p>}
      {record.state === 'complete' && record.package === 'failed' && <p className="rf-meta" role="alert">The download for this backup could not be prepared. Request a new backup to get a download.</p>}
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
            : isVerifying(record)
            ? <p className="rf-meta" role="status">Checking the stored copy. This can take a few minutes for a large backup.</p>
            : (
              <>
                {record.verification === 'failed' && <p className="rf-meta" role="alert">The stored copy could not be checked against this backup, so it does not count as a recovery point yet. Check the fingerprint and confirm again.</p>}
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

/** The operational report an incomplete backup carries: why it stopped and which elements are missing or mismatched (R36.6). */
interface IncompleteReport { readonly reason?: string | null; readonly misses?: readonly { readonly element: string; readonly reason: string }[] }
const incompleteReport = (record: BackupView): IncompleteReport =>
  record.incomplete !== null && typeof record.incomplete === 'object' && !Array.isArray(record.incomplete) ? (record.incomplete as IncompleteReport) : {};

/** A plain sentence for a known operational reason; an unknown reason is shown as recorded. */
function reasonSentence(reason: string): string {
  if (/already holds the write-freeze lease/u.test(reason)) return 'Another backup was already running, so this one did not start.';
  if (/not finished within 24 hours/u.test(reason)) return 'The backup did not finish within 24 hours of starting.';
  if (/privacy deletion removed a pinned file/u.test(reason)) return 'A file was removed for privacy while the backup was copying it.';
  if (/write-freeze lease lost/u.test(reason)) return 'The backup took too long to freeze changes and was stopped.';
  const unexpected = /^unexpected error in the (\w+) step/u.exec(reason);
  if (unexpected !== null) return `The backup stopped on an unexpected error in the ${unexpected[1]} step.`;
  return reason;
}
const MISS_REASONS: Readonly<Record<string, string>> = { missing: 'missing', size: 'size does not match', checksum: 'checksum does not match' };

/** The reason a backup did not finish, or a generic sentence when none was recorded. */
const failureSentence = (record: BackupView): string => {
  const reason = incompleteReport(record).reason;
  return typeof reason === 'string' && reason !== '' ? reasonSentence(reason) : 'This backup could not include every element.';
};

/** Who or what started a backup. */
const triggerName = (record: BackupView): string | undefined => record.trigger === undefined ? undefined : record.trigger === 'scheduled' ? 'Scheduled' : 'Requested';

/** One backup still queued or running: shown as in progress with its start time. */
function InProgressBackupCard({ record }: { readonly record: BackupView }) {
  const trigger = triggerName(record);
  return (
    <section className="rf-section" aria-label={`Backup ${record.id}`}>
      <h3>{`Backup started ${whenLabel(record.startedAt)}`}</h3>
      <p className="rf-meta">
        <span className="rf-status">In progress</span>
        {trigger === undefined ? '' : ` · ${trigger}`}
      </p>
      <p className="rf-meta">This page refreshes every 10 seconds until the backup finishes.</p>
    </section>
  );
}

/** One backup that did not finish: a visible warning with the reason, the missing elements, and how long it is kept. */
function FailedBackupCard({ record }: { readonly record: BackupView }) {
  const trigger = triggerName(record);
  const misses = incompleteReport(record).misses ?? [];
  return (
    <section className="rf-section" aria-label={`Backup ${record.id}`}>
      <h3>{`Backup from ${whenLabel(record.startedAt)}`}</h3>
      <Notice tone="warning" title="This backup did not finish">
        <p>{failureSentence(record)}</p>
        {misses.length > 0 && (
          <ul className="rf-list" aria-label={`Elements not included in backup ${record.id}`}>
            {misses.map((miss, index) => <li key={index}>{`${miss.element}: ${MISS_REASONS[miss.reason] ?? miss.reason}`}</li>)}
          </ul>
        )}
        <p className="rf-meta">
          <span className="rf-status">{backupStateName(record.state)}</span>
          {trigger === undefined ? '' : ` · ${trigger}`}
          {record.expiresAt === null ? '' : ` · kept until ${whenLabel(record.expiresAt)}`}
        </p>
      </Notice>
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

  // While any backup is queued or running, a complete one is still preparing its download, or its stored copy is being checked, reload the list every 10 seconds; the timer is cleared when none is.
  const anyInProgress = backups.data?.backups.some((backup) => isInProgress(backup) || isPreparing(backup) || isVerifying(backup)) ?? false;
  const reloadBackups = backups.reload;
  useEffect(() => {
    if (!anyInProgress) return undefined;
    const timer = setInterval(reloadBackups, BACKUP_REFRESH_MS);
    return () => clearInterval(timer);
  }, [anyInProgress, reloadBackups]);

  // Backups and restores are for Administrators only; the gate matches every backup and restore route (R36.2, R36.8).
  if (!session.can('backup.manage')) return <Notice tone="warning" title="This page does not exist, or you cannot see it." />;
  if (backups.data === undefined || restores.data === undefined) return <LoadState error={backups.error ?? restores.error} />;

  const completeBackups = backups.data.backups.filter((backup) => backup.state === 'complete');
  // Every backup, newest first, so a failed or running one is as visible as a complete one.
  const orderedBackups = [...backups.data.backups].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const newestBackup = orderedBackups[0];
  const recentComplete = completeBackups.some((backup) => Date.now() - Date.parse(backup.finishedAt ?? backup.startedAt) < 24 * 60 * 60 * 1000);
  const newestFailed = newestBackup !== undefined && newestBackup.state !== 'complete' && !isInProgress(newestBackup);
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
      {newestFailed
        ? <Notice tone="warning" title="The most recent backup did not finish"><p>{failureSentence(newestBackup)}</p></Notice>
        : !recentComplete && <Notice tone="warning" title="No backup has finished in the last 24 hours"><p>{newestBackup !== undefined && isInProgress(newestBackup) ? 'A backup is in progress.' : 'Request a backup below, or check that scheduled backups are running.'}</p></Notice>}

      <section className="rf-section" aria-label="Request a backup">
        <h2>Request a backup</h2>
        <p className="rf-meta">Backups are also taken automatically. A backup you request here is kept for seven days.</p>
        <div className="rf-actions"><Button variant="primary" disabled={busy} onClick={() => void requestBackup()}>Request the backup</Button></div>
        {backupRequested && <Notice tone="success" title="The backup was requested. It is listed below as In progress; this page refreshes until it finishes." />}
      </section>

      <section className="rf-section" aria-label="Backups">
        <h2>Backups</h2>
        {backups.data.backups.length === 0 && <p className="rf-meta">There are no backups yet.</p>}
        {orderedBackups.map((record) => record.state === 'complete'
          ? <BackupCard key={record.id} record={record} onConfirm={confirmOffsite} busy={busy} />
          : isInProgress(record) ? <InProgressBackupCard key={record.id} record={record} /> : <FailedBackupCard key={record.id} record={record} />)}
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
