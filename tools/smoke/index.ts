/**
 * Static CI smoke checks (spec task 45.4). Each check reads the committed repository and returns a list of
 * human-readable violations; an empty list means the invariant holds. The checks are pure repo analysis — they
 * run locally and in CI, make no network or account access, and are NOT browser/E2E tests. They guard:
 *
 *   1. No HTTP route accepts a raw file body and none returns a rendition/transformed media (R12.5, R14.9).
 *   2. The AI model allow-list holds only Cloudflare-hosted `@cf/` models and no AI Gateway is configured (R20.20).
 *   3. No committed secret value appears in the repository (R44.9), reusing `tools/check-secrets.ts`.
 *   4. Every self-hosted font (and icon, if a manifest exists) has a licence permitting self-hosting and export (R45.20).
 *   5. The seeded Policy_Section list matches the canonical list of Requirement 46.32 (R46.32).
 *
 * The module imports package code only through the public `@researchforce/*` entry points; it reaches app source
 * (which `tools` may not import) by reading the files from disk and analysing their text, never by importing them.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AI_MODEL_ALLOW_LIST, isAllowedModel } from '@researchforce/domain/ai';
import { SEED_POLICY_SECTIONS } from '@researchforce/db/seed/policy-sections';
import { FONT_LICENCES } from '@researchforce/design/fonts';
import { workerSecrets } from '../../infra/secrets';

/** The repository root, two levels up from `tools/smoke/`. */
export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The HTTP-serving Workers whose route handlers are audited for file bodies and renditions (R12.5, R14.9). */
const ROUTE_WORKER_DIRS = ['apps/app/src', 'apps/submit/src', 'apps/dl/src', 'apps/ops/src'] as const;

/** A single smoke-check result: a stable name and the violations it found (empty when the invariant holds). */
export interface SmokeResult {
  readonly check: string;
  readonly violations: readonly string[];
}

// --- Check 1: no file-body or rendition routes (R12.5, R14.9) -----------------------------------------------

/**
 * A request-body read that would consume a raw/binary or multipart file body. A route that accepts a file body
 * would match one of these; the Research_CMS takes uploads only as presigned direct-to-R2 PUTs, so no route reads
 * a file body and every JSON body is read with `c.req.json()` (R12.5).
 */
