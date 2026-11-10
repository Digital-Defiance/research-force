/**
 * The configured staging endpoints, operator credentials, and content handles the staging
 * verification suites drive, read from environment variables so one build of the suites runs against
 * a real deployed staging installation without a code change (task 48.5; R1.1, R1.3, R12.10, R20.19,
 * R20.21, R20.22, R20.24, R20.26, R24.11, R24.12, R24.16, R24.17, R28.1, R28.2, R28.6, R28.7,
 * R28.17, R36.17, R45.21, R60.4, R60.9).
 *
 * These are MANDATORY staging verification suites. They run against a REAL deployed staging install
 * — a real Cloudflare account and R2 bucket, real Microsoft Graph, real Access/Turnstile — and are
 * the evidence the deployment gate (task 48.12 / the 68.4 checker) consumes. A full, non-skipped run
 * therefore belongs in CI/operator context against the deployed staging versions; it cannot run in a
 * build environment that has no deployed install or operator credentials. See
 * `tests/staging/README.md` and `playwright.staging.config.ts`.
 *
 * GATING CONTRACT (task 48.5): "missing operator infrastructure blocks the applicable gate rather
 * than skipping tests." When the endpoints/credentials a suite needs are absent, that suite does NOT
 * `test.skip` — it reports its gate BLOCKED via a failing status the gate checker treats as "not
 * satisfied" (never a green skip). The `requireGate`/`gateStatus` helpers in `./gate.ts` implement
 * this; nothing in this file fabricates a pass or lets an unconfigured check pass silently.
 *
 * Unlike `tests/security/support/env.ts`, there are NO local-dev defaults for the operator handles:
 * a missing handle is a BLOCKED gate, not a fall-back to a local origin, because staging evidence
 * must come from the real deployed install.
 */

/** An environment variable value, trimmed, or undefined when unset or blank. */
export function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/** A required environment value, or undefined; callers gate on undefined with `requireGate` (never skip). */
export function optional(name: string): string | undefined {
  return envValue(name);
}

/** An origin from an environment variable with a trailing slash stripped, or undefined when unset. */
export function origin(name: string): string | undefined {
  const value = envValue(name);
  return value === undefined ? undefined : value.replace(/\/+$/u, '');
}

/** Whether the run is explicitly marked as targeting the deployed staging install. */
export const STAGING_LIVE = envValue('STAGING_LIVE') === '1';

/**
 * The staging Workspace origin (the authenticated app, behind Cloudflare Access). The Access suite
 * proves an unauthenticated request is redirected to the Identity_Provider here, and that the scoped
 * bearer-link exceptions behave as configured (R1.1, R1.3).
 */
export const WORKSPACE_ORIGIN = origin('STAGING_WORKSPACE_ORIGIN');

/** The staging apex / Public_Site origin, used for the public change-timing and containment checks. */
export const PUBLIC_ORIGIN = origin('STAGING_PUBLIC_ORIGIN');

/** The staging public-files origin (`files.*`), used for the R2 CORS PUT origin checks. */
export const FILES_ORIGIN = origin('STAGING_FILES_ORIGIN');

/**
 * The configured Identity_Provider host the Workspace Access policy redirects to. The Access suite
 * asserts the redirect Location points at this host (R1.1); absent, the Access gate is BLOCKED.
 */
export const IDP_HOST = envValue('STAGING_IDP_HOST');

/**
 * A live scoped bearer link: the FULL URL of one `/t/<token>` (Attachment file) or `/x/<token>`
 * (export or backup volume) Download_Link on the download host (rf-dl). The token is the credential
 * and is a secret while valid; mint it just before a run. The Access suite proves the link admits its
 * own path and nothing else (R1.3).
 */
export const BEARER_LINK = envValue('STAGING_BEARER_LINK');

/** The real staging R2 bucket name and its S3 endpoint, for the single/multipart upload + CORS checks (R12.10). */
export const R2_ENDPOINT = origin('STAGING_R2_ENDPOINT');
export const R2_BUCKET = envValue('STAGING_R2_BUCKET');

/**
 * Operator R2 credentials for the real single/multipart upload checksum rehearsal against the real
 * bucket (R12.10). These are operator secrets supplied in CI/staging, never committed; absent, the
 * R2 gate is BLOCKED.
 */
export const R2_ACCESS_KEY_ID = envValue('STAGING_R2_ACCESS_KEY_ID');
export const R2_SECRET_ACCESS_KEY = envValue('STAGING_R2_SECRET_ACCESS_KEY');
export const R2_REGION = envValue('STAGING_R2_REGION') ?? 'auto';

