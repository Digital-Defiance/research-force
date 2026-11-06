import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { EvidenceEntry, GateManifest, LaunchEvidence } from '../src/launch-gates';
import { buildDeploymentPlan, DEPLOYMENT_SCOPES, resolveRequestedScopes } from '../src/deployment-plan';
import { developmentManifest } from '../src/release-manifest';
import { ROOT, inventoryFixture, releaseFixture } from './release-fixtures';

// Synthetic fixtures only. No real network, no account access, no real deployment. The plan path is
// a pure function; the CLI is exercised only in --check guard mode.

function runNode(args: string[], cwd = ROOT.replace(/\/$/u, '')) {
  return spawnSync(process.execPath, ['--import', 'tsx', ...args], { cwd, encoding: 'utf8' });
}

/** Synthetic gate manifests mirroring the three deployment scopes, one requirement each. */
function gateManifests(): GateManifest[] {
  return [
    { id: 'team_archive', title: 'Team archive', requiresGates: [], requirements: [{ id: 'recovery', description: 'independent recovery', infra: 'infra-restore', critical: true }] },
    { id: 'public_archive', title: 'Public archive', requiresGates: ['team_archive'], requirements: [{ id: 'licence', description: 'content licence', infra: 'infra-staging', critical: true }] },
    { id: 'outside_services', title: 'Outside services', requiresGates: ['public_archive'], requirements: [{ id: 'provider', description: 'least privilege', infra: 'infra-staging', critical: true }] },
  ];
}

const pass = (gate: string, requirement: string, kind: EvidenceEntry['kind']): EvidenceEntry => ({ gate, requirement, kind, result: 'passed', scope: 'deployed-staging', remediationTasks: [] });
const ledger = (entries: EvidenceEntry[]): LaunchEvidence => ({ schemaVersion: 1, entries });

/** Evidence that satisfies every scope gate (team_archive -> public_archive -> outside_services). */
const fullyCertified = (): LaunchEvidence => ledger([
  pass('team_archive', 'recovery', 'infra-restore'),
  pass('public_archive', 'licence', 'infra-staging'),
  pass('outside_services', 'provider', 'infra-staging'),
]);

function plan(evidence: LaunchEvidence, requestedScopes: readonly string[], mutate?: (release: ReturnType<typeof releaseFixture>, inventory: ReturnType<typeof inventoryFixture>) => void) {
  const release = releaseFixture('r3');
  const inventory = inventoryFixture(release);
  mutate?.(release, inventory);
  return buildDeploymentPlan({ target: release, inventory, catalog: [release], gateManifests: gateManifests(), evidence, requestedScopes });
}

describe('compatible rollout plan (task 48.4)', () => {
  it('emits the exact ordered expand -> deploy -> backfill -> verify -> switch -> wait -> contract phases', () => {
    const result = plan(fullyCertified(), ['team_archive']);
    expect(result.phases).toEqual(['expand', 'deploy-compatible-consumers', 'backfill', 'verify', 'switch', 'wait-recovery-window', 'contract']);
    expect(result.mode).toBe('dry-run');
    expect(result.productionAuthorized).toBe(false);
    expect(result.realDeploymentAuthorized).toBe(false);
  });

  it('records the safe rollback and forward-recovery targets', () => {
    const result = plan(fullyCertified(), ['team_archive']);
    expect(result.recovery.rollback?.targetRelease).toBe('r3');
    expect(result.recovery.forward?.targetRelease).toBe('r3');
  });

  it('refuses an incompatible inventory schema (never runs an incompatible consumer)', () => {
    expect(() => plan(fullyCertified(), ['team_archive'], (_release, inventory) => { inventory.schemas.core = inventory.schemas.core + 1; }))
      .toThrow(/cannot read\/write|Use recovery checks/u);
  });

  it('refuses a target that is not the catalog manifest (incompatible/forged manifest)', () => {
    const release = releaseFixture('r3');
    const inventory = inventoryFixture(release);
    const forged = releaseFixture('r3');
    forged.recoveryWindowHours = release.recoveryWindowHours + 24; // changed copy not in the catalog
    expect(() => buildDeploymentPlan({ target: forged, inventory, catalog: [release], gateManifests: gateManifests(), evidence: fullyCertified(), requestedScopes: ['team_archive'] }))
      .toThrow(/not the catalog manifest/u);
  });
});

