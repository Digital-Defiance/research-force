import type { OpsDeployResult } from '@researchforce/domain/ops';
import type { Timestamp } from '@researchforce/domain/types';
import {
  type Generation,
  type Reconciliation,
  type ReconciliationResult,
  beginOperation,
  promoteUnderEpoch,
  readEpoch,
  readOperation,
  reconcile,
  settleOperation,
} from '@researchforce/db/publication-epoch';
import { CLOUDFLARE_API, CloudflareApiError } from './access';

/**
 * The `rf-ops` transport that deploys the assets-only `rf-site` Worker through the Cloudflare Workers Static
 * Assets Direct Upload API, under the serialized publication-epoch fence (task 32.1, design "Public pages" +
 * "Workers Static Assets", R24.7, R24.11, R24.12, R24.16, R24.17, R28.6, R28.16, R60.2).
 *
 * `rf-site` is an assets-only Worker (no script) on `researchforce.org`, deployed ONLY by the Publisher
 * through rf-ops. The Direct Upload protocol has three phases (design, Cloudflare docs):
 *   1. Register a manifest of {path -> {hash, size}} at the account's assets-upload-session endpoint. The
 *      platform answers with a one-hour upload token (JWT) and `buckets`: the hashes it is MISSING, grouped
 *      for batch upload. Unchanged files are not returned, so only the missing files are uploaded. The
 *      one-hour token is the "resumable upload token": uploads may span invocations.
 *   2. Upload only the missing files (base64, multipart). The final upload returns a "completion" token.
 *   3. Create an assets-only Worker VERSION with `html_handling: 'auto-trailing-slash'` and
 *      `not_found_handling: '404-page'`, then DEPLOY that version to 100%.
 *
 * rf-ops SERIALIZES promotion: one deploy at a time. Immediately BEFORE and AFTER the deploy it rereads the
 * authoritative publication epoch and runs {@link promoteUnderEpoch}; if the epoch advanced (a
 * confidentiality save landed), the promotion is stale and MUST NOT stand, and any independent containment
 * (task 59.2) is kept — an obsolete operation can never reopen a contained host (R24.16, R24.17). The pure
 * before/after decision lives in `@researchforce/db/publication-epoch`; this module does not reimplement it.
 *
 * For an ambiguous API answer (lost/uncertain response) the operation identity, exact Worker version/manifest,
 * and a verified status are recorded against the durable `external_operations` row (state `uncertain`), so a
 * later {@link reconcile} against actual provider state decides before any retry — rf-ops never blind-retries
 * an uncertain deploy (R24.17, R60.2). On a clear success the row is settled `confirmed` with the version id
 * as the provider reference, and the version/manifest/verified status are recorded on the run.
 *
 * Pure decision logic (the epoch fence, reconcile) stays in `db`; this class holds only the Cloudflare I/O and
 * the thin durable-recording glue, mirroring how 59.1/59.2/59.3 split pure decisions from provider calls. It
 * depends only on `@researchforce/db` and `@researchforce/domain`, never on `apps/app`
 * (scripts/check-boundaries.mjs).
 */

// ---------------------------------------------------------------------------
// Direct Upload protocol shapes (modelled from the design's "Workers Static Assets" bullet and the
// Cloudflare Direct Upload docs). Kept in named helpers/constants so an endpoint or field correction is a
// one-line change; the tests assert the SEQUENCE and the fencing, not brittle exact URLs.
// ---------------------------------------------------------------------------

/** One manifest entry: the content hash and byte size the platform uses to decide whether a file is missing. */
export interface AssetFile {
  readonly hash: string;
  readonly size: number;
}

/** The site manifest the Publisher builds in 32.3; 32.1 only consumes it: path -> {hash, size}. */
export type SiteManifest = Readonly<Record<string, AssetFile>>;

/** The bytes of one missing file, keyed for the uploader to fetch from the rendered build area. */
export interface AssetBody {
  /** Base64-encoded file content, as the upload endpoint requires (`?base64=true`). */
  readonly base64: string;
  /** The content type served for this file; `application/null` suppresses a Content-Type header. */
  readonly contentType: string;
}

/**
 * Supplies the bytes of a missing file by hash, so only files the platform lacks are read and uploaded. The
 * Publisher (32.3/32.5) backs this with the rendered build area; 32.1 stays transport-only and never reads
 * the whole manifest's contents. Returning `null` for a hash the platform asked for is a deploy error.
 */
export type AssetSource = (hash: string) => Promise<AssetBody | null>;

