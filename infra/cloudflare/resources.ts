/**
 * Cloudflare resources as code (spec task 48.1). Pure data: a declarative description of every
 * Cloudflare resource the Research Force stack requires, for both the `production` and `staging`
 * environments. There are NO side effects, NO I/O, NO network calls and NO account access here;
 * the file exports a single frozen tree plus the types that describe it.
 *
 * Sources for the encoded values:
 *   - the per-Worker wrangler.jsonc files (Worker names, D1 database names, R2 bucket names, origins);
 *   - `.kiro/specs/research-collab-cms/design.md` §"Hosts" (lines 126–134), "File isolation" (513),
 *     "Public copies" (517), "Access configuration" (319–320), "Privacy of Visitors" (992),
 *     the R2 table (1298–1301) and the multipart lifecycle note (483);
 *   - the README "Files and protected downloads" section.
 *
 * Account and zone identifiers are deliberately NOT encoded. Real IDs and `database_id`s are
 * provisioned later (tasks 48.4/48.6); the current wrangler `database_id`s are placeholder UUIDs.
 * The provisioner (`provision.ts`) is handed a `ResourceContext` with named placeholders so nothing
 * here implies real account access. Requirements referenced: 1.1, 1.3, 25.2, 25.3, 28.5, 31.3, 45.18.
 */

/** The two deployment environments every per-Worker wrangler config already splits on. */
export type EnvironmentName = 'production' | 'staging';

export interface D1DatabaseResource {
  readonly kind: 'd1_database';
  /** The provisioned database name, e.g. `rf-core` / `rf-core-staging`. */
  readonly name: string;
  /** The Worker binding(s) that reference this database. */
  readonly binding: string;
}

export interface R2CorsRule {
  readonly allowedMethods: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly allowedHeaders: readonly string[];
  readonly exposeHeaders: readonly string[];
  readonly maxAgeSeconds: number;
}

export interface R2LifecycleRule {
  readonly id: string;
  /** Abort incomplete multipart uploads this many days after they start. */
  readonly abortIncompleteMultipartUploadDays: number;
}

export interface R2BucketResource {
  readonly kind: 'r2_bucket';
  readonly name: string;
  readonly binding: readonly string[];
  /** Public `r2.dev` managed access. Off for every bucket (design 1301, 513, R25.2). */
  readonly publicDevAccess: boolean;
  /** CORS rules, present only on the private upload bucket. */
  readonly cors?: readonly R2CorsRule[];
  /** Lifecycle rules, present only on the private upload bucket. */
  readonly lifecycleRules?: readonly R2LifecycleRule[];
  /** Custom domain, present only on the public bucket (`files.*`). */
  readonly customDomain?: string;
}

export interface RedirectRuleResource {
  readonly kind: 'redirect_rule';
  readonly name: string;
  /** The source hostname that is redirected. */
  readonly fromHost: string;
  /** The destination hostname. */
  readonly toHost: string;
  readonly statusCode: 301 | 302 | 307 | 308;
  readonly preservePathAndQuery: boolean;
}

export interface CacheRuleResource {
  readonly kind: 'cache_rule';
  readonly name: string;
  readonly host: string;
  /** `bypass` disables Cloudflare's cache on the host (design 127, 139). */
  readonly cache: 'bypass';
}

export interface ResponseHeaderRuleResource {
  readonly kind: 'response_header_rule';
  readonly name: string;
  readonly host: string;
  /** Header name → value added to every response on the host. */
  readonly setHeaders: Readonly<Record<string, string>>;
}

export interface WafBlockRuleResource {
  readonly kind: 'waf_block_rule';
  readonly name: string;
  readonly host: string;
  /** Encoded disabled: the Public_Traffic_Budget block rule is toggled by `rf-ops`, not left on. */
  readonly enabled: false;
  readonly action: 'block';
  readonly description: string;
}

export interface RateLimitRuleResource {
  readonly kind: 'rate_limit_rule';
  readonly name: string;
  /** Hosts the single shared rule protects (`submit` and `dl`). */
  readonly hosts: readonly string[];
  readonly requestsPerPeriod: number;
  readonly periodSeconds: number;
  readonly action: 'block';
  readonly mitigationTimeoutSeconds: number;
}

export interface ZoneSetting {
  readonly kind: 'zone_setting';
  readonly setting: string;
  readonly value: 'on' | 'off';
}

export interface WorkerCustomDomainResource {
  readonly kind: 'worker_custom_domain';
  /** The Worker service name, e.g. `rf-app` / `rf-app-staging`. */
  readonly service: string;
  readonly hostname: string;
}

