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
 *   - rf-ops:    apps/ops/src/index.ts (OpsEnv) — the Access-sync credentials for the Cloudflare API.
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
    note: 'Public submission API. Secret from apps/submit/src/index.ts (Env). BUDGET/MAILER are DO bindings, not secrets.',
    secrets: [{ name: 'TURNSTILE_SECRET', note: 'Turnstile siteverify secret key.' }],
    vars: [],
  },
  {
    worker: 'rf-dl',
    note: 'Download Worker. From apps/dl/src/index.ts (Env). WORKSPACE_ORIGIN is a var in apps/dl/wrangler.jsonc.',
    secrets: [{ name: 'DOWNLOAD_HMAC_KEY', note: 'Shared download-link HMAC key; same value as rf-app.' }],
    vars: [{ name: 'WORKSPACE_ORIGIN', note: 'Workspace origin; already set in apps/dl/wrangler.jsonc vars.' }],
  },
  {
    worker: 'rf-ops',
    note: 'Access-sync Worker (no fetch route; reachable only via service bindings). Env from apps/ops/src/index.ts (OpsEnv); AccessSync throws "Access sync is not configured." when any is absent.',
    secrets: [{ name: 'CF_ACCESS_API_TOKEN', note: 'Cloudflare API token (Access Apps/Policies Edit + Zero Trust list edit, this account only).' }],
    vars: [
      { name: 'CF_ACCOUNT_ID', note: 'Cloudflare account id the Access list/revoke calls target; installation input.' },
      { name: 'ACCESS_MEMBER_LIST_ID', note: 'Zero Trust list id for the rf-members Access list; installation input.' },
    ],
  },
]);
