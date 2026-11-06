import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBootstrapPlan, formatBootstrapPlan } from './src/bootstrap-plan';

/**
 * Installation bootstrap CLI (task 48.4). It reads a bootstrap-input JSON file, validates it, and
 * prints the ordered dry-run bootstrap plan. It makes NO network or account call and provisions,
 * buys, publishes, and selects nothing. When a required operator input is absent — a missing or
 * partial Installation_Public_Copy, a bundle changed without a release, a missing Content_Licence,
 * operating profile/budget, recovery custody, or (for production) fresh restore/containment — it
 * refuses and prints the exact reasons, exiting non-zero.
 */

const USAGE = 'Usage: tools/bootstrap.ts --dry-run <bootstrap-input.json> [--json]. Bootstrap is dry-run only; no account access.';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args[0] !== '--dry-run' || args.length < 2) throw new Error(USAGE);
    const json = args.includes('--json');
    const input = JSON.parse(readFileSync(resolve(args[1]!), 'utf8')) as unknown;
    const plan = buildBootstrapPlan(input);
    console.log(json ? JSON.stringify(plan, null, 2) : formatBootstrapPlan(plan));
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