/** The assets-only version routing the design fixes for `rf-site` (design "Workers Static Assets", R45.1). */
export const SITE_ASSET_CONFIG = {
  html_handling: 'auto-trailing-slash',
  not_found_handling: '404-page',
} as const;

export interface SiteDeployConfig {
  readonly accountId: string;
  /** The `rf-site` script/dispatch name the assets-upload-session and version/deploy endpoints address. */
  readonly scriptName: string;
  /** Secret. The Workers deploy API token scoped to `rf-site` on this account only. */
  readonly apiToken: string;
}

/** The live result of a deploy attempt, for the 32.5 orchestrator to act on (the RPC surface's result shape). */
export type DeployOutcome = OpsDeployResult;

// ---------------------------------------------------------------------------
// Pure helpers (no I/O), exported for direct testing.
// ---------------------------------------------------------------------------

/**
 * A stable digest of what a deploy intends to put live: the manifest contents plus the fixed asset routing.
 * Recorded as the operation's `request_hash` so the same generation re-entering reuses its row, and a
 * reconciliation later knows exactly which version/manifest was in flight (R60.2). Order-independent in the
 * manifest so an equivalent manifest hashes the same.
 */
export async function manifestRequestHash(manifest: SiteManifest): Promise<string> {
  const entries = Object.keys(manifest).sort().map((path) => `${path}\u0000${manifest[path]!.hash}\u0000${manifest[path]!.size}`);
  const material = `${JSON.stringify(SITE_ASSET_CONFIG)}\n${entries.join('\n')}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// The Cloudflare Direct Upload transport.
// ---------------------------------------------------------------------------

/**
 * The rf-ops assets-only site deploy. Mirrors {@link AccessSync}/{@link Containment}: an injected `fetcher`
 * (default global `fetch`) for deterministic tests, a `CloudflareApiError` on a clear refusal, and a private
 * `#call` Bearer-token/success-flag helper. It takes the `rf-core` D1 handle for the durable operation record;
 * the DO caller in 32.5 owns the actual single-in-flight lock, so this class only has to be safe to call
 * serially and to detect a concurrent/obsolete call through the durable operation identity.
 */
export class SiteDeploy {
  readonly #fetch: typeof fetch;

  constructor(readonly config: SiteDeployConfig, readonly db: D1Database, fetcher: typeof fetch = (input, init) => fetch(input, init)) {
    this.#fetch = fetcher;
  }

  /**
   * Deploy `manifest` as a new `rf-site` version under `operationId`, fenced by `epoch`.
   *
   * `generation` carries the run id and the epoch the run observed; `operationId` is the deterministic
   * epoch-labelled id (`operationId('deploy', run, epoch, versionTarget)`) the 32.5 caller passes so a
   * concurrent/obsolete re-entry reuses the same durable row rather than deploying twice. `assets` supplies
   * the bytes of the files the platform reports missing; `containmentActive` is whether independent
   * containment is currently in force. `now` is the record timestamp.
   */
  async deploySite(input: {
    readonly manifest: SiteManifest;
    readonly generation: Generation;
    readonly operationId: string;
    readonly assets: AssetSource;
    readonly containmentActive: boolean;
    readonly now: Timestamp;
  }): Promise<DeployOutcome> {
    const { manifest, generation, operationId: id, assets, containmentActive, now } = input;

    // A concurrent/obsolete re-entry is detected through the durable operation identity: if this id already
    // confirmed, do not deploy again — return its recorded version. If it is uncertain, refuse to blindly
    // redo it and ask the caller to reconcile first (R24.17, R60.2).
    const prior = await readOperation(this.db, id);
    if (prior?.state === 'confirmed') {
      return { promoted: true, keepContainment: false, versionId: prior.providerRef, operationId: id, operationState: 'confirmed', reason: 'promoted' };
    }
    if (prior?.state === 'uncertain') {
      return { promoted: false, keepContainment: containmentActive, versionId: prior.providerRef, operationId: id, operationState: 'uncertain', reason: 'uncertain' };
    }

    // Record that the epoch-labelled operation is about to reach the provider (content-free: the request
    // digest names the exact version/manifest, never a research body). Idempotent on the id (R60.2).
    const requestHash = await manifestRequestHash(manifest);
    await beginOperation(this.db, { id, kind: 'deploy', requestHash }, now);

    // --- Direct Upload: register the manifest -> missing files + resumable (1-hour) token (R24.7) ---
    const session = await this.#startUploadSession(manifest);

    // --- Upload ONLY the missing files the platform returned in `buckets`; unchanged files are skipped ---
    const completionToken = await this.#uploadMissing(session, manifest, assets);

    // --- Create the assets-only version (no script): fixed html/404 routing (design, R45.1) ---
    // The version is created but NOT yet promoted; promotion is fenced below. A CloudflareApiError is a
    // DEFINITE refusal (settle failed, rethrow). Any other thrown/lost answer is UNCERTAIN: we do not know
    // whether the version was created, so we record `uncertain` with the manifest digest and never blind
    // -retry — a later reconcile against actual provider state must decide first (R24.17, R60.2).
    let versionId: string;
    try {
      versionId = await this.#createVersion(completionToken);
    } catch (error) {
      if (error instanceof CloudflareApiError) {
        await settleOperation(this.db, id, { state: 'failed', detail: `create:${error.status}` }, now);
        throw error;
      }
      await settleOperation(this.db, id, { state: 'uncertain', detail: 'create:lost_answer' }, now);
      return { promoted: false, keepContainment: containmentActive, versionId: null, operationId: id, operationState: 'uncertain', reason: 'uncertain' };
    }

    // --- Serialized epoch fence, BEFORE promotion: reread the authoritative epoch (R24.16, R24.17, R60.2) ---
    const before = await readEpoch(this.db);
    if (before !== generation.epoch) {
      // Stale before we even promote: an obsolete operation. Do NOT deploy the version; keep containment.
      const decision = promoteUnderEpoch({ expected: generation.epoch, before, after: before, containmentActive });
      await settleOperation(this.db, id, { state: 'failed', detail: `stale_before:e${before}`, providerRef: versionId }, now);
      return { promoted: false, keepContainment: decision.keepContainment, versionId, operationId: id, operationState: 'failed', reason: decision.reason };
    }

    // --- Promote the created version to 100% ---
    // A refusal is definite (failed, rethrow). A lost answer during promotion is UNCERTAIN: the version may
    // or may not be live, so we record the exact version id + manifest under `uncertain`, keep containment,
    // and leave reconciliation to decide against the real provider state before any retry (R24.17, R60.2).
    try {
      await this.#promote(versionId);
    } catch (error) {
      if (error instanceof CloudflareApiError) {
        await settleOperation(this.db, id, { state: 'failed', detail: `deploy:${error.status}`, providerRef: versionId }, now);
        throw error;
      }
      await settleOperation(this.db, id, { state: 'uncertain', detail: 'deploy:lost_answer', providerRef: versionId }, now);
      return { promoted: false, keepContainment: containmentActive, versionId, operationId: id, operationState: 'uncertain', reason: 'uncertain' };
    }

    // --- Serialized epoch fence, AFTER promotion: reread and run the pure before/after decision ---
    const after = await readEpoch(this.db);
    const decision = promoteUnderEpoch({ expected: generation.epoch, before, after, containmentActive });
    if (!decision.promoted) {
      // A confidentiality save raced the promotion: the now-live version may show suppressed material, so it
      // must not stand and containment is kept until the next authorized generation verifies (R24.17).
      await settleOperation(this.db, id, { state: 'failed', detail: `raced_after:e${after}`, providerRef: versionId }, now);
      return { promoted: false, keepContainment: decision.keepContainment, versionId, operationId: id, operationState: 'failed', reason: decision.reason };
    }

    // Clear success: record the exact version id as the provider reference. 32.5 owns the separate verify
    // step and records `publishRuns.versionId`/`verifiedAt`; 32.1 records what it deployed.
    await settleOperation(this.db, id, { state: 'confirmed', providerRef: versionId }, now);
    return { promoted: true, keepContainment: decision.keepContainment, versionId, operationId: id, operationState: 'confirmed', reason: 'promoted' };
  }

  /**
   * Reconcile an earlier uncertain deploy against the provider's actual state BEFORE any retry (R24.17,
   * R60.2). `observed` is what a fresh read of the provider reports the version to be; the pure
   * {@link reconcile} decides whether the uncertain operation can be adopted as done or whether denial is
   * kept and the caller must re-run under the latest authorized generation. Never blind-retries.
   */
  async reconcileDeploy(args: {
    readonly operationId: string;
    readonly generation: Generation;
    readonly observed: Reconciliation['observed'];
    readonly now: Timestamp;
  }): Promise<ReconciliationResult> {
    const authoritative = await readEpoch(this.db);
    const result = reconcile({ operation: args.generation, authoritative, observed: args.observed, intent: 'present' });
    if (result.resolved) {
      const row = await readOperation(this.db, args.operationId);
      await settleOperation(this.db, args.operationId, { state: 'confirmed', providerRef: row?.providerRef ?? null }, args.now);
    }
    return result;
  }

  // --- Direct Upload phase 1: register the manifest, get missing hashes + the one-hour upload token ---
  async #startUploadSession(manifest: SiteManifest): Promise<{ readonly token: string; readonly missing: readonly string[] }> {
    const result = await this.#call<{ jwt?: string; buckets?: string[][] }>(
      'POST',
      `/accounts/${this.config.accountId}/workers/scripts/${this.config.scriptName}/assets-upload-session`,
      { manifest },
    );
    const token = result.jwt;
    if (!token) throw new CloudflareApiError(200, []);
    // `buckets` lists only the hashes the platform is MISSING; an absent/empty buckets means nothing to upload.
    const missing = (result.buckets ?? []).flat();
    return { token, missing };
  }

  // --- Direct Upload phase 2: upload ONLY the missing files; the final response carries the completion token ---
  async #uploadMissing(
    session: { readonly token: string; readonly missing: readonly string[] },
    manifest: SiteManifest,
    assets: AssetSource,
  ): Promise<string> {
    if (session.missing.length === 0) {
      // Nothing missing: every file was already uploaded in a prior version. The upload token doubles as the
      // completion token when no upload is needed.
      return session.token;
    }
    const hashToPath = new Map(Object.entries(manifest).map(([path, file]) => [file.hash, path]));
    let completionToken: string | null = null;
    for (const hash of session.missing) {
      if (!hashToPath.has(hash)) throw new Error(`The platform asked for a hash not in the manifest: ${hash}.`);
      const body = await assets(hash);
      if (!body) throw new Error(`No bytes available for a missing file (hash ${hash}).`);
      const form = new FormData();
      form.append(hash, new Blob([body.base64], { type: body.contentType }), hash);
      const response = await this.#fetch(`${CLOUDFLARE_API}/accounts/${this.config.accountId}/workers/assets/upload?base64=true`, {
        method: 'POST',
        headers: { authorization: `Bearer ${session.token}` },
        body: form,
      });
      const result = await response.json<{ success?: boolean; errors?: { code?: number }[]; result?: { jwt?: string } }>().catch(() => ({ success: false as boolean, errors: [] as { code?: number }[], result: undefined }));
      if (!response.ok || result.success !== true) {
        throw new CloudflareApiError(response.status, (result.errors ?? []).flatMap((e) => (typeof e.code === 'number' ? [e.code] : [])));
      }
      if (result.result?.jwt) completionToken = result.result.jwt;
    }
    if (!completionToken) throw new CloudflareApiError(201, []);
    return completionToken;
  }

  // --- Direct Upload phase 3a: create the assets-only version (no script module) with fixed routing ---
  async #createVersion(completionToken: string): Promise<string> {
    const result = await this.#call<{ id?: string }>(
      'POST',
      `/accounts/${this.config.accountId}/workers/scripts/${this.config.scriptName}/versions`,
      { assets: { jwt: completionToken, config: SITE_ASSET_CONFIG }, compatibility_date: COMPAT_DATE },
    );
    if (!result.id) throw new CloudflareApiError(200, []);
    return result.id;
  }

  // --- Direct Upload phase 3b: deploy the created version to 100% ---
  async #promote(versionId: string): Promise<void> {
    await this.#call(
      'POST',
      `/accounts/${this.config.accountId}/workers/scripts/${this.config.scriptName}/deployments`,
      { strategy: 'percentage', versions: [{ version_id: versionId, percentage: 100 }] },
    );
  }

  /** Bearer-token/success-flag Cloudflare API call, returning the `result` payload (reuses the AccessSync pattern). */
  async #call<T>(method: string, path: string, body: unknown): Promise<T> {
    if (!this.config.accountId || !this.config.scriptName || !this.config.apiToken) throw new Error('Site deploy is not configured.');
    const response = await this.#fetch(`${CLOUDFLARE_API}${path}`, {
      method, body: JSON.stringify(body), headers: { authorization: `Bearer ${this.config.apiToken}`, 'content-type': 'application/json' },
    });
    const result = await response.json<{ success?: boolean; errors?: { code?: number }[]; result?: T }>().catch(() => ({ success: false as boolean, errors: [] as { code?: number }[], result: undefined }));
    if (!response.ok || result.success !== true) {
      throw new CloudflareApiError(response.status, (result.errors ?? []).flatMap((e) => (typeof e.code === 'number' ? [e.code] : [])));
    }
    return (result.result ?? {}) as T;
  }
}

/** The compatibility date the `rf-site` version is pinned to; a fixed, correctable constant. */
export const COMPAT_DATE = '2025-01-01';
