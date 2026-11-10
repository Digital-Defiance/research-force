import { DurableObject } from 'cloudflare:workers';
import { newULID } from '@researchforce/domain/identifiers';
import type { OutboxTopic } from '@researchforce/db/accountant';
import type { Timestamp } from '@researchforce/domain/types';
import { fence, readEpoch } from '@researchforce/db/publication-epoch';
import type { Generation } from '@researchforce/db/publication-epoch';
import { GuardedBatch } from '@researchforce/db/batch';
import { notifySystemAlert } from '../notifications/fanout';
import type { Env } from '../env';
import { createLogger } from '../log';
import { isFrozen, runProjectionSlice } from '../publisher/projection';
import type { ProjectionDeps } from '../publisher/projection';
import { deleteManifestRows, headersFile, raiseFileCountAlert, renderPlanned } from '../publisher/render';
import { readOutbox } from '../outbox';
import type { PlannedRender } from '../publisher/render';
import { loadShellAssets } from '../publisher/shell-assets';
import type { FormsConfig } from '@researchforce/public-render/site';
import { publicCopyOf } from '../publisher/public-copy';
import { runFileOpsSlice } from '../publisher/files';
import { reachesFileAlert } from '../publisher/plan';
import { renderToStaging, stageWindow } from '../publisher/stage';
import type { StageDeps, StagingStore } from '../publisher/stage';
import { SliceMeter } from '../publisher/slice-budget';
import {
  siteViewCeiling, PROBES_PER_SLICE, PROBE_BATCH_MAX, SITE_VIEW_ALERT_SHARE, UPLOAD_SESSION_MAX_MS,
} from '@researchforce/domain/slice-budget';
import type { OpsSpendAlert } from '@researchforce/domain/ops';
import { canServerSideCopy } from '../files/s3';
import {
  CONTAIN_AT_MS,
  EVALUATE_EVERY_MS,
  VERIFY_BY_MS,
  beginDeploy,
  currentPublicAttachments,
  deployFinish,
  deployWhen,
  elapsedSince,
  escalateAfterProbes,
  fileOpsFor,
  liveFileCopies,
  probeWindow,
  reconcileUncertainDeploy,
  removedProbeUrls,
  shouldEvaluate,
  sqlDeletionRetryState,
  uploadChunk,
} from '../publisher/deploy';
import type { DeployManifest, DeployOps, DeployRunResult, ProbeResult, PublicOrigins } from '../publisher/deploy';

/** The SQL default for the run's starting phase column (a template literal, not user-facing copy). */
const PROJECT_PHASE_DEFAULT = `'project'`;

/**
 * The Publisher Durable Object (one instance named `publisher`). It owns the projection step of the
 * publication path (task 32.2, design "Publisher" steps 1 to 3): on `kick('publish')` or an alarm it starts
 * or continues a run that drains the `publish` outbox, projects the dirty Root_Items, and writes versioned
 * `public_views` rows in `rf-public`, in bounded slices resumed by the alarm (mirroring the Jobs object).
 *
 * A run has a durable generation — its id and the publication epoch it observed when it began — kept in this
 * object's own SQLite so a `rf-public` or `rf-core` failure never loses it. The generation and observed epoch
 * are recorded on the `publish_runs` row. Each slice re-reads the authoritative epoch: an urgent invalidation
 * that advanced it preempts the older addition run at the slice boundary, and every projection write is fenced
 * so a stale generation cannot resurrect suppressed output (R24.16, R24.17). While an Internal_Backup restore
 * holds rf-core frozen, the Publisher processes nothing and leaves the rows pending (R36.16, R59.3).
 *
 * Planning and rendering (task 32.3), public file copies (32.4), and deploy and verification (32.5) consume
 * the run and the versioned Public_Views this step produces.
 */
