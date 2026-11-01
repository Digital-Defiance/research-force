import type { Env } from '../env';
import { bucketKeyOf, exportPrefix, unitIndexKey } from '../jobs/export';
import { labelsFor } from '../jobs/export-manifest';
import type { CurrentState, LabelReason, UnitIndex } from '../jobs/export-manifest';

/**
 * The records-layer reads and actions over held Public_Archive_Exports (task 38.2, R35.10, R46.34, R22.8, R42.18):
 * loading a package's stored unit index, computing its labels against the current state, listing the packages that
 * contain the elements a permanent deletion removes, and deleting a package's R2 objects and row. Kept apart from the
 * route so the HTTP layer stays thin and these reads are testable against a D1+R2 harness.
 */

/** One stored export, as the list and the labelling read it. */
export interface ExportRecord {
  readonly id: string;
  readonly scopeProjectId: string | null;
  readonly scheduled: number;
  readonly requestedBy: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly state: string;
  readonly incomplete: string | null;
  readonly volumes: string[] | null;
  readonly unitIndexKey: string | null;
  readonly expiresAt: string | null;
}

/** Read a package's stored unit index, or null when it was never written (an incomplete or still-running export). */
export async function loadUnitIndex(env: Env, id: string): Promise<UnitIndex | null> {
  const object = await env.RF_PRIVATE_BUCKET.get(bucketKeyOf(unitIndexKey(id)));
  if (object === null) return null;
  try { return JSON.parse(await object.text()) as UnitIndex; } catch { return null; }
}

/**
 * The current state the labelling compares an index against (R35.10, R46.34): the current Effective_Disclosure of each
 * unit key from the open `public_views` rows (`valid_to_at IS NULL`), the External_Parties now marked Do_Not_Name, and
 * the registered Member addresses (every Member's `email_lc`, in any Member_Status, matched case-insensitively). Loaded
 * once for a batch of packages, so a list labels many packages with one read of each table.
 */
export async function currentState(env: Env): Promise<CurrentState> {
  const [viewRows, partyRows, memberRows] = await Promise.all([
    env.RF_PUBLIC.prepare('SELECT unit_key AS unitKey, effective FROM public_views WHERE valid_to_at IS NULL').all<{ unitKey: string; effective: 'public' | 'withheld' }>(),
    env.RF_CORE.prepare('SELECT id FROM external_parties WHERE do_not_name = 1').all<{ id: string }>(),
    env.RF_CORE.prepare('SELECT email_lc AS emailLc FROM members').all<{ emailLc: string }>(),
  ]);
  const levels = new Map(viewRows.results.map((row) => [row.unitKey, row.effective]));
  const doNotName = new Set(partyRows.results.map((row) => row.id));
  const emails = new Set(memberRows.results.map((row) => row.emailLc.toLowerCase()));
  return {
    level: (key) => levels.get(key) ?? 'absent',
    doNotName: (partyId) => doNotName.has(partyId),
    registeredEmail: (email) => emails.has(email.toLowerCase()),
  };
}

/** A package's labels (R35.10, R46.34): empty when the package holds nothing that is no longer public. */
export async function labelsOf(env: Env, id: string, current: CurrentState): Promise<LabelReason[]> {
  const index = await loadUnitIndex(env, id);
  return index === null ? [] : labelsFor(index, current);
}

/**
 * The ids of the held exports whose unit index contains any of the given unit keys (R22.8, R42.18): when an Item or a
 * Dissent_Note is permanently deleted, every Public_Archive_Export that exported one of the removed units is listed so
 * the Administrator can delete it within 24 hours. Reads each package's index; a package with no index (never
 * completed) holds nothing deletable and is skipped.
 */
export async function packagesContaining(env: Env, removedUnitKeys: readonly string[]): Promise<string[]> {
  const removed = new Set(removedUnitKeys);
  const rows = await env.RF_CORE.prepare("SELECT id FROM exports WHERE type = 'public' AND state <> 'deleted' AND unit_index_key IS NOT NULL").all<{ id: string }>();
  const matches: string[] = [];
  for (const row of rows.results) {
    const index = await loadUnitIndex(env, row.id);
    if (index !== null && index.units.some((unit) => removed.has(unit.key))) matches.push(row.id);
  }
  return matches;
}

/**
 * Delete a held Public_Archive_Export from the Object_Store (R35.6, R35.10, R35.11, R22.8, R42.18): remove every object
 * under its package prefix in bounded batches and mark the row `deleted`. Copies held outside R2 are not affected; the
 * route states this to the Administrator. Idempotent: re-running deletes any remaining objects and leaves the row
 * `deleted`.
 */
export async function deleteExport(env: Env, id: string, now: string): Promise<void> {
  const prefix = `${bucketKeyOf(exportPrefix(id))}/`;
  let cursor: string | undefined;
  do {
    const listed = await env.RF_PRIVATE_BUCKET.list({ prefix, ...(cursor ? { cursor } : {}) });
    if (listed.objects.length > 0) await env.RF_PRIVATE_BUCKET.delete(listed.objects.map((object) => object.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
  await env.RF_CORE.prepare("UPDATE exports SET state = 'deleted', finished_at = coalesce(finished_at, ?2), volumes = NULL WHERE id = ?1").bind(id, now).run();
}

/** Every held export, newest first, for the list; scheduled ones and the caller's requested ones are filtered by the route. */
export async function listExports(env: Env): Promise<ExportRecord[]> {
  const rows = await env.RF_CORE.prepare(
    `SELECT id, scope_project_id AS scopeProjectId, scheduled, requested_by AS requestedBy, started_at AS startedAt,
       finished_at AS finishedAt, state, incomplete, volumes, unit_index_key AS unitIndexKey, expires_at AS expiresAt
     FROM exports WHERE type = 'public' AND state <> 'deleted' ORDER BY started_at DESC`,
  ).all<ExportRecord & { incomplete: string | null; volumes: string | null }>();
  return rows.results.map((row) => ({
    ...row,
    incomplete: row.incomplete,
    volumes: row.volumes === null ? null : (JSON.parse(row.volumes) as string[]),
  }));
}
