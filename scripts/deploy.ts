import { deploymentInventorySchema, rolloutPlan } from '@researchforce/domain/compatibility';
import { checkRelease, readRelease, releaseCatalog } from '../tools/src/release-manifest';
import { buildDeploymentPlan, formatDeploymentPlan, resolveRequestedScopes, type DeploymentPlan, type DeploymentProfileName } from '../tools/src/deployment-plan';
import { manifestsForRepository, readLaunchEvidence } from '../tools/check-launch';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDeployable } from '../tools/src/deploy-guard';

/**
 * Deployment orchestration for task 48.4. It is SAFE by default: every exported path is a pure
 * planner or a guard, and the CLI only ever enumerates the ordered rollout steps and the launch-gate
 * decisions. It makes NO network or account call and never uploads or activates a deployment. A real
 * deployment would require explicit real-deploy arguments that this build environment does not
 * supply, and would still refuse any scope whose launch gate is not satisfied.
 */

/** Guard foundation for task 48.4; this command never uploads or activates a deployment. */
export function checkDeployment(configPath: string): void {
  const path = resolve(configPath);
  const vars = ['', '.staging', '.production'].map((suffix) => resolve(dirname(path), `.dev.vars${suffix}`)).filter(existsSync).map((file) => readFileSync(file, 'utf8'));
  assertDeployable(JSON.parse(readFileSync(path, 'utf8')), vars, process.env);
}

/** Compatibility preflight only; the full plan is produced by `planDeployment`. */
export function checkCompatibleDeployment(configPath: string, manifestPath: string, inventoryPath: string) {
  checkDeployment(configPath);
  const root = fileURLToPath(new URL('../', import.meta.url));
  const manifest = readRelease(root, manifestPath); checkRelease(root, manifest);
  const inventory = deploymentInventorySchema.parse(JSON.parse(readFileSync(resolve(inventoryPath), 'utf8')));
  return rolloutPlan(manifest, inventory, releaseCatalog(root));
}

/**
 * Build the full dry-run deployment plan for the requested scopes/profile: the compatible rollout
 * guard and preflight, the ordered rollout phases, and the per-scope launch-gate decisions read from
 * the repository's gate manifests and recorded launch evidence. In a build checkout with no recorded
 * infrastructure acceptance evidence, every gate is BLOCKED and no scope activates. This never
 * deploys and never touches an account.
 */
export function planDeployment(root: string, configPath: string, manifestPath: string, inventoryPath: string, profile: DeploymentProfileName | readonly string[]): DeploymentPlan {
  checkDeployment(configPath);
  const target = readRelease(root, manifestPath); checkRelease(root, target);
  const inventory = deploymentInventorySchema.parse(JSON.parse(readFileSync(resolve(inventoryPath), 'utf8')));
  const requestedScopes = resolveRequestedScopes(profile);
  return buildDeploymentPlan({
    target,
    inventory,
    catalog: releaseCatalog(root),
    gateManifests: manifestsForRepository(root),
    evidence: readLaunchEvidence(root),
    requestedScopes,
  });
}

const USAGE = [
  'Usage: scripts/deploy.ts --check <config>',
  '     | scripts/deploy.ts --preflight <config> <repository-manifest> <observed-inventory.json>',
  '     | scripts/deploy.ts --dry-run <config> <repository-manifest> <observed-inventory.json> [--profile workspace-only|public|full] [--json]',
  'Deployment is dry-run only; no real deployment or account access is performed.',
].join('\n');

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const args = process.argv.slice(2);
    if (args.length === 2 && args[0] === '--check') {
      checkDeployment(args[1]!);
      console.log('Deployment configuration checked; nothing was deployed.');
    } else if (args.length === 4 && args[0] === '--preflight') {
      console.log(JSON.stringify(checkCompatibleDeployment(args[1]!, args[2]!, args[3]!), null, 2));
    } else if (args[0] === '--dry-run' && args.length >= 4) {
      const json = args.includes('--json');
      const profileIndex = args.indexOf('--profile');
      const profile = (profileIndex === -1 ? 'full' : args[profileIndex + 1]) as DeploymentProfileName;
      if (profileIndex !== -1 && !['workspace-only', 'public', 'full'].includes(profile)) throw new Error(USAGE);
      // Refuse a real-deploy request: this build environment never makes an account call.
      if (args.includes('--apply') || args.includes('--execute')) throw new Error('Real deployment is not available in this build environment; use --dry-run. No account access.');
      const plan = planDeployment(root, args[1]!, args[2]!, args[3]!, profile);
      console.log(json ? JSON.stringify(plan, null, 2) : formatDeploymentPlan(plan));
    } else throw new Error(USAGE);
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
