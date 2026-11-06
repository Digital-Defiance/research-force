/**
 * Single source of truth for the secrets and installation vars each Worker requires (spec task 48.1).
 * Pure data, no side effects. `tools/check-secrets.ts` does a local-only presence check against it.
 *
 * `secrets` are set with `wrangler secret put` (never committed). `vars` are plaintext installation
 * inputs placed in wrangler `vars`. Names are mirrored (not imported, to respect the import boundary:
 * `tools` may not reach into app internals) from:
 *   - rf-app:    apps/app/src/env.ts and apps/app/src/mail/providers/graph.ts (GraphProvider.fromEnv);
 *   - rf-submit: apps/submit/src/index.ts (Env);
 *   - rf-dl:     apps/dl/src/index.ts (Env);
 *   - rf-ops:    apps/ops/src/index.ts (OpsEnv) — the Cloudflare API credentials/inputs for Access-sync,
 *                usage analytics, rf-site deploy, edge Containment, the submit-host WAF shed and the
 *                independent health/spend/incident alerts.
 * A test asserts these exact lists, so drift from the source files is caught.
 *
 * Production and staging must use SEPARATE credentials/secrets (README: "Production and staging must
 * use separate credentials"); the same key NAMES apply to both environments.
 */

/** A single installation input: its key name and whether it is a secret or a plaintext var. */
export interface SecretEntry {
  readonly name: string;
  readonly note: string;
}

export interface WorkerSecrets {
  /** Worker service base name (without the `-staging` suffix). */
  readonly worker: string;
  /** Values set with `wrangler secret put`; never printed. */
  readonly secrets: readonly SecretEntry[];
  /** Plaintext installation inputs set in wrangler `vars`. */
  readonly vars: readonly SecretEntry[];
  readonly note: string;
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) freeze(entry);
    Object.freeze(value);
  }
  return value;
}

