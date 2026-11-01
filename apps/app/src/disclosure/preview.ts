import type { Context } from 'hono';
import { z } from 'zod';
import { GuardedBatch } from '@researchforce/db/batch';
import { jobs } from '@researchforce/db/schema/core';
import { newULID } from '@researchforce/domain/identifiers';
import { LEVELS } from '@researchforce/domain/types';
import type { DisclosureLine, Level, PublicPresentation } from '@researchforce/domain/types';
import type { RichText } from '@researchforce/domain/richtext';
import { richTextSchema } from '@researchforce/domain/schemas/common';
import { MAX_CHANGE_UNITS, previewChange } from '@researchforce/kernel/preview';
import type { ChangeSet, GateFailure, PreviewDiff, UnitChange } from '@researchforce/kernel/preview';
import { unitKey } from '@researchforce/kernel/views';
import type { UnitKey } from '@researchforce/kernel/views';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import { parse } from '../api/input';
import { authorize } from '../auth/authorize';
import { loadProjectionInput } from '../kernel-input';
import { issuePreviewToken } from './token';

export const PUBLIC_PRESENTATIONS = ['summary_only', 'full_content'] as const;
/** Previews above this many units run in a `Jobs` object with progress and paging rather than inline (R23.6). */
export const INLINE_PREVIEW_LIMIT = 300;
/** Changed views per page of a job preview's result. */
export const PREVIEW_PAGE_SIZE = 100;

const keyPattern = /^[up]:[A-Za-z0-9]+$/u;
const unitChangeSchema = z.strictObject({
  key: z.string().regex(keyPattern, 'A unit key is `u:<id>` or `p:<id>`.'),
  level: z.enum(LEVELS).optional(),
  presentation: z.enum(PUBLIC_PRESENTATIONS).optional(),
  publicSummary: richTextSchema().nullable().optional(),
  disclosureLine: z.record(z.string(), z.unknown()).nullable().optional(),
});
const changeSchema = z.strictObject({
  units: z.array(unitChangeSchema).max(MAX_CHANGE_UNITS).optional(),
  moves: z.array(z.strictObject({ itemId: z.string(), projectId: z.string() })).optional(),
  doNotNameOff: z.array(z.string()).optional(),
});
type ChangeInput = z.infer<typeof changeSchema>;

const idOf = (key: UnitKey): string => key.slice(2);

/** The kernel change set from the validated request body; the kernel checks every value's validity in `checkGates`. */
export function changeSet(input: ChangeInput): ChangeSet {
  const units = input.units?.map((entry): UnitChange => ({
    key: entry.key,
    ...(entry.level === undefined ? {} : { level: entry.level as Level }),
    ...(entry.presentation === undefined ? {} : { presentation: entry.presentation as PublicPresentation }),
    ...(entry.publicSummary === undefined ? {} : { publicSummary: entry.publicSummary as RichText | null }),
    ...(entry.disclosureLine === undefined ? {} : { disclosureLine: entry.disclosureLine as DisclosureLine | null }),
  }));
  return {
    ...(units === undefined ? {} : { units }),
    ...(input.moves === undefined ? {} : { moves: input.moves }),
    ...(input.doNotNameOff === undefined ? {} : { doNotNameOff: input.doNotNameOff }),
  };
}

/** The distinct units and Projects a change set names. */
export function changeUnitCount(change: ChangeSet): number {
  return new Set([...(change.units ?? []).map((entry) => entry.key), ...(change.moves ?? []).map((move) => unitKey(move.itemId))]).size;
}

/** The Root_Items the change touches: every unit's and move's Root_Item, with the linked neighbours whose views a change may alter, and the Projects it names. */
export async function rootsOf(c: Context<ApiEnv>, change: ChangeSet): Promise<{ roots: string[]; projectIds: string[] }> {
  const db = c.env.RF_CORE;
  const unitIds = [...new Set([
    ...(change.units ?? []).filter((entry) => entry.key.startsWith('u:')).map((entry) => idOf(entry.key)),
    ...(change.moves ?? []).map((move) => move.itemId),
  ])];
  const projectIds = [...new Set([
    ...(change.units ?? []).filter((entry) => entry.key.startsWith('p:')).map((entry) => idOf(entry.key)),
    ...(change.moves ?? []).map((move) => move.projectId),
  ])];
  if (unitIds.length === 0) return { roots: [], projectIds };
  const unitJson = JSON.stringify(unitIds);
  const [rootRows, linkedRows] = await c.get('accountant').track(db.batch([
    db.prepare('SELECT DISTINCT root_id AS rootId FROM units WHERE id IN (SELECT value FROM json_each(?1))').bind(unitJson),
    db.prepare(`SELECT DISTINCT u.root_id AS rootId FROM cross_links l JOIN units u ON u.id IN (l.origin_id, l.target_id)
      WHERE l.removed_at IS NULL AND (l.origin_id IN (SELECT value FROM json_each(?1)) OR l.target_id IN (SELECT value FROM json_each(?1)))`).bind(unitJson),
  ]));
  const roots = [...new Set([
    ...(rootRows as D1Result<{ rootId: string }>).results.map((row) => row.rootId),
    ...(linkedRows as D1Result<{ rootId: string }>).results.map((row) => row.rootId),
  ])];
  return { roots, projectIds };
}

