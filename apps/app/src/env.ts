import type { Budget, Jobs, Mailer, Publisher } from './durable-objects';

export interface Env {
  RF_CORE: D1Database;
  RF_SEARCH: D1Database;
  RF_PUBLIC: D1Database;
  RF_PRIVATE_BUCKET: R2Bucket;
  RF_PUBLIC_BUCKET: R2Bucket;
  AI: Ai;
  ASSETS: Fetcher;
  OPS: Fetcher;
  PUBLISHER: DurableObjectNamespace<Publisher>;
  MAILER: DurableObjectNamespace<Mailer>;
  BUDGET: DurableObjectNamespace<Budget>;
  JOBS: DurableObjectNamespace<Jobs>;
}
