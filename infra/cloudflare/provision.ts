/**
 * Provisioning planner for the Cloudflare resources as code (spec task 48.1).
 *
 * `planApiCalls` is a pure function: it turns the declarative `cloudflareResources` plan into an
 * ordered list of Cloudflare REST calls, with account and zone identifiers left as `:accountId` /
 * `:zoneId` placeholders. It never reads credentials, never resolves real IDs and never calls out.
 *
 * The CLI prints that plan. `--dry-run` is required; there is NO live apply in this task. Endpoint
 * path templates are illustrative, dependency-ordered placeholders written from general Cloudflare
 * API knowledge — task 48.4/48.6 performs real activation. `body` summaries never carry secret
 * values (they describe which secret NAMES a step would need, never their contents).
 */

import { fileURLToPath } from 'node:url';
import {
  cloudflareResources,
  type CloudflareResourcePlan,
  type EnvironmentName,
  type EnvironmentResources,
} from './resources';

/** Placeholder identifiers handed to the planner; never resolved to real account/zone IDs. */
export interface ResourceContext {
  readonly accountId: string;
  readonly zoneId: string;
}

/** The default, deliberately non-real context. Using it keeps the plan free of any real ID. */
export const PLACEHOLDER_CONTEXT: ResourceContext = { accountId: ':accountId', zoneId: ':zoneId' };

export interface PlannedCall {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** A Cloudflare REST path template with `:accountId` / `:zoneId` placeholders. */
  readonly endpoint: string;
  /** A one-line human description of the step. */
  readonly summary: string;
  /** A redacted payload summary (shapes and names only; never secret values). */
  readonly body?: Readonly<Record<string, unknown>>;
}

function d1Calls(env: EnvironmentResources, ctx: ResourceContext): PlannedCall[] {
  return env.d1Databases.map((db) => ({
    method: 'POST',
    endpoint: `/accounts/${ctx.accountId}/d1/database`,
    summary: `Create D1 database ${db.name} (binding ${db.binding})`,
    body: { name: db.name },
  }));
}

function r2Calls(env: EnvironmentResources, ctx: ResourceContext): PlannedCall[] {
  const calls: PlannedCall[] = [];
  for (const bucket of env.r2Buckets) {
    // The bucket itself precedes any configuration applied to it.
    calls.push({
      method: 'POST',
      endpoint: `/accounts/${ctx.accountId}/r2/buckets`,
      summary: `Create R2 bucket ${bucket.name}`,
      body: { name: bucket.name },
    });
    calls.push({
      method: 'PUT',
      endpoint: `/accounts/${ctx.accountId}/r2/buckets/${bucket.name}/public-access`,
      summary: `Set r2.dev public access ${bucket.publicDevAccess ? 'on' : 'off'} for ${bucket.name}`,
      body: { enabled: bucket.publicDevAccess },
    });
    if (bucket.cors) {
      calls.push({
        method: 'PUT',
        endpoint: `/accounts/${ctx.accountId}/r2/buckets/${bucket.name}/cors`,
        summary: `Apply CORS (${bucket.cors.length} rule(s)) to ${bucket.name}`,
        body: { rules: bucket.cors },
      });
    }
    if (bucket.lifecycleRules) {
      calls.push({
        method: 'PUT',
        endpoint: `/accounts/${ctx.accountId}/r2/buckets/${bucket.name}/lifecycle`,
        summary: `Apply lifecycle rules (${bucket.lifecycleRules.length}) to ${bucket.name}`,
        body: { rules: bucket.lifecycleRules },
      });
    }
    if (bucket.customDomain) {
      calls.push({
        method: 'POST',
        endpoint: `/accounts/${ctx.accountId}/r2/buckets/${bucket.name}/domains/custom`,
        summary: `Attach custom domain ${bucket.customDomain} to ${bucket.name}`,
        body: { domain: bucket.customDomain, zoneId: ctx.zoneId, enabled: true },
      });
    }
  }
  return calls;
}

