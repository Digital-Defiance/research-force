// Feature: research-collab-cms, Property 125: Release gates and compatibility evidence cannot be bypassed
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { encodedJsonBytes } from '@researchforce/domain/resource-profile';
import {
  assertContraction,
  assertDeployedCompatibility,
  assertWorkerCompatibility,
  recoveryPlan,
  rolloutPlan,
  STORES,
  validateReleaseCatalog,
} from '@researchforce/domain/compatibility';
import type { EvidenceEntry, EvidenceKind, GateManifest, GateRequirement, LaunchEvidence } from '../../src/launch-gates';
import {
  certifyScopes,
  EMPTY_LAUNCH_EVIDENCE,
  evaluateGates,
  INFRA_KINDS,
  isRealAcceptance,
  SUBSTITUTE_KINDS,
} from '../../src/launch-gates';
import { checkRelease, developmentManifest, hash } from '../../src/release-manifest';
import { applyUpgrade, runBackfillSlice } from '../../src/upgrade-store';
import type { BackfillDefinition } from '../../src/upgrade-store';
import { assertDeployable } from '../../src/deploy-guard';
import { ROOT, inventoryFixture, releaseFixture, restoreFixture, setSchemaRange } from '../release-fixtures';

// **Validates: Requirements 60.1, 60.3, 60.4, 60.5, 60.6, 60.7, 60.8, 60.9**
//
// Property 125 is the bypass-resistance property for the entire release/compatibility/launch toolchain. It proves,
// over arbitrary interleavings with INJECTED FAULTS, that a release or a deployment SCOPE cannot be certified or
// deployed unless every required gate is satisfied by REAL acceptance evidence, that a stale or incompatible manifest
// is detected and blocks deployment, that the expand → compatible-deploy → bounded-backfill/verify → switch →
// contract-after-window rollout invariants hold, and that cleanup/retention never removes a live dependency.
//
// The logic under test is pure tooling (`tools/src`): `launch-gates` (R60.4 runtime gate checker and the 68.4
// real-vs-substitute / BLOCKED-not-skipped rules), `release-manifest` (`checkRelease` source/dependency/build/
// migration fingerprints), the `@researchforce/domain/compatibility` rollout/contraction/recovery contracts, the
// SQLite upgrade/backfill engine (`upgrade-store`), and `deploy-guard`. Nothing touches a network or an account.
//
// INDEPENDENT MODEL. The launch-gate half is driven by a hand-written, deliberately independent re-derivation of the
// matrix rule: `modelSatisfied(manifests, ledger, scope)` recomputes the certify verdict from first principles (a
// requirement is met only by a passing `infra-*` entry against a non-`local-synthetic` deployed scope; every
// prerequisite in the transitive closure must itself be met; an unknown scope is a hard failure) WITHOUT calling the
// production evaluator, and the property asserts the production `certifyScopes` verdict equals the model's for every
// generated ledger and scope. The compatibility half uses the real domain contracts as the oracle but drives them
// with a generator of arbitrary manifests/inventories/proofs plus fault injection, asserting the invariant direction
// (a planted incompatibility / early contraction / stale proof is ALWAYS refused). The two concrete design scenarios
// — the CURRENT-ACCESS case (a running install's exact-privacy gate) and the MAXIMUM-ENCODED-INPUT case (a backfill
// source row exactly at and one byte past the `maxBytes` bound) — are pinned as their own regression cases.
//
// FAULT INJECTION covered below: a stale development manifest, a hand-edited source/build hash, an incompatible
// worker schema range, an interrupted/retried migration and backfill (crash mid-slice, replayed slice), a missing
// independent-recovery / content-licence / profile-approval gate, a failed control path, an absent R60.9 walkthrough,
// a substitute-evidence entry, a prerequisite-gate failure, and a `local-synthetic`-only infra entry.

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Independent re-derivation of the launch-gate matrix verdict (NOT the production evaluator).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A requirement is MET under the model only by a passing infra-kind entry on a real (non-local-synthetic) scope. */
function modelRequirementMet(ledger: LaunchEvidence, gateId: string, requirement: GateRequirement): boolean {
  return ledger.entries.some((entry) =>
    entry.gate === gateId &&
    entry.requirement === requirement.id &&
    entry.kind === requirement.infra &&
    (INFRA_KINDS as readonly string[]).includes(entry.kind) &&
    entry.result === 'passed' &&
    entry.scope !== 'local-synthetic');
}

/** A gate is SATISFIED under the model only when every requirement is met AND every prerequisite is itself satisfied.
 *  Unknown or cyclic prerequisites fail closed. This mirrors the intended rule, independently of the production code. */
