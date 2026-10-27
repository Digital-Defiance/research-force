import type { OpsAccess } from '@researchforce/domain/ops';
import type { Budget, Jobs, Mailer, Publisher } from './durable-objects';

export interface Env {
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
  /** The installation's current Content_Licence name; unset until the owner chooses one (no default). */
  CONTENT_LICENCE_NAME?: string;
}
