import { OPERATIONS } from '@researchforce/domain/settings';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import { canonicalJson, projectKey, unitKey } from '@researchforce/kernel/views';
import type { PublicView, UnitKey } from '@researchforce/kernel/views';
import { projectDetailed } from '@researchforce/kernel/project';
import type { Projection } from '@researchforce/kernel/project';
import { readEpoch } from '@researchforce/db/publication-epoch';
import { fence, shouldPreempt } from '@researchforce/db/publication-epoch';
import type { Generation } from '@researchforce/db/publication-epoch';
import { loadProjectionInput } from '../kernel-input';
import type { OutboxRow } from '../outbox';

/**
 * The Publisher's projection step (task 32.2, design "Publisher" steps 1 to 3). It drains the `publish`
 * outbox, expands each dirty scope to the Root_Items whose Public_Views it can change, projects those roots
 * with the kernel, and writes versioned `public_views` rows in `rf-public`: a changed view opens a new
 * version and closes the prior current one; a unit that is now Not_Published has its current version closed
 * with no new row (R24.1, R24.2, R24.5). Logical fields are read through the bounded Field_Version readers
 * the loader uses (task 57), and each slice stays within `OPERATIONS.projectionSliceBytes` of logical text.
 *
 * Every run carries a durable generation (its id and the publication epoch it observed when it began). An
 * urgent invalidation — a removal or edit of already-public material — advances the epoch, so an older
 * addition generation is preempted at its next bounded slice and every projection write is fenced: a stale
 * generation may never resurrect suppressed output (R24.16, R24.17). While an Internal_Backup restore holds
 * rf-core frozen, the Publisher processes nothing, so restored material stays quarantined until the
 * suppression and public-launch preflight pass (R36.16, R59.3).
 */

export interface ProjectionDeps { readonly core: D1Database; readonly public: D1Database }

/** A unit's Effective_Disclosure as the versioned store records it; a Not_Published unit has no current row. */
const EFFECTIVE_LEVELS = ['public', 'withheld'] as const;
type Effective = typeof EFFECTIVE_LEVELS[number];
const isEffective = (level: string): level is Effective => level === 'public' || level === 'withheld';

/** SHA-256 of the canonical Public_View, matching the digest the consent snapshot and disclosure records use. */
async function viewHash(view: PublicView): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(view));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * True while an Internal_Backup holds a LIVE write-freeze lease over rf-core; the Publisher skips every change until
 * the lease lapses or is released (R36.16, R36.14, R59.3). A lease that expired, was released, or overran its window
 * is not live, so the Publisher resumes the moment writers do. Read against `now` so the same instant the predicate
 * blocks saves also pauses projection.
 */
export async function isFrozen(core: D1Database, now?: Timestamp): Promise<boolean> {
  const at = now ?? (new Date().toISOString() as Timestamp);
  const row = await core.prepare(
    "SELECT 1 AS live FROM write_freeze_leases WHERE only = 1 AND state = 'held' AND ?1 < expires_at AND ?1 < deadline_at",
  ).bind(at).first<{ live: number }>();
  if (row !== null) return true;
  // A restore keeps its restored material QUARANTINED until an operator explicitly releases containment: while any
  // restore is running, quarantined, or incomplete, the Publisher must project nothing so no restored Disclosure_Unit
  // reaches the Public_Site before release (R36.9, R36.16; task 38.5 `restoreQuarantineActive`). A `released` or
  // `failed` restore no longer holds the quarantine, so the Publisher resumes.
  const quarantined = await core.prepare(
    "SELECT 1 AS n FROM restores WHERE state IN ('running', 'quarantined', 'incomplete') LIMIT 1",
  ).first<{ n: number }>();
  return quarantined !== null;
}

/** The project a scope names, or the whole-site/policy scopes that carry no projectable root. */
function parseScope(scope: string): { readonly kind: string; readonly rest: string } {
  const colon = scope.indexOf(':');
  return colon < 0 ? { kind: scope, rest: '' } : { kind: scope.slice(0, colon), rest: scope.slice(colon + 1) };
}

/** The affected Root_Items and the Projects whose own Project view must be reprojected, from a slice of `publish` rows. */
export interface DirtyScope { readonly roots: ReadonlySet<ULID>; readonly projects: ReadonlySet<ULID> }

