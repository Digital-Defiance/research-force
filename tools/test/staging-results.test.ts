import { describe, expect, it } from 'vitest';
import { prepareEntry } from '../src/evidence-recorder';
import { fileOutcome, planFromReport, RESULT_MAPPINGS, type PlaywrightReport, type ResultMapping } from '../src/staging-results';
import { GATE_BUILDERS } from '../src/launch-gates';

const spec = (file: string, title: string, status: string) => ({ title, file, ok: status === 'expected', tests: [{ status }] });
const report = (...specs: ReturnType<typeof spec>[]): PlaywrightReport => ({ suites: [{ file: specs[0]?.file ?? '', suites: [{ specs }] }] });
const FULL: ResultMapping = { suite: 'staging', file: 'a.spec.ts', gate: 'team_archive', requirement: 'large_text', coverage: 'full' };
const options = { suite: 'staging', releaseId: 'rel-1', evidenceRef: 'docs/acceptance/reports/x.md', mappings: [FULL] } as const;

describe('RESULT_MAPPINGS', () => {
  it('only names gate requirements that exist', () => {
    for (const mapping of RESULT_MAPPINGS) {
      expect(GATE_BUILDERS[mapping.gate]?.requirements.some((r) => r.id === mapping.requirement), `${mapping.file}`).toBe(true);
    }
  });
  it('only maps staging specs that exist in the staging suite, and keeps partial coverage honest', () => {
    for (const mapping of RESULT_MAPPINGS.filter((m) => m.coverage === 'partial')) expect(mapping.uncovered).toBeTruthy();
    expect(RESULT_MAPPINGS.filter((m) => m.suite !== 'staging').every((m) => m.disabled)).toBe(true);
  });
});

describe('fileOutcome', () => {
  it('is passed only when every test in the file passed', () => {
    expect(fileOutcome(report(spec('a.spec.ts', 't1', 'expected'), spec('a.spec.ts', 't2', 'expected')), 'a.spec.ts')).toBe('passed');
    expect(fileOutcome(report(spec('a.spec.ts', 't1', 'expected'), spec('a.spec.ts', 't2', 'unexpected')), 'a.spec.ts')).toBe('failed');
    expect(fileOutcome(report(spec('a.spec.ts', 't1', 'expected'), spec('a.spec.ts', 't2', 'skipped')), 'a.spec.ts')).toBe('blocked');
    expect(fileOutcome(report(spec('a.spec.ts', 't1', 'flaky')), 'a.spec.ts')).toBe('blocked');
  });
  it('is blocked when the file is absent or its gate reported BLOCKED', () => {
    expect(fileOutcome(report(spec('b.spec.ts', 't', 'expected')), 'a.spec.ts')).toBe('blocked');
    expect(fileOutcome(report(spec('a.spec.ts', 'Gate: BLOCKED — operator infrastructure not configured', 'unexpected')), 'a.spec.ts')).toBe('blocked');
    expect(fileOutcome({}, 'a.spec.ts')).toBe('blocked');
  });
});

describe('planFromReport', () => {
  it('turns a fully passing, full-coverage file into a recorder-valid passed entry', () => {
    const [item] = planFromReport(report(spec('a.spec.ts', 't', 'expected')), options);
    expect(item!.input).toMatchObject({ result: 'passed', scope: 'deployed-staging', gate: 'team_archive', requirement: 'large_text' });
    expect(() => prepareEntry(item!.input!)).not.toThrow();
  });
  it('records failures as failed and never records blocked runs', () => {
    expect(planFromReport(report(spec('a.spec.ts', 't', 'unexpected')), options)[0]!.input?.result).toBe('failed');
    expect(planFromReport(report(spec('a.spec.ts', 't', 'skipped')), options)[0]!.input).toBeUndefined();
    expect(planFromReport({}, options)[0]!.input).toBeUndefined();
  });
  it('does not record a pass for partial coverage or a disabled row', () => {
    const partial = { ...FULL, coverage: 'partial', uncovered: 'x' } as const;
    expect(planFromReport(report(spec('a.spec.ts', 't', 'expected')), { ...options, mappings: [partial] })[0]!.input).toBeUndefined();
    const disabled = { ...FULL, disabled: 'why' } as const;
    expect(planFromReport(report(spec('a.spec.ts', 't', 'expected')), { ...options, mappings: [disabled] })[0]!.input).toBeUndefined();
  });
  it('with the real table, a green run of every staging file yields no passed entry today', () => {
    const everything = report(...RESULT_MAPPINGS.map((m) => spec(m.file, 't', 'expected')));
    const plan = planFromReport(everything, { suite: 'staging', releaseId: 'r', evidenceRef: 'docs/x.md' });
    expect(plan.some((item) => item.input?.result === 'passed')).toBe(false);
  });
});