/**
 * The Microsoft Graph verifier endpoint the mail suite drives. The staging install exposes an
 * operator-only verification route (the same checks `Verify-ResearchForceMail.ps1` performs, surfaced
 * for the automated gate) that reports: least-privilege send (only as the ResearchForce mailbox),
 * certificate-credential presence/thumbprint/expiry (R20.21), SPF/DKIM/DMARC resolution (R20.22),
 * the acceptance-vs-delivery distinction (R20.26), MIME/plain-text handling (R20.19), and that
 * residual provider retention is none (R20.24). An operator bearer token authorizes the route.
 */
export const GRAPH_VERIFY_ENDPOINT = origin('STAGING_GRAPH_VERIFY_ENDPOINT');
export const GRAPH_VERIFY_TOKEN = envValue('STAGING_GRAPH_VERIFY_TOKEN');

/** The expected ResearchForce mailbox display name (R45.21) and Sending_Address the mail checks assert against. */
export const MAILBOX_DISPLAY_NAME = envValue('STAGING_MAILBOX_DISPLAY_NAME') ?? 'ResearchForce';
export const SENDING_ADDRESS = envValue('STAGING_SENDING_ADDRESS');

/** The configured Turnstile sitekey the public/submit forms serve; the Turnstile check asserts it is present (R28.17). */
export const TURNSTILE_SITEKEY = envValue('STAGING_TURNSTILE_SITEKEY');

/**
 * The operator containment/timing control endpoint. The public change-timing and containment suite
 * drives a real copy-only release and reads back the independently verified containment report
 * across pages, the search index, files, People, policy, and release assets, and injects
 * deploy/quota failures and old-generation retries (R24.11, R24.12, R24.16, R24.17). An operator
 * token authorizes it.
 */
export const CONTAINMENT_ENDPOINT = origin('STAGING_CONTAINMENT_ENDPOINT');
export const CONTAINMENT_TOKEN = envValue('STAGING_CONTAINMENT_TOKEN');

/**
 * The operator Abuse_Profile harness endpoint. The reserve suite runs the distributed Abuse_Profile
 * while Members save/download and reads back the measured resource/spend reserve to compare against
 * the certified profile (R28.1, R28.2, R28.6, R28.7, R28.17). An operator token authorizes it.
 */
export const ABUSE_ENDPOINT = origin('STAGING_ABUSE_ENDPOINT');
export const ABUSE_TOKEN = envValue('STAGING_ABUSE_TOKEN');
export const CERTIFIED_PROFILE = envValue('STAGING_OPERATING_PROFILE');

/**
 * The operator distributed-abuse / removal-failure harness endpoint. The mandatory launch-gate
 * distributed-abuse suite (task 59.4) drives this route on the deployed staging install to run the
 * certified initial flood (100 requests/second, 1,000 distributed sources, 30 minutes) WHILE ten
 * Members save/download under a Confidentiality_Hold applied during a long addition run, to inject
 * the fault classes the containment/removal path must survive (provider outage, exhausted quotas,
 * false HEAD results, a stale job, a late deploy response), and to drive the Free_Qualified
 * profile-failure scope-disable certification. It reads back a SANITIZED report — the measured
 * reserve, the authorized interactive success rate, and the removal/containment/incident outcome —
 * with no research content, flood internals, or canary tokens (R24.16, R24.17, R28.5, R28.6, R28.7,
 * R28.17, R60.4, R60.7). An operator bearer token authorizes it; absent, the gate is BLOCKED.
 */
export const DISTRIBUTED_ABUSE_ENDPOINT = origin('STAGING_DISTRIBUTED_ABUSE_ENDPOINT');
export const DISTRIBUTED_ABUSE_TOKEN = envValue('STAGING_DISTRIBUTED_ABUSE_TOKEN');

/**
 * The operator backup/restore rehearsal endpoint. The backup suite rehearses an independent
 * encrypted backup and key recovery, and a fresh restore with a bootstrap identity conflict, an
 * older schema, a crash/resume, and a later suppression, keeping only SANITIZED evidence (R36.17,
 * R60.4). The independent recovery key id and the sanitized evidence destination are operator
 * inputs. An operator token authorizes it.
 */
export const BACKUP_ENDPOINT = origin('STAGING_BACKUP_ENDPOINT');
export const BACKUP_TOKEN = envValue('STAGING_BACKUP_TOKEN');
export const BACKUP_RECOVERY_KEY_ID = envValue('STAGING_BACKUP_RECOVERY_KEY_ID');
export const BACKUP_EVIDENCE_DEST = envValue('STAGING_BACKUP_EVIDENCE_DEST');

/** The operator team-walkthrough evidence endpoint for the R60.9 walkthrough results. */
export const WALKTHROUGH_ENDPOINT = origin('STAGING_WALKTHROUGH_ENDPOINT');
export const WALKTHROUGH_TOKEN = envValue('STAGING_WALKTHROUGH_TOKEN');

/** The absolute URL of a path on a configured origin. */
export function url(base: string, path: string): string {
  return `${base}/${path.replace(/^\/+/u, '')}`;
}
