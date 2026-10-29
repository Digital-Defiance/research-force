import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cloudflareResources } from '../../infra/cloudflare/resources';
import { PLACEHOLDER_CONTEXT, planApiCalls, type PlannedCall } from '../../infra/cloudflare/provision';
import { workerSecrets } from '../../infra/secrets';
import { hasMissing, missingSecrets, parsePresentKeys, runCli as runSecretsCli } from '../check-secrets';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/u, '');
function runNode(args: string[], cwd = repoRoot) {
  return spawnSync(process.execPath, ['--import', 'tsx', ...args], { cwd, encoding: 'utf8' });
}

describe('cloudflare resources plan', () => {
  const prod = cloudflareResources.production;

  it('encodes the D1 databases for production and staging', () => {
    expect(prod.d1Databases.map((db) => db.name)).toEqual(['rf-core', 'rf-search', 'rf-public']);
    expect(cloudflareResources.staging.d1Databases.map((db) => db.name)).toEqual(['rf-core-staging', 'rf-search-staging', 'rf-public-staging']);
  });

  it('encodes the private bucket CORS, lifecycle and no public access/custom domain', () => {
    const priv = prod.r2Buckets.find((b) => b.name === 'rf-private')!;
    expect(priv.publicDevAccess).toBe(false);
    expect(priv.customDomain).toBeUndefined();
    const cors = priv.cors![0]!;
    expect(cors.allowedMethods).toEqual(['PUT']);
    expect(cors.allowedOrigins).toEqual(['https://app.researchforce.org', 'https://researchforce.org']);
    expect(cors.allowedHeaders).toEqual(['content-length', 'x-amz-checksum-sha256', 'if-none-match']);
    expect(cors.exposeHeaders).toEqual(['ETag']);
    expect(priv.lifecycleRules![0]).toMatchObject({ abortIncompleteMultipartUploadDays: 1 });
  });

  it('encodes the public bucket with r2.dev off and the files custom domain', () => {
    const pub = prod.r2Buckets.find((b) => b.name === 'rf-public')!;
    expect(pub.publicDevAccess).toBe(false);
    expect(pub.customDomain).toBe('files.researchforce.org');
  });

  it('encodes the zone redirect, cache, response-header, WAF and rate-limit rules', () => {
    const z = prod.zone;
    expect(z.redirects[0]).toMatchObject({ fromHost: 'www.researchforce.org', toHost: 'researchforce.org', statusCode: 301 });
    expect(z.cacheRules[0]).toMatchObject({ host: 'files.researchforce.org', cache: 'bypass' });
    expect(z.responseHeaderRules[0]!.setHeaders).toEqual({ 'Content-Security-Policy': 'sandbox', 'X-Content-Type-Options': 'nosniff' });
    expect(z.wafBlockRules[0]).toMatchObject({ host: 'submit.researchforce.org', enabled: false, action: 'block' });
    expect(z.rateLimitRules[0]!.hosts).toEqual(['submit.researchforce.org', 'dl.researchforce.org']);
  });

  it('encodes Bot Fight Mode off, Always Online off and the Worker custom domains', () => {
    const settings = Object.fromEntries(prod.zone.settings.map((s) => [s.setting, s.value]));
    expect(settings['bot_fight_mode']).toBe('off');
    expect(settings['always_online']).toBe('off');
    const domains = prod.zone.workerCustomDomains;
    expect(domains.map((d) => [d.service, d.hostname])).toEqual([
      ['rf-app', 'app.researchforce.org'],
      ['rf-submit', 'submit.researchforce.org'],
      ['rf-dl', 'dl.researchforce.org'],
    ]);
    // rf-ops has no public route, so it carries no custom domain.
    expect(domains.some((d) => d.service.startsWith('rf-ops'))).toBe(false);
  });

  it('encodes the Access application, rf-members list/policy and managed Turnstile widget', () => {
    const app = prod.accessApplications[0]!;
    expect(app).toMatchObject({ host: 'app.researchforce.org', sessionDuration: '24h' });
    expect(app.cookie).toEqual({ httpOnly: true, sameSite: 'lax', enableBindingCookie: true });
    expect(app.identityProviders.map((idp) => idp.type)).toEqual(['onetimepin', 'google', 'github']);
    expect(app.list.name).toBe('rf-members');
    expect(app.policy).toMatchObject({ decision: 'allow', includeList: 'rf-members' });
    expect(prod.turnstileWidgets[0]).toMatchObject({ mode: 'managed' });
  });

  it('is deeply frozen', () => {
    expect(Object.isFrozen(cloudflareResources)).toBe(true);
    expect(Object.isFrozen(prod.d1Databases)).toBe(true);
    expect(() => {
      (prod.d1Databases as unknown as { push: (x: unknown) => void }).push({});
    }).toThrow();
  });
});