export interface AccessIdentityProvider {
  /** `onetimepin`, `google` or `github` (design 319). */
  readonly type: 'onetimepin' | 'google' | 'github';
  readonly name: string;
}

export interface AccessListResource {
  readonly kind: 'access_list';
  /** The `rf-members` Access list of Pending and Active Member emails (design 320). */
  readonly name: string;
  readonly listType: 'email';
}

export interface AccessApplicationResource {
  readonly kind: 'access_application';
  readonly name: string;
  readonly host: string;
  /** 24-hour session (design 317, 129). */
  readonly sessionDuration: string;
  readonly cookie: {
    readonly httpOnly: boolean;
    readonly sameSite: 'lax' | 'strict' | 'none';
    /** The Access binding cookie (design 320). */
    readonly enableBindingCookie: boolean;
  };
  readonly identityProviders: readonly AccessIdentityProvider[];
  /** The Access list the allow policy references. */
  readonly list: AccessListResource;
  readonly policy: {
    readonly name: string;
    readonly decision: 'allow';
    /** The list name the allow policy includes. */
    readonly includeList: string;
  };
}

export interface TurnstileWidgetResource {
  readonly kind: 'turnstile_widget';
  readonly name: string;
  /** Managed mode (design 985; R31.3 context). */
  readonly mode: 'managed';
  readonly hostnames: readonly string[];
}

/** Every zone-level edge resource for one environment. */
export interface ZoneResources {
  readonly zone: string;
  readonly redirects: readonly RedirectRuleResource[];
  readonly cacheRules: readonly CacheRuleResource[];
  readonly responseHeaderRules: readonly ResponseHeaderRuleResource[];
  readonly wafBlockRules: readonly WafBlockRuleResource[];
  readonly rateLimitRules: readonly RateLimitRuleResource[];
  /** Account/zone toggles: Bot Fight Mode off, Always Online off (R45.18, design 992). */
  readonly settings: readonly ZoneSetting[];
  readonly workerCustomDomains: readonly WorkerCustomDomainResource[];
}

/** The full resource set for a single environment. */
export interface EnvironmentResources {
  readonly environment: EnvironmentName;
  readonly d1Databases: readonly D1DatabaseResource[];
  readonly r2Buckets: readonly R2BucketResource[];
  readonly zone: ZoneResources;
  readonly accessApplications: readonly AccessApplicationResource[];
  readonly turnstileWidgets: readonly TurnstileWidgetResource[];
}

export type CloudflareResourcePlan = Readonly<Record<EnvironmentName, EnvironmentResources>>;

