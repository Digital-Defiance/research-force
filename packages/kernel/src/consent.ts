import { fragmentDigest } from '@researchforce/domain/text-fragments';
import type { Level } from '@researchforce/domain/types';
import type { ProjectRecord, ProjectionInput, UnitRecord } from './input';
import { projectDetailed } from './project';
import { canonicalJson } from './views';
import type { PublicView, UnitKey } from './views';

/**
 * The widening test, the approved-snapshot and dependency digests, and the Confidentiality_Hold and
 * Publication_Consent gates (R23.17, R23.20, R23.23, R23.24, R48.2, R48.4).
 *
 * Publication of a Disclosure_Unit's own values is gated on top of the ordinary disclosure rules: a
 * change that would widen a Consenting_Member's Public_View needs that Member's unused, unwithdrawn
 * Publication_Consent for the exact proposed material, and a Confidentiality_Hold covering a unit blocks
 * any widening of it until the hold is lifted or overridden. A consent is bound to a canonical snapshot
 * of the resulting Public_View and a bounded dependency manifest, so a later change to any dependency
 * invalidates it and a new approval is needed. "Narrower output is omission of approved material, not a
 * text substitution": a consent for a wider view still covers a strictly narrower one only by omitting
 * approved fields, never by substituting different text or files.
 *
 * The module is pure: `loadProjectionInput` feeds it the consent rows and Confidentiality_Hold coverage.
 */

/** SHA-256 of a value's canonical JSON; the domain digest sorts object keys, so equal values hash identically. */
const digest = (value: unknown): string => fragmentDigest(value);

/**
 * The input with every unit and Project treated as Public and Full_Content, except the unit whose own
 * widening is being judged, which keeps its own level, presentation, and classification. This is the
 * prospective-public evaluation: a change that makes an ancestor public can widen a descendant, so the
 * widening test runs it in addition to the real-ancestor evaluation (R23.17, design "Widening test").
 */
function prospectivePublic(input: ProjectionInput, exceptId: string): ProjectionInput {
  const projects = input.projects.map((project): ProjectRecord => ({ ...project, level: 'public' }));
  const units = input.units.map((unit): UnitRecord => {
    if (unit.id === exceptId) return unit;
    const lifted = { ...unit, level: 'public' as Level, unclassified: false };
    if (lifted.type === 'research_item') return { ...lifted, item: { ...lifted.item, presentation: 'full_content', restricted: false } };
    return lifted;
  });
  return { ...input, projects, units };
}

/** The unit's own Public_View in one projection, or undefined when the unit leaves no public trace. */
function ownView(input: ProjectionInput, key: UnitKey): PublicView | undefined {
  return projectDetailed(input).views.get(key);
}

const LEVEL_RANK: Readonly<Record<Level, number>> = { not_published: 0, withheld: 1, public: 2 };

/** The unit's own projected Effective_Disclosure and Public_View in one projection. */
function ownState(input: ProjectionInput, key: UnitKey): { readonly level: Level; readonly view: PublicView | undefined } {
  const projected = projectDetailed(input);
  return { level: projected.levels.get(key) ?? 'not_published', view: projected.views.get(key) };
}

/**
 * Whether the unit's own state in `after` presents material its state in `before` did not, under one
 * projection. A higher Effective_Disclosure (Not_Published < Withheld < Public) always widens; a lower
 * one never does; at the same level the views are the same shape, so a view that presents beyond the
 * earlier one widens.
 */
function widensIn(before: ProjectionInput, after: ProjectionInput, key: UnitKey): boolean {
  const a = ownState(before, key);
  const b = ownState(after, key);
  if (LEVEL_RANK[b.level] > LEVEL_RANK[a.level]) return true;
  if (LEVEL_RANK[b.level] < LEVEL_RANK[a.level]) return false;
  return presentsBeyond(a.view, b.view);
}

