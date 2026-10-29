import { searchIndexSlice } from './upgrade-backfills';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { deploymentInventorySchema, STORES } from '@researchforce/domain/compatibility';
import { checkRelease, readRelease } from './release-manifest';
import { applyUpgrade } from './upgrade-store';

/** Explicitly limited to SQLite files created by the local release rehearsal, never dev state or remote D1. */
export function upgradeCommand(root: string, phase: 'expand' | 'backfill' | 'contract', args: readonly string[]): unknown {
  if (args[0] !== '--local' || (phase !== 'contract' ? args.length !== 4 : args.length !== 6)) throw new Error(`Usage: scripts/${phase}.ts --local <repository-manifest> <core|search|public> <rehearsal.sqlite>${phase === 'contract' ? ' <inventory.json> <restore-proof.json>' : ''}`);
  const manifest = readRelease(root, args[1]!); checkRelease(root, manifest);
  const store = args[2]; if (!STORES.includes(store as typeof STORES[number])) throw new Error('Unknown store.');
  const path = realpathSync(resolve(args[3]!));
  const parent = resolve(path, '..');
  const marker = JSON.parse(readFileSync(resolve(parent, 'report.json'), 'utf8')) as { environment?: string; releaseId?: string; results?: { store: string; checkpoint: number }[] };
  if (!marker.results?.some((r) => r.store === store && basename(path) === `${r.store}-${r.checkpoint}.sqlite`) || marker.environment !== 'isolated-local-sqlite' || marker.releaseId !== manifest.id) throw new Error('Only an existing matching local rehearsal file is allowed.');
  const inventory = phase === 'contract' ? deploymentInventorySchema.parse(JSON.parse(readFileSync(resolve(args[4]!), 'utf8'))) : undefined;
  if (inventory && inventory.environment !== 'rehearsal') throw new Error('This adapter refuses staging/production inventories.');
  const proof = phase === 'contract' ? JSON.parse(readFileSync(resolve(args[5]!), 'utf8')) as unknown : undefined;
  const db = new DatabaseSync(path);
  try {
    if (phase === 'backfill') {
      if (store !== 'search') throw new Error('No registered backfill for this store.');
      return { ...searchIndexSlice(db, manifest), productionAuthorized: false };
    }
    return { ...applyUpgrade(db, root, manifest, store as typeof STORES[number], { phase, ...(inventory ? { inventory, restoreProof: proof, now: new Date() } : {}) }), productionAuthorized: false };
  } finally { db.close(); }
}