export class Publisher extends DurableObject<Env> {
  readonly #log = createLogger();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The current run's durable generation and its phase through the publication pipeline. A single row:
    // `phase` is 'project' (draining the outbox), 'deploy' (batching + deploying), or 'verify' (escalating an
    // urgent removal). `started_ms`/`last_change_ms` drive the urgency batching; `verify_start_ms` anchors the
    // four-/five-minute escalation deadlines; `containment` tracks whether edge Containment is in force so a
    // stale retry never clears it (task 32.5).
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS publish_run (
      only INTEGER PRIMARY KEY CHECK (only = 1), run_id TEXT NOT NULL, epoch INTEGER NOT NULL,
      seq_to INTEGER NOT NULL DEFAULT 0, urgent INTEGER NOT NULL DEFAULT 0,
      phase TEXT NOT NULL DEFAULT 'project', started_ms INTEGER NOT NULL DEFAULT 0,
      last_change_ms INTEGER NOT NULL DEFAULT 0, verify_start_ms INTEGER NOT NULL DEFAULT 0,
      containment INTEGER NOT NULL DEFAULT 0, progress_ms INTEGER NOT NULL DEFAULT 0,
      deploy_json TEXT NOT NULL DEFAULT '{}')`);
    // Older instances created the table before these columns existed; add them if missing (no rf-public change).
    const columns = [
      `phase TEXT NOT NULL DEFAULT ${PROJECT_PHASE_DEFAULT}`,
      'started_ms INTEGER NOT NULL DEFAULT 0', 'last_change_ms INTEGER NOT NULL DEFAULT 0',
      'verify_start_ms INTEGER NOT NULL DEFAULT 0', 'containment INTEGER NOT NULL DEFAULT 0',
      'progress_ms INTEGER NOT NULL DEFAULT 0', `deploy_json TEXT NOT NULL DEFAULT '{}'`,
    ];
    for (const column of columns) {
      try { ctx.storage.sql.exec(`ALTER TABLE publish_run ADD COLUMN ${column}`); } catch { /* already present */ }
    }
    // The sliced deploy's companion tables: the platform's missing-hash buckets for the open upload session, and the
    // public addresses this run removed (pages by path, files by Item_Identifier) that the verify phase must probe.
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS deploy_buckets (idx INTEGER PRIMARY KEY, hashes TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS deploy_removed (kind TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (kind, value))');
    // The verify phase's probe results for the pass in progress (url -> present/absent/unknown); cleared when a pass restarts.
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS verify_probes (url TEXT PRIMARY KEY, status TEXT NOT NULL)');
    // The deploy generation's render, kept between slices so the site is rendered once per generation: the added and
    // changed files whose build object and manifest row are not written yet (a row leaves once both are).
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS deploy_staged (path TEXT PRIMARY KEY, hash TEXT NOT NULL, size INTEGER NOT NULL, content_type TEXT NOT NULL, content BLOB NOT NULL)');
    // The Free-plan site-size alerts already sent (one row per level and channel), so each is raised once.
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS site_size_alerts (key TEXT PRIMARY KEY)');
    // The durable pending-public-file-deletion retry set (task 32.4's DeletionRetryState, backed here, R25.3).
    this.#retry = sqlDeletionRetryState(ctx.storage.sql);
  }

  readonly #retry: ReturnType<typeof sqlDeletionRetryState>;

  /**
   * A test-only override of the `rf-ops` surface. Production always resolves OPS through {@link #ops} to
   * `this.env.OPS` (the service binding); the local workers test harness binds OPS as a bare 503 Fetcher with
   * no RPC methods, so a DO/integration test injects a fake here through {@link setOpsForTest} to drive the
   * deploy and verify phases end-to-end. It is never set in production and so is fully transparent there.
   */
  #opsOverride: DeployOps | undefined;

  /** Inject a fake `rf-ops` surface for a DO/integration test (see {@link #opsOverride}); no production effect. */
  setOpsForTest(ops: DeployOps): void { this.#opsOverride = ops; }

  /** A test-only replacement for the stage step's render (a synthetic file set); never set in production. */
  #renderOverride: ((deps: StageDeps, now: Timestamp) => Promise<PlannedRender>) | undefined;

  /** Inject a synthetic render for a DO/integration test (see {@link #renderOverride}); no production effect. */
  setRenderForTest(render: ((deps: StageDeps, now: Timestamp) => Promise<PlannedRender>) | undefined): void { this.#renderOverride = render; }

  /** The meter of the slice in progress; its wrappers count the deploy and verify I/O. */
  #meter: SliceMeter | undefined;

  /** The `rf-ops` surface the deploy/verify phases call: the service binding, or a test-injected fake. */
  #ops(): DeployOps { return this.#opsOverride ?? this.env.OPS; }

  /** The topic owner's kick: start or continue the projection run draining the `publish` outbox. */
  async kick(topic: OutboxTopic = 'publish'): Promise<void> {
    if (topic !== 'publish') return;
    // A frozen rf-core (restore in progress) is left untouched; no run opens until it clears, so restored
    // material stays quarantined. A later kick or the one-minute cron retries once unfrozen (R36.16, R59.3).
    if (await isFrozen(this.env.RF_CORE)) return;
    // Open a run only for queued work. The one-minute cron kicks every owner; without this check every kick opened a
    // fresh run and redeployed the unchanged site each minute (about 170 R2 calls per deploy, past the free tier).
    // An existing run is always advanced (and recovered when stale), so a pending removal is never dropped.
    if (this.#load() === null && (await readOutbox(this.env.RF_CORE, 'publish', 1)).length === 0) return;
    await this.#ensureRun();
    await this.#recoverStale();
    await this.#wake(Date.now());
  }

  /**
   * Open a run and re-render the whole site even when nothing is queued: the explicit restore release, whose restored
   * rows enqueue no `publish` outbox rows by design (backup/derived.ts), so a plain {@link kick} would do nothing.
   */
  async republish(): Promise<void> {
    if (await isFrozen(this.env.RF_CORE)) return;
    await this.#ensureRun();
    await this.#recoverStale();
    await this.#wake(Date.now());
  }

  /** Read-only: whether a run is open, its phase, and when it started. Writes nothing. */
  status(): { running: boolean; phase: RunPhase | null; startedAt: Timestamp | null } {
    const run = this.#load();
    return run === null
      ? { running: false, phase: null, startedAt: null }
      : { running: true, phase: run.phase, startedAt: new Date(run.startedMs).toISOString() as Timestamp };
  }
  /**
   * Un-wedge a run that has made no progress for {@link STALE_RUN_MS}. Root cause of the staging wedge: a slice
   * that throws (deploy/render/ops failure) is retried by the platform a limited number of times and then its
   * alarm is dropped, leaving a durable `publish_run` row that nothing advances, while a kick only ever
   * re-used that row. Policy per phase, chosen so nothing safety-relevant is dropped:
   *  - project, or a non-urgent deploy: REPLACE in place with a fresh run at the current epoch. The outbox rows
   *    are only marked done after a successful projection, so the new run re-reads them; urgency and edge
   *    Containment carry over (a reset can never clear them). The old `publish_runs` row is closed with no
   *    `verified_at`, so success is never claimed for it.
   *  - urgent deploy, or verify: RESUME (never abandon). The removal must still be deployed and verified, and
   *    the verify clock keeps running so the 4-/5-minute contain/verify-Containment/incident escalation fires.
   */
  async #recoverStale(): Promise<void> {
    const run = this.#load();
    if (!run) return;
    const nowMs = Date.now();
    if (nowMs - Math.max(run.progressMs, run.startedMs, run.lastChangeMs) < STALE_RUN_MS) return;
    if (run.phase === 'verify' || (run.phase === 'deploy' && run.urgent)) {
      this.#log('warn', 'publish_run_stale_resumed', { run: run.run, phase: run.phase });
      this.ctx.storage.sql.exec('UPDATE publish_run SET progress_ms = ? WHERE only = 1', nowMs);
      return;
    }
    this.#log('warn', 'publish_run_stale_replaced', { run: run.run, phase: run.phase });
    const now = new Date(nowMs).toISOString() as Timestamp;
    const epoch = await readEpoch(this.env.RF_CORE);
    const runId = newULID(now);
    await this.env.RF_PUBLIC.prepare(
      'UPDATE publish_runs SET finished_at = ?2, seq_to = ?3, urgent = ?4 WHERE id = ?1 AND finished_at IS NULL',
    ).bind(run.run, now, run.seqTo || null, run.urgent ? 1 : 0).run();
    await this.env.RF_PUBLIC.prepare(
      'INSERT INTO publish_runs (id, started_at, urgent) VALUES (?1, ?2, ?3) ON CONFLICT (id) DO NOTHING',
    ).bind(runId, now, run.urgent ? 1 : 0).run();
    this.ctx.storage.sql.exec(
      "UPDATE publish_run SET run_id = ?, epoch = ?, seq_to = 0, phase = 'project', started_ms = ?, last_change_ms = ?, verify_start_ms = 0, progress_ms = ? WHERE only = 1",
      runId, epoch, nowMs, nowMs, nowMs,
    );
    this.#resetDeployState();
  }

  override async alarm(): Promise<void> {
    await this.#runSlice();
  }

  /** Start a run if none is active, stamping the epoch it observes now and recording its `publish_runs` row. */
  async #ensureRun(): Promise<Generation> {
    const existing = this.#load();
    if (existing) return existing;
    const now = new Date().toISOString() as Timestamp;
    const nowMs = Date.now();
    const epoch = await readEpoch(this.env.RF_CORE);
    const runId = newULID(now);
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO publish_run (only, run_id, epoch, seq_to, urgent, phase, started_ms, last_change_ms, verify_start_ms, containment) VALUES (1, ?, ?, 0, 0, 'project', ?, ?, 0, ?)",
      runId, epoch, nowMs, nowMs, this.#containmentActive() ? 1 : 0,
    );
    // The run record in rf-public carries the lease/generation and the observed epoch (schema `publish_runs`).
    await this.env.RF_PUBLIC.prepare(
      'INSERT INTO publish_runs (id, started_at, urgent) VALUES (?1, ?2, 0) ON CONFLICT (id) DO NOTHING',
    ).bind(runId, now).run();
    return { run: runId, epoch };
  }

  /** One bounded step of the current run, dispatched by its phase (project → deploy → verify → finish). */
  async #runSlice(): Promise<void> {
    const run = this.#load();
    if (!run) return;
    // A restore in progress holds rf-core frozen: do nothing and leave the run where it is until it clears, so
    // restored/held material stays quarantined (R36.16, R59.3). A later kick or the cron resumes it.
    // One meter per slice: every deploy/verify call below goes through it (see SliceMeter).
    const meter = new SliceMeter();
    this.#meter = meter;
    if (await isFrozen(meter.core(this.env.RF_CORE))) { await this.#wake(Date.now() + 60_000); return; }
    try {
      if (run.phase === 'project') await this.#projectSlice(run);
      else if (run.phase === 'deploy') await this.#deployPhase(run, meter);
      else await this.#verifyPhase(run, meter);
    } catch (error) {
      // Content-free: the run id and phase only. Rethrow so the platform retries the alarm; if it gives up,
      // the next kick recovers the stale run (see #recoverStale) rather than leaving it wedged.
      this.#log('error', 'publish_phase_failed', { run: run.run, phase: run.phase, error });
      throw error;
    } finally {
      // A unit that overshot its slice budget (a mis-estimated STEP_NEEDS or window) is reported, content-free.
      const over = meter.overBudget();
      if (over.length > 0) this.#log('warn', 'publish_slice_over_budget', { run: run.run, phase: run.phase, over, used: meter.used() });
    }
    // The slice completed without throwing: that is progress (a no-op when the run just finished).
    this.ctx.storage.sql.exec('UPDATE publish_run SET progress_ms = ? WHERE only = 1', Date.now());
  }

  /** Projection phase: drain the `publish` outbox in bounded slices; on completion, move to the deploy phase. */
  async #projectSlice(run: RunState): Promise<void> {
    const now = new Date().toISOString() as Timestamp;
    const deps: ProjectionDeps = { core: this.env.RF_CORE, public: this.env.RF_PUBLIC };
    let result;
    try {
      result = await runProjectionSlice(deps, run, now);
    } catch (error) {
      this.#log('error', 'publish_slice_failed', { run: run.run, error });
      throw error; // let the platform retry the alarm
    }

    if (result.seqTo > 0 || result.urgent) {
      // A new change folded in resets the 30-second addition-quiet window (task 32.5 urgency batching).
      this.#update({ seqTo: Math.max(run.seqTo, result.seqTo), urgent: run.urgent || result.urgent, lastChangeMs: Date.now() });
    }

    if (result.preempted) {
      // A newer epoch superseded this run; finish it so the urgent generation's run supersedes it (R24.16).
      await this.#finish(run, now);
      await this.#wake(Date.now()); // open a fresh run at the current epoch for the remaining rows
      return;
    }
    if (result.more) {
      await this.ctx.storage.setAlarm(Date.now());
      return;
    }
    // Projection drained: enter the deploy phase and let the urgency batching decide when to deploy.
    this.#update({ phase: 'deploy' });
    this.#resetDeployState();
    await this.#wake(Date.now());
  }

  /**
   * Deploy phase (task 32.5, design "Publisher" step 6), sliced to the Workers Free plan. The pure {@link deployWhen}
   * decides when: an urgent run deploys at once; an addition-only run waits 30 s quiet / 5 min max. When it is time,
   * the phase is a persisted step machine, run in order within one alarm until the slice budget is spent and then
   * resumed by an immediate re-arm: `stage` (render, store build objects, write manifest rows) -> `files` (public-file
   * deletions, then copies) -> `begin` (register the manifest with rf-ops) -> `upload` (the platform's missing files,
   * chunk by chunk) -> `finish` (promote once, under the epoch fence). Every slice re-reads the authoritative epoch
   * BEFORE any side effect: a fenced-out (stale) generation deploys nothing. After an urgent deploy the run moves to
   * the verify phase; an addition deploy that promoted finishes with verified success (R24.11).
   */
  async #deployPhase(run: RunState, meter: SliceMeter): Promise<void> {
    const nowMs = Date.now();
    const when = deployWhen(
      { urgent: run.urgent, projectionComplete: true, startedAtMs: run.startedMs, lastChangeAtMs: run.lastChangeMs },
      nowMs,
    );
    if (!when.deploy) { await this.#wake(when.waitUntilMs); return; }

    const now = new Date().toISOString() as Timestamp;
    const io = this.#io(meter);
    let progress = this.#loadDeploy();

    // The epoch fence, before any side effect of this slice (R24.16, R24.17, R30.7).
    const authoritative = await readEpoch(io.core);
    if (!fence(run, authoritative, 'promotion').authorized) {
      await this.#deployFenced(run, now);
      return;
    }

    let first = true;
    for (;;) {
      // The first unit of a slice always runs (progress is guaranteed); later ones only while the budget allows.
      if (!first && !meter.canSpend(STEP_NEEDS[progress.step])) { await this.#wake(Date.now()); return; }
      first = false;

      switch (progress.step) {
        case 'stage': {
          if (!progress.rendered) {
            // The Free-plan site-size ceiling, BEFORE rendering: one render holds the whole site in memory.
            if (await this.#overSiteCeiling(run, io, meter, now)) {
              await this.#refuseOverCeiling(run, now);
              return;
            }
            // Render ONCE for this generation; later slices read the staged files and never re-render.
            const deps: StageDeps = {
              core: io.core, public: io.pub, privateBucket: io.priv, licence: this.#licence(), publicCopy: this.#publicCopy(),
              ...this.#forms(), shellAssets: await loadShellAssets(meter.assets(this.env.ASSETS)),
            };
            const rendered = await renderToStaging(deps, now, this.#staging, this.#renderOverride);
            // Record the removed pages BEFORE their manifest rows go, so verify can still probe them (R24.16).
            for (const path of rendered.removed) this.ctx.storage.sql.exec("INSERT OR IGNORE INTO deploy_removed (kind, value) VALUES ('page', ?)", path);
            progress = this.#saveDeploy({ ...progress, rendered: true, fileCount: rendered.fileCount });
          }
          const staged = await stageWindow({ public: io.pub, privateBucket: io.priv }, meter, now, this.#staging);
          if (!staged.done) { await this.#wake(Date.now()); return; }
          const removed = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM deploy_removed WHERE kind = 'page'").toArray().map((row) => row.value);
          await deleteManifestRows(io.pub, removed);
          if (reachesFileAlert(progress.fileCount)) await raiseFileCountAlert(io.core, progress.fileCount, now);
          progress = this.#saveDeploy({ ...progress, step: 'files' });
          continue;
        }

        case 'files': {
          // Copies/deletions derived from the current Public attachment views vs. the live copies: deletions first,
          // copies before the deploy links them (R24.3/R25.3). Failed deletions stay in the retry set.
          const publicAttachments = await currentPublicAttachments(io.core, io.pub);
          const live = await liveFileCopies(io.pubBucket);
          const viaS3 = canServerSideCopy(this.env) && Boolean(this.env.PUBLIC_BUCKET_NAME);
          const r2Pairs = Math.max(1, Math.floor(meter.remaining('r2') / 2));
          const result = await runFileOpsSlice(
            io.env, fileOpsFor(publicAttachments, live), this.#retry,
            { deletion: progress.deletionCursor, copy: progress.copyCursor },
            { deletions: r2Pairs, copies: viaS3 ? Math.max(1, meter.remaining('external')) : r2Pairs, chargeExternal: (n) => meter.charge('external', n) },
          );
          for (const id of result.deleted) this.ctx.storage.sql.exec("INSERT OR IGNORE INTO deploy_removed (kind, value) VALUES ('file', ?)", id);
          const finished = result.deletionsDone && result.copiesDone;
          progress = this.#saveDeploy({
            ...progress, step: finished ? 'begin' : 'files', deletionCursor: result.cursors.deletion, copyCursor: result.cursors.copy,
          });
          if (!finished) { await this.#wake(Date.now()); return; }
          continue;
        }

        case 'begin': {
          const { begin } = await beginDeploy(io.ops, run, await this.#manifest(io.pub), this.#containmentActive());
          this.ctx.storage.sql.exec('DELETE FROM deploy_buckets');
          if (begin.state === 'settled') {
            await this.#afterFinish(run, now, authoritative, progress, { outcome: begin.result, operationId: begin.result.operationId, deployed: begin.result.promoted, fencedOut: false }, io.ops);
            return;
          }
          if (begin.state === 'ready') {
            progress = this.#saveDeploy({ ...progress, step: 'finish', completionToken: begin.completionToken, uploadToken: '' });
            continue;
          }
          begin.buckets.forEach((hashes, idx) => this.ctx.storage.sql.exec('INSERT INTO deploy_buckets (idx, hashes) VALUES (?, ?)', idx, JSON.stringify(hashes)));
          progress = this.#saveDeploy({ ...progress, step: 'upload', uploadToken: begin.uploadToken, completionToken: '', bucket: 0, offset: 0, sessionStartMs: Date.now() });
          continue;
        }

        case 'upload': {
          // An upload session older than the platform's token lifetime restarts at `begin`.
          if (Date.now() - progress.sessionStartMs > UPLOAD_SESSION_MAX_MS) {
            progress = this.#saveDeploy({ ...progress, step: 'begin', uploadToken: '', completionToken: '', bucket: 0, offset: 0 });
            continue;
          }
          const row = this.ctx.storage.sql.exec<{ hashes: string }>('SELECT hashes FROM deploy_buckets WHERE idx = ?', progress.bucket).toArray()[0];
          if (!row) {
            // Every bucket is uploaded: the platform's completion token is what `finish` promotes with. Without one,
            // register again (the platform then reports nothing missing and issues it).
            progress = this.#saveDeploy({ ...progress, step: progress.completionToken === '' ? 'begin' : 'finish' });
            continue;
          }
          const hashes = (JSON.parse(row.hashes) as string[]).slice(progress.offset);
          const chunk = await uploadChunk(io.priv, hashes, meter.remaining('r2'));
          if (chunk.missing.length > 0) {
            // A bounded retry: after MAX_RESTAGES restarts the slice fails instead of looping on the same missing objects.
            if (progress.restages >= MAX_RESTAGES) {
              throw new Error(`Build objects still missing after ${MAX_RESTAGES} re-stages (${chunk.missing.length} hashes).`);
            }
            // A manifest row whose build object is gone: drop the rows so the stage step re-renders and re-stores them.
            await io.pub.prepare('DELETE FROM site_files WHERE hash IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(chunk.missing)).run();
            this.ctx.storage.sql.exec('DELETE FROM deploy_buckets');
            this.ctx.storage.sql.exec('DELETE FROM deploy_staged');
            this.#saveDeploy({ ...DEFAULT_DEPLOY, restages: progress.restages + 1 });
            await this.#wake(Date.now());
            return;
          }
          const uploaded = await io.ops.uploadSiteAssets({ uploadToken: progress.uploadToken, files: chunk.files });
          const offset = progress.offset + chunk.consumed;
          const bucketDone = offset >= (JSON.parse(row.hashes) as string[]).length;
          progress = this.#saveDeploy({
            ...progress,
            completionToken: uploaded.completionToken ?? progress.completionToken,
            bucket: bucketDone ? progress.bucket + 1 : progress.bucket,
            offset: bucketDone ? 0 : offset,
          });
          continue;
        }

        case 'finish': {
          if (progress.uncertain) {
            // An uncertain promotion is never blind-retried: reconcile against the live site, wake again if unresolved.
            await this.#reconcile(run, now, authoritative, progress, io.ops);
            return;
          }
          const result = await deployFinish(io.ops, run, await readEpoch(io.core), progress.completionToken, this.#containmentActive(), headersFile(this.#forms().forms));
          await this.#afterFinish(run, now, authoritative, progress, result, io.ops);
          return;
        }
      }
    }
  }

  /** A stale generation deploys nothing: an urgent run still verifies (contain if unconfirmed), an addition run just ends. */
  async #deployFenced(run: RunState, now: Timestamp): Promise<void> {
    // A stale or refused deploy stands for nothing: do NOT claim success (no verified_at).
    if (!run.urgent) { await this.#finish(run, now); return; }
    this.#clearDeployProgress();
    this.#update({ phase: 'verify', verifyStartMs: run.startedMs });
    await this.#wake(Date.now());
  }

  /** What follows rf-ops' answer to the promotion (or an already-settled operation): the old post-deploy logic, verbatim. */
  async #afterFinish(
    run: RunState, now: Timestamp, authoritative: number, progress: DeployProgress, result: DeployRunResult, ops: DeployOps,
  ): Promise<void> {
    // Keep containment across a stale retry: a reset/retry can never clear active containment (R24.17).
    if (result.outcome.keepContainment) this.#update({ containment: true });

    if (result.outcome.operationState === 'uncertain') {
      const uncertain = this.#saveDeploy({ ...progress, step: 'finish', uncertain: true, versionId: result.outcome.versionId });
      await this.#reconcile(run, now, authoritative, uncertain, ops);
      return;
    }
    if ((result.fencedOut || !result.deployed) && !run.urgent) {
      // A refused deploy stands for nothing: do NOT claim success. An urgent run still proceeds to the
      // verify/escalation path so a suppression that did not promote is contained; an addition run just finishes.
      await this.#finish(run, now);
      return;
    }
    await this.#completeDeploy(run, now, result.outcome.versionId);
  }

  /** Reconcile an uncertain promotion against the live site before anything depends on it (never a blind retry). */
  async #reconcile(run: RunState, now: Timestamp, authoritative: number, progress: DeployProgress, ops: DeployOps): Promise<void> {
    const reconciled = await reconcileUncertainDeploy(ops, run, authoritative, this.#siteOrigins().site, this.#containmentActive());
    if (reconciled.keepContainment) this.#update({ containment: true });
    if (!reconciled.resolved) { await this.#wake(Date.now() + 30_000); return; } // reconcile again; finish is not re-sent
    await this.#completeDeploy(run, now, progress.versionId);
  }

  /** The deploy stood: record its version, then verify an urgent removal or record an addition's verified success. */
  async #completeDeploy(run: RunState, now: Timestamp, versionId: string | null): Promise<void> {
    // Record the deployed version id (recorded even when not promoted, for the reconcile/incident record).
    if (versionId) {
      await this.#pubDb().prepare('UPDATE publish_runs SET version_id = ?2 WHERE id = ?1').bind(run.run, versionId).run();
    }
    if (run.urgent) {
      // An urgent run must verify the removal is actually gone (or contained) before it may claim success.
      this.#clearDeployProgress();
      // The deploy phase persisted every removed address before it deleted the manifest rows: verify uses that record.
      this.#saveVerify({ ...DEFAULT_VERIFY, removedReady: true });
      this.#update({ phase: 'verify', verifyStartMs: run.startedMs });
      await this.#wake(Date.now());
      return;
    }
    // An addition-only run that promoted has nothing to suppress: record verified success and finish (R24.11).
    await this.#pubDb().prepare('UPDATE publish_runs SET verified_at = ?2 WHERE id = ?1').bind(run.run, now).run();
    await this.#finish(run, now);
  }

  /**
   * Verify phase (task 32.5, design "Publisher" step 7), sliced to the Workers Free plan. HEAD each removed page+file
   * address through rf-ops, expecting not-found, and drive the four-/five-minute escalation: at 4 min unverified →
   * contain + alert; by 5 min → verify Containment; if neither removal nor Containment can be confirmed → UNCONFIRMED
   * incident, NEVER success (R24.16, R24.17, R25.7). Only a genuinely safe outcome records `publish_runs.verified_at`.
   *
   * It never re-renders per tick. The removed set is the one the deploy phase persisted in `deploy_removed` (a run that
   * arrives without one, such as a legacy or seeded run, computes it ONCE with a read-only render and stores it). Each
   * slice retries pending public-file deletions, then probes the next window of the set in batches and stores the
   * results in `verify_probes`. The escalation is evaluated when a pass completes OR, from the 4-minute mark on, at
   * least every 15 s even mid-pass, so the deadlines hold however long a pass takes. Removal counts as verified only
   * for a COMPLETE pass with every address absent.
   */
  async #verifyPhase(run: RunState, meter: SliceMeter): Promise<void> {
    const now = new Date().toISOString() as Timestamp;
    const nowMs = Date.now();
    const io = this.#io(meter);
    let state = this.#loadVerify();

    // (1) The removed set: persisted by the deploy phase, or computed once, read-only, for a run without one. A site
    // over the Free-plan ceiling is not rendered: its removal is unconfirmable and goes the Containment path.
    if (!state.removedReady && await this.#overSiteCeiling(run, io, meter, now)) {
      state = this.#saveVerify({ ...state, removedReady: true, unconfirmable: true });
    }
    if (!state.removedReady) {
      const render = await (this.#renderOverride ?? renderPlanned)(
        { core: io.core, public: io.pub, privateBucket: io.priv, licence: this.#licence(), publicCopy: this.#publicCopy(), ...this.#forms(), shellAssets: await loadShellAssets(meter.assets(this.env.ASSETS)) },
        now,
      );
      for (const path of render.plan.removed) this.ctx.storage.sql.exec("INSERT OR IGNORE INTO deploy_removed (kind, value) VALUES ('page', ?)", path);
      state = this.#saveVerify({ ...state, removedReady: true });
    }

    // (2) Retry public-file deletions that have not been confirmed yet (R25.3); only confirmed-gone copies are probed.
    const deletions = await runFileOpsSlice(
      io.env, { copies: [], deletions: [] }, this.#retry, { deletion: state.deletionCursor, copy: '' },
      { deletions: Math.min(PROBES_PER_SLICE, Math.max(1, Math.floor(meter.remaining('r2') / 2))), copies: 0 },
    );
    for (const id of deletions.deleted) this.ctx.storage.sql.exec("INSERT OR IGNORE INTO deploy_removed (kind, value) VALUES ('file', ?)", id);
    state = this.#saveVerify({ ...state, deletionCursor: deletions.deletionsDone ? '' : deletions.cursors.deletion });

    const removed = state.unconfirmable ? [] : this.ctx.storage.sql.exec<{ kind: string; value: string }>('SELECT kind, value FROM deploy_removed ORDER BY kind, value').toArray();
    const urls = removedProbeUrls(
      { pages: removed.filter((row) => row.kind === 'page').map((row) => row.value), files: removed.filter((row) => row.kind === 'file').map((row) => row.value) },
      this.#siteOrigins(),
    );
    const elapsed = elapsedSince(run.verifyStartMs || run.startedMs, nowMs);

    let result;
    let complete: boolean;
    try {
      // (3) Probe the next window in batches; each batch is stored at once so a failure keeps what was learned.
      const done = new Set(this.ctx.storage.sql.exec<{ url: string }>('SELECT url FROM verify_probes').toArray().map((row) => row.url));
      const window = probeWindow(urls, done, PROBES_PER_SLICE);
      for (let start = 0; start < window.length; start += PROBE_BATCH_MAX) {
        const batch = window.slice(start, start + PROBE_BATCH_MAX);
        const answers = await io.ops.probePublicAddresses(batch);
        for (const url of batch) {
          const answer = answers[url];
          this.ctx.storage.sql.exec('INSERT OR REPLACE INTO verify_probes (url, status) VALUES (?, ?)', url, answer === 'present' || answer === 'absent' ? answer : 'unknown');
          done.add(url);
        }
      }
      // An unconfirmable removal (the site was over the ceiling, so it was neither deployed nor probed) never completes
      // a pass: it can only be resolved by verified Containment, from the 4-minute mark on.
      complete = !state.unconfirmable && probeWindow(urls, done, 1).length === 0;

      // (4) Evaluate the escalation when the pass is complete, or (from 4 minutes) on the mid-pass cadence.
      if (!shouldEvaluate({ passComplete: complete, elapsedMs: elapsed, lastEvalMs: state.lastEvalMs, nowMs })) {
        // A partial pass keeps probing at once; an unconfirmable one has nothing to probe and waits for the next deadline.
        const verifyStartMs = run.verifyStartMs || run.startedMs;
        await this.#wake(state.unconfirmable ? Math.max(verifyStartMs + CONTAIN_AT_MS, state.lastEvalMs + EVALUATE_EVERY_MS) : Date.now());
        return;
      }
      const stored = new Map(this.ctx.storage.sql.exec<{ url: string; status: ProbeResult['status'] }>('SELECT url, status FROM verify_probes').toArray().map((row) => [row.url, row.status]));
      const probes: ProbeResult[] = [];
      // The whole public site stands for an unconfirmable removal's targets (content-free: the origin only).
      const unprobed: string[] = state.unconfirmable ? [`${this.#siteOrigins().site}/`] : [];
      for (const url of urls) {
        const status = stored.get(url);
        if (status === undefined) unprobed.push(url);
        else probes.push({ url, status });
      }
      result = await escalateAfterProbes(io.ops, run, probes, complete, elapsed, unprobed);
      state = this.#saveVerify({ ...state, lastEvalMs: nowMs });
    } catch (error) {
      this.#log('error', 'publish_verify_failed', { run: run.run, error });
      await this.#wake(nowMs + 30_000); // retry the verify step; never claim success on a failed verify
      return;
    }

