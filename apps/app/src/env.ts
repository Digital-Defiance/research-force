import type { OpsAccess } from '@researchforce/domain/ops';
import type { Budget, Jobs, Mailer, Publisher } from './durable-objects';
import type { LocalServices } from './local/services';

export interface Env {
  /** Explicit deployment selection; absence keeps pre-profile development installs compatible. */
  RESOURCE_PROFILE?: string;
  /** Local entrypoint only; generated from the ignored .dev.vars opt-in by the local runner. */
  RF_DEV_AUTH?: string;
  RF_DEV_AUTH_PRIVATE_KEY?: string;
  /** Present only in the generated local config; production refuses both fields. */
  RF_LOCAL_SERVICES?: string;
  LOCAL_SERVICES?: DurableObjectNamespace<LocalServices>;
  /** Bucket-scoped S3 credentials and shared download secret, configured per installation. */
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  PRIVATE_BUCKET_NAME?: string;
  DOWNLOAD_HMAC_KEY?: string;
  DOWNLOAD_ORIGIN?: string;
  RF_CORE: D1Database;
  RF_SEARCH: D1Database;
  RF_PUBLIC: D1Database;
  RF_PRIVATE_BUCKET: R2Bucket;
  RF_PUBLIC_BUCKET: R2Bucket;
  AI: Ai;
  ASSETS: Fetcher;
  OPS: Fetcher & OpsAccess;
  PUBLISHER: DurableObjectNamespace<Publisher>;
  MAILER: DurableObjectNamespace<Mailer>;
  BUDGET: DurableObjectNamespace<Budget>;
  JOBS: DurableObjectNamespace<Jobs>;
  /** `https://app.researchforce.org`, or the staging hostname. */
  WORKSPACE_ORIGIN: string;
  /** Secrets: `https://<team>.cloudflareaccess.com` and the Access application's AUD tag. */
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  /** Secrets of the Microsoft Graph Email_Provider: the app registration, its certificate key (PKCS#8 PEM) and SHA-1 thumbprint, and the Sending_Address. */
  GRAPH_TENANT_ID?: string;
  GRAPH_CLIENT_ID?: string;
  GRAPH_CERT_KEY?: string;
  GRAPH_CERT_THUMBPRINT?: string;
  SENDING_ADDRESS?: string;
  /** The installation's current Content_Licence name; unset until the owner chooses one (no default). */
  CONTENT_LICENCE_NAME?: string;
}