/**
 * Expand the dirty scopes of a slice to the set of Root_Items (and Projects) whose Public_Views they can
 * change (design "Publisher" step 1, the scope→root table):
 * - `root:<id>` is a Root_Item directly; `unit:<id>` resolves to the unit's Root_Item.
 * - `project:<id>` reprojects the Project's own view and every Root_Item in it (a Project level change moves
 *   every unit under it).
 * - `member:<id>` / `party:<id>` / `value:<g>:<k>` reproject every Root_Item whose views name that Member,
 *   External_Party, or configurable value (a credited name, a party label, a Rights_Status or status).
 * - `policy:<page>` and `site` drive page rendering (task 32.3), not Public_View rows, so they add no root.
 */
export async function expandScopesToRoots(core: D1Database, rows: readonly OutboxRow[]): Promise<DirtyScope> {
  const roots = new Set<ULID>();
  const projects = new Set<ULID>();
  const unitIds = new Set<string>();
  const projectIds = new Set<string>();
  const memberIds = new Set<string>();
  const partyIds = new Set<string>();
  const valueIds = new Set<string>();
  for (const row of rows) {
    const { kind, rest } = parseScope(row.scope);
    if (kind === 'root') roots.add(rest as ULID);
    else if (kind === 'unit') unitIds.add(rest);
    else if (kind === 'project') projectIds.add(rest);
    else if (kind === 'member') memberIds.add(rest);
    else if (kind === 'party') partyIds.add(rest);
    else if (kind === 'value') valueIds.add(rest.slice(rest.indexOf(':') + 1)); // value:<group>:<key> → the config value id
    // 'policy' and 'site' scopes carry no projectable root; they drive rendering in task 32.3.
  }

  const addRoots = async (query: string, ids: ReadonlySet<string>): Promise<void> => {
    if (ids.size === 0) return;
    const result = await core.prepare(query).bind(JSON.stringify([...ids])).all<{ id: ULID }>();
    for (const r of result.results) roots.add(r.id);
  };
  // A unit's Root_Item, whether it still exists or was deleted (its root is kept in `deletions`).
  await addRoots(
    `SELECT root_id AS id FROM units WHERE id IN (SELECT value FROM json_each(?1))
      UNION SELECT root_id AS id FROM deletions WHERE unit_id IN (SELECT value FROM json_each(?1))`,
    unitIds,
  );
  // Every Root_Item of a Project whose level changed; the Project view itself is reprojected too.
  for (const id of projectIds) projects.add(id as ULID);
  await addRoots('SELECT DISTINCT root_id AS id FROM units WHERE project_id IN (SELECT value FROM json_each(?1))', projectIds);
  // Root_Items whose views can name a changed Member: a credit entry, a related Member, or a Dissent_Note author.
  await addRoots(
    `SELECT DISTINCT u.root_id AS id FROM units u WHERE EXISTS (SELECT 1 FROM json_each(u.credit) c WHERE c.value ->> '$.member' IN (SELECT value FROM json_each(?1)))
      UNION SELECT DISTINCT unit_id AS id FROM research_items WHERE unit_id IN (SELECT unit_id FROM dissent_notes WHERE author_id IN (SELECT value FROM json_each(?1)))
      UNION SELECT DISTINCT u.root_id AS id FROM je_members j JOIN units u ON u.id = j.unit_id WHERE j.member_id IN (SELECT value FROM json_each(?1))`,
    memberIds,
  );
  // Root_Items whose views can name a changed External_Party: a Correspondence party, a Source recoverer, or an Archival_Request archive/contact.
  await addRoots(
    `SELECT DISTINCT u.root_id AS id FROM correspondence_parties cp JOIN units u ON u.id = cp.unit_id WHERE cp.party_kind = 'external' AND cp.party_id IN (SELECT value FROM json_each(?1))
      UNION SELECT DISTINCT u.root_id AS id FROM sources s JOIN units u ON u.id = s.unit_id WHERE s.recoverer_kind = 'external' AND s.recoverer_id IN (SELECT value FROM json_each(?1))
      UNION SELECT DISTINCT u.root_id AS id FROM archival_requests a JOIN units u ON u.id = a.unit_id WHERE (a.archive_kind = 'external' AND a.archive_id IN (SELECT value FROM json_each(?1))) OR (a.contact_kind = 'external' AND a.contact_id IN (SELECT value FROM json_each(?1)))`,
    partyIds,
  );
  // Root_Items whose views can name a changed configurable value: a Rights_Status, a status/outcome/reliability, or a Cross_Link relation.
  await addRoots(
    `SELECT DISTINCT unit_id AS id FROM research_items WHERE status_value_id IN (SELECT value FROM json_each(?1))
      UNION SELECT DISTINCT u.root_id AS id FROM sources s JOIN units u ON u.id = s.unit_id WHERE s.reliability_id IN (SELECT value FROM json_each(?1)) OR s.rights_status_id IN (SELECT value FROM json_each(?1))
      UNION SELECT DISTINCT u.root_id AS id FROM runs r JOIN units u ON u.id = r.unit_id WHERE r.outcome_id IN (SELECT value FROM json_each(?1))
      UNION SELECT DISTINCT u.root_id AS id FROM attachments a JOIN units u ON u.id = a.unit_id WHERE a.rights_status_id IN (SELECT value FROM json_each(?1))`,
    valueIds,
  );

  // Cross_Link neighbour expansion (design "Publisher", R24.8, R50.5): a Cross_Link renders the other end's title
  // and status on each end's page, so a change under one end's Root_Item must reproject the neighbour's Root_Item.
  // This is what makes a change to a Research_Question entry's target (an Addresses Cross_Link) re-render the question
  // page. Every unit under a dirty root, plus any named unit, is an end; the roots of their link partners join the set.
  const seed = JSON.stringify([...roots, ...unitIds]);
  const neighbours = await core.prepare(
    `WITH ends(uid) AS (
       SELECT id FROM units WHERE root_id IN (SELECT value FROM json_each(?1))
       UNION SELECT value FROM json_each(?1)
     )
     SELECT DISTINCT u.root_id AS id FROM cross_links l JOIN units u
       ON u.id = CASE WHEN l.origin_id IN (SELECT uid FROM ends) THEN l.target_id ELSE l.origin_id END
       WHERE l.removed_at IS NULL AND (l.origin_id IN (SELECT uid FROM ends) OR l.target_id IN (SELECT uid FROM ends))`,
  ).bind(seed).all<{ id: ULID }>();
  for (const r of neighbours.results) roots.add(r.id);

  return { roots, projects };
}