    if (result.decision.keepContainment) this.#update({ containment: true });

    if (result.safe) {
      // The removal is provably gone (or Containment is provably in force): the ONLY success (R24.17).
      await this.#pubDb().prepare('UPDATE publish_runs SET verified_at = ?2 WHERE id = ?1').bind(run.run, now).run();
      await this.#finish(run, now);
      return;
    }
    if (result.decision.action === 'incident') {
      // Neither removal nor Containment confirmed: the incident was declared; close the run WITHOUT verified_at
      // so success is never claimed. Containment (if active) stays in force for the next authorized generation.
      this.#log('error', 'publish_unconfirmed_incident', { run: run.run, unverified: result.unverified.length });
      // Raise the System_Alert for every Administrator within one minute of the five-minute deadline (R25.7):
      // a save's removal could not be confirmed unreachable. The alert is content-free — it carries only the
      // run identity and the count of still-reachable addresses, never any research body.
      await notifySystemAlert(
        new GuardedBatch(io.core, { id: null, now }),
        'publication:unconfirmed_removal',
        { run: run.run, unverified: result.unverified.length },
      ).commit();
      await this.#finish(run, now);
      return;
    }
    // (5) Still watching/containing/verifying. A partial pass keeps probing at once; a complete, unsafe pass starts a
    // fresh one at the next deadline boundary.
    if (!complete) { await this.#wake(state.unconfirmable ? nowMs + EVALUATE_EVERY_MS : Date.now()); return; }
    this.ctx.storage.sql.exec('DELETE FROM verify_probes');
    this.#saveVerify({ ...state, passes: state.passes + 1 });
    const nextAtMs = elapsed < VERIFY_BY_MS ? nowMs + 30_000 : nowMs + 15_000;
    await this.#wake(nextAtMs);
  }