/** Deep-freeze helper so the exported plan is immutable at runtime, not merely `readonly` in types. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

// Hostnames and origins, taken from the wrangler configs and design "Hosts" table.
const PROD = {
  zone: 'researchforce.org',
  apex: 'researchforce.org',
  workspaceHost: 'app.researchforce.org',
  workspaceOrigin: 'https://app.researchforce.org',
  apexOrigin: 'https://researchforce.org',
  submitHost: 'submit.researchforce.org',
  downloadHost: 'dl.researchforce.org',
  filesHost: 'files.researchforce.org',
  wwwHost: 'www.researchforce.org',
  suffix: '',
} as const;
const STAGING = {
  zone: 'researchforce.org',
  apex: 'researchforce.org',
  // Staging hostnames as found in apps/app/wrangler.jsonc (staging env).
  workspaceHost: 'staging.researchforce.org',
  workspaceOrigin: 'https://staging.researchforce.org',
  apexOrigin: 'https://researchforce.org',
  submitHost: 'submit-staging.researchforce.org',
  downloadHost: 'dl-staging.researchforce.org',
  filesHost: 'files-staging.researchforce.org',
  wwwHost: 'www-staging.researchforce.org',
  suffix: '-staging',
} as const;

function environment(name: EnvironmentName, host: typeof PROD | typeof STAGING): EnvironmentResources {
  const s = host.suffix;
  return {
    environment: name,
    // D1 databases — bindings and names from apps/app/wrangler.jsonc (R1.1). IDs stay unencoded.
    d1Databases: [
      { kind: 'd1_database', name: `rf-core${s}`, binding: 'RF_CORE' },
      { kind: 'd1_database', name: `rf-search${s}`, binding: 'RF_SEARCH' },
      { kind: 'd1_database', name: `rf-public${s}`, binding: 'RF_PUBLIC' },
    ],
    r2Buckets: [
      {
        // Private upload bucket: no public access, no r2.dev, no custom domain (design 1301, 513; R25.2).
        kind: 'r2_bucket',
        name: `rf-private${s}`,
        binding: ['RF_PRIVATE_BUCKET'],
        publicDevAccess: false,
        // CORS: PUT from the Workspace and apex origins with the checksum headers (design 1301, 478).
        cors: [
          {
            allowedMethods: ['PUT'],
            allowedOrigins: [host.workspaceOrigin, host.apexOrigin],
            allowedHeaders: ['content-length', 'x-amz-checksum-sha256', 'if-none-match'],
            exposeHeaders: ['ETag'],
            maxAgeSeconds: 3600,
          },
        ],
        // Abort incomplete multipart uploads after one day (design 483, 1301).
        lifecycleRules: [{ id: 'abort-incomplete-multipart', abortIncompleteMultipartUploadDays: 1 }],
      },
      {
        // Public copies bucket: r2.dev off, served through files.researchforce.org (design 127, 517, 1298).
        kind: 'r2_bucket',
        name: `rf-public${s}`,
        binding: ['RF_PUBLIC_BUCKET'],
        publicDevAccess: false,
        customDomain: host.filesHost,
      },
    ],
    zone: {
      zone: host.zone,
      redirects: [
        {
          // www → apex permanent redirect (design 126).
          kind: 'redirect_rule',
          name: `www-to-apex${s}`,
          fromHost: host.wwwHost,
          toHost: host.apex,
          statusCode: 301,
          preservePathAndQuery: true,
        },
      ],
      cacheRules: [
        {
          // Bypass cache on the files host so a deleted public copy outlives nothing (design 127, 139, R25.3).
          kind: 'cache_rule',
          name: `files-bypass-cache${s}`,
          host: host.filesHost,
          cache: 'bypass',
        },
      ],
      responseHeaderRules: [
        {
          // Confine public files to a sandbox and forbid MIME sniffing (design 127, R25.3).
          kind: 'response_header_rule',
          name: `files-response-headers${s}`,
          host: host.filesHost,
          setHeaders: {
            'Content-Security-Policy': 'sandbox',
            'X-Content-Type-Options': 'nosniff',
          },
        },
      ],
      wafBlockRules: [
        {
          // The Public_Traffic_Budget block rule for submit, encoded DISABLED; rf-ops toggles it (design 128, 141).
          kind: 'waf_block_rule',
          name: `submit-public-traffic-budget${s}`,
          host: host.submitHost,
          enabled: false,
          action: 'block',
          description: 'Public_Traffic_Budget block rule for submit; toggled by rf-ops, provisioned disabled.',
        },
      ],
      rateLimitRules: [
        {
          // One rate-limit rule shared by submit and dl (design 128–130, 141; R28.5).
          kind: 'rate_limit_rule',
          name: `submit-dl-rate-limit${s}`,
          hosts: [host.submitHost, host.downloadHost],
          requestsPerPeriod: 60,
          periodSeconds: 60,
          action: 'block',
          mitigationTimeoutSeconds: 60,
        },
      ],
      settings: [
        // Bot Fight Mode and Always Online never run on the apex (design 992; R45.18).
        { kind: 'zone_setting', setting: 'bot_fight_mode', value: 'off' },
        { kind: 'zone_setting', setting: 'always_online', value: 'off' },
      ],
      workerCustomDomains: [
        // rf-app, rf-submit and rf-dl have public custom domains; rf-ops has no route (design 128–131).
        { kind: 'worker_custom_domain', service: `rf-app${s}`, hostname: host.workspaceHost },
        { kind: 'worker_custom_domain', service: `rf-submit${s}`, hostname: host.submitHost },
        { kind: 'worker_custom_domain', service: `rf-dl${s}`, hostname: host.downloadHost },
      ],
    },
    accessApplications: [
      {
        // One Access application over the Workspace host (design 129, 317, 319–320; R1.1/R1.3).
        kind: 'access_application',
        name: `research-force-workspace${s}`,
        host: host.workspaceHost,
        sessionDuration: '24h',
        cookie: { httpOnly: true, sameSite: 'lax', enableBindingCookie: true },
        identityProviders: [
          { type: 'onetimepin', name: 'One-time PIN' },
          { type: 'google', name: 'Google' },
          { type: 'github', name: 'GitHub' },
        ],
        list: { kind: 'access_list', name: `rf-members${s}`, listType: 'email' },
        policy: { name: `allow-rf-members${s}`, decision: 'allow', includeList: `rf-members${s}` },
      },
    ],
    turnstileWidgets: [
      {
        // Managed-mode widget for the submit/consent forms (design 985; R31.3).
        kind: 'turnstile_widget',
        name: `rf-submit-turnstile${s}`,
        mode: 'managed',
        hostnames: [host.submitHost, host.apex],
      },
    ],
  };
}

export const cloudflareResources: CloudflareResourcePlan = deepFreeze({
  production: environment('production', PROD),
  staging: environment('staging', STAGING),
});
