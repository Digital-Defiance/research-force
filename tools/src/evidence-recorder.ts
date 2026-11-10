import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  EMPTY_LAUNCH_EVIDENCE,
  evidenceEntrySchema,
  GATE_BUILDERS,
  launchEvidenceSchema,
  type EvidenceEntry,
  type LaunchEvidence,
} from './launch-gates';

/**
 * Launch-evidence recorder (the missing writer for `docs/acceptance/launch-evidence.json`).
 *
 * The checker (`./launch-gates.ts`) cannot tell a real run from a typed-in entry, so this recorder
 * enforces what CAN be enforced mechanically, and nothing more:
 *  - the entry is shaped by the checker's own `evidenceEntrySchema`;
 *  - gate, requirement and kind are derived from `GATE_BUILDERS`, so they cannot drift from what the
 *    checker would accept for that requirement;
 *  - `releaseId` and `evidenceRef` are required and `recordedAt` is set here, never supplied;
 *  - `passed` against `local-synthetic` is refused;
 *  - the evidence reference and note must not look like a token, key or bearer link;
 *  - one entry per gate + requirement + releaseId unless `replace` is given.
 * Whether the run was real remains a process rule: only record the output of a run you did.
 */

/** The ledger path, relative to the repository root (same file `tools/check-launch.ts` reads). */
export const EVIDENCE_LEDGER_FILE = 'docs/acceptance/launch-evidence.json';

/** The raw, operator-supplied fields. `kind` is optional: it defaults to the requirement's required kind. */
export interface EvidenceInput {
  readonly gate: string;
  readonly requirement: string;
  readonly kind?: string;
  readonly result: string;
  readonly scope: string;
  readonly releaseId?: string;
  readonly evidenceRef?: string;
  readonly remediationTasks?: readonly string[];
  readonly note?: string;
}

/** Thrown when an entry must not be recorded; `reasons` lists every problem found. */
export class EvidenceRejection extends Error {
  constructor(readonly reasons: readonly string[]) {
    super(`Evidence not recorded:\n${reasons.map((reason) => `  - ${reason}`).join('\n')}`);
    this.name = 'EvidenceRejection';
  }
}

const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/u;
const MAX_TEXT = 500;

/** Patterns that indicate a credential, token or bearer link rather than a plain path or sentence. */
const SECRET_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['a private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/u],
  ['an Authorization/Bearer value', /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/iu],
  ['a download/bearer link path (/t/<token> or /x/<token>)', /\/[tx]\/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u],
  ['a JWT', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u],
  ['a known provider token prefix', /\b(?:ghp_|gho_|ghs_|github_pat_|sk-|xox[abprs]-|AKIA|ASIA|glpat-)[A-Za-z0-9_-]{8,}/u],
  ['a URL with credentials', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/iu],
  ['a URL query carrying a secret-like parameter', /[?&](?:token|key|secret|sig|signature|password|auth|access_token|x-amz-signature)=/iu],
  ['a secret assignment', /\b(?:secret|password|passwd|token|api[_-]?key|private[_-]?key)\s*[:=]\s*\S{6,}/iu],
  ['a long hexadecimal string', /\b[0-9a-f]{32,}\b/iu],
  ['a long base64-like string', /[A-Za-z0-9+=]{40,}/u],
];

/** The reasons a free-text field looks like a secret or research content; empty when it looks safe. */
export function secretLikeReasons(label: string, text: string): string[] {
  const reasons: string[] = [];
  if (text.length > MAX_TEXT) reasons.push(`${label} is longer than ${MAX_TEXT} characters; keep it to a path or a short sanitized sentence`);
  if (/[\r\n]/u.test(text)) reasons.push(`${label} must be a single line`);
  for (const [name, pattern] of SECRET_PATTERNS) {
    if (pattern.test(text)) reasons.push(`${label} looks like it contains ${name}; evidence must never carry secrets or research content`);
  }
  return reasons;
}

/** Look up the requirement a gate/requirement pair names, from the checker's own manifest table. */
function lookupRequirement(gate: string, requirement: string): { readonly infra: string } | { readonly error: string } {
  const builder = GATE_BUILDERS[gate];
  if (!builder) return { error: `unknown gate "${gate}"; known gates: ${Object.keys(GATE_BUILDERS).join(', ')}` };
  const found = builder.requirements.find((candidate) => candidate.id === requirement);
  if (!found) return { error: `gate "${gate}" has no requirement "${requirement}"; its requirements: ${builder.requirements.map((r) => r.id).join(', ')}` };
  return { infra: found.infra };
}

