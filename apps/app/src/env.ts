import type { OpsAccess, OpsContainment, OpsDeploy, OpsWaf } from '@researchforce/domain/ops';
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
  /** The `rf-public` bucket name, enabling the Publisher's server-side `CopyObject` of public files (R24.3); absent falls back to the binding get→put stream. */
  PUBLIC_BUCKET_NAME?: string;
  DOWNLOAD_HMAC_KEY?: string;
  DOWNLOAD_ORIGIN?: string;
  RF_CORE: D1Database;
  RF_SEARCH: D1Database;
  RF_PUBLIC: D1Database;
  RF_PRIVATE_BUCKET: R2Bucket;
  RF_PUBLIC_BUCKET: R2Bucket;
  AI: Ai;
  ASSETS: Fetcher;
  /** rf-ops over the service binding: Access, the Publisher's site deploy and edge Containment (tasks 32.1/32.5/59.2), and the Budget's submit WAF block (task 34.1/34.2). */
  OPS: Fetcher & OpsAccess & OpsDeploy & OpsContainment & OpsWaf;
  PUBLISHER: DurableObjectNamespace<Publisher>;
  MAILER: DurableObjectNamespace<Mailer>;
  BUDGET: DurableObjectNamespace<Budget>;
  JOBS: DurableObjectNamespace<Jobs>;
  /** `https://app.researchforce.org`, or the staging hostname. */
  WORKSPACE_ORIGIN: string;
  /** The public pages origin (`https://researchforce.org`) the verify step HEADs removed page addresses at (R24.16). */
  PUBLIC_SITE_ORIGIN?: string;
  /** The public files origin (`https://files.researchforce.org`) the verify step HEADs removed file copies at (R24.16). */
  PUBLIC_FILES_ORIGIN?: string;
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
  /** The full-text address the Content_Licence name links to on public pages (R29.10, R46.15); unset until the owner configures it. */
  CONTENT_LICENCE_URL?: string;
  /** Secret HMAC key authenticating sealed Research_Release manifests (R59.2); sealing and manifest verification require it. */
  RELEASE_MANIFEST_KEY?: string;
}
