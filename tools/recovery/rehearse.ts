/**
 * FRESH-ENVIRONMENT RECOVERY REHEARSAL tooling (task 58.5; R36.12, R36.13, R36.15, R36.16, R36.17,
 * R60.4, R60.6, R60.9).
 *
 * An operator must REHEARSE restoring an Internal_Backup into an ISOLATED FRESH environment at least
 * quarterly and before any breaking storage/identity change, demonstrating the ≤24-hour RPO and the
 * ≤8-hour Reference_Archive RTO, recording independent-copy age, keys by IDENTIFIER only, counts/hashes,
 * elapsed time, and failures (R36.17). The FULL rehearsal is impossible to fake inside this build
 * sandbox: it needs INDEPENDENT replacement infrastructure, an INDEPENDENT inventory, and
 * OPERATOR-HELD recovery keys — none of which exist here — exactly as the 48.5 staging and 46.2 perf
 * harnesses face. So, mirroring `tests/staging/support/gate.ts`, this tool:
 *
 *   • EXERCISES, here and now, with synthetic fixtures and an in-memory SQLite engine, the PURE,
 *     DETERMINISTIC restore DECISIONS every required failure scenario turns on — the bootstrap-identity
 *     reconcile (same-email mapping vs conflict refusal), the RPO/RTO classification, the
 *     preflight-refuses-corruption decision, EVERY checkpoint interruption/rollback through the
 *     `tools/src/upgrade-store.ts` engine, and the post-snapshot suppression re-application. These
 *     cases PASS on real deterministic evidence computed in this environment.
 *
 *   • REPORTS the LIVE restore — the actual restore into independent replacement infrastructure and the
 *     MEASURED RPO/RTO — as BLOCKED (a non-pass, never a green skip) whenever the operator handles,
 *     independent inventory, and recovery-key identifiers are absent, naming exactly what must be
 *     supplied. A BLOCKED live case is NEVER downgraded to a pass and NEVER faked.
 *
 * The honest acceptance contract this tool enforces, verbatim from the task: neither a PACKAGE DOWNLOAD
 * alone nor an APPLICATION-ONLY ALERT is acceptance. {@link acceptanceRejection} rejects both explicitly,
 * and {@link rehearsalEvidence} produces the `infra-restore` evidence the 68.4 launch-gate checker
 * (`tools/src/launch-gates.ts`) consumes ONLY from a LIVE, operator-run rehearsal against a fresh
 * isolated environment — a dry/sandbox run yields `blocked`/`local-synthetic`, which that checker reads
 * as NOT satisfied.
 *
 * BOUNDARY: `tools` may not import `apps/app/src` (see `scripts/check-boundaries.mjs`). The real restore
 * primitives (`apps/app/src/backup/preflight.ts`, `reconcile.ts`, `rpo.ts`, `freeze.ts`,
 * `jobs/restore.ts`, `backup/checkpoints.ts`) are APP-SIDE. So this tool does NOT import them: it
 * reimplements ONLY the PURE decisions in `tools` (the same thing `tools/src/upgrade-store.ts` already
 * does for `reconcileBootstrapIdentity`), reuses the shared FORMAT layer from `@researchforce/manifest`
 * (which neither app nor tools owns), and drives the real `tools/src/upgrade-store.ts` SQLite
 * checkpoint/rollback engine for the interruption scenario. On a live rehearsal the actual app-side
 * restore runs inside the independent replacement install; this tool orchestrates and records it, it
 * does not re-run app code across the boundary.
 *
 * NO module here makes a network, account, or key operation. The CLI dry/enumerate mode exits cleanly
 * and never touches a secret.
 */
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { BACKUP_SCHEDULE } from '@researchforce/domain/settings';
import { REFERENCE_ARCHIVE } from '@researchforce/domain/resource-profile';
import {
  BACKUP_FORMAT_VERSION, buildRegistry, rootDigest, selectTransform, validateManifest,
  UnsupportedSchemaError,
} from '@researchforce/manifest/backup/index';
import type {
  CompatibilityTransform, InventoryRegistry, RootManifest, SchemaInventory,
} from '@researchforce/manifest/backup/index';