/**
 * Validate an input and build the entry to record, stamping `recordedAt`. Throws {@link EvidenceRejection}
 * listing every reason when the entry must be refused.
 */
export function prepareEntry(input: EvidenceInput, now: string = new Date().toISOString()): EvidenceEntry {
  const reasons: string[] = [];

  const resolved = lookupRequirement(input.gate, input.requirement);
  let kind = input.kind;
  if ('error' in resolved) {
    reasons.push(resolved.error);
  } else if (kind === undefined) {
    kind = resolved.infra;
  } else if (kind !== resolved.infra) {
    reasons.push(`requirement "${input.requirement}" of gate "${input.gate}" is only satisfied by kind "${resolved.infra}", not "${kind}"`);
  }

  if (input.releaseId === undefined || input.releaseId.trim() === '') reasons.push('releaseId is required (the deployed release the run was against)');
  else if (!RELEASE_ID.test(input.releaseId)) reasons.push('releaseId must be 1-100 characters of letters, digits, ".", "_", "+" or "-"');

  if (input.evidenceRef === undefined || input.evidenceRef.trim() === '') reasons.push('evidenceRef is required (path or reference to the sanitized report)');
  else reasons.push(...secretLikeReasons('evidenceRef', input.evidenceRef));

  if (input.note !== undefined) reasons.push(...secretLikeReasons('note', input.note));

  if (input.result === 'passed' && input.scope === 'local-synthetic') {
    reasons.push('a local-synthetic run can never be recorded as passed; only a run against a deployed scope can pass');
  }

  const parsed = evidenceEntrySchema.safeParse({
    gate: input.gate,
    requirement: input.requirement,
    kind,
    result: input.result,
    scope: input.scope,
    releaseId: input.releaseId,
    evidenceRef: input.evidenceRef,
    recordedAt: now,
    remediationTasks: input.remediationTasks ?? [],
    ...(input.note === undefined ? {} : { note: input.note }),
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) reasons.push(`${issue.path.join('.') || 'entry'}: ${issue.message}`);
  }

  if (reasons.length || !parsed.success) throw new EvidenceRejection(reasons);
  return parsed.data;
}

/** Whether two entries are the same record slot: same gate, requirement and release. */
const sameSlot = (a: EvidenceEntry, b: EvidenceEntry): boolean =>
  a.gate === b.gate && a.requirement === b.requirement && a.releaseId === b.releaseId;

/** Append an entry to a ledger, refusing a duplicate slot unless `replace` is set. Pure; returns a new ledger. */
export function appendEntry(ledger: LaunchEvidence, entry: EvidenceEntry, options: { readonly replace?: boolean } = {}): LaunchEvidence {
  const existing = ledger.entries.filter((candidate) => sameSlot(candidate, entry));
  if (existing.length && !options.replace) {
    throw new EvidenceRejection([
      `an entry for ${entry.gate}/${entry.requirement} at release ${entry.releaseId} already exists (recorded ${existing[0]!.recordedAt ?? 'earlier'}, result ${existing[0]!.result}); pass replace to overwrite it`,
    ]);
  }
  return launchEvidenceSchema.parse({
    ...ledger,
    recordedAt: entry.recordedAt,
    entries: [...ledger.entries.filter((candidate) => !sameSlot(candidate, entry)), entry],
  });
}

/** Read the ledger under `root`, or a fresh empty one when the file does not exist. Refuses an invalid file. */
export function readLedger(root: string): LaunchEvidence {
  const path = resolve(root, EVIDENCE_LEDGER_FILE);
  if (!existsSync(path)) return { ...EMPTY_LAUNCH_EVIDENCE, entries: [] };
  const parsed = launchEvidenceSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) throw new EvidenceRejection([`${EVIDENCE_LEDGER_FILE} is not a valid ledger; fix it by hand before recording (${parsed.error.issues[0]?.message ?? 'invalid'})`]);
  return parsed.data;
}

/** Validate and append one entry to the ledger file under `root`, writing atomically. Returns the recorded entry. */
export function recordEvidence(
  root: string,
  input: EvidenceInput,
  options: { readonly replace?: boolean; readonly now?: string } = {},
): EvidenceEntry {
  const entry = prepareEntry(input, options.now);
  const next = appendEntry(readLedger(root), entry, options);
  const path = resolve(root, EVIDENCE_LEDGER_FILE);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
  return entry;
}

/** A one-line, human-readable description of a recorded entry. */
export function describeEntry(entry: EvidenceEntry): string {
  return `${entry.gate}/${entry.requirement} [${entry.kind}] = ${entry.result} (scope ${entry.scope}, release ${entry.releaseId}, ref ${entry.evidenceRef})`;
}
