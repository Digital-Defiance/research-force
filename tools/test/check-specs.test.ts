import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditSpecs, type SpecInput } from '../src/specs';
import { sanitizeTestReport } from '../src/spec-test-report';
import { checkSpecs, EVIDENCE_FILE, inspectRepositoryPath, LOCAL_CHECK_FILE, recordLocalTests, repositoryStatus, SPEC_DIRECTORY, STATUS_FILE } from '../check-specs';

const sha256 = 'a'.repeat(64);
const source = 'tools/src/example.ts';
const testPath = 'tools/test/example.test.ts';
const propertyPath = 'packages/example/test/properties/p01-example.test.ts';
const reportPath = 'docs/acceptance/checks/example.json';
function fixture() {
  const graph = {
    schemaVersion: 2, semantics: { waveDependencies: 'Serial barriers.' }, completedBaseline: [] as string[],
    phases: { foundation: { firstWave: 0, lastWave: 1 } },
    waves: [
      { id: 0, phase: 'foundation', dependsOn: [] as number[], tasks: ['1.1'] },
      { id: 1, phase: 'foundation', dependsOn: [0], tasks: ['1.2'] },
    ], helperEdges: [['1.1', '1.2']],
    gates: [{ id: 'archive', checkerTask: '1.2', evidenceTask: '1.2', requiredTasks: ['1.1'], requiresGates: [] as string[], requiredEvidence: ['Executed acceptance.'] }],
  };
  const evidence = { schemaVersion: 1, historicalBaseline: [] as string[], historicalPolicy: 'Unchecked inherited evidence is not release acceptance.', records: [] as Record<string, unknown>[] };
  const requirements = '# Requirements\n### Requirement 1: Example\n#### Acceptance Criteria\n1. The system preserves the example.\n';
  const design = '### Property 1: Example survives\n\n**Validates: Requirements 1.1**\n\nArbitrary examples survive.\n';
  let body = 'Canonical phases: `foundation`\n\n- [ ] 1. Example\n  - [ ] 1.1 Implement the example\n    - Implement `tools/src/example.ts`.\n    - _Requirements: 1.1_\n  - [ ] 1.2 Verify the example\n    - **Property 1: Example survives**\n    - **Validates: Requirements 1.1**\n';
  let report: unknown = { schemaVersion: 1, command: 'vitest --run', recordedAt: '2026-10-28T08:00:00.000Z', scope: 'local-synthetic', success: true,
    suites: [{ path: testPath, passed: 2, failed: 0, skipped: 0 }], files: { [source]: sha256, [testPath]: sha256 } };
  const input = (): SpecInput => ({ requirements, design, tasks: `${body}\n## Task Dependency Graph\n\n\`\`\`json\n${JSON.stringify(graph)}\n\`\`\`\n`, evidence,
    propertyFiles: [propertyPath], inspect: () => ({ kind: 'file', sha256 }), readReport: () => report });
  return { graph, evidence, input, setBody: (value: string) => { body = value; }, getBody: () => body, setReport: (value: unknown) => { report = value; } };
}
const problems = (input: SpecInput): string => auditSpecs(input).issues.join('\n');

