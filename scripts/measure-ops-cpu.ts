import { Containment, type ContainmentConfig } from '../apps/ops/src/containment';
import { manifestRequestHash, SiteDeploy, type AssetBody, type SiteManifest } from '../apps/ops/src/deploy';
import { PROBE_BATCH_MAX, UPLOAD_CHUNK } from '../packages/domain/src/slice-budget';

// Measures the CPU time of the CPU-bound parts of each rf-ops step, in Node (same V8 as workerd; not the platform's
// meter). Network waits are stubbed, so the numbers are the Worker's own CPU. The Free plan allows 10 ms per Worker
// invocation.
//
//   node --import tsx scripts/measure-ops-cpu.ts [manifest sizes...]
const SIZES = process.argv.slice(2).map(Number).filter((n) => n > 0);
const manifestOf = (files: number): SiteManifest => Object.fromEntries(Array.from({ length: files }, (_, i) => [`/research/item-${i}/index.html`, { hash: i.toString(16).padStart(32, '0'), size: 4096 }]));
const cpuMs = async (run: () => Promise<unknown>): Promise<number> => {
  await run(); // warm the JIT: a Worker isolate is long-lived across invocations
  const before = process.cpuUsage();
  await run();
  const used = process.cpuUsage(before);
  return (used.user + used.system) / 1000;
};
const ok = async (): Promise<Response> => Response.json({ success: true, result: { jwt: 'jwt', buckets: [] } });
const deploy = new SiteDeploy({ accountId: 'a', scriptName: 's', apiToken: 't' }, {} as D1Database, ok as unknown as typeof fetch);
const base64 = 'A'.repeat(Math.floor(UPLOAD_CHUNK.maxBytes / UPLOAD_CHUNK.maxFiles));
const body: AssetBody = { base64, contentType: 'text/html' };
const chunk = Object.fromEntries(Array.from({ length: UPLOAD_CHUNK.maxFiles }, (_, i) => [i.toString(16).padStart(32, '0'), body]));
const config = { publicZoneId: 'z', appHost: 'app', publicDenyRuleIds: ['r'], denyRulesetId: 'x', probeUrl: 'https://p/', containmentApiToken: 't' } as unknown as ContainmentConfig;
const containment = new Containment(config, (async () => new Response(null, { status: 404 })) as unknown as typeof fetch);
const urls = Array.from({ length: PROBE_BATCH_MAX }, (_, i) => `https://files.example.org/research/item-${i}/index.html`);
const results: Record<string, number> = {};
for (const files of SIZES.length > 0 ? SIZES : [1_000, 2_500, 5_000, 16_000]) {
  const manifest = manifestOf(files);
  results[`begin: hash + register a ${files}-file manifest`] = await cpuMs(async () => {
    await manifestRequestHash(manifest);
    JSON.stringify({ manifest });
    new Set(Object.values(manifest).map((file) => file.hash));
  });
}
results[`upload: one chunk of ${UPLOAD_CHUNK.maxFiles} files, ${(UPLOAD_CHUNK.maxFiles * base64.length / 1048576).toFixed(1)} MiB base64`] = await cpuMs(() => deploy.uploadSiteAssets({ uploadToken: 't', files: chunk }));
results[`probe: batch of ${PROBE_BATCH_MAX} addresses`] = await cpuMs(() => containment.probePublicAddresses(urls));
for (const [step, ms] of Object.entries(results)) process.stdout.write(`${ms.toFixed(2).padStart(8)} ms  ${step}\n`);