export const workerSecrets: readonly WorkerSecrets[] = freeze([
  {
    worker: 'rf-app',
    note: 'Workspace Worker. Secrets from apps/app/src/env.ts and GraphProvider.fromEnv in apps/app/src/mail/providers/graph.ts.',
    secrets: [
      { name: 'R2_ACCESS_KEY_ID', note: 'Bucket-scoped S3 access key id.' },
      { name: 'R2_SECRET_ACCESS_KEY', note: 'Bucket-scoped S3 secret access key.' },
      { name: 'DOWNLOAD_HMAC_KEY', note: 'Shared download-link HMAC key; identical value in rf-dl.' },
      { name: 'ACCESS_TEAM_DOMAIN', note: 'https://<team>.cloudflareaccess.com — verified on every API request.' },
      { name: 'ACCESS_AUD', note: "The Access application's AUD tag." },
      { name: 'GRAPH_TENANT_ID', note: 'Microsoft Graph app registration tenant id.' },
      { name: 'GRAPH_CLIENT_ID', note: 'Microsoft Graph app registration client id.' },
      { name: 'GRAPH_CERT_KEY', note: "The certificate's private key, PKCS#8 PEM." },
      { name: 'GRAPH_CERT_THUMBPRINT', note: 'SHA-1 certificate thumbprint, hexadecimal.' },
      { name: 'SENDING_ADDRESS', note: 'The mailbox the emails are sent from.' },
    ],
    vars: [
      { name: 'WORKSPACE_ORIGIN', note: 'Workspace origin; already set in apps/app/wrangler.jsonc vars.' },
      { name: 'DOWNLOAD_ORIGIN', note: 'Download host origin; already set in apps/app/wrangler.jsonc vars.' },
      { name: 'R2_ACCOUNT_ID', note: 'Cloudflare account id for the S3 endpoint; installation input.' },
      { name: 'PRIVATE_BUCKET_NAME', note: 'Private bucket name for presigned uploads; installation input.' },
    ],
  },
  {
    worker: 'rf-submit',
    note: 'Public submission API. Secrets from apps/submit/src/index.ts (Env). BUDGET/MAILER are DO bindings, not secrets.',
    secrets: [
      { name: 'TURNSTILE_SECRET', note: 'Turnstile siteverify secret key.' },
      { name: 'R2_ACCESS_KEY_ID', note: 'Bucket-scoped S3 access key id; presigns Outside_Submission uploads.' },
      { name: 'R2_SECRET_ACCESS_KEY', note: 'Bucket-scoped S3 secret access key; presigns Outside_Submission uploads.' },
    ],
    vars: [
      { name: 'R2_ACCOUNT_ID', note: 'Cloudflare account id for the S3 endpoint; installation input.' },
      { name: 'PRIVATE_BUCKET_NAME', note: 'Private bucket name for presigned uploads; installation input.' },
    ],
  },
  {
    worker: 'rf-dl',
    note: 'Download Worker. From apps/dl/src/index.ts (Env). WORKSPACE_ORIGIN is a var in apps/dl/wrangler.jsonc.',
    secrets: [{ name: 'DOWNLOAD_HMAC_KEY', note: 'Shared download-link HMAC key; same value as rf-app.' }],
    vars: [{ name: 'WORKSPACE_ORIGIN', note: 'Workspace origin; already set in apps/dl/wrangler.jsonc vars.' }],
  },
  {
    worker: 'rf-ops',
    note: 'Ops Worker (no fetch route; reachable only via service bindings). Env from apps/ops/src/index.ts (OpsEnv). Covers Access-sync, usage analytics (task 44.1), rf-site deploy (task 32.1), edge Containment (task 59.2), the submit-host WAF budget shed (task 34.2) and the independent health/spend/incident alerts (task 67.2). Each subsystem refuses to operate when its inputs are absent. Separate credentials per environment.',
    secrets: [
      { name: 'CF_ACCESS_API_TOKEN', note: 'Cloudflare API token (Access Apps/Policies Edit + Zero Trust list edit, this account only).' },
      { name: 'CF_ANALYTICS_API_TOKEN', note: 'Account Analytics Read API token scoped to CF_ACCOUNT_ID only, for the GraphQL Analytics API (task 44.1).' },
      { name: 'CF_SITE_DEPLOY_API_TOKEN', note: 'Workers deploy API token scoped to rf-site on this account only (task 32.1).' },
      { name: 'CONTAINMENT_API_TOKEN', note: 'Independently recoverable API token scoped to the public-host zone WAF only, held in a store separate from CF_ACCESS_API_TOKEN so Containment survives a primary-account lock (task 59.2, R60.6).' },
      { name: 'INCIDENT_ALERT_TOKEN', note: 'Bearer credential for the independent alert channel (task 59.2/67.2, R28.6).' },
      { name: 'CF_SUBMIT_WAF_API_TOKEN', note: 'API token scoped to the submit-host zone WAF only, for toggling the precreated submit-block rule (task 34.2).' },
    ],
    vars: [
      { name: 'CF_ACCOUNT_ID', note: 'Cloudflare account id the Access list/revoke and analytics calls target; installation input.' },
      { name: 'ACCESS_MEMBER_LIST_ID', note: 'Zero Trust list id for the rf-members Access list; installation input.' },
      { name: 'CF_SITE_SCRIPT_NAME', note: 'The rf-site script/dispatch name the assets-upload-session and version/deploy endpoints address (task 32.1).' },
      { name: 'CF_PUBLIC_ZONE_ID', note: 'The zone that serves the public research hosts, for edge Containment (task 59.2).' },
      { name: 'APP_HOST', note: 'The app host Containment must never deny; kept available while the public hosts are denied (task 59.2).' },
      { name: 'CF_PUBLIC_DENY_RULESET_ID', note: 'The WAF ruleset id the precreated public-host deny rules live in (task 59.2).' },
      { name: 'CF_PUBLIC_DENY_RULE_IDS', note: 'Comma-separated ids of the precreated public-host deny rules Containment enables/disables (task 59.2).' },
      { name: 'CONTAINMENT_PROBE_URL', note: 'A public research address an out-of-band probe HEADs to confirm a denial is actually serving (task 59.2).' },
      { name: 'PLAN_CAN_DENY', note: 'Whether the configured plan can carry WAF custom deny rules at all; false blocks public launch (task 59.2, R60.4).' },
      { name: 'INCIDENT_ALERT_WEBHOOK_URL', note: 'The independent alert channel endpoint, a provider distinct from the app and its email queue (task 59.2/67.2, R28.6).' },
      { name: 'HEALTH_CHECK_ENDPOINTS', note: 'Comma-separated name=url pairs the independent health check HEADs out-of-band; empty reports degraded (task 67.2).' },
      { name: 'CF_SUBMIT_ZONE_ID', note: 'The zone that serves the public submit host, for the submit-host WAF budget shed (task 34.2).' },
      { name: 'CF_SUBMIT_BLOCK_RULESET_ID', note: 'The WAF ruleset id the precreated submit-block rule lives in (task 34.2).' },
      { name: 'CF_SUBMIT_BLOCK_RULE_ID', note: 'The id of the precreated submit-block WAF custom rule the shed enables/disables, never creates (task 34.2).' },
    ],
  },
]);
