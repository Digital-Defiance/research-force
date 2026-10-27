export interface Env {
  RF_CORE: D1Database;
  RF_PRIVATE_BUCKET: R2Bucket;
  DOWNLOAD_HMAC_KEY: string;
}

export default {
  fetch() { return new Response('Not found', { status: 404 }); },
} satisfies ExportedHandler<Env>;
