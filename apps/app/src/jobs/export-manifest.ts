import type { ExportFile, ManifestEntry } from '@researchforce/public-render/export/manifest';
import { OPERATIONS } from '@researchforce/domain/settings';

/**
 * Pure helpers of the Public_Archive_Export job (task 38.2), kept apart from R2/D1 so each is unit-testable: the
 * manifest completeness check (R35.6, R35.7), the group of package files into volume manifests (R35.9), the choice of
 * the 3 most recent complete scheduled exports to keep (R35.6), the retention cut of requested exports (R35.11), and
 * the label computation over a package's unit index against the current state (R35.10, R46.34, R22.8, R42.18).
 */

/** One file verified in the package: its manifest path and the size and SHA-256 the job read back from the stored object. */
export interface VerifiedFile { readonly path: string; readonly bytes: number; readonly sha256: string }

/** A file the manifest lists that the package is missing, or whose stored size or checksum does not match the manifest (R35.7). */
export interface ManifestMiss { readonly path: string; readonly reason: 'missing' | 'size' | 'checksum' }

/**
 * Compare every Export_Manifest entry with what the package actually holds (R35.6, R35.7). A package is complete only
 * when every entry has a non-null size and checksum in the manifest AND a stored file of the same size and checksum;
 * any entry with a null size/checksum, no stored file, or a size or checksum mismatch is a miss. The returned list
 * names each missing or mismatched file, in manifest order, for `exports.incomplete`.
 */
export function manifestMisses(entries: readonly ManifestEntry[], stored: ReadonlyMap<string, VerifiedFile>): ManifestMiss[] {
  const misses: ManifestMiss[] = [];
  for (const entry of entries) {
    const file = stored.get(entry.path);
    if (entry.bytes === null || entry.sha256 === null || file === undefined) { misses.push({ path: entry.path, reason: 'missing' }); continue; }
    if (file.bytes !== entry.bytes) { misses.push({ path: entry.path, reason: 'size' }); continue; }
    if (file.sha256.toLowerCase() !== entry.sha256.toLowerCase()) misses.push({ path: entry.path, reason: 'checksum' });
  }
  return misses;
}

/** One file registered in a volume manifest: its R2 bucket key (no `rf-private/` prefix) and the POSIX name it takes in the tar. */
export interface VolumeMember { readonly key: string; readonly name: string; readonly size?: number }
/**
 * One volume manifest object rf-dl assembles into a tar: at most `exportObjectsPerVolume` members (R35.9). An
 * Internal_Backup volume also records each member's `size` once the pack job has measured it, and `tar` once the pack
 * job has pre-built the whole volume as one object that rf-dl serves directly (R36.2).
 */
export interface VolumeManifest { readonly members: readonly VolumeMember[]; readonly tar?: { readonly key: string; readonly bytes: number } }

/**
 * Group every package file into volume manifests of at most `OPERATIONS.exportObjectsPerVolume` (900) members, so each
 * rf-dl download invocation stays within its per-invocation call budget (R35.9). `bucketKey` maps a package path to the
 * object's bucket key (dropping `rf-private/`); `name` is the package-relative path the tar carries. The order of the
 * files is preserved, split into consecutive volumes.
 */
export function volumeManifests(paths: readonly string[], bucketKey: (path: string) => string): VolumeManifest[] {
  const limit = OPERATIONS.exportObjectsPerVolume;
  const volumes: VolumeManifest[] = [];
  for (let start = 0; start < paths.length; start += limit) {
    volumes.push({ members: paths.slice(start, start + limit).map((path) => ({ key: bucketKey(path), name: path })) });
  }
  return volumes;
}

/** One scheduled export considered for retention: its id, whether it is complete, and its start time (R35.6). */
export interface ScheduledExport { readonly id: string; readonly state: string; readonly startedAt: string }