/** The current `public_views` row for every unit under a Root_Item (or a Project), used to diff against the new projection. */
interface CurrentRow { readonly unitKey: UnitKey; readonly rootKey: UnitKey; readonly effective: Effective; readonly viewHash: string }

/** The current rows of every given root, in one query, grouped by `root_key` (each root sees exactly its own rows). */
async function currentViewsByRoot(pub: D1Database, rootKeys: readonly UnitKey[]): Promise<Map<UnitKey, Map<UnitKey, CurrentRow>>> {
  const byRoot = new Map<UnitKey, Map<UnitKey, CurrentRow>>();
  if (rootKeys.length === 0) return byRoot;
  const result = await pub.prepare(
    `SELECT unit_key AS unitKey, root_key AS rootKey, effective, view_hash AS viewHash FROM public_views
      WHERE valid_to_at IS NULL AND root_key IN (SELECT value FROM json_each(?1))`,
  ).bind(JSON.stringify([...new Set(rootKeys)])).all<CurrentRow>();
  for (const row of result.results) (byRoot.get(row.rootKey) ?? byRoot.set(row.rootKey, new Map()).get(row.rootKey)!).set(row.unitKey, row);
  return byRoot;
}

/** What one Root_Item's projection changed, and whether that change is urgent (it removed or edited public material). */
export interface RootResult {
  /** Statements that close the prior current versions and insert the new ones, run as one `rf-public` batch. */
  readonly statements: readonly D1PreparedStatement[];
  /** True when any existing Public_View changed or disappeared (an urgent invalidation), per design "Classify urgency". */
  readonly urgent: boolean;
}

/**
 * Project one Root_Item and compute the `public_views` writes that bring the versioned store in step with it.
 * `validFrom` is the change sequence the run processed to (`seqTo`); a new version closes the prior current
 * one in the same batch. A unit that drops to Not_Published has its current version closed and gets no new
 * row. A view whose hash is unchanged is left alone.
 */