/**
 * Whether `candidate` presents any material that `approved` does not, treating `approved` as the widest
 * agreed view. A candidate widens beyond the approved view when it holds a field the approved view omits,
 * or a differing value for a field both hold; omitting an approved field never widens. Structural keys
 * (`tag`, `key`, `path`, ids) and the computed `firstPublicOn` are the view's identity rather than
 * presented material, so a difference there alone is not a widening.
 */
const IDENTITY_KEYS: ReadonlySet<string> = new Set(['tag', 'key', 'path', 'download', 'firstPublicOn']);
function presentsBeyond(approved: unknown, candidate: unknown): boolean {
  if (candidate === undefined || candidate === null) return false;
  if (approved === undefined || approved === null) return true;
  if (Array.isArray(candidate)) {
    if (!Array.isArray(approved)) return true;
    // A longer list, or any entry presenting beyond the entry approved at the same position, widens.
    if (candidate.length > approved.length) return true;
    return candidate.some((entry, index) => presentsBeyond(approved[index], entry));
  }
  if (typeof candidate === 'object') {
    if (typeof approved !== 'object' || Array.isArray(approved)) return true;
    const a = approved as Record<string, unknown>;
    const c = candidate as Record<string, unknown>;
    return Object.keys(c).some((key) => !IDENTITY_KEYS.has(key) && presentsBeyond(a[key], c[key]));
  }
  // A primitive: equal values present nothing new; any other value (or a structural change) widens.
  return canonicalJson(approved) !== canonicalJson(candidate);
}

/**
 * Whether the change from `before` to `after` widens the unit's own Public_View: its own values would
 * present material its view did not present before, evaluated both with the real ancestors and with
 * every ancestor treated as Public and Full_Content (R23.17). Narrowing values never widen.
 */
export function widens(before: ProjectionInput, after: ProjectionInput, key: UnitKey): boolean {
  const id = key.slice(2);
  if (widensIn(before, after, key)) return true;
  return widensIn(prospectivePublic(before, id), prospectivePublic(after, id), key);
}

/** The exact values a Publication_Consent is given for, compared character for character (R23.20). */
export interface ConsentValues {
  readonly level: Level;
  readonly presentation?: 'summary_only' | 'full_content';
  readonly publicSummary?: unknown;
  readonly disclosureLine?: unknown;
}

/**
 * The canonical snapshot a consent signs off: the exact resulting Public_View of the unit under its
 * prospective-public ancestors, so the agreed material is independent of ancestor levels that a Project
 * change may later raise. The snapshot digest binds this view; the dependency digest binds the content
 * revisions, file identities, rights, naming, licence, and other projection inputs that determine it.
 */
export interface ApprovedSnapshot {
  readonly key: UnitKey;
  /** The agreed values applied to the unit. */
  readonly values: ConsentValues;
  /** The canonical Public_View the consent was signed against, under prospective-public ancestors. */
  readonly view: PublicView | undefined;
  /** SHA-256 of `view`; empty-view snapshots hash the explicit null. */
  readonly viewHash: string;
  /** SHA-256 of the bounded dependency manifest. */
  readonly dependencyHash: string;
}

/** One dependency the resulting Public_View is bound to: a content revision, a file identity, or a projection input (R23.23). */
export interface SnapshotDependency {
  readonly table: string;
  readonly id: string;
  readonly updatedSeq: number;
}

/** SHA-256 of the canonical Public_View the consent signs off (R23.23). */
export function viewDigest(view: PublicView | undefined): string {
  return digest(view ?? null);
}

/**
 * SHA-256 of the bounded dependency manifest: the ordered content revisions, file identities, rights,
 * naming, licence records, and other projection inputs that determine the resulting Public_View, so a
 * change to any of them invalidates the consent (R23.23, R23.24). Order is canonical, so equal manifests
 * hash identically whatever order the caller collected the rows in.
 */