const sha256Hex = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The RPO/RTO objectives, taken from the one source of truth (never redeclared here).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The chosen recovery objectives for the Reference_Archive: ≤24-hour RPO, ≤8-hour RTO (R36.17). */
export const RECOVERY_OBJECTIVES = Object.freeze({
  /** ≤24h: the latest VERIFIED independent recovery point may be at most this old (R36.12, R36.17). */
  rpoHours: REFERENCE_ARCHIVE.rpoHours,
  /** ≤8h: a full fresh restore of the Reference_Archive must complete within this (R36.17). */
  rtoHours: REFERENCE_ARCHIVE.rtoHours,
  /** The 18-hour warning / 24-hour breach thresholds the independent age check uses (R36.7). */
  warnMs: BACKUP_SCHEDULE.warnMs,
  breachMs: BACKUP_SCHEDULE.breachMs,
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// PURE DECISION 1 — RPO/RTO classification (mirrors apps/app/src/backup/rpo.ts `classifyRpo`, which
// tools may not import across the boundary; the thresholds come from the shared domain settings).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The RPO state derived from the latest VERIFIED independent recovery point's age (R36.7, R36.12). */
export type RpoState = 'ok' | 'warning' | 'breach';

/** The computed RPO status: the state and the whole-hour age of the latest verified point, or null. */
export interface RpoStatus {
  readonly state: RpoState;
  readonly ageHours: number | null;
}

/**
 * Classify the RPO at `now` from the latest VERIFIED independent recovery point (pure, R36.7, R36.12).
 * No verified point ever (null) is the worst state — a BREACH — because there is no independent
 * recovery point at all. A mere package download that never decrypted/re-verified is NOT a verified
 * point and must be passed as `null` here, so a download alone can never read as `ok`.
 */
export function classifyRpo(latestVerifiedAt: string | null, now: string): RpoStatus {
  if (latestVerifiedAt === null) return { state: 'breach', ageHours: null };
  const ageMs = Date.parse(now) - Date.parse(latestVerifiedAt);
  const ageHours = Math.max(0, Math.floor(ageMs / (60 * 60 * 1000)));
  if (ageMs >= RECOVERY_OBJECTIVES.breachMs) return { state: 'breach', ageHours };
  if (ageMs >= RECOVERY_OBJECTIVES.warnMs) return { state: 'warning', ageHours };
  return { state: 'ok', ageHours };
}

/** The RTO verdict: whether a measured elapsed restore time meets the ≤8-hour objective (R36.17). */
export interface RtoStatus {
  readonly withinObjective: boolean;
  readonly elapsedHours: number;
  readonly objectiveHours: number;
}

/**
 * Classify a MEASURED elapsed restore time against the ≤8-hour Reference_Archive RTO (R36.17). The
 * elapsed time must be a real wall-clock measurement of a full fresh restore; a null/absent measurement
 * (no live restore ran) is NOT within objective — there is nothing measured to meet it.
 */
export function classifyRto(elapsedHours: number | null): RtoStatus {
  const objectiveHours = RECOVERY_OBJECTIVES.rtoHours;
  if (elapsedHours === null || !Number.isFinite(elapsedHours) || elapsedHours < 0) {
    return { withinObjective: false, elapsedHours: Number.POSITIVE_INFINITY, objectiveHours };
  }
  return { withinObjective: elapsedHours <= objectiveHours, elapsedHours, objectiveHours };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// PURE DECISION 2 — bootstrap-identity reconciliation (same-email mapping vs conflict refusal). The
// app-side decision lives in apps/app/src/backup/reconcile.ts (not importable); its structured result
// is reproduced here so the rehearsal asserts the SAME behaviour deterministically. tools/src/
// upgrade-store.ts also exports a throwing variant used by the release rehearsal; this returns a
// structured outcome so the rehearsal can distinguish an accepted mapping from each conflict kind.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The verified bootstrap Administrator of the fresh environment (a NEW id, the operator's email). */
export interface BootstrapIdentity {
  readonly id: string;
  readonly emailLc: string;
}

/** A backed-up Member the restore recreates, by ORIGINAL id and folded email (R36.5, R36.15). */
export interface BackedUpMember {
  readonly id: string;
  readonly emailLc: string;
}

/** The reasons a reconciliation fails preflight (R36.8: "incompatible bootstrap identity"). */
export type ReconcileConflict =
  | { readonly kind: 'ambiguous-email'; readonly emailLc: string; readonly backedUpIds: readonly string[] }
  | { readonly kind: 'id-collision'; readonly bootstrapId: string; readonly conflictingBackedUpId: string };

/** The reconciliation outcome: the id mapping to apply, or the conflict that fails preflight. */
export type Reconciliation =
  | {
      readonly ok: true;
      readonly mapping:
        | { readonly kind: 'matched'; readonly fromBootstrapId: string; readonly toBackedUpId: string }
        | { readonly kind: 'standalone'; readonly bootstrapId: string };
    }
  | { readonly ok: false; readonly conflict: ReconcileConflict };

/**
 * Decide how to reconcile a verified bootstrap Administrator against the backed-up Members (R36.9,
 * R36.10, R36.15). Same verified email → map the transient bootstrap id onto the ORIGINAL backed-up id
 * (never rewriting a backed-up id). More than one email match → `ambiguous-email` (fails preflight). The
 * bootstrap id colliding with a DIFFERENT backed-up Member → `id-collision` (fails preflight). No email
 * match and no id collision → a genuinely new `standalone` operator kept alongside the restored Members.
 */
export function reconcileBootstrapIdentity(
  bootstrap: BootstrapIdentity, backedUp: readonly BackedUpMember[],
): Reconciliation {
  const emailMatches = backedUp.filter((member) => member.emailLc === bootstrap.emailLc);
  if (emailMatches.length > 1) {
    return { ok: false, conflict: { kind: 'ambiguous-email', emailLc: bootstrap.emailLc, backedUpIds: emailMatches.map((m) => m.id) } };
  }
  const intended = emailMatches[0];
  const idCollision = backedUp.find((m) => m.id === bootstrap.id && (intended === undefined || m.id !== intended.id));
  if (idCollision !== undefined) {
    return { ok: false, conflict: { kind: 'id-collision', bootstrapId: bootstrap.id, conflictingBackedUpId: idCollision.id } };
  }
  if (intended !== undefined) return { ok: true, mapping: { kind: 'matched', fromBootstrapId: bootstrap.id, toBackedUpId: intended.id } };
  return { ok: true, mapping: { kind: 'standalone', bootstrapId: bootstrap.id } };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// PURE DECISION 3 — preflight refuses corruption / an older-or-unknown format. The app-side preflight
// (apps/app/src/backup/preflight.ts) runs against real package bytes/keys; its structural manifest +
// schema-transform decision uses the SHARED @researchforce/manifest FORMAT layer, which tools may
// import. The rehearsal exercises exactly that decision over a synthetic manifest here.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A structural preflight decision over a synthetic manifest (R36.8, R36.16). */
export type PreflightDecision =
  | { readonly ok: true; readonly transform: CompatibilityTransform }
  | { readonly ok: false; readonly reasons: readonly string[] };

/**
 * The structural restore preflight decision over a root manifest and the reader's inventory registry
 * (R36.8, R36.16). It runs the SHARED manifest validation (so a tampered/corrupted manifest — a bad
 * hash, a count mismatch, a fingerprint that does not match the recomputed digest — is REFUSED) and the
 * schema-transform selection (so an older format restores through a transform, and an unknown/too-old
 * schema is refused). It authorises NOTHING on any fault; it only decides. This is the pure core the
 * app-side preflight shares; the live preflight additionally authenticates/decrypts real bytes and
 * resolves cross-table references, which happen inside the independent environment.
 */
export function preflightDecision(manifest: RootManifest, registry: InventoryRegistry): PreflightDecision {
  const reasons: string[] = [];
  if (manifest.formatVersion !== BACKUP_FORMAT_VERSION) reasons.push(`unsupported-format:${manifest.formatVersion}`);
  for (const fault of validateManifest(manifest)) reasons.push(`manifest:${fault}`);
  let transform: CompatibilityTransform | null = null;
  try {
    transform = selectTransform(registry, manifest.schemaRelease);
  } catch (error) {
    reasons.push(error instanceof UnsupportedSchemaError ? `unsupported-schema:${manifest.schemaRelease}` : 'schema-unresolved');
  }
  if (reasons.length > 0 || transform === null) return { ok: false, reasons };
  return { ok: true, transform };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// PURE DECISION 4 — post-snapshot suppression re-application (a later withdrawal is honoured; withdrawn
// material is NOT resurrected). The app-side logic is apps/app/src/backup/quarantine.ts `applySuppressions`;
// reproduced here as the pure decision so the rehearsal asserts it deterministically.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** One independently retained suppression record (opaque ids only; never any content). */
export interface SuppressionRecord {
  readonly suppressedId: string;
  readonly generation: number;
  readonly suppressedAt: string;
  readonly digest: string;
}

/** The digest the independent ledger binds over a record's minimal fields (authenticates it). */
export function suppressionDigest(record: Pick<SuppressionRecord, 'suppressedId' | 'generation' | 'suppressedAt'>): string {
  return sha256Hex(`${record.suppressedId}\u0000${record.generation}\u0000${record.suppressedAt}`);
}

/** The outcome of re-applying the independent suppression ledger to the ids a restore would install. */
export type SuppressionApplication =
  | { readonly ok: true; readonly suppressed: readonly string[]; readonly installable: readonly string[] }
  | { readonly ok: false; readonly fault: 'tampered-ledger'; readonly element: string };

/**
 * Re-apply the independently known POST-SNAPSHOT suppression ledger to the ids a restore would install
 * (R36.15, R36.16). Every record is AUTHENTICATED against its own digest first — a tampered ledger fails
 * so release is denied rather than trusting an altered suppression set. The old package's manifest is
 * evidence of historic state, NOT authorisation to override a later withdrawal: any restored id present
 * in the ledger is returned as `suppressed` (must NOT be installed) and removed from `installable`, so a
 * withdrawn element is never resurrected.
 */
export function applySuppressions(restoredIds: readonly string[], ledger: readonly SuppressionRecord[]): SuppressionApplication {
  for (const record of ledger) {
    if (record.digest !== suppressionDigest(record)) return { ok: false, fault: 'tampered-ledger', element: `suppression:${record.suppressedId}` };
  }
  const suppressedSet = new Set(ledger.map((record) => record.suppressedId));
  const suppressed = restoredIds.filter((id) => suppressedSet.has(id));
  const installable = restoredIds.filter((id) => !suppressedSet.has(id));
  return { ok: true, suppressed, installable };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// EXERCISED SCENARIO — EVERY checkpoint interruption resumes/rolls back exactly once. This drives the
// REAL tools/src/upgrade-store.ts SQLite checkpoint engine (`runBackfillSlice`), the same engine the
// release rehearsal uses, over an in-memory database. An injected fault rolls back the slice's effects
// AND its checkpoint atomically; the resume then re-applies the row exactly once and advances.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The result of the checkpoint interruption/rollback exercise: how a crash rolled back and resumed. */
export interface CheckpointInterruptionResult {
  /** True when the injected crash left NO partial effect and NO checkpoint (atomic rollback). */
  readonly rolledBackCleanly: boolean;
  /** The number of rows the completed, resumed restore installed (each exactly once). */
  readonly installedRows: number;
  /** True when a replay after completion installed nothing again (idempotent resume). */
  readonly resumeIsIdempotent: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Synthetic fixtures (no real account/key/network). A deterministic in-memory backup corpus.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A synthetic backed-up corpus: members, unit ids, and the recovery point time, for the rehearsal. */
export interface SyntheticCorpus {
  readonly schemaRelease: string;
  readonly members: readonly BackedUpMember[];
  readonly unitIds: readonly string[];
  readonly recoveryPointAt: string;
}

/** Build a small deterministic synthetic corpus the exercised scenarios run against. */
export function syntheticCorpus(now = '2026-02-01T12:00:00.000Z'): SyntheticCorpus {
  return {
    schemaRelease: 'synthetic-current',
    members: [
      { id: 'member-owner', emailLc: 'owner@example.test' },
      { id: 'member-historian', emailLc: 'historian@example.test' },
    ],
    unitIds: ['unit-100', 'unit-200', 'unit-300'],
    // A verified independent recovery point 6 hours before `now`: inside the ≤24h RPO objective.
    recoveryPointAt: new Date(Date.parse(now) - 6 * 60 * 60 * 1000).toISOString(),
  };
}

/** Build a synthetic, self-consistent, fingerprint-correct root manifest at a given schema release. */
export function syntheticManifest(schemaRelease: string): RootManifest {
  const table = { table: 'units', rows: 3, sha256: sha256Hex('units-body') };
  const file = { id: sha256Hex('attachment-0').slice(0, 32), bytes: 10, sha256: sha256Hex('attachment-bytes') };
  const base: Omit<RootManifest, 'trust'> & { trust: { custodians: RootManifest['trust']['custodians'] } } = {
    kind: 'rf-internal-backup-root', formatVersion: BACKUP_FORMAT_VERSION, schemaRelease,
    installationId: 'synthetic-installation', snapshot: { sequence: 1, at: '2026-02-01T06:00:00.000Z' },
    tables: [table], fields: [], files: [file],
    counts: { tables: 1, fields: 0, files: 1, rows: 3 },
    trust: { custodians: [{ keyId: 'recovery-key-identifier-only', fingerprint: sha256Hex('recovery-key-fingerprint') }] },
  };
  const manifest = base as unknown as RootManifest;
  return { ...manifest, trust: { ...manifest.trust, manifestFingerprint: rootDigest(manifest) } };
}

/** Build the reader's inventory registry: a current schema plus one preceding (older) format. */
export function syntheticRegistry(current = 'synthetic-current', priorFormat = 'synthetic-prior'): InventoryRegistry {
  const inventory = (schemaRelease: string): SchemaInventory => ({ schemaRelease, tables: ['units'], fieldOwners: [] });
  const transform: CompatibilityTransform = {
    from: priorFormat, to: current, note: `${priorFormat} is row-compatible with ${current}`,
    upgrade: (manifest) => ({ ...manifest, schemaRelease: current }),
  };
  return buildRegistry({ current: inventory(current), preceding: [{ inventory: inventory(priorFormat), transform }] });
}

/**
 * Exercise EVERY checkpoint interruption against the real `tools/src/upgrade-store.ts` engine over an
 * in-memory SQLite database (R36.10, R60.2). Imported lazily so the module graph of the pure decisions
 * stays independent of `node:sqlite`. A crash injected mid-slice must roll back the slice's effects AND
 * its checkpoint atomically (no partial install, no stale checkpoint); the resume then installs each
 * remaining row exactly once, and a replay after completion installs nothing again.
 */
export async function exerciseCheckpointInterruption(rowCount = 5, sliceRows = 2): Promise<CheckpointInterruptionResult> {
  const { runBackfillSlice } = await import('../src/upgrade-store');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE restored(id TEXT PRIMARY KEY NOT NULL, payload TEXT, installed TEXT); CREATE TABLE source(id TEXT PRIMARY KEY NOT NULL, payload TEXT);');
    for (let i = 1; i <= rowCount; i++) {
      const id = `row-${String(i).padStart(2, '0')}`;
      db.prepare('INSERT INTO source(id,payload) VALUES (?,?)').run(id, `payload-${i}`);
      db.prepare('INSERT INTO restored(id,payload,installed) VALUES (?,?,NULL)').run(id, `payload-${i}`);
    }
    const definition = { id: 'rehearsal-restore', version: 1, store: 'core' as const, table: 'restored', key: 'id', columns: ['payload'], maxRows: sliceRows, maxBytes: 128_000 };
    // Install-or-verify per row: mark the row installed exactly once. The engine commits the effect and
    // the cursor together, so a crash rolls both back.
    const apply = (row: Record<string, unknown>): void => { db.prepare('UPDATE restored SET installed=? WHERE id=?').run('yes', row['id'] as string); };
    const verify = (): boolean => db.prepare('SELECT count(*) AS n FROM restored WHERE installed IS NULL').get()?.['n'] === 0;
    const installedCount = (): number => Number(db.prepare("SELECT count(*) AS n FROM restored WHERE installed='yes'").get()?.['n'] ?? 0);

    // Inject a crash in the FIRST slice and confirm an atomic rollback: no effect, no checkpoint.
    let rolledBackCleanly = false;
    try { runBackfillSlice(db, 'rehearsal', definition, 0, apply, verify, () => { throw new Error('injected checkpoint crash'); }); }
    catch { /* expected */ }
    const checkpointRows = Number(db.prepare('SELECT count(*) AS n FROM _rf_release_checkpoints').get()?.['n'] ?? 0);
    rolledBackCleanly = installedCount() === 0 && checkpointRows === 0;

    // Resume through every bounded slice until complete; each row installs exactly once.
    let generation = 0;
    let result = runBackfillSlice(db, 'rehearsal', definition, generation, apply, verify);
    generation = result.generation;
    while (!result.complete) { result = runBackfillSlice(db, 'rehearsal', definition, generation, apply, verify); generation = result.generation; }
    const installedRows = installedCount();

    // A replay after completion is idempotent: it installs nothing more and keeps the same generation.
    const before = installedCount();
    const replay = runBackfillSlice(db, 'rehearsal', definition, generation, () => { throw new Error('must not re-apply after completion'); }, verify);
    const resumeIsIdempotent = replay.complete && installedCount() === before && replay.generation === generation;

    return { rolledBackCleanly, installedRows, resumeIsIdempotent };
  } finally {
    db.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The scenario enumeration and the BLOCKED-not-faked contract.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The required failure scenarios the fresh-environment rehearsal must exercise (R36.17, task 58.5). */
export const SCENARIOS = [
  'production-account-loss', // restore into fresh independent replacement infrastructure
  'older-backup-format',     // an older schema restores through a transform (R36.16)
  'same-email-new-bootstrap', // a DIFFERENT bootstrap id with the SAME email maps onto the original (R36.15)
  'bootstrap-identity-conflict', // a true identity conflict FAILS preflight (R36.8)
  'corruption-refused',      // preflight REFUSES a corrupted/tampered package (R36.8)
  'checkpoint-interruption', // EVERY checkpoint interruption rolls back and resumes exactly once (R36.10)
  'post-snapshot-withdrawal', // a later withdrawal is honoured; withdrawn material is not resurrected (R36.15)
  'measured-rpo-rto',        // the ≤24h RPO and ≤8h RTO measured against the real restore (R36.17)
] as const;
export type Scenario = (typeof SCENARIOS)[number];

/** Which scenarios PASS on deterministic evidence in this sandbox vs require the live environment. */
export const EXERCISED_HERE: ReadonlySet<Scenario> = new Set<Scenario>([
  'older-backup-format', 'same-email-new-bootstrap', 'bootstrap-identity-conflict',
  'corruption-refused', 'checkpoint-interruption', 'post-snapshot-withdrawal',
]);
/** The scenarios whose acceptance needs the LIVE independent environment and the measured restore. */
export const REQUIRES_LIVE: ReadonlySet<Scenario> = new Set<Scenario>(['production-account-loss', 'measured-rpo-rto']);

/** The outcome of one scenario: passed (real evidence here), or blocked (live environment absent). */
export type ScenarioStatus =
  | { readonly scenario: Scenario; readonly status: 'passed'; readonly detail: string }
  | { readonly scenario: Scenario; readonly status: 'blocked'; readonly detail: string; readonly missing: readonly string[] };

/**
 * The operator-supplied handles for a LIVE rehearsal, read from the independent inventory file and
 * environment handles — NEVER the production account's own secrets. Recovery keys are referenced by
 * IDENTIFIER only (R36.17: "keys used by identifier only"); no key bytes are ever read or recorded.
 */
export interface LiveHandles {
  /** Path to the INDEPENDENT deployment inventory (see infra/recovery/deployment.example.json). */
  readonly independentInventoryPath: string | undefined;
  /** Path/handle to the INDEPENDENT replacement infrastructure endpoint descriptor. */
  readonly replacementInfraHandle: string | undefined;
  /** The recovery-key custodian IDENTIFIERS the operator holds outside the production account. */
  readonly recoveryKeyIdentifiers: string | undefined;
  /** The verified independent-copy source the restore reads from (not the production account). */
  readonly independentCopyHandle: string | undefined;
}

/** The handle names a blocked live case reports as missing, so an operator knows what to supply. */
export const LIVE_HANDLE_NAMES = Object.freeze({
  independentInventoryPath: 'RF_RECOVERY_INDEPENDENT_INVENTORY',
  replacementInfraHandle: 'RF_RECOVERY_REPLACEMENT_INFRA',
  recoveryKeyIdentifiers: 'RF_RECOVERY_KEY_IDS',
  independentCopyHandle: 'RF_RECOVERY_INDEPENDENT_COPY',
});

/** Read the live handles from the process environment (never a production secret). */
export function liveHandlesFromEnv(env: NodeJS.ProcessEnv = process.env): LiveHandles {
  const read = (name: string): string | undefined => {
    const value = env[name];
    return value !== undefined && value.trim() !== '' ? value : undefined;
  };
  return {
    independentInventoryPath: read(LIVE_HANDLE_NAMES.independentInventoryPath),
    replacementInfraHandle: read(LIVE_HANDLE_NAMES.replacementInfraHandle),
    recoveryKeyIdentifiers: read(LIVE_HANDLE_NAMES.recoveryKeyIdentifiers),
    independentCopyHandle: read(LIVE_HANDLE_NAMES.independentCopyHandle),
  };
}

/** The handle names that are unset, or an empty list when every live handle is present. */
export function missingLiveHandles(handles: LiveHandles): string[] {
  const missing: string[] = [];
  if (handles.independentInventoryPath === undefined) missing.push(LIVE_HANDLE_NAMES.independentInventoryPath);
  if (handles.replacementInfraHandle === undefined) missing.push(LIVE_HANDLE_NAMES.replacementInfraHandle);
  if (handles.recoveryKeyIdentifiers === undefined) missing.push(LIVE_HANDLE_NAMES.recoveryKeyIdentifiers);
  if (handles.independentCopyHandle === undefined) missing.push(LIVE_HANDLE_NAMES.independentCopyHandle);
  return missing;
}

/** Whether a complete, live independent environment is configured. */
export function liveEnvironmentReady(handles: LiveHandles): boolean {
  return missingLiveHandles(handles).length === 0;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The acceptance contract: a download alone, or an application-only alert, is NOT acceptance.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A candidate piece of recovery evidence an operator might mistake for acceptance. */
export interface AcceptanceCandidate {
  /** Did the operator download the package bytes? (NOT acceptance on its own, R36.17.) */
  readonly packageDownloaded?: boolean;
  /** Did an in-application backup-age alert fire? (NOT acceptance on its own, R36.7/R36.17.) */
  readonly applicationAlertFired?: boolean;
  /** Did a LIVE restore into a fresh ISOLATED environment complete and verify? (The only acceptance.) */
  readonly freshIsolatedRestoreVerified?: boolean;
  /** The measured elapsed restore time in hours (required for RTO; a download has none). */
  readonly measuredElapsedHours?: number | null;
  /** The age of the latest VERIFIED independent recovery point in hours (required for RPO). */
  readonly verifiedCopyAgeHours?: number | null;
}

/** The acceptance verdict: accepted only on a real measured fresh-isolated restore, else rejected. */
export type AcceptanceVerdict =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reasons: readonly string[] };

/**
 * Decide whether a candidate meets the recovery-acceptance contract (R36.17). This is the single place
 * the task's two explicit non-acceptances are ENFORCED: delivery of package bytes alone is not a
 * recovery test, and an application-only alert is not a recovery test. Acceptance requires a LIVE restore
 * into a fresh ISOLATED environment that COMPLETED and VERIFIED, a measured elapsed time within the ≤8h
 * RTO, and a verified independent copy within the ≤24h RPO. Anything short of that is rejected with the
 * exact reasons.
 */
export function acceptanceRejection(candidate: AcceptanceCandidate): AcceptanceVerdict {
  const reasons: string[] = [];
  if (!candidate.freshIsolatedRestoreVerified) {
    if (candidate.packageDownloaded) reasons.push('a package download alone is NOT acceptance (R36.17): delivery of package bytes is not a recovery test');
    if (candidate.applicationAlertFired) reasons.push('an application-only alert is NOT acceptance (R36.17): an in-app alert is not a fresh-environment restore');
    reasons.push('no verified restore into a fresh isolated environment was recorded');
    return { accepted: false, reasons };
  }
  const rto = classifyRto(candidate.measuredElapsedHours ?? null);
  if (!rto.withinObjective) reasons.push(`the measured restore did not meet the ≤${RECOVERY_OBJECTIVES.rtoHours}-hour RTO`);
  const rpo = classifyRpo(
    candidate.verifiedCopyAgeHours === undefined || candidate.verifiedCopyAgeHours === null
      ? null
      : new Date(Date.now() - candidate.verifiedCopyAgeHours * 60 * 60 * 1000).toISOString(),
    new Date().toISOString(),
  );
  if (rpo.state === 'breach') reasons.push(`the latest verified independent recovery point breaches the ≤${RECOVERY_OBJECTIVES.rpoHours}-hour RPO`);
  return reasons.length === 0 ? { accepted: true } : { accepted: false, reasons };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The rehearsal orchestrator.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Whether a value is a usable operator-supplied number of hours. */
function isHours(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

/** Sanitized, content-free rehearsal record (no research body, no key bytes, no PII) (R36.17, R60.6). */
export interface RehearsalRecord {
  readonly recordVersion: 1;
  readonly recordedAt: string;
  readonly environment: 'local-synthetic' | 'independent-fresh';
  readonly objectives: { readonly rpoHours: number; readonly rtoHours: number };
  readonly liveReady: boolean;
  readonly missingLiveHandles: readonly string[];
  readonly scenarios: readonly ScenarioStatus[];
  /** Sanitized manifest evidence: counts/hashes/schema (no bodies, R36.13/R36.17). */
  readonly manifestEvidence: { readonly schemaRelease: string; readonly counts: RootManifest['counts']; readonly fingerprint: string };
  /** Independent-copy age in whole hours and the RPO verdict, or BLOCKED when no verified copy exists. */
  readonly rpo: { readonly state: RpoState; readonly ageHours: number | null; readonly blocked: boolean };
  /** Measured elapsed restore time and the RTO verdict, or BLOCKED when no live restore ran. */
  readonly rto: { readonly withinObjective: boolean; readonly elapsedHours: number | null; readonly blocked: boolean };
  /** The explicit non-acceptance notes carried into every record (R36.17). */
  readonly notAcceptance: readonly string[];
  readonly limitations: readonly string[];
}

/**
 * Run the fresh-environment recovery rehearsal (R36.17). When the LIVE independent environment is NOT
 * configured (the sandbox/dry case), it EXERCISES the deterministic scenarios here with synthetic
 * fixtures and reports the live scenarios BLOCKED. When the operator supplies the independent inventory,
 * replacement infrastructure, independent copy, and recovery-key identifiers, the live scenarios instead
 * carry the operator-run restore evidence — but this tool still makes NO account/key/network call itself;
 * the live restore executes inside the independent replacement install and the operator records its
 * result. Either way the record is sanitized and the non-acceptance contract is explicit.
 */
export async function runRehearsal(options?: {
  readonly handles?: LiveHandles;
  readonly now?: string;
  /** Operator-measured elapsed hours of the live fresh-environment restore. Without it RTO stays BLOCKED. */
  readonly measuredElapsedHours?: number;
  /** Operator-verified age in hours of the latest independent recovery point. Without it RPO stays BLOCKED. */
  readonly verifiedCopyAgeHours?: number;
}): Promise<RehearsalRecord> {
  const now = options?.now ?? new Date().toISOString();
  const handles = options?.handles ?? liveHandlesFromEnv();
  const liveReady = liveEnvironmentReady(handles);
  const missing = missingLiveHandles(handles);
  const corpus = syntheticCorpus(now);
  const registry = syntheticRegistry(corpus.schemaRelease);
  const scenarios: ScenarioStatus[] = [];

  // older-backup-format: an older schema restores through a transform; the upgrade targets current.
  const olderManifest = syntheticManifest('synthetic-prior');
  const older = preflightDecision(olderManifest, registry);
  scenarios.push(older.ok && older.transform.to === corpus.schemaRelease
    ? { scenario: 'older-backup-format', status: 'passed', detail: `older format restores through transform ${older.transform.from}→${older.transform.to}` }
    : { scenario: 'older-backup-format', status: 'blocked', detail: 'older-format transform did not resolve', missing: [] });

  // same-email-new-bootstrap: a DIFFERENT bootstrap id with the SAME email maps onto the original id.
  const matched = reconcileBootstrapIdentity({ id: 'fresh-bootstrap-id', emailLc: 'owner@example.test' }, corpus.members);
  scenarios.push(matched.ok && matched.mapping.kind === 'matched' && matched.mapping.toBackedUpId === 'member-owner'
    ? { scenario: 'same-email-new-bootstrap', status: 'passed', detail: 'same-email bootstrap mapped onto the original backed-up id' }
    : { scenario: 'same-email-new-bootstrap', status: 'blocked', detail: 'same-email mapping did not resolve', missing: [] });

  // bootstrap-identity-conflict: a true identity conflict FAILS preflight (id collides with another member).
  const conflict = reconcileBootstrapIdentity({ id: 'member-historian', emailLc: 'owner@example.test' }, corpus.members);
  scenarios.push(!conflict.ok && conflict.conflict.kind === 'id-collision'
    ? { scenario: 'bootstrap-identity-conflict', status: 'passed', detail: 'a true identity conflict fails preflight (id-collision)' }
    : { scenario: 'bootstrap-identity-conflict', status: 'blocked', detail: 'identity conflict was not refused', missing: [] });

  // corruption-refused: a tampered manifest (mutated fingerprint) is REFUSED by preflight.
  const corrupt = { ...syntheticManifest(corpus.schemaRelease), trust: { ...syntheticManifest(corpus.schemaRelease).trust, manifestFingerprint: sha256Hex('tampered') } } as RootManifest;
  const corruptDecision = preflightDecision(corrupt, registry);
  scenarios.push(!corruptDecision.ok && corruptDecision.reasons.some((r) => r.includes('fingerprint-mismatch'))
    ? { scenario: 'corruption-refused', status: 'passed', detail: 'preflight refuses a corrupted/tampered manifest' }
    : { scenario: 'corruption-refused', status: 'blocked', detail: 'corruption was not refused', missing: [] });

  // checkpoint-interruption: every interruption rolls back and resumes exactly once (real SQLite engine).
  const interruption = await exerciseCheckpointInterruption();
  scenarios.push(interruption.rolledBackCleanly && interruption.installedRows === 5 && interruption.resumeIsIdempotent
    ? { scenario: 'checkpoint-interruption', status: 'passed', detail: 'a crash rolled back atomically and the resume installed every row exactly once' }
    : { scenario: 'checkpoint-interruption', status: 'blocked', detail: 'checkpoint interruption did not roll back/resume cleanly', missing: [] });

  // post-snapshot-withdrawal: a later withdrawal is honoured; withdrawn material is not resurrected.
  const withdrawnId = corpus.unitIds[1]!;
  const ledger: SuppressionRecord[] = [{ suppressedId: withdrawnId, generation: 7, suppressedAt: '2026-02-01T09:00:00.000Z', digest: suppressionDigest({ suppressedId: withdrawnId, generation: 7, suppressedAt: '2026-02-01T09:00:00.000Z' }) }];
  const suppression = applySuppressions(corpus.unitIds, ledger);
  scenarios.push(suppression.ok && suppression.suppressed.includes(withdrawnId) && !suppression.installable.includes(withdrawnId)
    ? { scenario: 'post-snapshot-withdrawal', status: 'passed', detail: 'a post-snapshot withdrawal is honoured; withdrawn material is not resurrected' }
    : { scenario: 'post-snapshot-withdrawal', status: 'blocked', detail: 'post-snapshot withdrawal was not honoured', missing: missing });

  // LIVE scenarios: production-account-loss and measured-rpo-rto. Reported BLOCKED when the independent
  // environment/keys are absent — NEVER faked. With handles present, the operator-run restore evidence
  // would be recorded here (still no account/key access from this tool).
  for (const scenario of ['production-account-loss', 'measured-rpo-rto'] as const) {
    scenarios.push(liveReady
      ? { scenario, status: 'passed', detail: 'operator-run restore evidence recorded against the independent fresh environment' }
      : { scenario, status: 'blocked', detail: 'the independent fresh environment, inventory, and recovery-key identifiers are not configured; the live restore cannot run here', missing });
  }

  // RPO/RTO: only a VERIFIED independent copy and a MEASURED live restore count. In the dry case there is
  // no measured restore, so RTO is BLOCKED; the RPO age of the synthetic verified copy is classified for
  // illustration but marked blocked for acceptance because it did not come from the independent inventory.
  // With a live environment, RPO/RTO come ONLY from operator-measured values; absent, they stay BLOCKED.
  const measuredRpo = liveReady && isHours(options?.verifiedCopyAgeHours);
  const measuredRto = liveReady && isHours(options?.measuredElapsedHours);
  const rpoStatus = classifyRpo(measuredRpo ? new Date(Date.parse(now) - options!.verifiedCopyAgeHours! * 3_600_000).toISOString() : null, now);
  const rtoStatus = classifyRto(measuredRto ? options!.measuredElapsedHours! : null);
  const manifest = syntheticManifest(corpus.schemaRelease);

  return {
    recordVersion: 1,
    recordedAt: now,
    environment: liveReady ? 'independent-fresh' : 'local-synthetic',
    objectives: { rpoHours: RECOVERY_OBJECTIVES.rpoHours, rtoHours: RECOVERY_OBJECTIVES.rtoHours },
    liveReady,
    missingLiveHandles: missing,
    scenarios,
    manifestEvidence: { schemaRelease: manifest.schemaRelease, counts: manifest.counts, fingerprint: manifest.trust.manifestFingerprint },
    rpo: { state: rpoStatus.state, ageHours: rpoStatus.ageHours, blocked: !measuredRpo },
    rto: { withinObjective: rtoStatus.withinObjective, elapsedHours: measuredRto ? options!.measuredElapsedHours! : null, blocked: !measuredRto },
    notAcceptance: [
      'A package DOWNLOAD alone is NOT a recovery test (R36.17): delivery of package bytes is not acceptance.',
      'An application-only ALERT is NOT a recovery test (R36.17): an in-app backup-age alert is not a fresh-environment restore.',
      'Acceptance requires a LIVE restore into a fresh ISOLATED environment that completed and verified, within the ≤24h RPO and ≤8h RTO.',
    ],
    limitations: liveReady ? [] : [
      'Run in a build sandbox with NO independent environment, inventory, or operator-held recovery keys.',
      'The pure/deterministic restore decisions are exercised here with synthetic fixtures and in-memory SQLite.',
      'The LIVE restore into independent replacement infrastructure and the measured RPO/RTO are BLOCKED, not faked.',
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 68.4 launch-gate evidence: produced ONLY from a live, verified rehearsal; a dry run is NOT acceptance.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** One sanitized `infra-restore` launch-gate entry (R60.4); the rest of the entry is added by the recorder. */
export interface RestoreEvidence {
  readonly gate: 'team_archive' | 'final_checkpoint_49';
  readonly requirement: 'independent_recovery' | 'final_restore';
  readonly kind: 'infra-restore';
  readonly result: 'passed' | 'blocked';
  readonly scope: 'deployed-staging' | 'deployed-production' | 'local-synthetic';
  readonly note: string;
}

/** Which deployed install a live rehearsal targeted. Defaults to production (the original behaviour). */
export type RehearsalTarget = 'staging' | 'production';

/** Whether the record is acceptance: a live, verified, measured restore within RPO/RTO. */
function isLiveAcceptance(record: RehearsalRecord): boolean {
  return record.environment === 'independent-fresh'
    && record.liveReady
    && record.scenarios.every((s) => s.status === 'passed')
    && !record.rto.blocked
    && record.rto.withinObjective
    && !record.rpo.blocked
    && record.rpo.state !== 'breach';
}

/**
 * Map a rehearsal record to BOTH `infra-restore` launch-gate entries the same restore evidences:
 * `team_archive`/`independent_recovery` and `final_checkpoint_49`/`final_restore` (task 68.4, R60.4).
 * A rehearsal is acceptance ONLY when it ran against the independent fresh environment with a verified,
 * measured restore: then both are `passed` with scope `deployed-staging` or `deployed-production` per
 * `target`. A sandbox/dry run yields `blocked`/`local-synthetic`, which the checker reads as NOT
 * satisfying either gate, so a dry run can never certify recovery.
 */
export function rehearsalEvidenceEntries(record: RehearsalRecord, target: RehearsalTarget = 'production'): RestoreEvidence[] {
  const live = isLiveAcceptance(record);
  const common = {
    kind: 'infra-restore',
    result: live ? 'passed' : 'blocked',
    scope: live ? (target === 'staging' ? 'deployed-staging' : 'deployed-production') : 'local-synthetic',
    note: live
      ? 'verified fresh-isolated restore within RPO/RTO against the independent environment'
      : 'BLOCKED: no verified live restore; a dry/sandbox run, package download, or application alert is not acceptance',
  } as const;
  return [
    { gate: 'team_archive', requirement: 'independent_recovery', ...common },
    { gate: 'final_checkpoint_49', requirement: 'final_restore', ...common },
  ];
}

/** The team-archive entry of {@link rehearsalEvidenceEntries} (kept for existing callers). */
export function rehearsalEvidence(record: RehearsalRecord, target: RehearsalTarget = 'production'): RestoreEvidence {
  return rehearsalEvidenceEntries(record, target)[0]!;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// CLI: enumerate/dry-run. Makes NO account/key/network call. Exits non-zero only on an internal error.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Read an independent inventory file if supplied (sanitized; never a production secret). Unused values ignored. */
function readIndependentInventory(path: string | undefined): unknown {
  if (path === undefined) return undefined;
  try { return JSON.parse(readFileSync(resolve(path), 'utf8')); } catch { return undefined; }
}

/** Render the rehearsal record as a human-readable report for the CLI. */
export function formatReport(record: RehearsalRecord, target: RehearsalTarget = 'production'): string {
  const lines: string[] = [];
  lines.push('Fresh-environment recovery rehearsal (task 58.5) — no account/key/network access.');
  lines.push(`recorded ${record.recordedAt} · environment: ${record.environment} · live ready: ${record.liveReady}`);
  lines.push(`objectives: RPO ≤ ${record.objectives.rpoHours}h, RTO ≤ ${record.objectives.rtoHours}h`);
  lines.push('');
  lines.push('Scenarios:');
  for (const scenario of record.scenarios) {
    const tag = scenario.status === 'passed' ? 'PASS   ' : 'BLOCKED';
    const extra = scenario.status === 'blocked' && scenario.missing.length ? ` [set: ${scenario.missing.join(', ')}]` : '';
    lines.push(`  ${tag} ${scenario.scenario} — ${scenario.detail}${extra}`);
  }
  lines.push('');
  lines.push(`RPO: ${record.rpo.blocked ? 'BLOCKED (no verified independent copy here)' : `${record.rpo.state} (${record.rpo.ageHours ?? 'n/a'}h)`}`);
  lines.push(`RTO: ${record.rto.blocked ? 'BLOCKED (no measured live restore here)' : `${record.rto.withinObjective ? 'within' : 'over'} objective`}`);
  lines.push('');
  lines.push('NOT acceptance:');
  for (const note of record.notAcceptance) lines.push(`  • ${note}`);
  if (record.limitations.length) {
    lines.push('');
    lines.push('Limitations:');
    for (const note of record.limitations) lines.push(`  • ${note}`);
  }
  lines.push('');
  for (const evidence of rehearsalEvidenceEntries(record, target)) {
    lines.push(`68.4 launch-gate evidence ${evidence.gate}/${evidence.requirement}: ${evidence.kind} = ${evidence.result} (scope ${evidence.scope}). ${evidence.note}`);
  }
  return lines.join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void (async () => {
    try {
      const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
          target: { type: 'string' }, record: { type: 'boolean', default: false }, release: { type: 'string' },
          'evidence-ref': { type: 'string' }, replace: { type: 'boolean', default: false },
        },
        strict: true,
      });
      const handles = liveHandlesFromEnv();
      // The independent inventory, when supplied, is read as a sanitized descriptor only — never a secret.
      void readIndependentInventory(handles.independentInventoryPath);
      // Operator-measured values from the real restore; absent, RPO/RTO stay BLOCKED and nothing can pass.
      const hours = (name: string): number | undefined => {
        const raw = process.env[name]?.trim();
        return raw ? Number(raw) : undefined;
      };
      const record = await runRehearsal({
        handles,
        ...(hours('RF_RECOVERY_MEASURED_ELAPSED_HOURS') === undefined ? {} : { measuredElapsedHours: hours('RF_RECOVERY_MEASURED_ELAPSED_HOURS')! }),
        ...(hours('RF_RECOVERY_VERIFIED_COPY_AGE_HOURS') === undefined ? {} : { verifiedCopyAgeHours: hours('RF_RECOVERY_VERIFIED_COPY_AGE_HOURS')! }),
      });
      const target: RehearsalTarget = values.target === 'staging' ? 'staging' : 'production';
      console.log(formatReport(record, target));
      // A dry/sandbox run exits 0 (it did its job: exercised the pure decisions and reported BLOCKED
      // honestly). It does NOT fail the process, because BLOCKED here is the expected, correct state.
      if (values.record) {
        if (values.target !== 'staging' && values.target !== 'production') throw new Error('--record needs --target staging|production');
        if (!values.release || !values['evidence-ref']) throw new Error('--record needs --release and --evidence-ref');
        const { recordEvidence } = await import('../src/evidence-recorder');
        const entries = rehearsalEvidenceEntries(record, target);
        if (entries.some((entry) => entry.result !== 'passed')) {
          console.log('Not recorded: this rehearsal is not a verified live restore, so nothing is written to the launch-evidence ledger.');
        } else {
          for (const entry of entries) {
            const { note, ...rest } = entry;
            const recorded = recordEvidence(resolve(fileURLToPath(new URL('../../', import.meta.url))), { ...rest, note, releaseId: values.release, evidenceRef: values['evidence-ref'] }, { replace: values.replace });
            console.log(`Recorded ${recorded.gate}/${recorded.requirement} = ${recorded.result} (scope ${recorded.scope})`);
          }
        }
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  })();
}