function zoneCalls(env: EnvironmentResources, ctx: ResourceContext): PlannedCall[] {
  const z = env.zone;
  const calls: PlannedCall[] = [];
  for (const redirect of z.redirects) {
    calls.push({
      method: 'POST',
      endpoint: `/zones/${ctx.zoneId}/rulesets/phases/http_request_dynamic_redirect/entrypoint`,
      summary: `Single redirect ${redirect.fromHost} → ${redirect.toHost} (${redirect.statusCode})`,
      body: { name: redirect.name, statusCode: redirect.statusCode, preservePathAndQuery: redirect.preservePathAndQuery },
    });
  }
  for (const rule of z.cacheRules) {
    calls.push({
      method: 'POST',
      endpoint: `/zones/${ctx.zoneId}/rulesets/phases/http_request_cache_settings/entrypoint`,
      summary: `Cache rule "${rule.cache}" on ${rule.host}`,
      body: { name: rule.name, host: rule.host, cache: rule.cache },
    });
  }
  for (const rule of z.responseHeaderRules) {
    calls.push({
      method: 'POST',
      endpoint: `/zones/${ctx.zoneId}/rulesets/phases/http_response_headers_transform/entrypoint`,
      summary: `Response header rule on ${rule.host} (${Object.keys(rule.setHeaders).join(', ')})`,
      body: { name: rule.name, host: rule.host, setHeaders: rule.setHeaders },
    });
  }
  for (const rule of z.wafBlockRules) {
    calls.push({
      method: 'POST',
      endpoint: `/zones/${ctx.zoneId}/rulesets/phases/http_request_firewall_custom/entrypoint`,
      summary: `WAF block rule on ${rule.host} (enabled=${rule.enabled})`,
      body: { name: rule.name, host: rule.host, action: rule.action, enabled: rule.enabled },
    });
  }
  for (const rule of z.rateLimitRules) {
    calls.push({
      method: 'POST',
      endpoint: `/zones/${ctx.zoneId}/rulesets/phases/http_ratelimit/entrypoint`,
      summary: `Rate-limit rule for ${rule.hosts.join(', ')} (${rule.requestsPerPeriod}/${rule.periodSeconds}s)`,
      body: {
        name: rule.name,
        hosts: rule.hosts,
        requestsPerPeriod: rule.requestsPerPeriod,
        periodSeconds: rule.periodSeconds,
        action: rule.action,
      },
    });
  }
  for (const setting of z.settings) {
    calls.push({
      method: 'PATCH',
      endpoint: `/zones/${ctx.zoneId}/settings/${setting.setting}`,
      summary: `Zone setting ${setting.setting} = ${setting.value}`,
      body: { value: setting.value },
    });
  }
  return calls;
}

function accessCalls(env: EnvironmentResources, ctx: ResourceContext): PlannedCall[] {
  const calls: PlannedCall[] = [];
  for (const app of env.accessApplications) {
    // The list precedes the application; the application's allow policy references the list.
    calls.push({
      method: 'POST',
      endpoint: `/accounts/${ctx.accountId}/access/groups`,
      summary: `Create Access list ${app.list.name} (${app.list.listType})`,
      body: { name: app.list.name, type: app.list.listType },
    });
    calls.push({
      method: 'POST',
      endpoint: `/accounts/${ctx.accountId}/access/apps`,
      summary: `Create Access application ${app.name} on ${app.host} (session ${app.sessionDuration})`,
      body: {
        name: app.name,
        domain: app.host,
        sessionDuration: app.sessionDuration,
        cookie: app.cookie,
        identityProviders: app.identityProviders.map((idp) => idp.type),
      },
    });
    calls.push({
      method: 'POST',
      endpoint: `/accounts/${ctx.accountId}/access/apps/:appId/policies`,
      summary: `Allow policy ${app.policy.name} including list ${app.policy.includeList}`,
      body: { name: app.policy.name, decision: app.policy.decision, includeList: app.policy.includeList },
    });
  }
  return calls;
}