  /** The deploy generation's staged render, in this object's SQLite (see `deploy_staged`). */
  readonly #staging: StagingStore = {
    save: (files) => {
      for (const file of files) {
        const bytes = file.content.buffer.slice(file.content.byteOffset, file.content.byteOffset + file.content.byteLength);
        this.ctx.storage.sql.exec('INSERT OR REPLACE INTO deploy_staged (path, hash, size, content_type, content) VALUES (?, ?, ?, ?, ?)', file.path, file.hash, file.size, file.contentType, bytes);
      }
    },
    pending: () => this.ctx.storage.sql.exec<{ path: string; hash: string; size: number }>('SELECT path, hash, size FROM deploy_staged ORDER BY path'),
    content: (hash) => {
      const row = this.ctx.storage.sql.exec<{ content: ArrayBuffer; content_type: string }>('SELECT content, content_type FROM deploy_staged WHERE hash = ? LIMIT 1', hash).toArray()[0];
      return row ? { content: new Uint8Array(row.content), contentType: row.content_type } : undefined;
    },
    stored: (paths) => { for (const path of paths) this.ctx.storage.sql.exec('DELETE FROM deploy_staged WHERE path = ?', path); },
    count: () => this.ctx.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM deploy_staged').one().n,
  };

  /**
   * The Free-plan site-size check, run before any full render: counts the current Public_Views and raises the approach
   * alert (at {@link SITE_VIEW_ALERT_SHARE} of the ceiling) or the over-ceiling alert, each once, on both the in-app
   * System_Alert and the independent rf-ops channel. Returns true when the site is over the ceiling.
   */
  async #overSiteCeiling(run: RunState, io: { readonly core: D1Database; readonly pub: D1Database }, meter: SliceMeter, now: Timestamp): Promise<boolean> {
    const views = (await io.pub.prepare('SELECT count(*) AS n FROM public_views WHERE valid_to_at IS NULL').first<{ n: number }>())?.n ?? 0;
    const ceiling = siteViewCeiling(this.env.PUBLISHER_SITE_VIEW_CEILING);
    const over = views > ceiling;
    if (views < ceiling * SITE_VIEW_ALERT_SHARE) {
      this.ctx.storage.sql.exec('DELETE FROM site_size_alerts'); // back under the approach line: re-arm both alerts
      return false;
    }
    const level = over ? 'over' : 'approach';
    if (over) this.#log('error', 'publish_site_over_ceiling', { run: run.run, views, ceiling: ceiling, urgent: run.urgent });
    const sent = (key: string) => this.ctx.storage.sql.exec('SELECT 1 FROM site_size_alerts WHERE key = ?', key).toArray().length > 0;
    const mark = (key: string) => this.ctx.storage.sql.exec('INSERT OR IGNORE INTO site_size_alerts (key) VALUES (?)', key);
    // Content-free: counts only. A failing channel is logged and retried on the next render, never fatal.
    if (!sent(`${level}:app`)) {
      try {
        await notifySystemAlert(new GuardedBatch(io.core, { id: null, now }, { ignoreFreeze: true }), `publication:site_views_${level}`, {
          views, ceiling: ceiling, at: now,
        }).commit();
        mark(`${level}:app`);
      } catch (error) { this.#log('error', 'publish_site_size_alert_failed', { run: run.run, channel: 'app', error }); }
    }
    if (!sent(`${level}:ops`)) {
      try {
        const alerting = (this.#opsOverride ?? this.env.OPS) as Partial<OpsSpendAlert>;
        if (typeof alerting.spendAlert !== 'function') throw new Error('No independent alert channel.');
        meter.charge('external');
        await alerting.spendAlert({
          level: over ? 'breach' : 'warning', meter: 'public_site_views',
          usagePercent: Math.round((views / ceiling) * 100), budgetAmount: ceiling, currency: 'count',
        });
        mark(`${level}:ops`);
      } catch (error) { this.#log('error', 'publish_site_size_alert_failed', { run: run.run, channel: 'ops', error }); }
    }
    return over;
  }

  /**
   * A site over the Free-plan ceiling is not rendered. An addition run closes WITHOUT `verified_at` (a later run tries
   * again once the site shrinks). An urgent run cannot deploy its removal, so it goes straight to the verify phase with
   * an unconfirmable removal: the 4-minute Containment, 5-minute verify-Containment and incident + System_Alert path.
   */
  async #refuseOverCeiling(run: RunState, now: Timestamp): Promise<void> {
    if (!run.urgent) { await this.#finish(run, now); return; }
    this.#clearDeployProgress();
    this.#saveVerify({ ...DEFAULT_VERIFY, removedReady: true, unconfirmable: true });
    this.#update({ phase: 'verify', verifyStartMs: run.startedMs });
    await this.#wake(Date.now());
  }

  /** Close the run: record its end, highest processed sequence, and urgent classification on `publish_runs`. */
  async #finish(run: Generation, now: Timestamp): Promise<void> {
    const stored = this.#load();
    const seqTo = stored?.seqTo ?? 0;
    const urgent = stored?.urgent ?? false;
    await this.#pubDb().prepare(
      'UPDATE publish_runs SET finished_at = ?2, seq_to = ?3, urgent = ?4 WHERE id = ?1',
    ).bind(run.run, now, seqTo || null, urgent ? 1 : 0).run();
    this.#resetDeployState();
    this.ctx.storage.sql.exec('DELETE FROM publish_run WHERE only = 1');
  }

  /** The rf-public database, counted by the slice meter while a slice is running. */
  #pubDb(): D1Database { return this.#meter ? this.#meter.pub(this.env.RF_PUBLIC) : this.env.RF_PUBLIC; }

  /** Every binding the deploy and verify phases touch, routed through the slice meter. */
  #io(meter: SliceMeter) {
    const core = meter.core(this.env.RF_CORE);
    const pub = meter.pub(this.env.RF_PUBLIC);
    const priv = meter.bucket(this.env.RF_PRIVATE_BUCKET);
    const pubBucket = meter.bucket(this.env.RF_PUBLIC_BUCKET);
    const env: Env = { ...this.env, RF_CORE: core, RF_PUBLIC: pub, RF_PRIVATE_BUCKET: priv, RF_PUBLIC_BUCKET: pubBucket };
    return { core, pub, priv, pubBucket, env, ops: meter.ops(this.#ops()) };
  }

  /** The deploy step machine's persisted progress; a fresh run (or an old row) starts at `stage`. */
  #loadDeploy(): DeployProgress {
    const row = this.ctx.storage.sql.exec<{ deploy_json: string }>('SELECT deploy_json FROM publish_run WHERE only = 1').toArray()[0];
    let stored: Partial<DeployProgress> = {};
    try { stored = JSON.parse(row?.deploy_json ?? '{}') as Partial<DeployProgress>; } catch { /* restart at stage */ }
    return { ...DEFAULT_DEPLOY, ...stored };
  }

  /** Persist the deploy progress after a step transition and return it. */
  #saveDeploy(progress: DeployProgress): DeployProgress {
    this.ctx.storage.sql.exec('UPDATE publish_run SET deploy_json = ? WHERE only = 1', JSON.stringify(progress));
    return progress;
  }

  /** Drop the step machine's progress and upload buckets but keep the removed-address record the verify phase reads. */
  #clearDeployProgress(): void {
    this.ctx.storage.sql.exec("UPDATE publish_run SET deploy_json = '{}' WHERE only = 1");
    this.ctx.storage.sql.exec('DELETE FROM deploy_buckets');
    this.ctx.storage.sql.exec('DELETE FROM deploy_staged');
    this.ctx.storage.sql.exec('DELETE FROM verify_probes');
  }

  /** The verify phase's persisted progress (it shares the `deploy_json` column; the deploy steps are done by then). */
  #loadVerify(): VerifyProgress {
    const row = this.ctx.storage.sql.exec<{ deploy_json: string }>('SELECT deploy_json FROM publish_run WHERE only = 1').toArray()[0];
    let stored: Partial<VerifyProgress> = {};
    try { stored = JSON.parse(row?.deploy_json ?? '{}') as Partial<VerifyProgress>; } catch { /* start the pass afresh */ }
    return { ...DEFAULT_VERIFY, ...stored };
  }

  #saveVerify(progress: VerifyProgress): VerifyProgress {
    this.ctx.storage.sql.exec('UPDATE publish_run SET deploy_json = ? WHERE only = 1', JSON.stringify(progress));
    return progress;
  }

  /** Forget everything the deploy and verify phases kept for a run: progress, buckets, and the removed addresses. */
  #resetDeployState(): void {
    this.#clearDeployProgress();
    this.ctx.storage.sql.exec('DELETE FROM deploy_removed');
  }

  async #wake(atMs: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    // An alarm that is missing, later than wanted, or already overdue (at or before now, so evidently not going
    // to fire) is replaced; otherwise a wedged run is never advanced.
    if (current === null || current > atMs || current <= Date.now()) await this.ctx.storage.setAlarm(atMs);
  }

  #update(change: {
    readonly seqTo?: number; readonly urgent?: boolean; readonly phase?: RunPhase;
    readonly lastChangeMs?: number; readonly verifyStartMs?: number; readonly containment?: boolean;
  }): void {
    const current = this.#load();
    if (!current) return;
    const next = {
      seqTo: change.seqTo ?? current.seqTo,
      urgent: change.urgent ?? current.urgent,
      phase: change.phase ?? current.phase,
      lastChangeMs: change.lastChangeMs ?? current.lastChangeMs,
      verifyStartMs: change.verifyStartMs ?? current.verifyStartMs,
      containment: change.containment ?? current.containment,
    };
    this.ctx.storage.sql.exec(
      'UPDATE publish_run SET seq_to = ?, urgent = ?, phase = ?, last_change_ms = ?, verify_start_ms = ?, containment = ? WHERE only = 1',
      next.seqTo, next.urgent ? 1 : 0, next.phase, next.lastChangeMs, next.verifyStartMs, next.containment ? 1 : 0,
    );
  }

  /** The active run's durable generation and full phase state, or null when idle. */
  #load(): RunState | null {
    const row = this.ctx.storage.sql.exec<{
      run_id: string; epoch: number; seq_to: number; urgent: number; phase: string;
      started_ms: number; last_change_ms: number; verify_start_ms: number; containment: number; progress_ms: number;
    }>('SELECT run_id, epoch, seq_to, urgent, phase, started_ms, last_change_ms, verify_start_ms, containment, progress_ms FROM publish_run WHERE only = 1').toArray()[0];
    if (!row) return null;
    return {
      run: row.run_id, epoch: row.epoch, seqTo: row.seq_to, urgent: row.urgent === 1,
      phase: (row.phase as RunPhase) ?? 'project', startedMs: row.started_ms, lastChangeMs: row.last_change_ms,
      verifyStartMs: row.verify_start_ms, containment: row.containment === 1, progressMs: row.progress_ms,
    };
  }

  /** Whether edge Containment is currently in force, as this object last recorded; a reset/retry cannot clear it. */
  #containmentActive(): boolean {
    return this.#load()?.containment ?? false;
  }

  /** The configured Content_Licence for the render (name links to URL on public pages); empty when unset. */
  #licence(): { readonly name: string; readonly url: string } {
    return { name: this.env.CONTENT_LICENCE_NAME ?? '', url: this.env.CONTENT_LICENCE_URL ?? '' };
  }

  /** The form pages' Turnstile site key and origins from the installation's variables; none (attributes omitted) when no site key is set. */
  #forms(): { readonly forms?: FormsConfig } {
    const siteKey = this.env.TURNSTILE_SITE_KEY ?? '';
    if (siteKey === '') return {};
    return { forms: { siteKey, submitOrigin: this.env.PUBLIC_SUBMIT_ORIGIN ?? 'https://submit.researchforce.org', filesOrigin: this.env.PUBLIC_FILES_ORIGIN ?? 'https://files.researchforce.org' } };
  }
  /** The validated Installation_Public_Copy; a missing or partial bundle refuses the render (R46.41, R46.42). */
  #publicCopy() {
    return publicCopyOf(this.env);
  }

  /** The current `rf-public.site_files` manifest the deploy promotes (path -> {hash, size}). */
  async #manifest(pub: D1Database): Promise<DeployManifest> {
    const result = await pub.prepare('SELECT path, hash, size FROM site_files').all<{ path: string; hash: string; size: number }>();
    const manifest: Record<string, { hash: string; size: number }> = {};
    // `_headers` is applied as version configuration at finish (see deployFinish), never uploaded as a page.
    for (const row of result.results) if (row.path !== HEADERS_PATH) manifest[row.path] = { hash: row.hash, size: row.size };
    return manifest;
  }

  /** The public origins the verify step builds removed-address probe URLs from (design hosts by default). */
  #siteOrigins(): PublicOrigins {
    return {
      site: this.env.PUBLIC_SITE_ORIGIN ?? 'https://researchforce.org',
      files: this.env.PUBLIC_FILES_ORIGIN ?? 'https://files.researchforce.org',
    };
  }
}

