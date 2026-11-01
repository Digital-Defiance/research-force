import { DurableObject } from 'cloudflare:workers';
import { newULID } from '@researchforce/domain/identifiers';
import type { OutboxTopic } from '@researchforce/db/accountant';
import type { Timestamp } from '@researchforce/domain/types';
import { readEpoch } from '@researchforce/db/publication-epoch';
import type { Generation } from '@researchforce/db/publication-epoch';
import { GuardedBatch } from '@researchforce/db/batch';
import { notifySystemAlert } from '../notifications/fanout';
import type { Env } from '../env';
import { createLogger } from '../log';
import { isFrozen, runProjectionSlice } from '../publisher/projection';
import type { ProjectionDeps } from '../publisher/projection';
import { renderSiteBuild } from '../publisher/render';
import type { ShellAsset } from '../publisher/render';
import { runFileOps } from '../publisher/files';
import type { PlannedFile } from '../publisher/plan';
import {
  VERIFY_BY_MS,
  collectDeployAssets,
  currentPublicAttachments,
  deployRun,
  deployWhen,
  elapsedSince,
  fileOpsFor,
  liveFileCopies,
  reconcileUncertainDeploy,
  removedAddresses,
  sqlDeletionRetryState,
  verifyRemoval,
} from '../publisher/deploy';
import type { DeployManifest, DeployOps, PublicOrigins } from '../publisher/deploy';

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
      containment INTEGER NOT NULL DEFAULT 0)`);
    // Older instances created the table before these columns existed; add them if missing (no rf-public change).
    const columns = [
      `phase TEXT NOT NULL DEFAULT ${PROJECT_PHASE_DEFAULT}`,
      'started_ms INTEGER NOT NULL DEFAULT 0', 'last_change_ms INTEGER NOT NULL DEFAULT 0',
      'verify_start_ms INTEGER NOT NULL DEFAULT 0', 'containment INTEGER NOT NULL DEFAULT 0',
    ];
    for (const column of columns) {
      try { ctx.storage.sql.exec(`ALTER TABLE publish_run ADD COLUMN ${column}`); } catch { /* already present */ }
    }
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

  /** The `rf-ops` surface the deploy/verify phases call: the service binding, or a test-injected fake. */
  #ops(): DeployOps { return this.#opsOverride ?? this.env.OPS; }

  /** The topic owner's kick: start or continue the projection run draining the `publish` outbox. */
  async kick(topic: OutboxTopic = 'publish'): Promise<void> {
    if (topic !== 'publish') return;
    // A frozen rf-core (restore in progress) is left untouched; no run opens until it clears, so restored
    // material stays quarantined. A later kick or the one-minute cron retries once unfrozen (R36.16, R59.3).
    if (await isFrozen(this.env.RF_CORE)) return;
    await this.#ensureRun();
    await this.#wake(Date.now());
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
    if (await isFrozen(this.env.RF_CORE)) { await this.#wake(Date.now() + 60_000); return; }
    if (run.phase === 'project') return this.#projectSlice(run);
    if (run.phase === 'deploy') return this.#deployPhase(run);
    return this.#verifyPhase(run);
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
    await this.#wake(Date.now());
  }

  /**
   * Deploy phase (task 32.5, design "Publisher" step 6). The pure {@link deployWhen} decides when: an urgent
   * run deploys at once; an addition-only run waits 30 s quiet / 5 min max. When it is time, render the site,
   * apply the public-file ops (deletions first, then copies), then deploy the manifest through rf-ops under
   * the epoch fence. A fenced-out (stale) generation deploys nothing and finishes. After an urgent deploy, the
   * run moves to the verify phase; an addition deploy with nothing suppressed finishes once promoted.
   */
  async #deployPhase(run: RunState): Promise<void> {
    const nowMs = Date.now();
    const when = deployWhen(
      { urgent: run.urgent, projectionComplete: true, startedAtMs: run.startedMs, lastChangeAtMs: run.lastChangeMs },
      nowMs,
    );
    if (!when.deploy) { await this.#wake(when.waitUntilMs); return; }

    const now = new Date().toISOString() as Timestamp;
    // Render the current site: reconciles rf-private/build and the rf-public.site_files manifest, returns the diff.
    const render = await renderSiteBuild(
      { core: this.env.RF_CORE, public: this.env.RF_PUBLIC, privateBucket: this.env.RF_PRIVATE_BUCKET, licence: this.#licence(), shellAssets: this.#shellAssets() },
      now,
    );

    // Public-file ops: copies/deletions derived from the current Public attachment views vs. the live copies
    // (deletions first, copies before the deploy links them, R24.3/R25.3). Failed deletions stay in the retry set.
    const publicAttachments = await currentPublicAttachments(this.env.RF_CORE, this.env.RF_PUBLIC);
    const live = await liveFileCopies(this.env.RF_PUBLIC_BUCKET);
    // Apply deletions first, then copies, before the deploy links them (R24.3/R25.3). Failures stay in the retry set.
    await runFileOps(this.env, fileOpsFor(publicAttachments, live), this.#retry);

    // Deploy the manifest, fenced against the current authoritative epoch (R24.16, R24.17, R30.7).
    const authoritative = await readEpoch(this.env.RF_CORE);
    const manifest = await this.#manifest();
    const assets = await collectDeployAssets(this.env.RF_PRIVATE_BUCKET, render.plan, (file: PlannedFile) => this.#contentTypeOf(file));
    const deployResult = await deployRun(this.#ops(), run, authoritative, manifest, assets, run.containment);

    // Keep containment across a stale retry: a reset/retry can never clear active containment (R24.17).
    if (deployResult.outcome.keepContainment) this.#update({ containment: true });

    if (deployResult.outcome.operationState === 'uncertain') {
      // Never blind-retry: reconcile the uncertain promotion against the live site before anything depends on it.
      const reconciled = await reconcileUncertainDeploy(this.#ops(), run, authoritative, this.#siteOrigins().site, run.containment);
      if (reconciled.keepContainment) this.#update({ containment: true });
      if (!reconciled.resolved) { await this.#wake(Date.now() + 30_000); return; } // retry under the current generation
    } else if (deployResult.fencedOut || !deployResult.deployed) {
      // A stale or refused deploy stands for nothing: do NOT claim success. An urgent run still proceeds to the
      // verify/escalation path so a suppression that did not promote is contained; an addition run just finishes.
      if (!run.urgent) { await this.#finish(run, now); return; }
    }

    // Record the deployed version id (recorded even when not promoted, for the reconcile/incident record).
    if (deployResult.outcome.versionId) {
      await this.env.RF_PUBLIC.prepare('UPDATE publish_runs SET version_id = ?2 WHERE id = ?1').bind(run.run, deployResult.outcome.versionId).run();
    }

    if (run.urgent) {
      // An urgent run must verify the removal is actually gone (or contained) before it may claim success.
      this.#update({ phase: 'verify', verifyStartMs: run.startedMs });
      await this.#wake(Date.now());
      return;
    }

    // An addition-only run that promoted has nothing to suppress: record verified success and finish (R24.11).
    await this.env.RF_PUBLIC.prepare('UPDATE publish_runs SET verified_at = ?2 WHERE id = ?1').bind(run.run, now).run();
    await this.#finish(run, now);
  }

  /**
   * Verify phase (task 32.5, design "Publisher" step 7). HEAD each removed page+file address through rf-ops,
   * expecting not-found, and drive the four-/five-minute escalation: at 4 min unverified → contain + alert; by
   * 5 min → verify Containment; if neither removal nor Containment can be confirmed → UNCONFIRMED incident,
   * NEVER success (R24.16, R24.17, R25.7). Only a genuinely safe outcome records `publish_runs.verified_at`.
   */
  async #verifyPhase(run: RunState): Promise<void> {
    const now = new Date().toISOString() as Timestamp;
    const nowMs = Date.now();
    // Re-render the plan to learn the removed page addresses, and re-run the file deletions so a removal that
    // failed earlier is retried (R25.3); only confirmed-gone copies count as removed for verification.
    const render = await renderSiteBuild(
      { core: this.env.RF_CORE, public: this.env.RF_PUBLIC, privateBucket: this.env.RF_PRIVATE_BUCKET, licence: this.#licence(), shellAssets: this.#shellAssets() },
      now,
    );
    const publicAttachments = await currentPublicAttachments(this.env.RF_CORE, this.env.RF_PUBLIC);
    const live = await liveFileCopies(this.env.RF_PUBLIC_BUCKET);
    const fileOps = await runFileOps(this.env, fileOpsFor(publicAttachments, live), this.#retry);

    const removed = removedAddresses(render.plan, fileOps);
    const elapsed = elapsedSince(run.verifyStartMs || run.startedMs, nowMs);
    let result;
    try {
      result = await verifyRemoval(this.#ops(), run, removed, this.#siteOrigins(), elapsed);
    } catch (error) {
      this.#log('error', 'publish_verify_failed', { run: run.run, error });
      await this.#wake(nowMs + 30_000); // retry the verify step; never claim success on a failed verify
      return;
    }

    if (result.decision.keepContainment) this.#update({ containment: true });

    if (result.safe) {
      // The removal is provably gone (or Containment is provably in force): the ONLY success (R24.17).
      await this.env.RF_PUBLIC.prepare('UPDATE publish_runs SET verified_at = ?2 WHERE id = ?1').bind(run.run, now).run();
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
        new GuardedBatch(this.env.RF_CORE, { id: null, now }),
        'publication:unconfirmed_removal',
        { run: run.run, unverified: result.unverified.length },
      ).commit();
      await this.#finish(run, now);
      return;
    }
    // Still watching/containing/verifying: schedule the next check at the next deadline boundary.
    const nextAtMs = elapsed < VERIFY_BY_MS ? nowMs + 30_000 : nowMs + 15_000;
    await this.#wake(nextAtMs);
  }

  /** Close the run: record its end, highest processed sequence, and urgent classification on `publish_runs`. */
  async #finish(run: Generation, now: Timestamp): Promise<void> {
    const stored = this.#load();
    const seqTo = stored?.seqTo ?? 0;
    const urgent = stored?.urgent ?? false;
    await this.env.RF_PUBLIC.prepare(
      'UPDATE publish_runs SET finished_at = ?2, seq_to = ?3, urgent = ?4 WHERE id = ?1',
    ).bind(run.run, now, seqTo || null, urgent ? 1 : 0).run();
    this.ctx.storage.sql.exec('DELETE FROM publish_run WHERE only = 1');
  }

  async #wake(atMs: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > atMs) await this.ctx.storage.setAlarm(atMs);
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
      started_ms: number; last_change_ms: number; verify_start_ms: number; containment: number;
    }>('SELECT run_id, epoch, seq_to, urgent, phase, started_ms, last_change_ms, verify_start_ms, containment FROM publish_run WHERE only = 1').toArray()[0];
    if (!row) return null;
    return {
      run: row.run_id, epoch: row.epoch, seqTo: row.seq_to, urgent: row.urgent === 1,
      phase: (row.phase as RunPhase) ?? 'project', startedMs: row.started_ms, lastChangeMs: row.last_change_ms,
      verifyStartMs: row.verify_start_ms, containment: row.containment === 1,
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

  /**
   * The compiled site-shell / Design_System static assets to ship with each deploy. Packaging these into the
   * Durable Object at runtime is a separate concern (design "Publisher" step 5); until that is wired, the
   * render ships every page against the fixed DEFAULT_ASSETS addresses, which is the empty set here.
   */
  #shellAssets(): readonly ShellAsset[] {
    return [];
  }

  /** The current `rf-public.site_files` manifest the deploy promotes (path -> {hash, size}). */
  async #manifest(): Promise<DeployManifest> {
    const result = await this.env.RF_PUBLIC.prepare('SELECT path, hash, size FROM site_files').all<{ path: string; hash: string; size: number }>();
    const manifest: Record<string, { hash: string; size: number }> = {};
    for (const row of result.results) manifest[row.path] = { hash: row.hash, size: row.size };
    return manifest;
  }

  /** The content type a produced file is served with; `_headers` and pages carry their own, assets keep theirs. */
  #contentTypeOf(file: PlannedFile): string {
    if (file.path.endsWith('.html')) return 'text/html; charset=utf-8';
    if (file.path.endsWith('.json')) return 'application/json';
    if (file.path.endsWith('.xml')) return 'application/xml';
    if (file.path.endsWith('.txt') || file.path === '/_headers') return 'text/plain; charset=utf-8';
    return 'application/octet-stream';
  }

  /** The public origins the verify step builds removed-address probe URLs from (design hosts by default). */
  #siteOrigins(): PublicOrigins {
    return {
      site: this.env.PUBLIC_SITE_ORIGIN ?? 'https://researchforce.org',
      files: this.env.PUBLIC_FILES_ORIGIN ?? 'https://files.researchforce.org',
    };
  }
}

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
}
