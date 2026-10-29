import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { deploymentInventorySchema, recoveryPlan, rolloutPlan, backupReader } from '@researchforce/domain/compatibility';
import { checkRelease, developmentManifest, readRelease, releaseCatalog, sealCandidate } from './src/release-manifest';
import { rehearseRelease } from './src/release-rehearsal';

const root = fileURLToPath(new URL('../', import.meta.url));
const json = (path: string): unknown => JSON.parse(readFileSync(resolve(path), 'utf8'));
export async function releaseCommand(args: readonly string[]): Promise<unknown> {
  if (args[0] === 'write' && args.length === 1) {
    const manifest = developmentManifest(root);
    writeFileSync(resolve(root, 'infra/releases/development.json'), JSON.stringify(manifest, null, 2) + '\n');
    return { releaseId: manifest.id, status: 'development-manifest-refreshed', productionAuthorized: false };
  }
  if (args[0] === 'seal' && args.length === 2) {
    const current = readRelease(root, 'infra/releases/development.json'); checkRelease(root, current, true);
    releaseCatalog(root);
    const candidate = sealCandidate(resolve(root, 'infra/releases'), current, args[1]!);
    return { releaseId: candidate.id, status: candidate.status, productionAuthorized: false };
  }
  if (args[0] === 'check' && args.length === 1) {
    const catalog = releaseCatalog(root);
    const current = catalog.find((m) => m.id === 'development');
    if (!current) throw new Error('The development manifest is missing.');
    checkRelease(root, current, true);
    return { releaseId: current.id, status: 'compatible-declarations-checked', releasedVersions: catalog.filter((m) => m.status === 'released').map((m) => m.id), productionAuthorized: false };
  }
  if (['plan', 'rollback', 'forward'].includes(args[0] ?? '') && args.length === 3) {
    const target = readRelease(root, args[1]!); const inventory = deploymentInventorySchema.parse(json(args[2]!));
    checkRelease(root, target);
    if (args[0] === 'plan') return rolloutPlan(target, inventory, releaseCatalog(root));
    return recoveryPlan(args[0] as 'rollback' | 'forward', target, inventory);
  }
  if (args[0] === 'rehearse' && args.length === 1) {
    const manifest = readRelease(root, 'infra/releases/development.json'); checkRelease(root, manifest, true);
    return rehearseRelease(root, manifest, tmpdir());
  }
  if (args[0] === 'backup-reader' && args.length === 4) {
    const manifest = readRelease(root, args[1]!); checkRelease(root, manifest);
    const format = Number(args[2]); if (!Number.isSafeInteger(format) || format < 0) throw new Error('Invalid backup format.');
    return { transform: backupReader(manifest, { format, schemaRelease: args[3]! }), quarantineRequired: true, productionAuthorized: false };
  }
  throw new Error('Usage: tools/release.ts write | check | rehearse | seal <candidate-id> | plan|rollback|forward <repository-manifest> <inventory.json> | backup-reader <repository-manifest> <format> <schema-release>. No deployment is performed.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await releaseCommand(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