/** The rendered `_headers` rules' manifest path; it is configuration for the version, not a served file. */
const HEADERS_PATH = '/_headers';

/** A run with no completed slice for this long is stale: 10 minutes, above the 5-minute addition ceiling and the alarm retry backoff. */
const STALE_RUN_MS = 10 * 60_000;

/** The deploy phase's steps, in order. */
type DeployStep = 'stage' | 'files' | 'begin' | 'upload' | 'finish';

/** The persisted deploy step machine: the step, its cursors, and the open upload session. */
interface DeployProgress {
  readonly step: DeployStep;
  readonly deletionCursor: string;
  readonly copyCursor: string;
  readonly sessionStartMs: number;
  readonly uploadToken: string;
  readonly completionToken: string;
  readonly bucket: number;
  readonly offset: number;
  /** True once rf-ops answered `uncertain`: later slices reconcile and never re-send the promotion. */
  readonly uncertain: boolean;
  readonly versionId: string | null;
  /** How many times this deploy restarted at `stage` because a manifest row's `build/{hash}` object was missing. */
  readonly restages: number;
  /** True once this generation's render is in `deploy_staged`; later stage slices only store the next window. */
  readonly rendered: boolean;
  /** The produced file count of that render, for the 16,000-file alert. */
  readonly fileCount: number;
}