describe('launch-gate activation decisions (task 48.4 calls the 68.4 checker)', () => {
  it('activates a scope only when its gate is satisfied by real recorded evidence', () => {
    const result = plan(fullyCertified(), ['team_archive']);
    const scope = result.scopes.find((s) => s.id === 'team_archive')!;
    expect(scope.activated).toBe(true);
    expect(result.certified).toBe(true);
  });

  it('refuses to activate a scope whose gate is not satisfied', () => {
    // No recorded evidence at all: every gate is BLOCKED, so the scope is refused and stays disabled.
    const result = plan({ schemaVersion: 1, entries: [] }, ['team_archive']);
    const scope = result.scopes.find((s) => s.id === 'team_archive')!;
    expect(scope.activated).toBe(false);
    expect(result.certified).toBe(false);
    expect(scope.unmet.join('\n')).toContain('no recorded evidence');
    // The Workers are still planned for compatible deployment, but the scope does not activate.
    expect(result.deployedWorkers).toContain('app');
  });

  it('refuses the dependent public scope when the prerequisite team gate is not satisfied', () => {
    // public_archive has its own licence evidence but team_archive (its prerequisite) is missing.
    const result = plan(ledger([pass('public_archive', 'licence', 'infra-staging')]), ['team_archive', 'public_archive']);
    const publicScope = result.scopes.find((s) => s.id === 'public_archive')!;
    expect(publicScope.activated).toBe(false);
    expect(result.certified).toBe(false);
  });
});

describe('Workspace-only deployment leaves public dynamic endpoints disabled', () => {
  it('disables submit and dl when the outside-services scope is not requested', () => {
    const result = plan(fullyCertified(), resolveRequestedScopes('workspace-only'));
    expect(result.scopes.map((s) => s.id)).toEqual(['team_archive']);
    // submit and dl are the public dynamic endpoints; they are not deployed and are reported disabled.
    expect(result.deployedWorkers).not.toContain('submit');
    expect(result.deployedWorkers).not.toContain('dl');
    expect([...result.disabledPublicDynamicEndpoints].sort()).toEqual(['dl', 'submit']);
  });

  it('keeps public dynamic endpoints disabled when requested but their own gate is not satisfied', () => {
    // Request the full profile but record no outside-services evidence: team+public activate, dynamic stays off.
    const evidence = ledger([pass('team_archive', 'recovery', 'infra-restore'), pass('public_archive', 'licence', 'infra-staging')]);
    const result = plan(evidence, resolveRequestedScopes('full'));
    const outside = result.scopes.find((s) => s.id === 'outside_services')!;
    expect(outside.activated).toBe(false);
    expect([...result.disabledPublicDynamicEndpoints].sort()).toEqual(['dl', 'submit']);
  });

  it('maps the outside-services scope to the public dynamic endpoint Workers', () => {
    const outside = DEPLOYMENT_SCOPES.find((s) => s.id === 'outside_services')!;
    expect(outside.publicDynamicEndpoints).toBe(true);
    expect([...outside.workers].sort()).toEqual(['dl', 'submit']);
  });
});

describe('deploy CLI guard mode makes no account access', () => {
  it('checks a deployment config without deploying and refuses an --apply request', () => {
    const checked = runNode(['scripts/deploy.ts', '--check', 'apps/app/wrangler.jsonc']);
    expect(checked.status).toBe(0);
    expect(checked.stdout).toContain('nothing was deployed');

    const dir = mkdtempSync(resolve(tmpdir(), 'rf-deploy-'));
    try {
      const inventory = inventoryFixture(releaseFixture('r3'));
      const inventoryPath = resolve(dir, 'inventory.json');
      writeFileSync(inventoryPath, JSON.stringify(inventory));
      // A real-deploy request is refused in this build environment; no account access is attempted.
      const applied = runNode(['scripts/deploy.ts', '--dry-run', 'apps/app/wrangler.jsonc', 'infra/releases/development.json', inventoryPath, '--apply']);
      expect(applied.status).toBe(1);
      expect(applied.stderr).toContain('Real deployment is not available');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('prints an ordered dry-run plan against the repository manifest with no recorded evidence (every scope blocked)', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'rf-deploy-'));
    try {
      // The repository inventory must match the committed development manifest exactly.
      const inventory = inventoryFixture(developmentManifest(ROOT));
      const inventoryPath = resolve(dir, 'inventory.json');
      writeFileSync(inventoryPath, JSON.stringify(inventory));
      const result = runNode(['scripts/deploy.ts', '--dry-run', 'apps/app/wrangler.jsonc', 'infra/releases/development.json', inventoryPath, '--profile', 'workspace-only']);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('No network or account access');
      expect(result.stdout).toContain('expand -> deploy-compatible-consumers');
      // In a build checkout there is no recorded infrastructure evidence, so the scope is refused.
      expect(result.stdout).toContain('REFUSE');
      expect(result.stdout).toContain('team_archive');
      expect(result.stdout).toContain('Public dynamic endpoints left DISABLED');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