const FILE_BODY_PATTERNS: readonly RegExp[] = [
  /\b(?:req|request)\s*\.\s*(?:arrayBuffer|blob|formData|bytes)\s*\(/u,
  /\.\s*raw\s*\.\s*(?:arrayBuffer|blob|formData|bytes)\s*\(/u,
  /\breq\s*\.\s*parseBody\s*\(/u,
];

/**
 * A server-side image/media transformation that would emit a rendition of a stored file. The Research_CMS serves
 * every Attachment and public copy inert and unchanged (R14.9, R24.3), so none of these transformation surfaces
 * appears in a route. Serving a stored file under its ORIGINAL content type is not a rendition and is not matched.
 */
const RENDITION_PATTERNS: readonly RegExp[] = [
  /\/cdn-cgi\/image\b/u,
  /\bcf\s*:\s*\{[^}]*\bimage\b/u,
  /\bimageResizing\b/u,
  /\bcreateImageBitmap\s*\(/u,
  /\b(?:rendition|thumbnail)\b/iu,
  /\.\s*resize\s*\(/u,
];

/** Walk a directory tree yielding every TypeScript source file path (skipping tests and generated output). */
function* tsSources(dir: string): Generator<string> {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // an absent worker directory contributes no routes to audit
  }
  for (const entry of entries) {
    if (['node_modules', 'dist', '.cache', '.wrangler', 'test'].includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* tsSources(full);
    else if (/\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name)) yield full;
  }
}

/** Every non-empty, non-comment line of `source`, with its 1-based line number, for pattern matching. */
function codeLines(source: string): readonly { readonly line: number; readonly text: string }[] {
  return source.split(/\r?\n/u).map((text, index) => ({ line: index + 1, text }))
    .filter(({ text }) => { const trimmed = text.trim(); return trimmed !== '' && !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*'); });
}

/** Scan the HTTP-serving Workers for any route that reads a file body or emits a rendition (R12.5, R14.9). */
export function fileBodyAndRenditionViolations(root: string = REPO_ROOT): readonly string[] {
  const violations: string[] = [];
  for (const workerDir of ROUTE_WORKER_DIRS) {
    for (const file of tsSources(join(root, workerDir))) {
      const rel = relative(root, file);
      const lines = codeLines(readFileSync(file, 'utf8'));
      for (const { line, text } of lines) {
        if (FILE_BODY_PATTERNS.some((pattern) => pattern.test(text))) {
          violations.push(`${rel}:${line} reads a raw/file request body; routes must accept uploads only as presigned direct-to-R2 PUTs (R12.5)`);
        }
        if (RENDITION_PATTERNS.some((pattern) => pattern.test(text))) {
          violations.push(`${rel}:${line} emits a media rendition/transformation; files must be served inert and unchanged (R14.9)`);
        }
      }
    }
  }
  return violations;
}

// --- Check 2: AI model allow-list, no AI Gateway (R20.20) ---------------------------------------------------

/** A configured AI Gateway: the `gateway` option on an `AI.run` call, a gateway id/binding, or a gateway URL. */
const AI_GATEWAY_PATTERNS: readonly RegExp[] = [
  /\bgateway\s*:/u,
  /\bai[-_]?gateway\b/iu,
  /\/ai-gateway\//u,
  /\bcloudflare\.com\/ai\/gateways\b/u,
];

/**
 * A `gateway` match that is the Zero Trust Gateway lists API (`/gateway/lists/…`), which the Access-sync Worker
 * uses to manage the member list (R2.x) — not an AI Gateway. Such a line is NOT an AI Gateway configuration.
 */
const ZERO_TRUST_GATEWAY = /\/gateway\/lists\//u;

/**
 * The smoke checker's OWN source and test files, excluded from the AI-Gateway textual scan. These files are
 * self-references, not a configured AI Gateway: `tools/smoke/index.ts` DEFINES the `/\bgateway\s*:/u` detector
 * pattern (its literal text would match itself) and `tools/test/smoke.test.ts` carries the `{ gateway: … }`
 * fixture that exercises positive detection. This mirrors how `secretLeakViolations` excludes
 * `secretsSourceRelative`; a real `{ gateway: … }` config in any OTHER file is still caught (R20.20).
 */
const SMOKE_SELF_FILES: ReadonlySet<string> = new Set(['tools/smoke/index.ts', 'tools/test/smoke.test.ts']);

/** Assert the AI model allow-list holds only `@cf/` models and no AI Gateway is configured anywhere (R20.20). */
export function aiAllowListViolations(root: string = REPO_ROOT): readonly string[] {
  const violations: string[] = [];
  for (const model of AI_MODEL_ALLOW_LIST) {
    if (!model.startsWith('@cf/')) violations.push(`AI_MODEL_ALLOW_LIST contains a non-Cloudflare-hosted model: ${model} (R20.20)`);
    if (!isAllowedModel(model)) violations.push(`isAllowedModel rejects an allow-listed model: ${model} (R20.20)`);
  }
  if (AI_MODEL_ALLOW_LIST.length === 0) violations.push('AI_MODEL_ALLOW_LIST is empty (R20.20)');
  // A model that is not @cf/-hosted must be rejected even if it were added to the list; the predicate guards that.
  if (isAllowedModel('@azure/openai/gpt-4o')) violations.push('isAllowedModel accepts a non-@cf/ model (R20.20)');

  for (const file of trackedFiles(root)) {
    if (SMOKE_SELF_FILES.has(file)) continue; // the checker's own pattern definition and fixtures, not a config
    if (!/\.(?:ts|tsx|js|mjs|cjs|json|jsonc|toml)$/u.test(file)) continue;
    const lines = readFileSync(join(root, file), 'utf8').split(/\r?\n/u);
    for (let i = 0; i < lines.length; i += 1) {
      const text = lines[i]!;
      if (ZERO_TRUST_GATEWAY.test(text)) continue; // the Access member-list API, not an AI Gateway
      if (AI_GATEWAY_PATTERNS.some((pattern) => pattern.test(text))) {
        violations.push(`${file}:${i + 1} configures an AI Gateway; Workers AI must be called directly with no gateway (R20.20)`);
      }
    }
  }
  return violations;
}

// --- Check 3: no committed secret value in the repository (R44.9) -------------------------------------------

/** The paths a Worker secret value may legitimately live in, each kept out of version control by `.gitignore`. */
const SECRET_FILE_GLOBS = ['.dev.vars', '.env'] as const;

/** Files whose committed text is scanned for secret values; binaries, fonts, lockfiles, and specs are skipped. */
function isScannableForSecrets(path: string): boolean {
  if (/\.(?:woff2?|ttf|otf|png|jpe?g|gif|webp|ico|pdf|sql|lock)$/u.test(path)) return false;
  if (path === 'package-lock.json') return false;
  return true;
}

/** Whether `path` is a test file, where synthetic secret-shaped values are expected and are not committed secrets. */
function isTestPath(path: string): boolean {
  return /(?:^|\/)test\//u.test(path) || /\.test\.[cm]?tsx?$/u.test(path) || /(?:^|\/)tests\//u.test(path);
}

/**
 * Assert no committed secret value appears in the repository (R44.9). Secret KEY names come from
 * `infra/secrets.ts` `workerSecrets`; this scans every git-tracked, non-test, text file for an assignment that
 * places a credential-shaped value next to a secret key (`SECRET_KEY = <value>`, `"SECRET_KEY": "<value>"`,
 * `SECRET_KEY: <value>`), ignoring references, placeholders, synthetic/local markers, URLs, and e-mail addresses.
 * Like `tools/check-secrets.ts`, it reports only key names and never prints a value. The files that legitimately
 * hold real secret values (`.dev.vars*`, `.env*`) are kept out of version control, which this also verifies, so a
 * real secret is injected with `wrangler secret put` and never committed.
 */
export function secretLeakViolations(root: string = REPO_ROOT): readonly string[] {
  const violations: string[] = [];
  const secretNames = [...new Set(workerSecrets.flatMap((worker) => worker.secrets.map((secret) => secret.name)))];

  // The secret-bearing local files must be git-ignored, so a value placed there is never committed.
  for (const glob of SECRET_FILE_GLOBS) {
    if (!isGitIgnored(root, glob)) violations.push(`${glob} is not git-ignored; secret values placed there could be committed (R44.9)`);
  }

  const tracked = trackedFiles(root).filter((path) => path !== secretsSourceRelative && !isTestPath(path) && isScannableForSecrets(path));
  for (const name of secretNames) {
    // A key followed by `=` or `:` and then a NON-EMPTY quoted value literal.
    const assignment = new RegExp(`\\b${name}\\b\\s*(?:=|:)\\s*(['"\`])([^'"\`\\n]+)\\1`, 'u');
    for (const file of tracked) {
      const lines = readFileSync(join(root, file), 'utf8').split(/\r?\n/u);
      for (let i = 0; i < lines.length; i += 1) {
        const match = assignment.exec(lines[i]!);
        if (match && looksLikeRealSecret(match[2]!)) {
          violations.push(`${file}:${i + 1} assigns a value to secret ${name}; secret values must never be committed (R44.9)`);
        }
      }
    }
  }
  return violations;
}

/** The relative path of the secrets source, which lists key NAMES (not values) and so is not a secret leak. */
const secretsSourceRelative = 'infra/secrets.ts';

/** A value is a reference/placeholder, not a committed literal: a `${VAR}`/`$VAR`, an `env.X`, or a named stand-in. */
function isReferenceOrPlaceholder(value: string): boolean {
  if (value === '') return true;
  if (/^\$\{?[A-Za-z_]/u.test(value)) return true; // a `${VAR}` / `$VAR` reference
  if (/^(?:process\.env|env)\./u.test(value)) return true; // a code reference to the env
  return /\b(?:placeholder|changeme|change-me|example|your[-_]|<[^>]+>|xxx+|dummy|fake|sample|redacted|\.\.\.)\b/iu.test(value);
}

/** A value is an obvious non-secret: a synthetic/local/test stand-in, a URL, an e-mail address, or a dev constant. */
function isSyntheticOrNonSecret(value: string): boolean {
  if (/\b(?:synthetic|local-development|localhost|test[-_]|[-_]test\b|mock|stub|canary)/iu.test(value)) return true;
  if (/^https?:\/\//u.test(value)) return true; // a URL (e.g. ACCESS_TEAM_DOMAIN, WORKSPACE_ORIGIN) is not a secret
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)) return true; // an e-mail address (e.g. the public Sending_Address)
  if (/^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$/u.test(value)) return true; // an IP/host:port
  return false;
}

/**
 * Whether a committed value is credential-like real secret material rather than a reference, placeholder, or
 * synthetic/local stand-in. A real secret is a reasonably long token that mixes letter cases, digits, or symbols;
 * short words and single-case identifiers are not treated as secrets, so synthetic test config never trips this.
 */
function looksLikeRealSecret(raw: string): boolean {
  const value = raw.trim();
  if (isReferenceOrPlaceholder(value) || isSyntheticOrNonSecret(value)) return false;
  if (value.length < 20) return false; // real R2 keys, HMAC keys, tokens, and thumbprints are long
  const classes = [/[a-z]/u, /[A-Z]/u, /[0-9]/u, /[^A-Za-z0-9]/u].filter((pattern) => pattern.test(value)).length;
  return classes >= 3; // mixed-class, high-entropy material — the shape of a committed credential
}

// --- Check 4: font/icon licences permit self-hosting and export (R45.20) ------------------------------------

/**
 * Wording in a licence text that permits self-hosting (installation/embedding) and redistribution (export). The
 * SIL Open Font License, under which every Design_System face ships (`packages/design/fonts/licences`), grants
 * exactly these: it allows the fonts to be bundled, embedded, and redistributed with the licence text. A licence
 * that lacked these permissions, or forbade embedding/redistribution, would fail the check.
 */
const SELF_HOST_SIGNALS: readonly RegExp[] = [/\bSIL Open Font License\b/u, /\bOFL\b/u];
const EXPORT_SIGNALS: readonly RegExp[] = [/\bredistribut/iu, /\bbundled\b/iu, /\bembed/iu];
const EXPORT_PROHIBITIONS: readonly RegExp[] = [/\bmust not be (?:redistributed|embedded|bundled)\b/iu, /\bno redistribution\b/iu];

/**
 * Assert every self-hosted font family has a licence text that permits self-hosting and export (R45.20). The
 * `FONT_LICENCES` manifest (public entry `@researchforce/design/fonts`) maps families to a licence file under
 * `packages/design/fonts`; each file's text must carry the SIL OFL grant and no embedding/redistribution ban. The
 * check extends to icons when an icon licence manifest exists; the repository ships no separate icon fonts today.
 */
export function fontLicenceViolations(root: string = REPO_ROOT): readonly string[] {
  const violations: string[] = [];
  if (FONT_LICENCES.length === 0) return ['FONT_LICENCES is empty; no self-hosted font declares a licence (R45.20)'];
  for (const licence of FONT_LICENCES) {
    if (licence.families.length === 0) { violations.push(`A font licence (${licence.file}) names no family (R45.20)`); continue; }
    let text: string;
    try {
      text = readFileSync(join(root, 'packages/design/fonts', licence.file), 'utf8');
    } catch {
      violations.push(`The licence file is missing for ${licence.families.join(', ')}: packages/design/fonts/${licence.file} (R45.20)`);
      continue;
    }
    const families = licence.families.join(', ');
    if (!SELF_HOST_SIGNALS.some((pattern) => pattern.test(text))) {
      violations.push(`The licence for ${families} (${licence.file}) does not grant self-hosting/embedding (R45.20)`);
    }
    if (!EXPORT_SIGNALS.some((pattern) => pattern.test(text))) {
      violations.push(`The licence for ${families} (${licence.file}) does not permit redistribution/export (R45.20)`);
    }
    if (EXPORT_PROHIBITIONS.some((pattern) => pattern.test(text))) {
      violations.push(`The licence for ${families} (${licence.file}) forbids redistribution/embedding (R45.20)`);
    }
  }
  return violations;
}

// --- Check 5: Policy_Section list matches R46.32 ------------------------------------------------------------

/**
 * The canonical Policy_Section list that Requirement 46.32 fixes: "each Policy_Page has exactly the Policy_Sections
 * that criteria 1, 6, 11, 15, 18, and 21 name, with those titles and in that order". Each page lists its sections
 * in order; the titles are taken verbatim from those criteria. A Workspace offers no way to add, remove, rename, or
 * reorder them, so the seeded list must equal this exactly (R46.32).
 */
export const CANONICAL_POLICY_SECTIONS: readonly { readonly page: string; readonly title: string }[] = [
  { page: 'about', title: 'About the group' }, // criterion 1
  { page: 'people', title: 'Introduction' }, // criterion 6
  { page: 'methods', title: 'Evidence standards' }, // criterion 11
  { page: 'methods', title: 'Provenance labels' },
  { page: 'methods', title: 'Statuses and outcomes' },
  { page: 'methods', title: 'Withheld and private material' },
  { page: 'methods', title: 'Corrections and withdrawals' },
  { page: 'licence', title: 'Further notes' }, // criterion 15
  { page: 'privacy', title: 'Members' }, // criterion 18
  { page: 'privacy', title: 'Submitters and requesters' },
  { page: 'privacy', title: 'People named in records' },
  { page: 'privacy', title: 'Visitors' },
  { page: 'privacy', title: 'Services that process data' },
  { page: 'privacy', title: 'Your requests' },
  { page: 'corrections', title: 'Asking for a correction' }, // criterion 21
  { page: 'corrections', title: 'Asking for a removal or about personal data' },
  { page: 'corrections', title: 'What happens next' },
];

/** Assert the seeded Policy_Sections match the canonical R46.32 list exactly in page, title, and order (R46.32). */
export function policySectionViolations(): readonly string[] {
  const violations: string[] = [];
  const seeded = SEED_POLICY_SECTIONS.map((section) => ({ page: section.pageKey, title: section.title }));
  const canonical = CANONICAL_POLICY_SECTIONS;
  const length = Math.max(seeded.length, canonical.length);
  for (let i = 0; i < length; i += 1) {
    const want = canonical[i];
    const got = seeded[i];
    if (!want) { violations.push(`The seed has an extra Policy_Section at position ${i + 1}: ${got!.page}/${got!.title} (R46.32)`); continue; }
    if (!got) { violations.push(`The seed is missing the Policy_Section at position ${i + 1}: ${want.page}/${want.title} (R46.32)`); continue; }
    if (got.page !== want.page || got.title !== want.title) {
      violations.push(`Policy_Section ${i + 1} is ${got.page}/${got.title}; R46.32 requires ${want.page}/${want.title} (R46.32)`);
    }
  }
  return violations;
}

// --- Shared git helpers -------------------------------------------------------------------------------------

/** Every git-tracked file, as repo-relative POSIX paths; the scans look only at committed content (R44.9). */
export function trackedFiles(root: string = REPO_ROOT): readonly string[] {
  const out = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\0').filter((path) => path !== '');
}

/** Whether `path` is ignored by git, so a value placed there is never committed. */
function isGitIgnored(root: string, path: string): boolean {
  try {
    execFileSync('git', ['-C', root, 'check-ignore', '-q', '--', path], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// --- Aggregation and CLI ------------------------------------------------------------------------------------

/** Run every smoke check against the repository and return each check's result. */
export function runSmokeChecks(root: string = REPO_ROOT): readonly SmokeResult[] {
  return [
    { check: 'no file-body or rendition routes (R12.5, R14.9)', violations: fileBodyAndRenditionViolations(root) },
    { check: 'AI model allow-list, no AI Gateway (R20.20)', violations: aiAllowListViolations(root) },
    { check: 'no committed secret value (R44.9)', violations: secretLeakViolations(root) },
    { check: 'font/icon licences allow self-hosting and export (R45.20)', violations: fontLicenceViolations(root) },
    { check: 'Policy_Section list matches R46.32', violations: policySectionViolations() },
  ];
}

/** Format the results for the CLI: one header line and, under each failing check, its violations. */
export function formatResults(results: readonly SmokeResult[]): { readonly output: string; readonly exitCode: number } {
  const failing = results.filter((result) => result.violations.length > 0);
  if (failing.length === 0) {
    return { output: `All smoke checks passed:\n${results.map((result) => `  ✓ ${result.check}`).join('\n')}`, exitCode: 0 };
  }
  const lines = ['Smoke checks found violations:'];
  for (const result of results) {
    lines.push(`${result.violations.length === 0 ? '  ✓' : '  ✗'} ${result.check}`);
    for (const violation of result.violations) lines.push(`      - ${violation}`);
  }
  return { output: lines.join('\n'), exitCode: 1 };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = formatResults(runSmokeChecks());
  if (result.exitCode === 0) console.log(result.output);
  else console.error(result.output);
  process.exitCode = result.exitCode;
}
