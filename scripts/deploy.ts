import { deploymentInventorySchema, rolloutPlan } from '@researchforce/domain/compatibility';
import { checkRelease, readRelease, releaseCatalog } from '../tools/src/release-manifest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDeployable } from '../tools/src/deploy-guard';

/** Guard foundation for task 48.4; this command never uploads or activates a deployment. */
export function checkDeployment(configPath: string): void {
  const path = resolve(configPath);
  const vars = ['', '.staging', '.production'].map((suffix) => resolve(dirname(path), `.dev.vars${suffix}`)).filter(existsSync).map((file) => readFileSync(file, 'utf8'));
  assertDeployable(JSON.parse(readFileSync(path, 'utf8')), vars, process.env);
}
/** Compatibility preflight only; actual provider observation/deployment remains task 48.4. */
export function checkCompatibleDeployment(configPath: string, manifestPath: string, inventoryPath: string) {
  checkDeployment(configPath);
  const root = fileURLToPath(new URL('../', import.meta.url));
  const manifest = readRelease(root, manifestPath); checkRelease(root, manifest);
  const inventory = deploymentInventorySchema.parse(JSON.parse(readFileSync(resolve(inventoryPath), 'utf8')));
  return rolloutPlan(manifest, inventory, releaseCatalog(root));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 2 && args[0] === '--check') {
      checkDeployment(args[1]!);
      console.log('Deployment configuration checked; nothing was deployed.');
    } else if (args.length === 4 && args[0] === '--preflight') {
      console.log(JSON.stringify(checkCompatibleDeployment(args[1]!, args[2]!, args[3]!), null, 2));
    } else throw new Error('Usage: scripts/deploy.ts --check <config> | --preflight <config> <repository-manifest> <observed-inventory.json>. Deployment orchestration remains task 48.4.');
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
