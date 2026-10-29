/**
 * Local-only presence check for Worker secrets and vars (spec task 48.1). It reports which required
 * keys are missing from a local source (a `.dev.vars`-style file and/or `process.env`). It makes NO
 * Cloudflare account access and NEVER prints secret values — only key names and present/missing.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workerSecrets, type WorkerSecrets } from '../infra/secrets';

export interface MissingReport {
  readonly worker: string;
  readonly missingSecrets: readonly string[];
  readonly missingVars: readonly string[];
}

/** Which required keys for each Worker are absent from the provided present-key set. */
export function missingSecrets(present: ReadonlySet<string>, worker?: string): readonly MissingReport[] {
  const entries: readonly WorkerSecrets[] = worker ? workerSecrets.filter((w) => w.worker === worker) : workerSecrets;
  return entries.map((entry) => ({
    worker: entry.worker,
    missingSecrets: entry.secrets.map((secret) => secret.name).filter((name) => !present.has(name)),
    missingVars: entry.vars.map((varEntry) => varEntry.name).filter((name) => !present.has(name)),
  }));
}

/** True when any Worker in the report is missing a secret or var. */
export function hasMissing(reports: readonly MissingReport[]): boolean {
  return reports.some((report) => report.missingSecrets.length > 0 || report.missingVars.length > 0);
}

/** Parse the KEY names present in a `.dev.vars`-style file. Values are ignored; only presence matters. */
export function parsePresentKeys(contents: string): Set<string> {
  const keys = new Set<string>();
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u.exec(line);
    if (match) keys.add(match[1]!);
  }
  return keys;
}

function formatReports(reports: readonly MissingReport[]): string {
  return reports
    .map((report) => {
      const parts: string[] = [`${report.worker}:`];
      if (report.missingSecrets.length === 0 && report.missingVars.length === 0) parts.push('  all required keys present');
      if (report.missingSecrets.length) parts.push(`  missing secrets: ${report.missingSecrets.join(', ')}`);
      if (report.missingVars.length) parts.push(`  missing vars: ${report.missingVars.join(', ')}`);
      return parts.join('\n');
    })
    .join('\n');
}

const USAGE = 'Usage: tools/check-secrets.ts [--vars <path-to-.dev.vars>] [--worker <name>]';

export function runCli(argv: readonly string[], env: NodeJS.ProcessEnv): { readonly output: string; readonly exitCode: number } {
  const args = [...argv];
  const present = new Set<string>(Object.keys(env));
  let worker: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--vars') {
      const path = args[i + 1];
      if (!path) return { output: USAGE, exitCode: 1 };
      try { for (const key of parsePresentKeys(readFileSync(resolve(path), 'utf8'))) present.add(key); }
      catch { return { output: `Cannot read vars file: ${path}`, exitCode: 1 }; }
      i += 1;
    } else if (arg === '--worker') {
      worker = args[i + 1];
      if (!worker) return { output: USAGE, exitCode: 1 };
      i += 1;
    } else return { output: USAGE, exitCode: 1 };
  }
  if (worker && !workerSecrets.some((entry) => entry.worker === worker)) {
    return { output: `Unknown Worker: ${worker}`, exitCode: 1 };
  }
  const reports = missingSecrets(present, worker);
  const missing = hasMissing(reports);
  const header = missing ? 'Missing required keys (no account access performed):' : 'All required secrets and vars are present locally.';
  return { output: `${header}\n${formatReports(reports)}`, exitCode: missing ? 1 : 0 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runCli(process.argv.slice(2), process.env);
  if (result.exitCode === 0) console.log(result.output);
  else console.error(result.output);
  process.exitCode = result.exitCode;
}