const DEFAULT_DEPLOY: DeployProgress = {
  step: 'stage', deletionCursor: '', copyCursor: '', sessionStartMs: 0, uploadToken: '', completionToken: '',
  bucket: 0, offset: 0, uncertain: false, versionId: null, restages: 0, rendered: false, fileCount: 0,
};

/**
 * The most restarts at `stage` one deploy makes for missing build objects. Beyond it the slice fails (throws), so a
 * stage that keeps believing an object is stored cannot loop forever; the platform's alarm retries and the stale-run
 * recovery then take over, exactly as for any other failing deploy slice.
 */
const MAX_RESTAGES = 3;

/** The verify phase's persisted progress. */
interface VerifyProgress {
  /** True once the removed set is in `deploy_removed` (written by the deploy phase, or computed once by verify). */
  readonly removedReady: boolean;
  /** When the escalation was last evaluated (ms epoch); throttles mid-pass evaluations after the 4-minute mark. */
  readonly lastEvalMs: number;
  /** Probe passes completed without a safe outcome. */
  readonly passes: number;
  /** Where the pending-deletion retry stopped (so a long retry set cannot starve its tail). */
  readonly deletionCursor: string;
  /** True when the site was over the Free-plan ceiling: nothing was deployed or probed, only Containment can resolve it. */
  readonly unconfirmable: boolean;
}

const DEFAULT_VERIFY: VerifyProgress = { removedReady: false, lastEvalMs: 0, passes: 0, deletionCursor: '', unconfirmable: false };

/** What the next deploy step needs from the slice budget (the first step of a slice always runs regardless). */
const STEP_NEEDS: Readonly<Record<DeployStep, { d1?: number; r2?: number; external?: number }>> = {
  stage: { d1: 30, r2: 20 },
  files: { d1: 3, r2: 4 },
  begin: { d1: 3, external: 1 },
  upload: { r2: 1, external: 1 },
  finish: { d1: 4, external: 1 },
};

/** The phases a run moves through: drain the outbox, deploy the rendered site, then verify an urgent removal. */
type RunPhase = 'project' | 'deploy' | 'verify';

/** The active run's durable generation plus its phase/batching/escalation state, read from the single run row. */
interface RunState extends Generation {
  readonly seqTo: number;
  readonly urgent: boolean;
  readonly phase: RunPhase;
  readonly startedMs: number;
  readonly lastChangeMs: number;
  readonly verifyStartMs: number;
  readonly containment: boolean;
  readonly progressMs: number;
}
