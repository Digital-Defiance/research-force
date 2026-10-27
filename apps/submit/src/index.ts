export interface Env {
  RF_CORE: D1Database;
  RF_PRIVATE_BUCKET: R2Bucket;
  BUDGET: DurableObjectNamespace;
  MAILER: DurableObjectNamespace;
  TURNSTILE_SECRET: string;
}

export default {
  fetch() { return new Response('Not found', { status: 404 }); },
} satisfies ExportedHandler<Env>;