function turnstileCalls(env: EnvironmentResources, ctx: ResourceContext): PlannedCall[] {
  return env.turnstileWidgets.map((widget) => ({
    method: 'POST' as const,
    endpoint: `/accounts/${ctx.accountId}/challenges/widgets`,
    summary: `Create ${widget.mode}-mode Turnstile widget ${widget.name}`,
    body: { name: widget.name, mode: widget.mode, domains: widget.hostnames },
  }));
}

function workerDomainCalls(env: EnvironmentResources, ctx: ResourceContext): PlannedCall[] {
  // Worker custom domains come last: the Workers must already be deployed.
  return env.zone.workerCustomDomains.map((domain) => ({
    method: 'PUT' as const,
    endpoint: `/accounts/${ctx.accountId}/workers/domains`,
    summary: `Attach custom domain ${domain.hostname} to Worker ${domain.service}`,
    body: { hostname: domain.hostname, service: domain.service, zoneId: ctx.zoneId },
  }));
}

/**
 * Plan every Cloudflare API call for one environment, dependency-ordered: D1 and R2 (bucket before
 * its CORS/lifecycle/custom-domain), then zone rules, then Access (list → application → policy),
 * then Turnstile, then Worker custom domains.
 */
export function planEnvironmentCalls(env: EnvironmentResources, ctx: ResourceContext = PLACEHOLDER_CONTEXT): readonly PlannedCall[] {
  return [
    ...d1Calls(env, ctx),
    ...r2Calls(env, ctx),
    ...zoneCalls(env, ctx),
    ...accessCalls(env, ctx),
    ...turnstileCalls(env, ctx),
    ...workerDomainCalls(env, ctx),
  ];
}

/** Plan calls for the selected environments (both by default). */
export function planApiCalls(
  resources: CloudflareResourcePlan = cloudflareResources,
  ctx: ResourceContext = PLACEHOLDER_CONTEXT,
  environments: readonly EnvironmentName[] = ['production', 'staging'],
): readonly PlannedCall[] {
  return environments.flatMap((name) => planEnvironmentCalls(resources[name], ctx));
}

function formatPlan(calls: readonly PlannedCall[]): string {
  return calls
    .map((call) => {
      const header = `${call.method} ${call.endpoint} — ${call.summary}`;
      const body = call.body ? `\n    payload: ${JSON.stringify(call.body)}` : '';
      return header + body;
    })
    .join('\n');
}

const USAGE = 'Usage: provision.ts --dry-run [--env production|staging] [--json]';

export function runCli(argv: readonly string[]): { readonly output: string; readonly exitCode: number } {
  const args = [...argv];
  if (!args.includes('--dry-run')) {
    return { output: `Live provisioning is not implemented in task 48.1.\n${USAGE}`, exitCode: 1 };
  }
  let environments: readonly EnvironmentName[] = ['production', 'staging'];
  const envIndex = args.indexOf('--env');
  if (envIndex !== -1) {
    const value = args[envIndex + 1];
    if (value !== 'production' && value !== 'staging') return { output: USAGE, exitCode: 1 };
    environments = [value];
  }
  const json = args.includes('--json');
  // Reject any unexpected flag so typos fail loudly, mirroring tools/check-specs.ts.
  const known = new Set(['--dry-run', '--json', '--env', ...(envIndex === -1 ? [] : [args[envIndex + 1]!])]);
  if (args.some((arg) => arg.startsWith('--') && !known.has(arg))) return { output: USAGE, exitCode: 1 };

  const calls = planApiCalls(cloudflareResources, PLACEHOLDER_CONTEXT, environments);
  if (json) return { output: JSON.stringify({ context: PLACEHOLDER_CONTEXT, environments, calls }, null, 2), exitCode: 0 };
  const header = `Dry run — ${calls.length} planned Cloudflare API call(s) for: ${environments.join(', ')}. No account access, nothing provisioned.`;
  return { output: `${header}\n${formatPlan(calls)}`, exitCode: 0 };
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = runCli(process.argv.slice(2));
  if (result.exitCode === 0) console.log(result.output);
  else console.error(result.output);
  process.exitCode = result.exitCode;
}
