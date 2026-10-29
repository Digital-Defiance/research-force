import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditSpecs, evidenceSchema, safePath, type PathInfo } from './src/specs';
import { sanitizeTestReport } from './src/spec-test-report';

export const SPEC_DIRECTORY = '.kiro/specs/research-collab-cms';
export const EVIDENCE_FILE = 'docs/acceptance/task-evidence.json';
export const STATUS_FILE = 'docs/acceptance/spec-status.json';
export const LOCAL_CHECK_FILE = 'docs/acceptance/checks/local-tests.json';
const hash = (content: string | Uint8Array): string => createHash('sha256').update(content).digest('hex');

/** All file inspection is confined to this checkout, including symlink targets. */
export function inspectRepositoryPath(root: string, path: string): PathInfo {
  if (!safePath(path)) return { kind: 'missing' };
  try {
    const target = realpathSync(resolve(root, path));
    if (target !== root && !target.startsWith(root + sep)) return { kind: 'missing' };
    const stat = statSync(target);
    if (stat.isDirectory()) return { kind: 'directory' };
    return stat.isFile() ? { kind: 'file', sha256: hash(readFileSync(target)) } : { kind: 'missing' };
  } catch { return { kind: 'missing' }; }
}

export function repositoryStatus(root: string) {
  const propertyFiles: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
      if (['node_modules', '.cache', 'dist', '.wrangler', '.git'].includes(entry.name) || entry.isSymbolicLink()) continue;
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (/\/test\/properties\/p\d+-[^/]+\.test\.[cm]?[jt]sx?$/u.test(path)) propertyFiles.push(path);
    }
  };
  for (const folder of ['apps', 'packages', 'tools']) walk(folder);
  const inspectCache = new Map<string, PathInfo>();
  const inspect = (path: string): PathInfo => {
    if (!inspectCache.has(path)) inspectCache.set(path, inspectRepositoryPath(root, path));
    return inspectCache.get(path)!;
  };
  const read = (path: string): string => {
    if (inspect(path).kind !== 'file') throw new Error(`Missing repository file: ${path}`);
    return readFileSync(resolve(root, path), 'utf8');
  };
  const specFiles = [`${SPEC_DIRECTORY}/requirements.md`, `${SPEC_DIRECTORY}/design.md`, `${SPEC_DIRECTORY}/tasks.md`, EVIDENCE_FILE];
  const [requirements, design, tasks, evidence] = specFiles.map(read);
  return {
    inputs: Object.fromEntries(specFiles.map((path) => [path, hash(read(path))])),
    ...auditSpecs({ requirements: requirements!, design: design!, tasks: tasks!, evidence: JSON.parse(evidence!),
      propertyFiles: propertyFiles.sort(), inspect, readReport: (path) => JSON.parse(read(path)) }),
  };
}

export function checkSpecs(root: string, write = false): string[] {
  const report = repositoryStatus(realpathSync(root));
  if (report.issues.length) return report.issues;
  const content = JSON.stringify(report, null, 2) + '\n';
  const path = resolve(root, STATUS_FILE);
  if (write) writeFileSync(path, content);
  else {
    try { if (readFileSync(path, 'utf8') !== content) return ['Spec inventory is stale. Run npm run specs:write and review the changes.']; }
    catch { return ['Spec inventory is missing. Run npm run specs:write.']; }
  }
  return [];
}

export function recordLocalTests(root: string, raw: unknown): void {
  const ledger = evidenceSchema.parse(JSON.parse(readFileSync(resolve(root, EVIDENCE_FILE), 'utf8')));
  const paths = [...new Set(ledger.records.flatMap((record) => [...record.sourcePaths, ...record.testPaths]))].sort();
  const files = Object.fromEntries(paths.map((path) => {
    const info = inspectRepositoryPath(root, path);
    if (info.kind !== 'file' || !info.sha256) throw new Error(`Missing evidence file: ${path}`);
    return [path, info.sha256];
  }));
  const report = sanitizeTestReport(raw, root, files);
  const started = Date.parse(report.recordedAt);
  if (started > Date.now()) throw new Error('Test receipts cannot be dated in the future.');
  for (const path of paths) if (statSync(resolve(root, path)).mtimeMs > started) throw new Error(`Evidence changed after the test run started; rerun tests: ${path}`);
  for (const suite of report.suites) if (inspectRepositoryPath(root, suite.path).kind !== 'file') throw new Error(`Missing executed test file: ${suite.path}`);
  writeFileSync(resolve(root, LOCAL_CHECK_FILE), JSON.stringify(report, null, 2) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/u, '');
  const args = process.argv.slice(2);
  try {
    if (args[0] === '--record-tests' && args.length === 2) {
      recordLocalTests(root, JSON.parse(readFileSync(resolve(args[1]!), 'utf8')));
      console.log(`Sanitized local test evidence recorded in ${LOCAL_CHECK_FILE}. Run npm run specs:write after reviewing the ledger.`);
    } else {
      if (args.some((arg) => arg !== '--write') || args.length > 1) throw new Error('Usage: tools/check-specs.ts [--write | --record-tests <Vitest JSON>]');
      const issues = checkSpecs(root, args.includes('--write'));
      if (issues.length) { console.error(issues.join('\n')); process.exitCode = 1; }
      else console.log(`Spec traceability, scheduling, local evidence and ${relative(root, resolve(root, STATUS_FILE))} checked.`);
    }
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
