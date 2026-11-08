import { PUBLISHER_SLICE_BUDGET } from '@researchforce/domain/slice-budget';
import type { Timestamp } from '@researchforce/domain/types';
import type { PlannedFile } from './plan';
import { renderPlanned, upsertManifestRows } from './render';
import type { PlannedRender, RenderDeps } from './render';
import type { SliceMeter } from './slice-budget';

/**
 * The most R2 calls the stage step may spend in one slice. The rest of the 300-call budget is left for the upload
 * step's reads of the same objects, so a small site still stages, uploads and finishes in one alarm.
 */
export const STAGE_R2_MAX = 200;

/** What {@link stageSlice} did this call. */
export interface StageResult {
  /** True when this call's window covered every added/changed file: the manifest now equals the produced set (less removals). */
  readonly done: boolean;
  /** Manifest rows written this call (files whose `build/{hash}` object now exists). */
  readonly staged: number;
  /** Added/changed files still waiting for a later slice. */
  readonly remainingFiles: number;
  /** Manifest paths the render no longer produces; the caller persists them, THEN calls {@link deleteManifestRows}. */
  readonly removed: readonly string[];
  /** The produced file count, for the 16,000-file alert. */
  readonly fileCount: number;
}

/** The inputs of one stage call: the render dependencies (already routed through the slice meter by the caller). */
export type StageDeps = RenderDeps;

/**
 * One bounded slice of staging the rendered site (design "Publisher" step 5, sliced). It renders the full file set in
 * memory, diffs it against `site_files`, and takes the next window of added/changed files (sorted by path, de-duplicated
 * by hash, sized by the meter's R2 budget and the 6-connection concurrency). For each window it stores
 * `rf-private/build/{hash}` and ONLY THEN upserts exactly those manifest rows.
 *
 * INVARIANT: a `site_files` row is never written before its `build/{hash}` object exists. If a put fails, rows are
 * written only for the hashes already stored, and the failure is rethrown, so the manifest never lists a file whose
 * bytes are missing. Resume is stateless: the next call re-renders and re-diffs, and the rows already written are no
 * longer in the diff, so there is no cursor to corrupt and an input that changes between slices simply converges.
 */
export async function stageSlice(
  deps: StageDeps,
  meter: SliceMeter,
  now: Timestamp,
  produce: (deps: StageDeps, now: Timestamp) => Promise<PlannedRender> = renderPlanned,
): Promise<StageResult> {
  const { plan, files } = await produce(deps, now);
  const pending = [...plan.added, ...plan.changed].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const maxPuts = Math.max(1, Math.min(STAGE_R2_MAX, meter.remaining('r2')));
  const batchFiles: PlannedFile[] = [];
  const hashes: string[] = [];
  const seen = new Set<string>();
  for (const file of pending) {
    if (!seen.has(file.hash)) {
      if (hashes.length >= maxPuts) break;
      seen.add(file.hash);
      hashes.push(file.hash);
    }
    batchFiles.push(file);
  }

  // Store each distinct hash's bytes (identical bytes share one object), a few at a time.
  const holder = new Map<string, PlannedFile>();
  for (const file of batchFiles) if (!holder.has(file.hash)) holder.set(file.hash, file);
  const stored = new Set<string>();
  let failure: unknown;
  for (let start = 0; start < hashes.length && failure === undefined; start += PUBLISHER_SLICE_BUDGET.r2Concurrency) {
    const batch = hashes.slice(start, start + PUBLISHER_SLICE_BUDGET.r2Concurrency);
    const settled = await Promise.allSettled(batch.map((hash) => {
      const held = files.get(holder.get(hash)!.path)!;
      return deps.privateBucket.put(`build/${hash}`, held.file.content, { httpMetadata: { contentType: held.file.contentType } });
    }));
    settled.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled') stored.add(batch[index]!);
      else failure ??= outcome.reason;
    });
  }

  // Manifest rows only for files whose object now exists.
  const writable = batchFiles.filter((file) => stored.has(file.hash));
  await upsertManifestRows(deps.public, writable, now);
  if (failure !== undefined) throw failure;

  return {
    done: batchFiles.length === pending.length,
    staged: writable.length,
    remainingFiles: pending.length - batchFiles.length,
    removed: plan.removed,
    fileCount: plan.all.length,
  };
}