describe('spec traceability and scheduling', () => {
  it('inventories criteria, test ownership, paths, prerequisites and scope without certifying launch', () => {
    const result = auditSpecs(fixture().input());
    expect(result.issues).toEqual([]);
    expect(result.nextTasks).toEqual(['1.1']);
    expect(result.remainingBuildOrder).toEqual(['1.1', '1.2']);
    expect(result.summary).toMatchObject({ criteria: 1, leafTasks: 2, properties: 1, remainingWaves: 2 });
    expect(result.requirements[0]?.criteria[0]?.tasks).toEqual(['1.1', '1.2']);
    expect(result.tasks[1]).toMatchObject({ prerequisites: ['1.1'], acceptance: 'planned' });
    expect(result.gates[0]?.certification).toContain('Not evaluated');
  });
  it('rejects missing/duplicate criterion and property numbers', () => {
    const f = fixture().input();
    expect(problems({ ...f, requirements: f.requirements.replace('1. The', '2. The') })).toContain('criteria');
    expect(problems({ ...f, requirements: f.requirements + '1. A duplicate.\n' })).toContain('criteria');
    expect(problems({ ...f, design: f.design.replace('Property 1:', 'Property 2:') })).toContain('Property headings');
  });
  it('rejects uncovered and unknown criteria and mismatched property/task references', () => {
    const f = fixture().input();
    expect(problems({ ...f, requirements: f.requirements + '2. Another promise.\n' })).toContain('1.2 has no task coverage');
    expect(problems({ ...f, tasks: f.tasks.replace('_Requirements: 1.1_', '_Requirements: 99.1_') })).toContain('unknown criterion 99.1');
    expect(problems({ ...f, tasks: f.tasks.replace('Validates: Requirements 1.1', 'Validates: Requirements 1.1, 99.1') })).toContain('different validation references');
  });
  it('requires one owning task per property and inventories supplementary layer-specific tests', () => {
    const f = fixture().input();
    expect(problems({ ...f, tasks: f.tasks.replace('_Requirements: 1.1_', '**Property 1: Example survives**\n    - **Validates: Requirements 1.1**') })).toContain('exactly one owning task');
    expect(problems({ ...f, tasks: f.tasks.replace('**Property 1: Example survives**', 'An ordinary test') })).toContain('found 0');
    expect(auditSpecs({ ...f, propertyFiles: [propertyPath, 'tools/test/properties/p01-integration.test.ts'] }).properties[0]?.testPaths).toHaveLength(2);
  });
  it('rejects optional tests and a completed parent with unfinished children', () => {
    const f = fixture().input();
    expect(problems({ ...f, tasks: f.tasks.replace('[ ] 1.2', '[ ]* 1.2') })).toContain('Optional');
    expect(problems({ ...f, tasks: f.tasks.replace('- [ ] 1. Example', '- [x] 1. Example') })).toContain('Checked parent');
  });
  it('rejects malformed graph JSON, missing tasks and duplicate scheduling', () => {
    const f = fixture();
    expect(problems({ ...f.input(), tasks: f.input().tasks.replace('"schemaVersion":2', '"schemaVersion":99') })).toContain('invalid schema');
    f.graph.waves[1]!.tasks = ['1.1'];
    expect(problems(f.input())).toContain('more than once');
    expect(problems(f.input())).toContain('omits task 1.2');
    f.graph.waves[1]!.tasks = ['99.1'];
    expect(problems(f.input())).toContain('unknown task 99.1');
  });
  it('rejects checked-baseline drift and a newly checked task without executed evidence', () => {
    const f = fixture(); f.graph.completedBaseline = ['1.1'];
    expect(problems(f.input())).toContain('baseline must match');
    f.setBody(f.getBody().replace('[ ] 1.1', '[x] 1.1'));
    expect(problems(f.input())).toContain('no acceptance record');
  });
  it('rejects cyclic/backward wave barriers, stale phase ranges and reordered milestone prose', () => {
    const f = fixture(); f.graph.waves[0]!.dependsOn = [1];
    expect(problems(f.input())).toContain('cyclic predecessor');
    f.graph.waves[0]!.dependsOn = []; f.graph.phases.foundation.lastWave = 5;
    expect(problems(f.input())).toContain('stale or noncontiguous');
    f.setBody(f.getBody().replace('`foundation`', '`different`'));
    expect(problems(f.input())).toContain('canonical phase order');
  });
  it('rejects backwards and self-referencing helper edges', () => {
    const f = fixture(); f.graph.helperEdges = [['1.2', '1.1'], ['1.1', '1.1']];
    expect(problems(f.input())).toContain('1.2 -> 1.1');
    expect(problems(f.input())).toContain('1.1 -> 1.1');
  });
  it('rejects unknown tasks/gates, gate cycles, and evidence scheduled after activation', () => {
    const f = fixture(); f.graph.gates[0]!.requiresGates = ['absent'];
    expect(problems(f.input())).toContain('unknown gate absent');
    f.graph.gates[0]!.requiresGates = ['archive'];
    expect(problems(f.input())).toContain('gate cycle');
    f.graph.gates[0]!.checkerTask = '99.1';
    expect(problems(f.input())).toContain('unknown task 99.1');
    const graph = { ...f.graph, gates: [{ id: 'late', checkerTask: '1.2', evidenceTask: '1.2', beforeTasks: ['1.1'], requiredEvidence: ['Acceptance.'] }] };
    expect(problems({ ...f.input(), tasks: f.input().tasks.replace(JSON.stringify(f.graph), JSON.stringify(graph)) })).toContain('too late');
  });
});