async function projectRoot(
  deps: ProjectionDeps,
  rootKey: UnitKey,
  projection: Projection,
  ownership: Ownership,
  members: ReadonlySet<UnitKey>,
  seqTo: number,
  now: Timestamp,
  current: ReadonlyMap<UnitKey, CurrentRow>,
): Promise<RootResult> {
  const statements: D1PreparedStatement[] = [];
  const close = (key: UnitKey): void => {
    statements.push(deps.public.prepare('UPDATE public_views SET valid_to_at = ?2 WHERE unit_key = ?1 AND valid_to_at IS NULL').bind(key, now));
  };
  let urgent = false;

  for (const key of members) {
    const level = projection.levels.get(key) ?? 'not_published';
    const was = current.get(key);
    if (!isEffective(level)) {
      // Now Not_Published: close the current version, write no new row. Losing a public/withheld view is urgent.
      if (was) { close(key); urgent = true; }
      continue;
    }
    const view = projection.views.get(key)!;
    const hash = await viewHash(view);
    if (was && was.viewHash === hash && was.effective === level) continue; // unchanged: write nothing
    if (was) { close(key); urgent = true; } // an existing view changed: urgent
    const owner = ownership.get(key)!;
    statements.push(deps.public.prepare(
      `INSERT INTO public_views (unit_key, valid_from, valid_from_at, valid_to_at, effective, project_id, root_key, path, view_json, view_hash)
        VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7, ?8, ?9)`,
    ).bind(key, seqTo, now, level, owner.projectId, rootKey, pathOf(view), canonicalJson(view), hash));
  }
  return { statements, urgent };
}

/** The Public_URL path a view carries, when it has its own page; Entry_Sections, Replies, and Dissent_Notes have none. */
function pathOf(view: PublicView): string | null {
  return 'path' in view && typeof view.path === 'string' ? view.path : null;
}

/** The Project and Root_Item each projected unit belongs to, so each `public_views` row carries its `project_id` and `root_key`. */
type Ownership = ReadonlyMap<UnitKey, { readonly projectId: ULID; readonly rootKey: UnitKey }>;

interface OwnerRow { readonly id: ULID; readonly rootId: ULID; readonly projectId: ULID }

/** The unit keys a Root_Item (or Project) owns, grouped by `root_key`, so one projection's writes split per root. */
async function ownershipOf(core: D1Database, roots: ReadonlySet<ULID>, projects: ReadonlySet<ULID>): Promise<{ ownership: Ownership; byRoot: Map<UnitKey, Set<UnitKey>> }> {
  const ownership = new Map<UnitKey, { projectId: ULID; rootKey: UnitKey }>();
  const byRoot = new Map<UnitKey, Set<UnitKey>>();
  const add = (key: UnitKey, projectId: ULID, rootKey: UnitKey): void => {
    ownership.set(key, { projectId, rootKey });
    (byRoot.get(rootKey) ?? byRoot.set(rootKey, new Set()).get(rootKey)!).add(key);
  };
  if (roots.size > 0) {
    const result = await core.prepare(
      'SELECT id, root_id AS rootId, project_id AS projectId FROM units WHERE root_id IN (SELECT value FROM json_each(?1))',
    ).bind(JSON.stringify([...roots])).all<OwnerRow>();
    for (const row of result.results) add(unitKey(row.id), row.projectId, unitKey(row.rootId));
  }
  for (const id of projects) add(projectKey(id), id as ULID, projectKey(id));
  return { ownership, byRoot };
}

/** The outcome of one bounded projection slice. */
export interface SliceResult {
  /** Whether more `publish` rows remain after this slice (another slice should run). */
  readonly more: boolean;
  /** Rows the slice projected and marked done, so the caller can advance the run cursor. */
  readonly processed: number;
  /** The highest change sequence this slice processed (the versions it wrote are valid from here). */
  readonly seqTo: number;
  /** True when any existing Public_View changed or disappeared in this slice (an urgent invalidation). */
  readonly urgent: boolean;
  /** Set when an advanced epoch preempted this run before any further addition work (R24.16). */
  readonly preempted: boolean;
}

/** The logical text a loaded root contributes, to keep each slice within `OPERATIONS.projectionSliceBytes`. */
function rootBytes(viewsJson: string): number { return new TextEncoder().encode(viewsJson).length; }

