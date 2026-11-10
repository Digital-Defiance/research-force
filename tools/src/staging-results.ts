import type { EvidenceInput } from './evidence-recorder';

/**
 * Turns a Playwright JSON report into launch-evidence recorder inputs.
 *
 * ONE table ({@link RESULT_MAPPINGS}) maps a spec file to the gate requirement it can evidence. A spec
 * file only counts when EVERY test in it ran and passed. Rules (see {@link planFromReport}):
 *  - passed + full coverage        -> record `passed`
 *  - passed + partial coverage     -> not recorded (the requirement still has uncovered parts)
 *  - failed                        -> record `failed` (an honest failure, never lost)
 *  - blocked / skipped / not run   -> not recorded (a missing run is absence of evidence, not a result)
 *  - disabled row                  -> not recorded, with the reason
 * Nothing here can produce `passed` unless the report says every test in the file passed.
 */

export type ResultSuite = 'staging' | 'security' | 'presentation';

export interface ResultMapping {
  readonly suite: ResultSuite;
  /** Spec file name (matched against the end of the report's spec path). */
  readonly file: string;
  readonly gate: string;
  readonly requirement: string;
  /** `full` when a pass in this file is the whole requirement; `partial` when parts are not covered. */
  readonly coverage: 'full' | 'partial';
  /** For `partial`: what the file does not cover. */
  readonly uncovered?: string;
  /** Set when results from this file must not be turned into evidence yet, and why. */
  readonly disabled?: string;
}

const NO_STAGING_GUARD = 'its origins default to local dev servers and it needs the download HMAC key, so a report cannot show it ran against staging; it needs a staging-only environment guard first';

export const RESULT_MAPPINGS: readonly ResultMapping[] = [
  {
    suite: 'staging', file: 'r2-upload-checksums.spec.ts', gate: 'team_archive', requirement: 'drafts_files', coverage: 'partial',
    uncovered: 'draft reload/reselection workflows have no automated suite; only the R2 upload checksum and CORS part is covered',
  },
  {
    suite: 'staging', file: 'access-and-bearer.spec.ts', gate: 'public_archive', requirement: 'provider_setup', coverage: 'partial',
    uncovered: 'only the Access redirect and scoped download-link checks are covered, not Turnstile, R2 or Graph setup',
  },
  { suite: 'security', file: 'channel-adapter-canaries.spec.ts', gate: 'public_archive', requirement: 'public_channel_canaries', coverage: 'full', disabled: NO_STAGING_GUARD },
  { suite: 'security', file: 'file-delivery-isolation.spec.ts', gate: 'public_archive', requirement: 'browser_file_safety', coverage: 'full', disabled: NO_STAGING_GUARD },
  {
    suite: 'presentation', file: 'accessibility.spec.ts', gate: 'public_archive', requirement: 'presentation_accessibility', coverage: 'partial',
    disabled: 'it targets PRESENTATION_BASE_URL (default local dev) so a report cannot show it ran against staging, and the staging seed content it needs is unverified',
    uncovered: 'only the configured page list is checked',
  },
];

export type Outcome = 'passed' | 'failed' | 'blocked';

/** The slice of the Playwright JSON reporter output this module reads. */
export interface PlaywrightReport {
  readonly suites?: readonly PlaywrightSuite[];
}
interface PlaywrightSuite {
  readonly title?: string;
  readonly file?: string;
  readonly specs?: readonly PlaywrightSpec[];
  readonly suites?: readonly PlaywrightSuite[];
}
interface PlaywrightSpec {
  readonly title: string;
  readonly file?: string;
  readonly ok?: boolean;
  readonly tests?: readonly { readonly status?: string }[];
}

const BLOCKED_TITLE = /BLOCKED — operator infrastructure not configured/u;

function collectSpecs(suites: readonly PlaywrightSuite[] | undefined, out: { spec: PlaywrightSpec; file: string }[] = []): { spec: PlaywrightSpec; file: string }[] {
  for (const suite of suites ?? []) {
    for (const spec of suite.specs ?? []) out.push({ spec, file: spec.file ?? suite.file ?? '' });
    collectSpecs(suite.suites, out);
  }
  return out;
}

/** The outcome of every test in a spec file; `blocked` when the file did not run, was skipped, or reported its gate BLOCKED. */
export function fileOutcome(report: PlaywrightReport, file: string): Outcome {
  const specs = collectSpecs(report.suites).filter((entry) => entry.file === file || entry.file.endsWith(`/${file}`));
  if (specs.length === 0) return 'blocked';
  if (specs.some(({ spec }) => BLOCKED_TITLE.test(spec.title))) return 'blocked';
  const statuses = specs.flatMap(({ spec }) => (spec.tests ?? []).map((test) => test.status ?? 'unknown'));
  if (statuses.length === 0) return 'blocked';
  if (statuses.includes('unexpected')) return 'failed';
  return statuses.every((status) => status === 'expected') && specs.every(({ spec }) => spec.ok === true) ? 'passed' : 'blocked';
}

export interface PlannedEntry {
  readonly mapping: ResultMapping;
  readonly outcome: Outcome;
  /** The recorder input, or undefined when the outcome is not recorded. */
  readonly input?: EvidenceInput;
  readonly reason: string;
}

export interface PlanOptions {
  readonly suite: ResultSuite;
  readonly releaseId: string;
  readonly evidenceRef: string;
  readonly mappings?: readonly ResultMapping[];
}

/** Decide, per mapped spec file, what (if anything) to record. Pure. */
export function planFromReport(report: PlaywrightReport, options: PlanOptions): PlannedEntry[] {
  const rows = (options.mappings ?? RESULT_MAPPINGS).filter((mapping) => mapping.suite === options.suite);
  return rows.map((mapping): PlannedEntry => {
    if (mapping.disabled) return { mapping, outcome: fileOutcome(report, mapping.file), reason: `not recorded: ${mapping.disabled}` };
    const outcome = fileOutcome(report, mapping.file);
    if (outcome === 'blocked') return { mapping, outcome, reason: 'not recorded: the suite did not run to a result (missing environment, skipped, or not in the report)' };
    const base = { gate: mapping.gate, requirement: mapping.requirement, scope: 'deployed-staging', releaseId: options.releaseId, evidenceRef: options.evidenceRef };
    if (outcome === 'failed') {
      return { mapping, outcome, reason: 'recorded as failed', input: { ...base, result: 'failed', note: `automated suite ${mapping.file} failed; see the evidence reference` } };
    }
    if (mapping.coverage === 'partial') {
      return { mapping, outcome, reason: `not recorded: passed, but the requirement is only partly covered (${mapping.uncovered ?? 'other parts uncovered'}); record it by hand once the rest is verified` };
    }
    return { mapping, outcome, reason: 'recorded as passed', input: { ...base, result: 'passed', note: `automated suite ${mapping.file} passed in full` } };
  });
}