describe('acceptance evidence', () => {
  const accepted = () => {
    const f = fixture(); f.setBody(f.getBody().replace('[ ] 1.1', '[x] 1.1'));
    f.graph.completedBaseline = ['1.1']; f.graph.waves.shift();
    f.graph.waves[0]!.id = 0; f.graph.waves[0]!.dependsOn = []; f.graph.phases.foundation.lastWave = 0;
    f.evidence.records.push({ task: '1.1', state: 'accepted', reason: 'Local synthetic behavior verified.', sourcePaths: [source], testPaths: [testPath], checks: [reportPath] });
    return f;
  };
  it('accepts local executed suites with current source/test fingerprints', () => {
    const result = auditSpecs(accepted().input());
    expect(result.issues).toEqual([]);
    expect(result.summary.acceptedWithLocalEvidence).toBe(1);
    expect(result.tasks[0]?.acceptance).toBe('accepted');
  });
  it('does not treat historical checkboxes as proof', () => {
    const f = accepted(); f.evidence.records = []; f.evidence.historicalBaseline = ['1.1'];
    const result = auditSpecs(f.input());
    expect(result.issues).toEqual([]);
    expect(result.tasks[0]?.acceptance).toBe('historical_unverified');
  });
  it('requires source, test and actual passing checks rather than a file or checkbox', () => {
    const f = accepted(); f.evidence.records[0]!['checks'] = [];
    expect(problems(f.input())).toContain('executed-check evidence');
    f.setReport({ success: true }); f.evidence.records[0]!['checks'] = [reportPath];
    expect(problems(f.input())).toContain('invalid executed-check report');
  });
  it('rejects stale evidence, failed/skipped suites and absent executed suites', () => {
    const f = accepted();
    expect(problems({ ...f.input(), inspect: () => ({ kind: 'file', sha256: 'b'.repeat(64) }) })).toContain('stale or unfingerprinted');
    for (const suite of [{ path: testPath, passed: 1, failed: 1, skipped: 0 }, { path: testPath, passed: 1, failed: 0, skipped: 1 }, { path: source, passed: 1, failed: 0, skipped: 0 }]) {
      f.setReport({ schemaVersion: 1, command: 'vitest --run', recordedAt: '2026-10-28T08:00:00.000Z', scope: 'local-synthetic', success: true,
        suites: [suite], files: { [source]: sha256, [testPath]: sha256 } });
      expect(problems(f.input())).not.toBe('');
    }
  });
  it('keeps reopened work unfinished and requires an existing correction ID', () => {
    const f = fixture(); f.evidence.records.push({ task: '1.1', state: 'reopened', reason: 'Known failure.', sourcePaths: [source], testPaths: [testPath] });
    expect(problems(f.input())).toContain('needs a correction task');
    f.evidence.records[0]!['correctionTasks'] = ['99.1'];
    expect(problems(f.input())).toContain('unknown correction task');
    f.evidence.records[0]!['correctionTasks'] = ['1.1']; f.setBody(f.getBody().replace('[ ] 1.1', '[x] 1.1'));
    expect(problems(f.input())).toContain('Incomplete evidence');
  });
  it('refuses paths escaping the checkout and never loads an unsafe report', () => {
    const f = accepted(); let reads = 0; f.evidence.records[0]!['checks'] = ['../private.json'];
    expect(problems({ ...f.input(), readReport: () => { reads += 1; return {}; } })).toContain('Unsafe evidence report path');
    expect(reads).toBe(0);
    f.setBody(f.getBody().replace('tools/src/example.ts', 'tools/../../private.ts'));
    expect(problems(f.input())).toContain('Unsafe repository path');
  });
});

