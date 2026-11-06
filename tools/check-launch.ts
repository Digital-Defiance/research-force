import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  certifyScopes,
  EMPTY_LAUNCH_EVIDENCE,
  formatReport,
  launchEvidenceSchema,
  manifestsForGraph,
  type GateManifest,
  type GraphGate,
  type LaunchEvidence,
} from './src/launch-gates';

/**
 * Runtime launch-gate checker CLI (task 68.4). It reads the canonical graph's gate definitions and
 * the recorded launch-evidence ledger, evaluates the mandatory R60.4 acceptance matrix, prints a
 * per-gate SATISFIED/BLOCKED report, and exits non-zero when a requested scope is not satisfied.
 *
 * It makes NO network or account call and establishes nothing itself — it evaluates recorded
 * evidence. In a build checkout with no recorded infrastructure acceptance evidence, every gate is
 * BLOCKED (not an error, not a false pass) and certifying any scope exits non-zero. This is the
 * runtime counterpart to the structural audit in `tools/check-specs.ts`.
 */

export const SPEC_DIRECTORY = '.kiro/specs/research-collab-cms';
export const TASKS_FILE = `${SPEC_DIRECTORY}/tasks.md`;
/** The ledger task 48.12 writes with recorded staging/acceptance evidence; absent means every gate BLOCKED. */
export const LAUNCH_EVIDENCE_FILE = 'docs/acceptance/launch-evidence.json';

/** The minimal graph gate shape parsed from tasks.md; only id/requiresGates/requiredEvidence are used here. */
interface ParsedGraphGate extends GraphGate {
  readonly id: string;
  readonly requiresGates?: readonly string[];
  readonly requiredEvidence: readonly string[];
}

/** Extract the canonical-graph `gates[]` array from the tasks.md task-dependency-graph JSON block. */
export function readGraphGates(tasksMarkdown: string): ParsedGraphGate[] {
  const json = /## Task Dependency Graph[\s\S]*?```json\n([\s\S]*?)\n```/u.exec(tasksMarkdown)?.[1];
  if (!json) throw new Error('Task dependency graph JSON block not found in tasks.md.');
  const parsed = JSON.parse(json) as { gates?: ParsedGraphGate[] };
  if (!Array.isArray(parsed.gates) || parsed.gates.length === 0) throw new Error('No gates defined in the task dependency graph.');
  return parsed.gates;
}

/** Load the recorded launch-evidence ledger, or the empty ledger when the file is absent. */
export function readLaunchEvidence(root: string): LaunchEvidence {
  let raw: string;
  try {
    raw = readFileSync(resolve(root, LAUNCH_EVIDENCE_FILE), 'utf8');
  } catch {
    return EMPTY_LAUNCH_EVIDENCE; // no recorded evidence yet → every gate BLOCKED, honestly
  }
  return launchEvidenceSchema.parse(JSON.parse(raw));
}

/** Build the runtime gate manifests for this repository from the canonical graph. */
export function manifestsForRepository(root: string): GateManifest[] {
  const tasks = readFileSync(resolve(root, TASKS_FILE), 'utf8');
  return manifestsForGraph(readGraphGates(tasks));
}

/** Evaluate the requested scopes against the repository's gate manifests and recorded evidence. */
export function checkLaunch(root: string, requested: readonly string[]): { report: string; certified: boolean } {
  const manifests = manifestsForRepository(root);
  const evidence = readLaunchEvidence(root);
  const report = formatReport(manifests, evidence, requested);
  const { certified } = certifyScopes(manifests, evidence, requested);
  return { report, certified };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/u, '');
  const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  try {
    const { report, certified } = checkLaunch(root, requested);
    console.log(report);
    // Exit non-zero when a scope was requested but not certified. Reporting-only (no scope) exits 0.
    if (requested.length && !certified) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