export function dependencyDigest(dependencies: readonly SnapshotDependency[]): string {
  const sorted = [...dependencies].sort((a, b) => (a.table < b.table ? -1 : a.table > b.table ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return digest(sorted.map((entry) => [entry.table, entry.id, entry.updatedSeq]));
}

/**
 * The canonical approved snapshot for a unit under the proposed values. The proposed input is the result
 * of applying the change; the unit's own view is read under prospective-public ancestors, so the agreed
 * material is exactly the unit's own contribution, and the dependency manifest binds the rows that
 * produced it (R23.23, R23.24).
 */
export function approvedSnapshot(proposed: ProjectionInput, key: UnitKey, values: ConsentValues, dependencies: readonly SnapshotDependency[]): ApprovedSnapshot {
  const id = key.slice(2);
  const view = ownView(prospectivePublic(proposed, id), key);
  return { key, values, view, viewHash: viewDigest(view), dependencyHash: dependencyDigest(dependencies) };
}

/** A Publication_Consent as the gates read it: the exact agreed values and the snapshot it was bound to (R23.17 to R23.24). */
export interface ConsentRow {
  readonly id: string;
  /** The Disclosure_Unit the consent is for; its Consenting_Member is `memberId`. */
  readonly unitKey: UnitKey;
  readonly memberId: string;
  readonly values: ConsentValues;
  /** SHA-256 of the approved Public_View the consent signed. */
  readonly viewHash: string;
  /**
   * The canonical approved Public_View, when it is on hand (the apply reads it from `approval_snapshots`).
   * It lets a consent for a wider view cover a strictly narrower output by omission; without it, only an
   * exact view-hash match is covered (R23.24).
   */
  readonly approvedView?: PublicView;
  /** SHA-256 of the approved dependency manifest. */
  readonly dependencyHash: string;
  /** Set when the Member withdrew the consent before it was used; a withdrawn consent covers nothing. */
  readonly withdrawn: boolean;
  /** Set when a save applied the consent; a used consent covers nothing further. */
  readonly used: boolean;
}

const RANK: Readonly<Record<Level, number>> = { not_published: 0, withheld: 1, public: 2 };
/** A value is narrower when it lowers the level, drops to Summary_Only, or omits a Public_Summary or Disclosure_Line (R23.20). */
function withinConsent(consented: ConsentValues, applied: ConsentValues): boolean {
  if (RANK[applied.level] > RANK[consented.level]) return false;
  if (applied.presentation === 'full_content' && consented.presentation !== 'full_content') return false;
  // A Public_Summary or Disclosure_Line must equal the consented text character for character, or be omitted (R23.20).
  if (applied.publicSummary !== undefined && canonicalJson(applied.publicSummary) !== canonicalJson(consented.publicSummary)) return false;
  if (applied.disclosureLine !== undefined && canonicalJson(applied.disclosureLine) !== canonicalJson(consented.disclosureLine)) return false;
  return true;
}

/**
 * Whether a live consent covers an exact change (R23.20, R23.23, R23.24). The consent must be for the
 * same unit, be neither withdrawn nor used, apply the consented values or narrower ones, and have been
 * signed against the exact resulting snapshot and dependency manifest. A narrower output is covered only
 * by omitting approved material, never by presenting a value the approved view did not; a changed
 * dependency changes `dependencyHash` and leaves the change uncovered.
 */
export function consentCovers(row: ConsentRow, snapshot: ApprovedSnapshot): boolean {
  if (row.unitKey !== snapshot.key || row.withdrawn || row.used) return false;
  if (!withinConsent(row.values, snapshot.values)) return false;
  if (row.dependencyHash !== snapshot.dependencyHash) return false;
  // The resulting view must be the approved view, or a strict omission of it: nothing new or substituted.
  if (row.viewHash === snapshot.viewHash) return true;
  // A narrower output is covered only when it presents nothing the approved view did not (omission, not substitution).
  if (row.approvedView !== undefined) return !presentsBeyond(row.approvedView, snapshot.view);
  return false;
}

/**
 * The exact coverage of a widening by the consents on hand for the unit's Consenting_Member (R23.17,
 * R23.20). A widening is covered only when some live consent covers the resulting snapshot; otherwise it
 * is uncovered and the whole change is refused, with the Consenting_Member named so the caller can offer
 * a Publication_Proposal. A narrower snapshot still requires a consent whose approved view the narrower
 * output only omits from.
 */
export function coverWidening(rows: readonly ConsentRow[], snapshot: ApprovedSnapshot, narrower: readonly ApprovedSnapshot[] = []):
  { readonly covered: true; readonly consentId: string } | { readonly covered: false; readonly consideredIds: readonly string[] } {
  const aboutUnit = rows.filter((row) => row.unitKey === snapshot.key);
  const candidates = [snapshot, ...narrower];
  for (const row of aboutUnit) {
    if (candidates.some((candidate) => consentCovers(row, candidate))) return { covered: true, consentId: row.id };
  }
  return { covered: false, consideredIds: aboutUnit.map((row) => row.id) };
}

/**
 * A Confidentiality_Hold covering an Item's whole subtree (R48.2). Coverage is computed by
 * `loadProjectionInput` from `units.root_id` and `parent_id`: the gate is given, for each covered unit
 * key, the holds that cover it and are neither lifted nor overridden.
 */
export interface HoldCoverage {
  /** The covered unit key. */
  readonly key: UnitKey;
  /** The active holds covering it: their id, placing Member, time, and note, for the refusal (R48.4, R48.5). */
  readonly holds: readonly HoldRef[];
}
export interface HoldRef { readonly id: string; readonly memberId: string; readonly placedAt: string; readonly note: string }

/**
 * The apply-side recheck a widening apply runs against the current rows, inside the guarded batch, before
 * any writes (design "Consents"; R23.23, R23.24, R48.4). It rechecks the snapshot dependencies' current
 * `updated_seq`, that the named consent is unused and unwithdrawn, that it still covers the resulting
 * material, and that no active Confidentiality_Hold covers the unit. Owner approval of change A followed
 * by an Administrator edit to field B of the same unit fails here even with an identical summary and
 * level, because the edit changes a dependency's `updated_seq`, so the current dependency manifest digest
 * no longer matches the one the consent was signed against.
 *
 * The acting Member's own edits to already-public work are not a widening of a Consenting_Member's view,
 * so `widens` returns false and the apply never reaches this recheck: the separate policy of R23.13 holds.
 */
export interface ConsentRecheck {
  /** The unit being widened. */
  readonly key: UnitKey;
  /** The consent the apply intends to spend, as named by the preview. */
  readonly consent: ConsentRow;
  /** The approved snapshot recomputed from the current input and current dependency manifest. */
  readonly current: ApprovedSnapshot;
  /** The active Confidentiality_Holds covering the unit now (R48.4). */
  readonly holds: readonly HoldRef[];
  /** The dependency rows' current `updated_seq`, and the versions the consent was signed against. */
  readonly expectedDependencyHash: string;
}

/** Why a widening apply is refused at recheck, mapping to the `consent_valid` or `hold_free` guard (R23.23, R23.24, R48.4). */
export type RecheckRefusal = 'held' | 'spent' | 'stale' | 'uncovered';

/**
 * Whether a widening apply may proceed against the current rows, or the reason it is refused. A hold
 * covering the unit refuses it (`held`); a withdrawn or used consent refuses it (`spent`); a dependency
 * change since approval refuses it (`stale`); and a consent that no longer covers the resulting material
 * refuses it (`uncovered`). An empty result means the apply may write.
 */
export function recheckWidening(recheck: ConsentRecheck): RecheckRefusal | undefined {
  if (recheck.holds.length > 0) return 'held';
  if (recheck.consent.withdrawn || recheck.consent.used) return 'spent';
  if (recheck.consent.dependencyHash !== recheck.expectedDependencyHash || recheck.current.dependencyHash !== recheck.expectedDependencyHash) return 'stale';
  if (!consentCovers(recheck.consent, recheck.current)) return 'uncovered';
  return undefined;
}