/** An active Confidentiality_Hold covering a Disclosure_Unit the preview touches, shown with the preview (R48.5). */
export interface PreviewHold {
  readonly id: string;
  readonly memberId: string;
  readonly placedAt: string;
  readonly note: string;
}

export interface PreviewResult {
  readonly diff: PreviewDiff;
  readonly failures: readonly GateFailure[];
  readonly token: string | null;
  /** The active Confidentiality_Holds covering any Disclosure_Unit this preview includes (R48.5). */
  readonly holds: readonly PreviewHold[];
  /** Set when the preview runs in a `Jobs` object; the client polls its progress and pages the result. */
  readonly job?: { readonly id: string; readonly units: number };
}

/**
 * `POST /disclosure/preview`: the kernel `diffViews` and `checkGates` of a change to 1 to 1,000 units, a Project's level,
 * a Project move, or turning Do_Not_Name off, with a preview token that is an HMAC over the change set and its dependency
 * rows' `updated_seq` (R23.6, R23.16, R34.9, R39.13, R46.16). A change touching more than a few hundred units runs in a
 * `Jobs` object with progress and paging.
 */
export async function previewDisclosure(c: Context<ApiEnv>, body: unknown): Promise<PreviewResult> {
  await authorize(c, [{ permission: 'disclosure.set' }]);
  const change = changeSet(parse(changeSchema, body));
  const { roots, projectIds } = await rootsOf(c, change);
  const accountant = c.get('accountant');
  const { input, dependencies, consent } = await loadProjectionInput(c.env.RF_CORE, roots, c.get('now'), {
    projectIds, track: accountant.track.bind(accountant), withConsent: true,
  });
  const requesterId = c.get('session').member.id;
  const contentLicence = c.get('contentLicence');

  if (changeUnitCount(change) > INLINE_PREVIEW_LIMIT) {
    const job = await queuePreviewJob(c, change, roots, projectIds);
    return { diff: emptyDiff(), failures: [], token: null, holds: [], job };
  }

  const { diff, failures } = previewChange(change, { input, requesterId, contentLicence, ...(consent ? { consent } : {}) });
  const token = failures.length === 0
    ? await issuePreviewToken({ change, dependencies, requesterId, issuedAt: new Date(c.get('now')).getTime() }, previewSecret(c))
    : null;
  return { diff, failures: [...failures], token, holds: holdsOf(change, consent) };
}

/** The active Confidentiality_Holds covering any Disclosure_Unit the change touches, each listed once (R48.5). */
function holdsOf(change: ChangeSet, consent: { readonly holds: readonly { readonly key: UnitKey; readonly holds: readonly PreviewHold[] }[] } | undefined): PreviewHold[] {
  if (!consent) return [];
  const touched = new Set<string>([...(change.units ?? []).map((entry) => entry.key), ...(change.moves ?? []).map((move) => unitKey(move.itemId))]);
  const seen = new Set<string>();
  const result: PreviewHold[] = [];
  for (const coverage of consent.holds) {
    if (!touched.has(coverage.key)) continue;
    for (const hold of coverage.holds) {
      if (seen.has(hold.id)) continue;
      seen.add(hold.id);
      result.push({ id: hold.id, memberId: hold.memberId, placedAt: hold.placedAt, note: hold.note });
    }
  }
  return result;
}

/** The shared HMAC secret for preview tokens; the same installation secret the Download_Links use. */
export function previewSecret(c: Context<ApiEnv>): string {
  const secret = c.env.DOWNLOAD_HMAC_KEY;
  if (!secret) throw new ApiError('unavailable');
  return secret;
}

const emptyDiff = (): PreviewDiff => ({ changed: [], partyNames: [], dissent: [], licences: [] });

/** The parameters a `preview` job carries: the change set and the roots and Projects to load. */
export interface PreviewJobParams { readonly change: ChangeSet; readonly roots: readonly string[]; readonly projectIds: readonly string[]; readonly requesterId: string }

/** Queue a large preview as a `preview` job; the client polls its progress and pages the changed views. */
async function queuePreviewJob(c: Context<ApiEnv>, change: ChangeSet, roots: readonly string[], projectIds: readonly string[]): Promise<{ id: string; units: number }> {
  const actor = c.get('session').member.id;
  const now = c.get('now');
  const id = newULID(now);
  const params: PreviewJobParams = { change, roots, projectIds, requesterId: actor };
  await new GuardedBatch(c.env.RF_CORE, { id: actor, now })
    .insert(jobs, { id, type: 'preview', state: 'queued', requestedBy: actor, params: params as unknown as Record<string, unknown>, createdAt: now, updatedAt: now })
    .outbox('jobs', `job:${id}`)
    .commit(c.get('accountant'));
  await c.env.JOBS.getByName(id).start(id);
  return { id, units: changeUnitCount(change) };
}

/** The stored result of a finished `preview` job, written to the private bucket under its report key. */
export interface PreviewJobResult { readonly diff: PreviewDiff; readonly failures: readonly GateFailure[]; readonly token: string | null }
export const previewReportKey = (id: string): string => `rf-private/preview/${id}.json`;