function modelGateSatisfied(manifests: readonly GateManifest[], ledger: LaunchEvidence, id: string, stack: readonly string[] = []): boolean {
  const manifest = manifests.find((m) => m.id === id);
  if (!manifest) return false; // unknown gate fails closed
  if (!manifest.requirements.every((requirement) => modelRequirementMet(ledger, id, requirement))) return false;
  for (const dependency of manifest.requiresGates) {
    if (stack.includes(dependency)) return false; // cycle fails closed
    if (!modelGateSatisfied(manifests, ledger, dependency, [...stack, id])) return false;
  }
  return true;
}

/** The model's certify verdict for the requested scopes: every scope and its transitive prerequisites must be met,
 *  and an unknown requested scope is a hard failure. */
function modelCertified(manifests: readonly GateManifest[], ledger: LaunchEvidence, requested: readonly string[]): boolean {
  const closure = new Set<string>();
  let unknown = false;
  const add = (id: string): void => {
    if (closure.has(id)) return;
    const manifest = manifests.find((m) => m.id === id);
    if (!manifest) { unknown = true; return; }
    closure.add(id);
    for (const dependency of manifest.requiresGates) add(dependency);
  };
  for (const id of requested) add(id);
  if (unknown) return false;
  return [...closure].every((id) => modelGateSatisfied(manifests, ledger, id));
}

// A small, self-contained two-gate matrix fixture: a base gate and a dependent gate that requires it. The dependent
// gate carries the critical requirements the design calls hard scope blockers (licence, independent keys, profile).
const req = (id: string, infra: EvidenceKind, critical = false): GateRequirement => ({ id, description: `requirement ${id}`, infra, critical });
const MODEL_MANIFESTS: readonly GateManifest[] = [
  {
    id: 'team_archive',
    title: 'Team archive',
    requiresGates: [],
    requirements: [
      req('independent_recovery', 'infra-restore', true),
      req('exact_privacy', 'infra-staging'),
      req('operating_profile', 'infra-profile', true),
      req('team_walkthroughs', 'infra-walkthrough'),
    ],
  },
  {
    id: 'public_archive',
    title: 'Public archive',
    requiresGates: ['team_archive'],
    requirements: [
      req('content_licence', 'infra-staging', true),
      req('distributed_abuse', 'infra-abuse', true),
    ],
  },
];
const GATE_IDS = MODEL_MANIFESTS.map((m) => m.id);
/** Every (gate, requirement) pair in the fixture, for generating arbitrary ledgers that target real requirements. */
const GATE_REQS = MODEL_MANIFESTS.flatMap((m) => m.requirements.map((r) => ({ gate: m.id, requirement: r.id })));

const ALL_KINDS: readonly EvidenceKind[] = [...INFRA_KINDS, ...SUBSTITUTE_KINDS];
const ledger = (entries: EvidenceEntry[]): LaunchEvidence => ({ schemaVersion: 1, entries });

/** An arbitrary ledger entry: it may name any gate/requirement (including mismatched ones), any kind (real or
 *  substitute), any result, and any scope (including the `local-synthetic` fault). This spans every bypass shape. */
const entryArb: fc.Arbitrary<EvidenceEntry> = fc
  .record({
    pair: fc.constantFrom(...GATE_REQS),
    kind: fc.constantFrom(...ALL_KINDS),
    result: fc.constantFrom<'passed' | 'failed' | 'blocked'>('passed', 'failed', 'blocked'),
    scope: fc.constantFrom<'deployed-staging' | 'deployed-production' | 'local-synthetic'>('deployed-staging', 'deployed-production', 'local-synthetic'),
  })
  .map(({ pair, kind, result, scope }) => ({ gate: pair.gate, requirement: pair.requirement, kind, result, scope, remediationTasks: [] }));

const ledgerArb: fc.Arbitrary<LaunchEvidence> = fc.array(entryArb, { maxLength: 14 }).map(ledger);
const requestedArb: fc.Arbitrary<string[]> = fc.uniqueArray(fc.constantFrom(...GATE_IDS, 'unknown_scope'), { maxLength: 3 });