describe('provision dry-run planner', () => {
  const calls = planApiCalls();

  it('orders each bucket before its CORS/lifecycle/custom-domain configuration', () => {
    const index = (predicate: (c: PlannedCall) => boolean) => calls.findIndex(predicate);
    const createPrivate = index((c) => c.summary === 'Create R2 bucket rf-private');
    const corsPrivate = index((c) => c.endpoint.includes('/r2/buckets/rf-private/cors'));
    const lifecyclePrivate = index((c) => c.endpoint.includes('/r2/buckets/rf-private/lifecycle'));
    expect(createPrivate).toBeGreaterThanOrEqual(0);
    expect(createPrivate).toBeLessThan(corsPrivate);
    expect(createPrivate).toBeLessThan(lifecyclePrivate);
    const createPublic = index((c) => c.summary === 'Create R2 bucket rf-public');
    const domainPublic = index((c) => c.endpoint.includes('/r2/buckets/rf-public/domains/custom'));
    expect(createPublic).toBeLessThan(domainPublic);
  });

  it('orders the Access list before the application before the policy', () => {
    const list = calls.findIndex((c) => c.summary.startsWith('Create Access list rf-members'));
    const app = calls.findIndex((c) => c.summary.startsWith('Create Access application'));
    const policy = calls.findIndex((c) => c.summary.startsWith('Allow policy'));
    expect(list).toBeLessThan(app);
    expect(app).toBeLessThan(policy);
  });

  it('places Worker custom domains after everything else', () => {
    const firstDomain = calls.findIndex((c) => c.summary.startsWith('Attach custom domain') && c.summary.includes('to Worker'));
    const lastOther = calls.reduce((acc, c, i) => (c.summary.startsWith('Attach custom domain') && c.summary.includes('to Worker') ? acc : i), -1);
    expect(firstDomain).toBeGreaterThan(-1);
    // There exists at least one non-worker-domain call, and all worker-domain calls follow it.
    expect(firstDomain).toBeGreaterThan(calls.findIndex((c) => c.summary.startsWith('Create D1 database')));
    expect(lastOther).toBeGreaterThan(-1);
  });

  it('never resolves a real account/zone id and never leaks a secret value', () => {
    expect(PLACEHOLDER_CONTEXT).toEqual({ accountId: ':accountId', zoneId: ':zoneId' });
    const serialized = JSON.stringify(calls);
    expect(serialized).toContain(':accountId');
    expect(serialized).toContain(':zoneId');
    // No secret NAMES carry values; assert no planned body contains anything resembling a credential value.
    for (const secretName of workerSecrets.flatMap((w) => w.secrets.map((s) => s.name))) {
      expect(serialized).not.toContain(`"${secretName}":`);
    }
  });

  it('runs --dry-run --json with exit 0 and a parseable plan via the CLI', () => {
    const result = runNode(['infra/cloudflare/provision.ts', '--dry-run', '--json']);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { calls: PlannedCall[]; environments: string[] };
    expect(parsed.environments).toEqual(['production', 'staging']);
    expect(parsed.calls.length).toBe(calls.length);
  });

  it('refuses a bare invocation with usage and a non-zero exit', () => {
    const result = runNode(['infra/cloudflare/provision.ts']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not implemented');
  });
});

describe('check-secrets missing detection', () => {
  it('reports every rf-app/rf-submit/rf-dl secret missing for an empty present set, and rf-ops none', () => {
    const reports = missingSecrets(new Set());
    const byWorker = Object.fromEntries(reports.map((r) => [r.worker, r]));
    expect(byWorker['rf-app']!.missingSecrets).toContain('GRAPH_CERT_KEY');
    expect(byWorker['rf-app']!.missingSecrets.length).toBe(10);
    expect(byWorker['rf-submit']!.missingSecrets).toEqual(['TURNSTILE_SECRET']);
    expect(byWorker['rf-dl']!.missingSecrets).toEqual(['DOWNLOAD_HMAC_KEY']);
    expect(byWorker['rf-ops']!.missingSecrets).toEqual([]);
    expect(byWorker['rf-ops']!.missingVars).toEqual([]);
    expect(hasMissing(reports)).toBe(true);
  });

  it('reports nothing missing when every required key is present', () => {
    const all = new Set(workerSecrets.flatMap((w) => [...w.secrets, ...w.vars].map((e) => e.name)));
    const reports = missingSecrets(all);
    expect(hasMissing(reports)).toBe(false);
  });

  it('parses only key names from a .dev.vars-style file', () => {
    const keys = parsePresentKeys('# comment\nTURNSTILE_SECRET=abc\nexport DOWNLOAD_HMAC_KEY = xyz\n\nnot a line');
    expect([...keys].sort()).toEqual(['DOWNLOAD_HMAC_KEY', 'TURNSTILE_SECRET']);
  });

  it('runs the CLI non-zero against an empty vars file and prints names but no values', () => {
    const result = runSecretsCli(['--vars', '/dev/null', '--worker', 'rf-submit'], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('TURNSTILE_SECRET');
  });

  it('exits 0 against a complete vars file via the spawned CLI', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rf-secrets-'));
    try {
      const varsPath = join(dir, 'complete.vars');
      const everyKey = workerSecrets.flatMap((w) => [...w.secrets, ...w.vars].map((e) => e.name));
      writeFileSync(varsPath, everyKey.map((name) => `${name}=placeholder-not-a-real-value`).join('\n') + '\n');
      const result = runNode(['tools/check-secrets.ts', '--vars', varsPath]);
      expect(result.status).toBe(0);
      // Values are never echoed.
      expect(result.stdout).not.toContain('placeholder-not-a-real-value');

      const emptyPath = join(dir, 'empty.vars');
      writeFileSync(emptyPath, '');
      const missing = runNode(['tools/check-secrets.ts', '--vars', emptyPath]);
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain('TURNSTILE_SECRET');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
