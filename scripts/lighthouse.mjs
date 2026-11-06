/**
 * Lighthouse CI runner for Requirement 45.8.
 *
 * `lighthouserc.json` holds the whole static configuration: 20 loads per page
 * (`collect.numberOfRuns`), the Reference_Mobile_Profile emulation
 * (`collect.settings`, the Lighthouse mobile default), an empty cache per run (Lighthouse
 * clears storage every run and `disableStorageReset` is left unset), and the 75th-percentile
 * Core Web Vitals assertions (`assert.assertions`). Its default `collect.url` list targets the
 * local preview origin so `lhci autorun` works unchanged on a developer machine.
 *
 * This runner lets CI and staging point the same configuration at a different origin and add the
 * content-dependent public page types without editing the committed JSON. The core `@lhci/cli`
 * does not interpolate environment variables inside the JSON `url` list, so this script resolves
 * them and passes the full URL list to `lhci` as repeated `--collect.url` overrides, which
 * `@lhci/cli` merges over the configuration file. Everything else — the run count, the profile,
 * the empty cache, and the assertions — comes straight from `lighthouserc.json`.
 *
 * Environment variables (all optional):
 *   LHCI_BASE_URL         Origin to test. Default: http://127.0.0.1:5173 (the local preview).
 *   LHCI_PROJECT_SLUG     A Project_Slug to add the Project page, its log, and its findings list.
 *   LHCI_ITEM_PATH        A public Research_Item path (e.g. /i/ABCD-1234) to add that page.
 *   LHCI_ATTACHMENT_PATH  A public Attachment path to add that page.
 *
 * The committed default URLs already cover the fixed public page types the presentation suite
 * names (home, About, People, Methods, Licence, Privacy, Corrections, the projects listing, the
 * public search page, and the general Outside_Submission form). Content-dependent types appear
 * only when the matching variable names content on the targeted deployment, mirroring
 * `tests/presentation/support/pages.ts`.
 */
import { spawnSync } from 'node:child_process';

/** An environment variable value, trimmed, or undefined when unset or blank. */
function envValue(name) {
  const value = process.env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/** The origin to test, without a trailing slash. */
const base = (envValue('LHCI_BASE_URL') ?? 'http://127.0.0.1:5173').replace(/\/+$/, '');

/** The fixed public page types every deployment builds (R46.2), relative to the base origin. */
const fixedPaths = [
  '/',
  '/about',
  '/people',
  '/methods',
  '/licence',
  '/privacy',
  '/corrections',
  '/projects',
  '/search',
  '/submit/general',
];

/** The content-dependent public page types, added only when their content is named. */
const contentPaths = [];
const slug = envValue('LHCI_PROJECT_SLUG');
if (slug !== undefined) {
  contentPaths.push(`/p/${slug}`, `/p/${slug}/log`, `/p/${slug}/findings`);
}
const itemPath = envValue('LHCI_ITEM_PATH');
if (itemPath !== undefined) contentPaths.push(itemPath.startsWith('/') ? itemPath : `/${itemPath}`);
const attachmentPath = envValue('LHCI_ATTACHMENT_PATH');
if (attachmentPath !== undefined) {
  contentPaths.push(attachmentPath.startsWith('/') ? attachmentPath : `/${attachmentPath}`);
}

const urls = [...fixedPaths, ...contentPaths].map((path) => `${base}${path}`);

// Pass the resolved URL list as repeated overrides; the run count, Reference_Mobile_Profile, and
// the Core Web Vitals assertions all come from lighthouserc.json.
const args = ['lhci', 'autorun', ...urls.map((url) => `--collect.url=${url}`)];

const result = spawnSync('npx', args, { stdio: 'inherit', env: process.env });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
