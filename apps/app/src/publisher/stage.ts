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

/** One rendered file waiting for its `build/{hash}` object and manifest row. */
export interface StagedFile extends PlannedFile { readonly contentType: string; readonly content: Uint8Array }

/**
 * Where one deploy generation's render is kept between slices (the Publisher's own SQLite in production), so the site
 * is rendered ONCE per generation and later slices only read the next window of it.
 */
export interface StagingStore {
  /** Persist the added/changed files of this generation's render. */
  save(files: readonly StagedFile[]): void;
  /** The files still waiting, ordered by path (lazily: a caller may stop early). */
  pending(): Iterable<PlannedFile>;
  /** The bytes and content type staged for `hash`. */
  content(hash: string): { readonly content: Uint8Array; readonly contentType: string } | undefined;
  /** Forget files whose object and manifest row are now written. */
  stored(paths: readonly string[]): void;
  /** How many files are still waiting. */
  count(): number;
}

/** The inputs of one stage call: the render dependencies (already routed through the slice meter by the caller). */
export type StageDeps = RenderDeps;

/** What {@link renderToStaging} kept. */
export interface RenderedStage {
  /** Manifest paths the render no longer produces; the caller persists them, THEN (once staged) deletes their rows. */
  readonly removed: readonly string[];
  /** The produced file count, for the 16,000-file alert. */
  readonly fileCount: number;
  /** Added/changed files now waiting in the store. */
  readonly pending: number;
}

/**
 * Render the full site once for this deploy generation (design "Publisher" step 5), diff it against `site_files`, and
 * keep only the added/changed files in `store`. Later slices call {@link stageWindow} and never re-render.
 */
export async function renderToStaging(
  deps: StageDeps, now: Timestamp, store: StagingStore,
  produce: (deps: StageDeps, now: Timestamp) => Promise<PlannedRender> = renderPlanned,
): Promise<RenderedStage> {
  const { plan, files } = await produce(deps, now);
  const pending = [...plan.added, ...plan.changed].map((entry): StagedFile => {
    const held = files.get(entry.path)!;
    return { ...entry, contentType: held.file.contentType, content: held.file.content };
  });
  store.save(pending);
  return { removed: plan.removed, fileCount: plan.all.length, pending: pending.length };
}

/** What {@link stageWindow} did this call. */
export interface StageResult {
  /** True when no staged file is left: the manifest now equals the produced set (less removals). */
  readonly done: boolean;
  /** Manifest rows written this call (files whose `build/{hash}` object now exists). */
  readonly staged: number;
  /** Staged files still waiting for a later slice. */
  readonly remainingFiles: number;
}

/**
 * One bounded slice of staging: take the next window of staged files (sorted by path, de-duplicated by hash, sized by
 * the meter's R2 budget and the 6-connection concurrency), store `rf-private/build/{hash}` and ONLY THEN upsert exactly
 * those manifest rows, then drop them from the store.
 *
 * INVARIANT: a `site_files` row is never written before its `build/{hash}` object exists. If a put fails, rows are
 * written only for the hashes already stored, and the failure is rethrown; the rest stay in the store for the next slice.
 */
export async function stageWindow(
  deps: Pick<StageDeps, 'public' | 'privateBucket'>, meter: SliceMeter, now: Timestamp, store: StagingStore,
): Promise<StageResult> {
  const maxPuts = Math.max(1, Math.min(STAGE_R2_MAX, meter.remaining('r2')));
  const batchFiles: PlannedFile[] = [];
  const hashes: string[] = [];
  const seen = new Set<string>();
  for (const file of store.pending()) {
    if (!seen.has(file.hash)) {
      if (hashes.length >= maxPuts) break;
      seen.add(file.hash);
      hashes.push(file.hash);
    }
    batchFiles.push({ path: file.path, hash: file.hash, size: file.size });
  }
  // Store each distinct hash's bytes (identical bytes share one object), a few at a time.
  const stored = new Set<string>();
  let failure: unknown;
  for (let start = 0; start < hashes.length && failure === undefined; start += PUBLISHER_SLICE_BUDGET.r2Concurrency) {
    const batch = hashes.slice(start, start + PUBLISHER_SLICE_BUDGET.r2Concurrency);
    const settled = await Promise.allSettled(batch.map((hash) => {
      const held = store.content(hash);
      if (!held) return Promise.reject(new Error(`Staged bytes missing for ${hash}.`));
      return deps.privateBucket.put(`build/${hash}`, held.content, { httpMetadata: { contentType: held.contentType } });
    }));
    settled.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled') stored.add(batch[index]!);
      else failure ??= outcome.reason;
    });
  }
  // Manifest rows only for files whose object now exists; then they leave the store.
  const writable = batchFiles.filter((file) => stored.has(file.hash));
  await upsertManifestRows(deps.public, writable, now);
  store.stored(writable.map((file) => file.path));
  if (failure !== undefined) throw failure;
  const remainingFiles = store.count();
  return { done: remainingFiles === 0, staged: writable.length, remainingFiles };
}

/** An in-memory {@link StagingStore}, for callers (and tests) that hold the render in one invocation. */
export function memoryStagingStore(): StagingStore {
  const files = new Map<string, StagedFile>();
  return {
    save: (staged) => { for (const file of staged) files.set(file.path, file); },
    pending: () => [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    content: (hash) => [...files.values()].find((file) => file.hash === hash),
    stored: (paths) => { for (const path of paths) files.delete(path); },
    count: () => files.size,
  };
}