/**
 * Of the scheduled exports, the ids to delete so the Object_Store keeps only the 3 most recent COMPLETE scheduled ones
 * (R35.6): every scheduled export that is not among the 3 newest complete ones, which includes every incomplete or
 * running scheduled export once 3 newer complete ones exist, and every scheduled export older than the 3rd newest
 * complete. Newest is by `startedAt` descending. An export still building (not complete) is kept until 3 complete ones
 * are newer than it, so an in-progress monthly run is never deleted before it finishes.
 */
export function scheduledToDelete(exports: readonly ScheduledExport[]): string[] {
  const complete = exports.filter((e) => e.state === 'complete').sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  const keepComplete = new Set(complete.slice(0, 3).map((e) => e.id));
  const oldestKeptStart = complete.length >= 3 ? complete[2]!.startedAt : null;
  return exports
    .filter((e) => !keepComplete.has(e.id) && (oldestKeptStart !== null && e.startedAt < oldestKeptStart))
    .map((e) => e.id);
}

/** Whether a requested export's 7-day retention has elapsed at `now`, measured from its `startedAt` (R35.11). */
export function requestedExpired(startedAt: string, now: string, lifetimeMs = 7 * 24 * 60 * 60 * 1000): boolean {
  return new Date(now).getTime() - new Date(startedAt).getTime() >= lifetimeMs;
}

/**
 * A package's stored unit index (R35.10, R46.34): for each unit the export holds, its key and the level it was exported
 * as; the External_Parties it names by their id; and the email-like strings it contains. The label computation reads it
 * against the current state and never reads the package files.
 */
export interface UnitIndex {
  /** Each exported unit with the Effective_Disclosure it was exported as (R35.2). */
  readonly units: readonly { readonly key: string; readonly level: 'public' | 'withheld' }[];
  /** The External_Party ids the package names (R35.10). */
  readonly parties: readonly string[];
  /** The email-like strings the package's text holds, lower-cased, so a now-registered Member address is found (R46.9, R46.34). */
  readonly emails: readonly string[];
}

/** The current state the label computation compares a package's index against (R35.10, R46.34). */
export interface CurrentState {
  /** The current Effective_Disclosure of each unit key, or `absent` when the unit is Not_Published or gone. */
  readonly level: (key: string) => 'public' | 'withheld' | 'absent';
  /** Whether an External_Party id is now marked Do_Not_Name. */
  readonly doNotName: (partyId: string) => boolean;
  /** Whether a lower-cased email-like string is a registered Member address (R46.9). */
  readonly registeredEmail: (email: string) => boolean;
}

/** Why a package is labelled as holding material that is no longer public, with the affected element named (R35.10, R46.34). */
export type LabelReason =
  | { readonly kind: 'unit_withdrawn'; readonly key: string }   // exported Public, now Withheld
  | { readonly kind: 'unit_removed'; readonly key: string }     // exported Public or Withheld, now Not_Published or gone
  | { readonly kind: 'party_do_not_name'; readonly partyId: string }
  | { readonly kind: 'member_email'; readonly email: string };

/**
 * Compute the labels for one package from its unit index against the current state (R35.10, R46.34): a unit exported as
 * Public whose Effective_Disclosure is now Withheld or absent, a unit exported as Withheld now absent, an External_Party
 * now marked Do_Not_Name, or a now-registered Member address the package holds. An empty result means the package holds
 * nothing that is no longer public. Pure: all current state is read through `CurrentState`.
 */
export function labelsFor(index: UnitIndex, current: CurrentState): LabelReason[] {
  const labels: LabelReason[] = [];
  for (const unit of index.units) {
    const now = current.level(unit.key);
    if (unit.level === 'public' && now === 'withheld') labels.push({ kind: 'unit_withdrawn', key: unit.key });
    else if (now === 'absent') labels.push({ kind: 'unit_removed', key: unit.key });
  }
  for (const partyId of index.parties) if (current.doNotName(partyId)) labels.push({ kind: 'party_do_not_name', partyId });
  for (const email of index.emails) if (current.registeredEmail(email)) labels.push({ kind: 'member_email', email });
  return labels;
}

/** The manifest/CSV `ExportFile`s re-exported for the job, so the job's module needs one import of the pure types. */
export type { ExportFile };