describe('repository integration', () => {
  it('checks generated inventory drift and refuses to overwrite it for structurally invalid specs', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'rf-spec-cli-')));
    try {
      for (const directory of ['apps', 'packages', 'tools/src', SPEC_DIRECTORY, 'docs/acceptance']) mkdirSync(join(root, directory), { recursive: true });
      const input = fixture().input();
      writeFileSync(join(root, SPEC_DIRECTORY, 'requirements.md'), input.requirements);
      writeFileSync(join(root, SPEC_DIRECTORY, 'design.md'), input.design);
      writeFileSync(join(root, SPEC_DIRECTORY, 'tasks.md'), input.tasks);
      writeFileSync(join(root, EVIDENCE_FILE), JSON.stringify(input.evidence));
      expect(checkSpecs(root)).toEqual([expect.stringContaining('missing')]);
      expect(checkSpecs(root, true)).toEqual([]);
      expect(checkSpecs(root)).toEqual([]);
      writeFileSync(join(root, SPEC_DIRECTORY, 'tasks.md'), input.tasks.replace('Implement the example', 'Implement the revised example'));
      expect(checkSpecs(root)).toEqual([expect.stringContaining('stale')]);
      expect(checkSpecs(root, true)).toEqual([]);
      const previous = readFileSync(join(root, STATUS_FILE), 'utf8');
      writeFileSync(join(root, SPEC_DIRECTORY, 'requirements.md'), input.requirements + '2. An uncovered promise.\n');
      expect(checkSpecs(root, true).join('\n')).toContain('has no task coverage');
      expect(readFileSync(join(root, STATUS_FILE), 'utf8')).toBe(previous);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('rejects symlinks escaping the checkout as well as lexical traversal', () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'rf-spec-path-'))); const root = join(parent, 'repo');
    try {
      mkdirSync(root); writeFileSync(join(root, 'inside.ts'), 'export {};'); writeFileSync(join(parent, 'outside.ts'), 'export {};');
      symlinkSync(join(parent, 'outside.ts'), join(root, 'escape.ts'));
      expect(inspectRepositoryPath(root, 'inside.ts').kind).toBe('file');
      expect(inspectRepositoryPath(root, 'escape.ts').kind).toBe('missing');
      expect(inspectRepositoryPath(root, '../outside.ts').kind).toBe('missing');
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });
  it('validates the actual project specs and inventories every declared criterion and property', () => {
    const root = new URL('../../', import.meta.url).pathname.replace(/\/$/u, '');
    const result = repositoryStatus(root);
    // Live receipt hashes are renewed after this run; CI check:specs validates both layers after import.
    expect(result.structuralIssues).toEqual([]);
    expect(result.requirements.every((r) => r.criteria.every((criterion) => criterion.tasks.length > 0))).toBe(true);
  });
});

describe('local test evidence import', () => {
  const raw = () => ({ success: true, startTime: Date.parse('2026-10-28T08:00:00.000Z'), numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, numPassedTests: 1, numTotalTests: 1,
    testResults: [{ name: '/repo/tools/test/example.test.ts', status: 'passed', assertionResults: [{ status: 'passed', title: 'Synthetic input', failureMessages: [], extraPrivateInput: 'never retain' }] }], consoleOutput: 'never retain' });
  it('keeps only counts, relative paths and hashes', () => {
    const result = sanitizeTestReport(raw(), '/repo', { [source]: sha256 });
    expect(result.suites).toEqual([{ path: testPath, passed: 1, failed: 0, skipped: 0 }]);
    expect(JSON.stringify(result)).not.toContain('never retain');
    expect(JSON.stringify(result)).not.toContain('/repo');
  });
  it('refuses failed/skipped/incomplete runs and inconsistent counts', () => {
    for (const patch of [{ success: false }, { numFailedTests: 1 }, { numPendingTests: 1 }, { numTotalTests: 2 }]) expect(() => sanitizeTestReport({ ...raw(), ...patch }, '/repo', {})).toThrow();
  });
  it('refuses test paths outside the checkout and duplicate suite identities', () => {
    const input = raw(); input.testResults[0]!.name = '/outside/secret.test.ts';
    expect(() => sanitizeTestReport(input, '/repo', {})).toThrow();
    const duplicate = raw(); duplicate.testResults.push(duplicate.testResults[0]!); duplicate.numTotalTests = 2; duplicate.numPassedTests = 2;
    expect(() => sanitizeTestReport(duplicate, '/repo', {})).toThrow();
  });
  it('refuses a receipt older than the inspected sources and imports fresh receipts without raw inputs', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'rf-spec-receipt-')));
    try {
      for (const path of ['tools/src', 'tools/test', 'docs/acceptance/checks']) mkdirSync(join(root, path), { recursive: true });
      writeFileSync(join(root, source), 'export {};'); writeFileSync(join(root, testPath), 'export {};');
      const f = fixture(); f.evidence.records.push({ task: '1.1', state: 'partial', reason: 'Acceptance pending.', sourcePaths: [source], testPaths: [testPath] });
      writeFileSync(join(root, EVIDENCE_FILE), JSON.stringify(f.evidence));
      const input = raw(); input.testResults[0]!.name = join(root, testPath); input.startTime = Date.now() - 60_000;
      expect(() => recordLocalTests(root, input)).toThrow('changed after the test run started');
      const before = new Date(Date.now() - 2000);
      for (const path of [source, testPath]) utimesSync(join(root, path), before, before);
      input.startTime = Date.now() - 1000; recordLocalTests(root, input);
      const receipt = JSON.parse(readFileSync(join(root, LOCAL_CHECK_FILE), 'utf8')) as { suites: { path: string }[] };
      expect(receipt.suites[0]?.path).toBe(testPath);
      expect(JSON.stringify(receipt)).not.toContain('never retain');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