/**
 * Run one bounded projection slice for the given generation. Reads the oldest pending `publish` rows, expands
 * their scopes to Root_Items, and projects each root until the accumulated logical text approaches the slice
 * byte budget, writing the versioned `public_views` changes. At the slice boundary the authoritative epoch is
 * re-read: a confidentiality-affecting save that advanced it preempts this older addition run (shouldPreempt),
 * and every write is fenced so a stale generation cannot resurrect a suppressed view (R24.16, R24.17).
 *
 * The run is skipped entirely while rf-core is frozen for an Internal_Backup restore (R36.16, R59.3); the
 * `publish` rows stay pending until the restore clears and the Publisher is kicked again.
 */
export async function runProjectionSlice(deps: ProjectionDeps, run: Generation, now: Timestamp): Promise<SliceResult> {
  if (await isFrozen(deps.core, now)) return { more: false, processed: 0, seqTo: 0, urgent: false, preempted: false };

  const authoritative = await readEpoch(deps.core);
  // A removal step is always authorized, so suppression proceeds; addition/promotion are fenced by a newer epoch.
  if (shouldPreempt(run, authoritative)) return { more: false, processed: 0, seqTo: 0, urgent: false, preempted: true };

  const rows = await readPublishSlice(deps.core, OPERATIONS.jobSliceRows);
  if (rows.length === 0) return { more: false, processed: 0, seqTo: 0, urgent: false, preempted: false };

  const { roots, projects } = await expandScopesToRoots(deps.core, rows);
  const { ownership, byRoot } = await ownershipOf(deps.core, roots, projects);
  const seqTo = rows.reduce((max, row) => Math.max(max, row.changeSeq), 0);

  // Project the affected roots together (one loader pass sees Cross_Link neighbours and shared Projects),
  // then split the writes per Root_Item so each slice stays bounded.
  const rootIds = [...roots];
  const projectIds = [...projects];
  let urgent = false;
  const statements: D1PreparedStatement[] = [];
  let bytes = 0;

  if (rootIds.length > 0 || projectIds.length > 0) {
    const { input } = await loadProjectionInput(deps.core, rootIds, now, { projectIds });
    const projection = projectDetailed(input);
    // The current versions of every affected root, read in ONE query (not one per root), so a slice's D1 round trips
    // stay constant however many roots it covers (Workers Free plan: 50 queries per invocation).
    const current = await currentViewsByRoot(deps.public, [...byRoot.keys()]);
    for (const [rootKey, members] of byRoot) {
      // Fence each root's projection: an addition under a stale epoch is refused so suppressed output is never rewritten.
      const authorized = fence(run, authoritative, 'addition').authorized || fence(run, authoritative, 'removal').authorized;
      if (!authorized) break;
      const result = await projectRoot(deps, rootKey, projection, ownership, members, seqTo, now, current.get(rootKey) ?? new Map());
      urgent = urgent || result.urgent;
      statements.push(...result.statements);
      bytes += rootBytes(canonicalJson([...members].flatMap((key) => projection.views.get(key) ?? [])));
      if (bytes >= OPERATIONS.projectionSliceBytes) break;
    }
  }

  if (statements.length > 0) await deps.public.batch(statements);
  const marked = await markPublishDone(deps.core, rows.map((row) => row.seq), now);
  const more = rows.length === OPERATIONS.jobSliceRows;
  return { more, processed: marked, seqTo, urgent, preempted: false };
}

/** The oldest pending `publish` rows, oldest first (the Publisher processes changes in sequence order). */
async function readPublishSlice(core: D1Database, limit: number): Promise<OutboxRow[]> {
  const result = await core.prepare(
    "SELECT seq, scope, change_seq AS changeSeq, created_at AS createdAt FROM outbox WHERE topic = 'publish' AND done_at IS NULL ORDER BY seq LIMIT ?1",
  ).bind(limit).all<OutboxRow>();
  return result.results;
}

async function markPublishDone(core: D1Database, seqs: readonly number[], now: Timestamp): Promise<number> {
  if (seqs.length === 0) return 0;
  const result = await core.prepare(
    "UPDATE outbox SET done_at = ?1 WHERE topic = 'publish' AND done_at IS NULL AND seq IN (SELECT value FROM json_each(?2))",
  ).bind(now, JSON.stringify(seqs)).run();
  return result.meta.changes;
}