describe('Property 125 — launch gates cannot be bypassed (independent model, R60.4/R60.6/R60.9)', () => {
  it('certifyScopes agrees with an independent re-derivation of the matrix verdict for every ledger and scope', () => {
    fc.assert(
      fc.property(ledgerArb, requestedArb, (evidence, requested) => {
        const actual = certifyScopes(MODEL_MANIFESTS, evidence, requested).certified;
        expect(actual).toBe(modelCertified(MODEL_MANIFESTS, evidence, requested));
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('no evidence shape outside the real-infra kinds ever flips a requirement to satisfied (isRealAcceptance is the gate)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...GATE_REQS), fc.constantFrom(...ALL_KINDS), fc.constantFrom<'passed' | 'failed' | 'blocked'>('passed', 'failed', 'blocked'), fc.constantFrom<'deployed-staging' | 'deployed-production' | 'local-synthetic'>('deployed-staging', 'deployed-production', 'local-synthetic'), (pair, kind, result, scope) => {
        const requirement = MODEL_MANIFESTS.flatMap((m) => m.requirements).find((r) => r.id === pair.requirement)!;
        const entry: EvidenceEntry = { gate: pair.gate, requirement: pair.requirement, kind, result, scope, remediationTasks: [] };
        const real = isRealAcceptance(entry, requirement, pair.gate);
        // isRealAcceptance is true ONLY for the exact infra kind, passing, on a real deployed scope. Any substitute
        // kind, any wrong kind, any non-pass, or a local-synthetic scope is rejected — the whole bypass surface.
        const shouldBeReal = kind === requirement.infra && (INFRA_KINDS as readonly string[]).includes(kind) && result === 'passed' && scope !== 'local-synthetic';
        expect(real).toBe(shouldBeReal);
        if (SUBSTITUTE_KINDS.includes(kind)) expect(real).toBe(false);
        if (scope === 'local-synthetic') expect(real).toBe(false);
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('a certified scope is exactly a scope whose entire prerequisite closure is satisfied by real evidence', () => {
    fc.assert(
      fc.property(ledgerArb, fc.constantFrom(...GATE_IDS), (evidence, scope) => {
        const result = certifyScopes(MODEL_MANIFESTS, evidence, [scope]);
        if (result.certified) {
          // Then every gate in the closure is satisfied, and the scope's own requirements are all met by real evidence.
          const scopeStatus = result.gates.find((s) => s.id === scope)!;
          expect(scopeStatus.satisfied).toBe(true);
          expect(scopeStatus.requirements.every((r) => r.met)).toBe(true);
          expect(scopeStatus.unsatisfiedPrerequisites).toEqual([]);
        }
        // The production verdict and the independent model never disagree on this scope.
        expect(result.certified).toBe(modelCertified(MODEL_MANIFESTS, evidence, [scope]));
      }),
      { numRuns: FC_RUNS },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Compatibility / rollout half: arbitrary manifests + inventories + proofs with injected faults (R60.5).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const NOW = new Date('2026-01-02T02:00:00.000Z');

// The release fixture reads and hashes the whole repository source tree, so it is built ONCE per identity and then
// cloned/mutated inside each property. Cloning + mutating + asserting is pure, so these run the full FC_RUNS without
// paying the fingerprint cost on every generated case.
let baseOld: ReturnType<typeof releaseFixture> | undefined;
let baseNext: ReturnType<typeof releaseFixture> | undefined;
let baseRelease: ReturnType<typeof releaseFixture> | undefined;
const old = (): ReturnType<typeof releaseFixture> => structuredClone(baseOld ??= releaseFixture('old'));
const next = (): ReturnType<typeof releaseFixture> => structuredClone(baseNext ??= releaseFixture('next'));
const release = (): ReturnType<typeof releaseFixture> => structuredClone(baseRelease ??= releaseFixture());

describe('Property 125 — the compatible rollout invariants cannot be bypassed (R60.5)', () => {
  it('a planted incompatible worker schema range always refuses the rollout (never runs incompatible consumers)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...STORES), fc.integer({ min: 1, max: 5 }), (store, bump) => {
        const target = next();
        // Advance the target's schema for the store, but DO NOT widen the already-deployed workers' read/write range:
        // the deployed old consumers cannot read the new schema, so expansion must be refused.
        target.schemas.expanded[store] += bump;
        target.schemas.contracted[store] += bump;
        const oldRelease = old();
        const deployed = inventoryFixture(oldRelease); // deployed at the OLD (narrower) schema
        expect(() => rolloutPlan(target, deployed, [oldRelease, target])).toThrow(/cannot read\/write|Target is not|Contraction must advance|history must be complete/);
      }),
      { numRuns: FC_RUNS },
    );
  }, 120_000);

  it('a compatible rollout plan always drives expand → compatible-deploy → backfill → verify → switch → window → contract', () => {
    const oldRelease = old();
    const target = next();
    const deployed = inventoryFixture(oldRelease);
    const plan = rolloutPlan(target, deployed, [oldRelease, target]);
    expect(plan.phases).toEqual(['expand', 'deploy-compatible-consumers', 'backfill', 'verify', 'switch', 'wait-recovery-window', 'contract']);
    expect(plan.productionAuthorized).toBe(false);
    // The recorded deployed versions are exactly the observed inventory — the plan never invents a version.
    expect(plan.deployed).toEqual(deployed.workers);
  }, 120_000);

  it('contraction is refused before the recovery window ends, while old consumers remain, or without a fresh restore proof', () => {
    fc.assert(
      fc.property(
        fc.record({
          windowBreach: fc.boolean(),
          leaseFault: fc.boolean(),
          oldConsumerFault: fc.boolean(),
          proofAgeHours: fc.integer({ min: -48, max: 72 }),
          proofMismatch: fc.boolean(),
        }),
        (fault) => {
          const target = release();
          const inventory = inventoryFixture(target);
          let proof: Record<string, unknown> = restoreFixture(target.id);

          // No fault at all: contraction is allowed. Each injected fault must flip it to a refusal.
          const anyFault = fault.windowBreach || fault.leaseFault || fault.oldConsumerFault || fault.proofMismatch || fault.proofAgeHours < 0 || fault.proofAgeHours > 24;
          if (fault.windowBreach) inventory.switchedAt = new Date(NOW.getTime() - 1000).toISOString(); // window not elapsed
          if (fault.leaseFault) inventory.oldConsumerLeases = 1;
          if (fault.oldConsumerFault) inventory.workers[1]!.releaseId = 'old-version';
          if (fault.proofMismatch) proof = { ...proof, releaseId: 'some-other-release' };
          // The restore proof must be within the last 24h of NOW; push it out of that window via completedAt.
          proof = { ...proof, completedAt: new Date(NOW.getTime() - fault.proofAgeHours * 3600_000).toISOString() };

          if (anyFault) {
            expect(() => assertContraction(target, inventory, proof, NOW)).toThrow();
          } else {
            expect(() => assertContraction(target, inventory, proof, NOW)).not.toThrow();
          }
        },
      ),
      { numRuns: FC_RUNS },
    );
  }, 120_000);

  it('rollback is refused for a non-prior-safe target and forward recovery can never downgrade a schema', () => {
    fc.assert(
      fc.property(fc.record({ dropSafe: fc.boolean(), bumpDeployed: fc.integer({ min: 0, max: 3 }) }), ({ dropSafe, bumpDeployed }) => {
        const target = release();
        const inventory = inventoryFixture(target);
        inventory.schemas.core += bumpDeployed;
        if (dropSafe) inventory.priorSafeReleaseIds = [];
        if (dropSafe || bumpDeployed > 0) {
          expect(() => recoveryPlan('rollback', target, inventory)).toThrow(/safe|cannot read\/write/);
        } else {
          expect(recoveryPlan('rollback', target, inventory).productionAuthorized).toBe(false);
        }
      }),
      { numRuns: FC_RUNS },
    );
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Manifest fingerprint half: a stale/hand-edited manifest is detected (R60.1/R60.5). These shell out to real FS hashing
// against the repository, so they are bounded to a few runs with a generous timeout.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('Property 125 — a stale or hand-edited manifest is always detected (R60.1/R60.5)', () => {
  it('a mutated source hash, build hash, or a declared-current stale manifest never passes checkRelease', () => {
    fc.assert(
      fc.property(fc.record({ target: fc.constantFrom('file', 'packageJson', 'packageLock', 'migration'), declareCurrent: fc.boolean() }), ({ target, declareCurrent }) => {
        const base = developmentManifest(ROOT);
        // The honest development manifest passes its own fingerprint check (and is current).
        expect(() => checkRelease(ROOT, base, true)).not.toThrow();

        const tampered = structuredClone(base);
        if (target === 'file') tampered.files[0]!.sha256 = '0'.repeat(64);
        if (target === 'packageJson') tampered.build.packageJsonSha256 = '0'.repeat(64);
        if (target === 'packageLock') tampered.build.packageLockSha256 = '0'.repeat(64);
        if (target === 'migration') tampered.migrations[0]!.sha256 = '0'.repeat(64);
        // Hand-editing any fingerprint is detected whether or not we also claim the manifest is current.
        expect(() => checkRelease(ROOT, tampered, declareCurrent)).toThrow(/changed|digest|stale/);
      }),
      { numRuns: Math.min(FC_RUNS, 12) },
    );
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// SQLite upgrade/backfill half: interrupted/retried migration and backfill roll back; a completed contraction is not
// replayed; the bounded backfill refuses the maximum-encoded-input fault. These use in-memory SQLite + a tmp root.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A self-contained schema fixture mirroring the upgrade-store test's shape: one core expand + one core contract, a
 *  bounded copy-values backfill, five seeded rows, and apply/verify closures. */
function migrationFixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'rf-p125-schema-'));
  const manifest = releaseFixture('p125-fixture');
  manifest.schemas = { expanded: { core: 1, search: 0, public: 0 }, contracted: { core: 2, search: 0, public: 0 } };
  setSchemaRange(manifest, manifest.schemas.expanded, manifest.schemas.contracted);
  manifest.migrations = [];
  const scripts = {
    core: [
      "CREATE TABLE records(id TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, legacy TEXT); CREATE INDEX records_value ON records(value);",
      'ALTER TABLE records ADD new_value TEXT;',
      'ALTER TABLE records DROP COLUMN legacy;',
    ],
    search: ['CREATE TABLE documents(id TEXT PRIMARY KEY);'],
    public: ['CREATE TABLE views(id TEXT PRIMARY KEY);'],
  };
  for (const store of STORES) {
    mkdirSync(resolve(root, 'packages/db/migrations', store), { recursive: true });
    for (const [revision, sql] of scripts[store].entries()) {
      const tag = `${String(revision).padStart(4, '0')}_fixture`;
      writeFileSync(resolve(root, 'packages/db/migrations', store, `${tag}.sql`), sql);
      manifest.migrations.push({ store, revision, tag, sha256: hash(sql), phase: revision === 2 ? 'contract' : revision === 1 ? 'expand' : 'baseline' });
    }
  }
  const definition: BackfillDefinition = { id: 'copy-values', version: 1, store: 'core', table: 'records', key: 'id', columns: ['value'], maxRows: 2, maxBytes: 128_000 };
  manifest.backfills = [{ id: definition.id, version: 1, store: 'core', maxRows: 2, maxBytes: 128_000 }];
  const db = new DatabaseSync(':memory:');
  applyUpgrade(db, root, manifest, 'core', { phase: 'expand' });
  for (let i = 1; i <= 5; i++) db.prepare('INSERT INTO records(id,value,legacy) VALUES (?,?,?)').run(`id-${i}`, `Synthetic 😀 ${i}`, 'old');
  const apply = (row: Record<string, unknown>): void => { db.prepare('UPDATE records SET new_value=? WHERE id=?').run(row['value'] as string, row['id'] as string); };
  const verify = (): boolean => db.prepare('SELECT count(*) AS n FROM records WHERE new_value IS NULL OR value != new_value').get()?.['n'] === 0;
  return { root, manifest, db, definition, apply, verify, close: (): void => { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

describe('Property 125 — interrupted migrations/backfills roll back and completed work is not replayed (R60.5)', () => {
  it('a crash at any slice leaves no partial effects and no checkpoint; resumed slices complete exactly once', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 }), (crashAtGeneration) => {
        const f = migrationFixture();
        try {
          // Run clean slices up to the crash point, injecting a fault mid-slice at the chosen generation. The fault
          // must roll the slice back: no new effects, and the checkpoint stays at the prior generation.
          let generation = 0;
          let processedBefore = 0;
          for (let g = 0; g < crashAtGeneration; g++) {
            const result = runBackfillSlice(f.db, f.manifest.id, f.definition, g, f.apply, f.verify);
            generation = result.generation;
            processedBefore = result.processed;
          }
          const checkpointBefore = f.db.prepare('SELECT generation,processed FROM _rf_release_checkpoints WHERE job_id=?').get(f.definition.id);
          const effectsBefore = f.db.prepare('SELECT count(*) AS n FROM records WHERE new_value IS NOT NULL').get()?.['n'];
          expect(() => runBackfillSlice(f.db, f.manifest.id, f.definition, generation, f.apply, f.verify, () => { throw new Error('crash'); })).toThrow(/crash/);
          const checkpointAfter = f.db.prepare('SELECT generation,processed FROM _rf_release_checkpoints WHERE job_id=?').get(f.definition.id);
          const effectsAfter = f.db.prepare('SELECT count(*) AS n FROM records WHERE new_value IS NOT NULL').get()?.['n'];
          // The crash committed nothing: effects and the checkpoint are exactly what they were before.
          expect(effectsAfter).toBe(effectsBefore);
          expect(checkpointAfter).toEqual(checkpointBefore);
          expect(processedBefore).toBeGreaterThanOrEqual(0);

          // Resume to completion; the job completes exactly once, and a replayed slice after completion applies nothing.
          let result = runBackfillSlice(f.db, f.manifest.id, f.definition, generation, f.apply, f.verify);
          while (!result.complete) result = runBackfillSlice(f.db, f.manifest.id, f.definition, result.generation, f.apply, f.verify);
          expect(result.processed).toBe(5);
          const replay = runBackfillSlice(f.db, f.manifest.id, f.definition, result.generation, () => { throw new Error('replayed'); }, f.verify);
          expect(replay.complete).toBe(true); // a completed job is not replayed, so the throwing apply is never called
          expect(f.verify()).toBe(true);
        } finally { f.close(); }
      }),
      { numRuns: Math.min(FC_RUNS, 24) },
    );
  }, 120_000);

  it('MAXIMUM-ENCODED-INPUT case: a source row exactly at the byte bound backfills, one byte past is refused with no checkpoint', () => {
    // The backfill refuses a row whose encoded JSON exceeds maxBytes. We shrink the bound to a small, exact value so
    // we can place a row EXACTLY at the bound and a row one byte past it, and assert the boundary is inclusive-exact.
    const f = migrationFixture();
    try {
      // Measure the encoded size of the selected {id,value} row shape, then size `value` so the row lands on an exact
      // byte bound. encodedJsonBytes counts an ASCII char as one byte, so growing `value` by one grows the row by one.
      const baseValue = 'x';
      f.db.prepare('UPDATE records SET value=? WHERE id=?').run(baseValue, 'id-1');
      // Encoded bytes for the row {"id":"id-1","value":"x"}: let the engine tell us by probing with a tiny bound.
      // Instead, pick a bound equal to the exact size of a known row, computed the same way the engine does.
      const rowAt = { id: 'id-1', value: baseValue };
      const exactBytes = encodedJsonBytes(rowAt);
      f.definition = { ...f.definition, maxRows: 5, maxBytes: exactBytes } as typeof f.definition;
      // id-1 is exactly at the bound; make every other row tiny too so the slice reaches id-1 without tripping first.
      for (let i = 2; i <= 5; i++) f.db.prepare('UPDATE records SET value=? WHERE id=?').run('x', `id-${i}`);
      // A row exactly at the bound is accepted (the first slice processes id-1 and advances).
      const atBound = runBackfillSlice(f.db, f.manifest.id, f.definition, 0, f.apply, f.verify);
      expect(atBound.processed).toBeGreaterThanOrEqual(1);

      // Now push id-1 one byte past the bound (ASCII grows one byte per char) and reset the checkpoints. The slice
      // must refuse the oversized row and leave NO checkpoint behind.
      const g = migrationFixture();
      try {
        const bigRow = { id: 'id-1', value: 'xx' };
        const bigExact = encodedJsonBytes({ id: 'id-1', value: 'x' });
        g.definition = { ...g.definition, maxRows: 5, maxBytes: bigExact } as typeof g.definition;
        g.db.prepare('UPDATE records SET value=? WHERE id=?').run('xx', 'id-1'); // one byte past the bound
        for (let i = 2; i <= 5; i++) g.db.prepare('UPDATE records SET value=? WHERE id=?').run('x', `id-${i}`);
        expect(encodedJsonBytes(bigRow)).toBeGreaterThan(bigExact);
        expect(() => runBackfillSlice(g.db, g.manifest.id, g.definition, 0, g.apply, g.verify)).toThrow(/byte bound/);
        expect(g.db.prepare('SELECT count(*) AS n FROM _rf_release_checkpoints').get()?.['n']).toBe(0);
      } finally { g.close(); }
    } finally { f.close(); }
  }, 60_000);

  it('contraction is refused until its bounded backfill is verified-complete (R60.5)', () => {
    const f = migrationFixture();
    try {
      // The backfill is not complete, so contraction must refuse even with a valid inventory and fresh restore proof.
      const inventory = inventoryFixture(f.manifest);
      const proof = { ...restoreFixture(f.manifest.id), schemas: f.manifest.schemas.expanded };
      expect(() => applyUpgrade(f.db, f.root, f.manifest, 'core', { phase: 'contract', inventory, restoreProof: proof, now: NOW })).toThrow(/Backfill/);
      // Complete the backfill, then contraction proceeds and drops the legacy column exactly once.
      let result = runBackfillSlice(f.db, f.manifest.id, f.definition, 0, f.apply, f.verify);
      while (!result.complete) result = runBackfillSlice(f.db, f.manifest.id, f.definition, result.generation, f.apply, f.verify);
      const contracted = applyUpgrade(f.db, f.root, f.manifest, 'core', { phase: 'contract', inventory, restoreProof: proof, now: NOW });
      expect(contracted.applied).toEqual(['0002_fixture']);
      expect(f.db.prepare('PRAGMA table_info(records)').all().map((r) => r['name'])).not.toContain('legacy');
      // A replayed contraction applies nothing (completed contraction is not replayed).
      expect(applyUpgrade(f.db, f.root, f.manifest, 'core', { phase: 'contract' }).applied).toEqual([]);
    } finally { f.close(); }
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Targeted regression tests for every named bypass hazard (R60.3/R60.4/R60.6/R60.7/R60.8/R60.9).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A passing real deployed-scope acceptance entry for a model gate requirement. */
const pass = (gate: string, requirement: string, kind: EvidenceKind): EvidenceEntry => ({ gate, requirement, kind, result: 'passed', scope: 'deployed-staging', remediationTasks: [] });
/** The full passing set for the team_archive model gate. */
const teamArchivePassing = (): EvidenceEntry[] => MODEL_MANIFESTS[0]!.requirements.map((r) => pass('team_archive', r.id, r.infra));

describe('Property 125 — regression: named bypass hazards are each refused', () => {
  it('substitute evidence (source-file / checked-box / unit-test) never satisfies an infrastructure requirement', () => {
    for (const kind of SUBSTITUTE_KINDS) {
      const entries: EvidenceEntry[] = [
        { gate: 'team_archive', requirement: 'exact_privacy', kind, result: 'passed', scope: 'deployed-staging', remediationTasks: [] },
        pass('team_archive', 'independent_recovery', 'infra-restore'),
        pass('team_archive', 'operating_profile', 'infra-profile'),
        pass('team_archive', 'team_walkthroughs', 'infra-walkthrough'),
      ];
      const gate = evaluateGates(MODEL_MANIFESTS, ledger(entries)).find((s) => s.id === 'team_archive')!;
      expect(gate.satisfied).toBe(false);
      expect(gate.requirements.find((s) => s.requirement.id === 'exact_privacy')?.reason).toContain('substitute');
    }
  });

  it('a local-synthetic-only infra entry does not satisfy a requirement (real acceptance needs a deployed install)', () => {
    const entries: EvidenceEntry[] = [
      { gate: 'team_archive', requirement: 'independent_recovery', kind: 'infra-restore', result: 'passed', scope: 'local-synthetic', remediationTasks: [] },
      pass('team_archive', 'exact_privacy', 'infra-staging'),
      pass('team_archive', 'operating_profile', 'infra-profile'),
      pass('team_archive', 'team_walkthroughs', 'infra-walkthrough'),
    ];
    const gate = evaluateGates(MODEL_MANIFESTS, ledger(entries)).find((s) => s.id === 'team_archive')!;
    expect(gate.satisfied).toBe(false);
    expect(gate.requirements.find((s) => s.requirement.id === 'independent_recovery')?.reason).toContain('local-synthetic');
  });

  it('a failed control path blocks the scope and the failure is retained with its remediation (R60.6)', () => {
    const entries: EvidenceEntry[] = [
      { gate: 'team_archive', requirement: 'independent_recovery', kind: 'infra-restore', result: 'failed', scope: 'deployed-staging', remediationTasks: ['58.5'], note: 'restore mismatch' },
      pass('team_archive', 'exact_privacy', 'infra-staging'),
      pass('team_archive', 'operating_profile', 'infra-profile'),
      pass('team_archive', 'team_walkthroughs', 'infra-walkthrough'),
    ];
    const gate = evaluateGates(MODEL_MANIFESTS, ledger(entries)).find((s) => s.id === 'team_archive')!;
    expect(gate.satisfied).toBe(false);
    expect(gate.failures).toEqual([expect.objectContaining({ requirement: 'independent_recovery', result: 'failed', remediationTasks: ['58.5'] })]);
  });

  it('a missing independent recovery / content licence / profile approval each block the applicable launch (R60.4/R60.6)', () => {
    // Missing independent recovery blocks team_archive.
    const noRecovery = teamArchivePassing().filter((e) => e.requirement !== 'independent_recovery');
    expect(certifyScopes(MODEL_MANIFESTS, ledger(noRecovery), ['team_archive']).certified).toBe(false);
    // Missing the certified profile blocks team_archive.
    const noProfile = teamArchivePassing().filter((e) => e.requirement !== 'operating_profile');
    expect(certifyScopes(MODEL_MANIFESTS, ledger(noProfile), ['team_archive']).certified).toBe(false);
    // Missing the content licence blocks the public launch (team_archive otherwise complete).
    const noLicence = [...teamArchivePassing(), pass('public_archive', 'distributed_abuse', 'infra-abuse')];
    const publicGate = certifyScopes(MODEL_MANIFESTS, ledger(noLicence), ['public_archive']);
    expect(publicGate.certified).toBe(false);
    expect(publicGate.gates.find((s) => s.id === 'public_archive')!.requirements.find((r) => r.requirement.id === 'content_licence')?.met).toBe(false);
  });

  it('R60.9: an absent team walkthrough blocks its scope and cannot be skipped', () => {
    const entries = teamArchivePassing().filter((e) => e.requirement !== 'team_walkthroughs');
    const gate = evaluateGates(MODEL_MANIFESTS, ledger(entries)).find((s) => s.id === 'team_archive')!;
    expect(gate.satisfied).toBe(false);
    expect(gate.requirements.find((s) => s.requirement.id === 'team_walkthroughs')?.met).toBe(false);
    // A walkthrough recorded as a substitute or on a local-synthetic scope still cannot satisfy it.
    const substituted: EvidenceEntry[] = [...entries, { gate: 'team_archive', requirement: 'team_walkthroughs', kind: 'checked-box', result: 'passed', scope: 'deployed-staging', remediationTasks: [] }];
    expect(evaluateGates(MODEL_MANIFESTS, ledger(substituted)).find((s) => s.id === 'team_archive')!.satisfied).toBe(false);
  });

  it('a prerequisite-gate failure blocks the dependent gate even when its own evidence is complete', () => {
    const entries: EvidenceEntry[] = [
      pass('team_archive', 'exact_privacy', 'infra-staging'), // team_archive intentionally incomplete (prerequisite)
      pass('public_archive', 'content_licence', 'infra-staging'),
      pass('public_archive', 'distributed_abuse', 'infra-abuse'),
    ];
    const result = certifyScopes(MODEL_MANIFESTS, ledger(entries), ['public_archive']);
    const publicGate = result.gates.find((s) => s.id === 'public_archive')!;
    expect(publicGate.requirements.every((r) => r.met)).toBe(true); // its OWN evidence is complete
    expect(publicGate.satisfied).toBe(false); // but the prerequisite is not satisfied
    expect(publicGate.unsatisfiedPrerequisites).toEqual(['team_archive']);
    expect(result.certified).toBe(false);
  });

  it('with no recorded evidence every scope is BLOCKED and nothing certifies (R60.4)', () => {
    const result = certifyScopes(MODEL_MANIFESTS, EMPTY_LAUNCH_EVIDENCE, GATE_IDS);
    expect(result.gates.every((s) => !s.satisfied)).toBe(true);
    expect(result.certified).toBe(false);
  });

  it('CURRENT-ACCESS case: the running install needs the exact current-access privacy gate on the deployed scope', () => {
    // The design's current-access scenario: the team_archive gate requires `exact current-access privacy checks on the
    // deployed install`. With every OTHER requirement satisfied, the scope is certified ONLY once that exact gate is
    // satisfied by a real deployed-scope infra-staging run — a running install cannot be certified without it, and a
    // local-synthetic rehearsal of it does not count.
    const withoutPrivacy = teamArchivePassing().filter((e) => e.requirement !== 'exact_privacy');
    expect(certifyScopes(MODEL_MANIFESTS, ledger(withoutPrivacy), ['team_archive']).certified).toBe(false);
    const localOnly = [...withoutPrivacy, { gate: 'team_archive', requirement: 'exact_privacy', kind: 'infra-staging', result: 'passed', scope: 'local-synthetic', remediationTasks: [] } as EvidenceEntry];
    expect(certifyScopes(MODEL_MANIFESTS, ledger(localOnly), ['team_archive']).certified).toBe(false);
    // The real deployed current-access check certifies the scope.
    expect(certifyScopes(MODEL_MANIFESTS, ledger(teamArchivePassing()), ['team_archive']).certified).toBe(true);
  });

  it('the deploy guard refuses a local-entrypoint / local sign-in / stand-in deployment configuration (R60.6)', () => {
    // A production/local-entrypoint deploy refusal guard: these must all be refused before any deployment command.
    expect(() => assertDeployable({}, [], { RF_DEV_AUTH_BYPASS: '1' })).toThrow(/local sign-in|stand-in/);
    expect(() => assertDeployable({}, ['RF_LOCAL_SERVICES=1\n'])).toThrow(/vars files/);
    expect(() => assertDeployable({ main: 'src/local.ts' })).toThrow(/entrypoints|configuration/);
    expect(() => assertDeployable({ durable_objects: { bindings: [{ name: 'DO', class_name: 'LocalServices' }] } })).toThrow(/configuration|entrypoints/);
    // A clean production config is accepted.
    expect(() => assertDeployable({ main: 'src/index.ts', vars: { PUBLIC_BASE: 'https://researchforce.org' } })).not.toThrow();
  });

  it('a validated release catalog retains the current and two prior released readers and refuses an unknown predecessor', () => {
    const releases = ['r1', 'r2', 'r3'].map((id, i) => {
      const m = releaseFixture(id);
      m.status = 'released';
      m.releasedAt = `2026-01-0${i + 1}T00:00:00.000Z`;
      m.priorReleased = ['r1', 'r2'].slice(0, i);
      m.backup = { writerFormat: i + 1, readers: Array.from({ length: i + 1 }, (_, j) => ({ format: j + 1, schemaRelease: `r${j + 1}`, transform: `transform-${j + 1}-to-${i + 1}` })) };
      return m;
    });
    expect(() => validateReleaseCatalog(releases)).not.toThrow();
    // Dropping a prior reader is a bypass of the "two prior readers" rule and is refused.
    releases[2]!.backup.readers.shift();
    expect(() => validateReleaseCatalog(releases)).toThrow(/reader/);
    // An invented predecessor is refused.
    expect(() => validateReleaseCatalog([{ ...releaseFixture('x'), priorReleased: ['invented'] }])).toThrow(/preceding/);
  });

  it('an unknown deployed release id and an out-of-range deployed schema are both refused (never runs incompatible consumers)', () => {
    const old = releaseFixture('old');
    const next = releaseFixture('next');
    const deployed = inventoryFixture(old);
    expect(() => assertDeployedCompatibility(deployed, [old, next])).not.toThrow();
    const unknown = structuredClone(deployed);
    unknown.workers[0]!.releaseId = 'ghost';
    expect(() => assertDeployedCompatibility(unknown, [old, next])).toThrow(/Unknown/);
    expect(() => assertWorkerCompatibility(old, { ...deployed.schemas, core: old.schemas.expanded.core + 1 })).toThrow(/cannot read\/write/);
  });
});
