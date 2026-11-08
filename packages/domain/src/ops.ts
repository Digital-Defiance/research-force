/**
 * The narrow RPC surface of `rf-ops` that `rf-app` uses for Access (design "Access configuration").
 * Each method throws when Cloudflare refuses or cannot be reached.
 */
export interface OpsAccess {
  /** Add the address to the `rf-members` Access list, so Access lets the person sign in. */
  addMember(email: string): Promise<void>;
  /** Remove the address from the `rf-members` Access list. */
  removeMember(email: string): Promise<void>;
  /** End every Access session of the address in every application. */
  revokeSessions(email: string): Promise<void>;
}

/**
 * The narrow RPC surface of `rf-ops` for reading platform usage from the Cloudflare GraphQL Analytics API
 * (task 44.1, R19.10). `rf-ops` is the SOLE holder of the account-scoped analytics-read token, exactly as it
 * is the sole holder of the Access, deploy, WAF, and Containment tokens; `rf-app`'s usage-alert check (task
 * 44.2, `apps/app/src/usage/alerts.ts`) reaches this over the OPS service binding rather than holding the
 * analytics token itself. Like {@link OpsAccess}, the method throws when Cloudflare refuses, the GraphQL
 * response carries `errors`, or the API cannot be reached; it throws a clear "not configured" error when the
 * account id or analytics token is missing. The returned snapshot is metered counts only, never any research
 * content.
 */
export interface OpsAnalytics {
  /**
   * Read a usage snapshot over the half-open window `[from, to)` (ISO-8601 timestamps): Worker requests, D1
   * rows read/written and storage PER DATABASE, R2 storage and Class A / Class B operations, and Workers AI
   * Neurons. The parse is defensive — a missing or empty analytics node reads as zero/empty rather than
   * throwing — so a dataset with no activity in the window reports zero and never a gap.
   */
  usage(window: UsageWindow): Promise<UsageSnapshot>;
}

/** The half-open time window `[from, to)` a usage read aggregates over, as ISO-8601 timestamps (R19.10). */
export interface UsageWindow {
  /** Inclusive start of the window, an ISO-8601 timestamp (e.g. the UTC day start for a daily allowance). */
  readonly from: string;
  /** Exclusive end of the window, an ISO-8601 timestamp (e.g. the current instant). */
  readonly to: string;
}

/** D1 rows read/written and current storage for a single database, keyed by its id/name (R19.10). */
export interface D1DatabaseUsage {
  /** The Cloudflare database id (`databaseId`) the analytics node is keyed by. */
  readonly databaseId: string;
  /** The D1 rows read in the window, summed across the database's analytics groups. */
  readonly rowsRead: number;
  /** The D1 rows written in the window, summed across the database's analytics groups. */
  readonly rowsWritten: number;
  /** The database's most recent reported stored bytes in the window (the latest storage sample, not a sum). */
  readonly storedBytes: number;
}

/** R2 operations split by billing class: Class A (mutating/list) and Class B (read) (R19.10). */
export interface R2OperationsUsage {
  /** Class A operations (writes, lists, and other mutating calls) in the window. */
  readonly classA: number;
  /** Class B operations (reads) in the window. */
  readonly classB: number;
}

/**
 * A content-free platform usage snapshot read from the Cloudflare GraphQL Analytics API (task 44.1, R19.10),
 * the input the usage-alert state machine (task 44.2) checks against the free-plan allowances. Every field is
 * a metered count or byte total — never any research content.
 */
export interface UsageSnapshot {
  /** The window this snapshot aggregates over, echoed back from the request. */
  readonly window: UsageWindow;
  /** Total Worker requests (invocations) across the account in the window. */
  readonly workerRequests: number;
  /** D1 rows read/written and storage PER DATABASE, keyed by database id, in a stable (id-sorted) order. */
  readonly d1: readonly D1DatabaseUsage[];
  /** R2 current stored bytes: the latest storage sample in the window across the account's buckets. */
  readonly r2StoredBytes: number;
  /** R2 operations in the window, split into Class A and Class B. */
  readonly r2Operations: R2OperationsUsage;
  /** Workers AI Neurons consumed in the window (the unit Cloudflare meters Workers AI usage in). */
  readonly aiNeurons: number;
}

/**
 * Whether the configured platform plan can actually deny traffic on the public research hosts. The Publisher
 * relies on precreated edge Containment as the fallback when a removal is not verified in time (design
 * "Publisher" step 7, R24.16); if the plan cannot carry the required deny rules this is a public-launch
 * blocker, not a runtime surprise (R60.4). `verifiable` is whether an out-of-band probe can confirm a denial
 * is in force, which the five-minute verification step needs (R24.16).
 */
export interface ContainmentCapabilities {
  /** Whether the plan can enable the precreated deny rule(s) that block the public research hosts. */
  readonly canDeny: boolean;
  /** Whether an out-of-band probe can verify a denial is actually in force. */
  readonly verifiable: boolean;
  /** Whether an independent alert channel is configured, so an incident can be declared off the primary path. */
  readonly canAlert: boolean;
  /** When `canDeny` is false, the plan-level reason, so the launch gate can report why Containment is unavailable. */
  readonly blockingReason: string | null;
}

/**
 * The state of edge Containment on the public research hosts, as a fresh out-of-band read reports it. The app
 * host is never part of Containment: Containment denies the public research hosts only, leaving the app
 * reachable (R24.16).
 */
export interface ContainmentState {
  /** Whether the precreated public-host deny rule(s) are currently enabled. */
  readonly active: boolean;
  /** Whether an out-of-band probe confirmed the denial is actually serving (not just configured). */
  readonly verified: boolean;
}

/**
 * The narrow RPC surface of `rf-ops` for edge Containment, health probing, and incident alerting that the
 * Publisher (tasks 32.1 to 32.5) drives when an urgent removal is not verified in time (design "Publisher"
 * step 7, R24.16, R24.17). Like {@link OpsAccess}, every method throws when Cloudflare refuses or cannot be
 * reached. This surface is deliberately asymmetric: Containment can be ENABLED freely (confidentiality must
 * always be allowed to proceed), but it can only be CLEARED by presenting the authorized new generation that
 * supersedes the removal — a plain reset or retry cannot clear active Containment (R24.17, R60.6).
 */
export interface OpsContainment {
  /** Report whether the configured plan can actually deny and verify on the public research hosts (R24.16, R60.4). */
  containmentCapabilities(): Promise<ContainmentCapabilities>;
  /**
   * Enable the precreated public-host deny rule(s), denying the public research hosts while leaving the app
   * host available (R24.16). Idempotent: enabling an already-enabled rule is not an error. This is the
   * four-minute fallback; it never touches the app host.
   */
  containPublicHosts(): Promise<void>;
  /**
   * Clear Containment, but only under an authorized new generation. `authorizedGeneration` is the run id of
   * the latest authorized Publisher generation that has verified the real public state; a reset/retry has no
   * such token and so cannot clear Containment (R24.17). Throws when the token is missing or not the current
   * authorized generation.
   */
  releaseContainment(authorizedGeneration: string): Promise<void>;
  /** Out-of-band read of whether Containment is enabled and actually serving on the public research hosts (R24.16). */
  verifyContainment(): Promise<ContainmentState>;
  /**
   * Out-of-band HEAD probe of a public address, independent of the primary app's health, returning whether
   * the address is served ("present"), not found ("absent"), or unreachable ("unknown"). Used to verify a
   * removal took effect (design "Publisher" step 7).
   */
  probePublicAddress(url: string): Promise<'present' | 'absent' | 'unknown'>;
  /**
   * {@link probePublicAddress} for up to `PROBE_BATCH_MAX` (25) addresses in one call (one RPC, one outbound HEAD per
   * address, six at a time), so the Publisher's sliced verify phase stays inside the Free plan's subrequest limits.
   * Each address gets exactly the status the single probe would give it. More than the batch maximum is a RangeError.
   */
  probePublicAddresses(urls: readonly string[]): Promise<Readonly<Record<string, 'present' | 'absent' | 'unknown'>>>;
  /**
   * Declare a confidentiality incident through the independently operated alert channel, recording the last
   * verified public state and the failed actions (R24.17, R60.6). Never asserts success; it is only called
   * when neither removal nor Containment could be confirmed. The payload carries no research body, only the
   * operation identities and states (R28.6, R60.6).
   */
  declareIncident(incident: ConfidentialityIncident): Promise<void>;
}

/**
 * The narrow RPC surface of `rf-ops` for the INDEPENDENT backup-age / RPO alert (task 58.2, R36.7, R28.4, R60.6;
 * design "Internal_Backup and independent recovery": "it warns at 18 hours and declares an RPO breach at 24 hours").
 * The backup RPO check (`apps/app/src/backup/rpo.ts`), run from the cron, calls this so the warning/breach reaches an
 * out-of-band channel operable without the application D1 and its email queue (R60.6) — not only an in-app notice.
 * Like {@link OpsContainment}, the method throws when the independent channel refuses or cannot be reached. The
 * payload is content-free: it names the age and threshold only, never a research body, bearer link, or recovery
 * secret (R28.6, R60.6).
 */
export interface OpsBackupAlert {
  /**
   * Declare a backup-age alert on the independent channel: a `warning` when the latest verified independent recovery
   * point is older than the 18-hour warning threshold, a `breach` when older than the 24-hour RPO objective, repeated
   * daily until resolved (R36.7). `cleared` withdraws a prior alert once a fresh verified point restores the RPO. The
   * payload is content-free; `ageHours` and `thresholdHours` are rounded ages, never any research content.
   */
  backupAgeAlert(alert: BackupAgeAlert): Promise<void>;
}

/** The content-free backup-age alert sent to the independent channel (R36.7, R60.6): ages and state only, no content. */
export interface BackupAgeAlert {
  /** The alert level: a crossed 18-hour warning, a crossed 24-hour RPO breach, or a withdrawal once resolved. */
  readonly level: 'warning' | 'breach' | 'cleared';
  /** The age in whole hours of the latest verified independent recovery point, or null when none has ever verified. */
  readonly ageHours: number | null;
  /** The threshold in whole hours this alert level crosses (18 for a warning, 24 for a breach). */
  readonly thresholdHours: number;
}

/**
 * The narrow RPC surface of `rf-ops` for the INDEPENDENT health / availability alert (task 67.2, R60.6; design
 * "Release assurance, maintenance, and independent operations": `infra/ops/` configures provider-native or
 * independent external health checks whose delivery does not need `rf-core` or the Graph queue).
 *
 * This is a PROVIDER-NATIVE / INDEPENDENT external check: {@link OpsHealthAlert.certifyHealth} does not read a
 * stored health flag — it HEADs the configured public/app endpoints out-of-band and reads the live Containment
 * capability, then declares the result on the independent channel. It is therefore operable, and meaningful,
 * even when the application D1 and its email queue are down (R60.6). Like {@link OpsContainment}, the method
 * throws only when the independent channel itself refuses or cannot be reached; an unreachable *monitored*
 * endpoint is a finding reported in the alert, not a throw. The payload is content-free: endpoint identities
 * and reachability states only, never a research body, bearer link, or recovery secret (R28.6, R60.6).
 */
export interface OpsHealthAlert {
  /**
   * Run the independent external health check and declare the result on the independent channel. Certifies
   * ACTUAL availability: each monitored endpoint is probed out-of-band and the Containment control path is
   * read live, so a `down`/`degraded` result reflects real reachability, not a stored flag. Returns the
   * certified report (also sent on the channel). Throws only when the independent channel refuses or is
   * unreachable.
   */
  certifyHealth(): Promise<HealthReport>;
}

/** The reachability of a single monitored endpoint, as a fresh out-of-band HEAD reports it (R60.6). */
export interface EndpointHealth {
  /** A stable, content-free label for the endpoint (e.g. `app`, `public`), never a bearer link. */
  readonly name: string;
  /** Whether the endpoint answered a HEAD within the probe: served, denied (reachable but blocked), or unreachable. */
  readonly state: 'up' | 'denied' | 'unreachable';
}

/**
 * The content-free health report sent to the independent channel (R60.6): endpoint identities, reachability
 * states, and whether the confidentiality-control path is actually available — never any research content,
 * bearer link, or recovery secret. `controlAvailable` is read live from the Containment capability, so it
 * certifies that denial can really be applied, not that a flag is set.
 */
export interface HealthReport {
  /** The overall level: `ok` when every endpoint is reachable and control is available, else `degraded`/`down`. */
  readonly level: 'ok' | 'degraded' | 'down';
  /** The per-endpoint reachability, as freshly probed. */
  readonly endpoints: readonly EndpointHealth[];
  /** Whether the confidentiality-denial control path is actually available right now (live, not a stored flag). */
  readonly controlAvailable: boolean;
}

/**
 * The narrow RPC surface of `rf-ops` for the INDEPENDENT spend / budget alert (task 67.2, R28.4, R60.6; design
 * "Capacity, cost, and public abuse budgets": alerts at 80% remain and the operator sees normal spend targets,
 * independent backup costs, and projected overrun). The `Budget` Durable Object and the spend forecaster call
 * this so a budget warning/breach reaches an out-of-band channel operable without the application D1 and its
 * email queue (R60.6). Like {@link OpsBackupAlert}, the method throws when the independent channel refuses or
 * cannot be reached; the payload is content-free — percentages and whole-currency amounts only, never a
 * research body, bearer link, or recovery secret (R28.6, R60.6).
 */
export interface OpsSpendAlert {
  /**
   * Declare a spend/budget alert on the independent channel: a `warning` at the 80% approach threshold, a
   * `breach` once the operator-approved budget or a provider daily quota is exceeded, and `cleared` to
   * withdraw a prior alert once spend falls back within budget (R28.4). The payload is content-free:
   * identities, percentages, and whole-currency amounts only.
   */
  spendAlert(alert: SpendAlert): Promise<void>;
}

/** The content-free spend/budget alert sent to the independent channel (R28.4, R60.6): amounts and states only. */
export interface SpendAlert {
  /** The alert level: an 80% approach warning, an over-budget/quota breach, or a withdrawal once back within budget. */
  readonly level: 'warning' | 'breach' | 'cleared';
  /** A stable, content-free label for what is being metered (e.g. `monthly_spend`, `workers_daily`, `d1_rows`). */
  readonly meter: string;
  /** The measured usage as a whole percentage of the operator-approved budget or provider daily quota. */
  readonly usagePercent: number;
  /**
   * The budget this alert is measured against, in whole units of its {@link SpendAlert.currency} (USD cents or
   * a provider daily count), so the operator can read the headroom without any research content. Null when the
   * meter is a pure percentage with no fixed amount.
   */
  readonly budgetAmount: number | null;
  /** The unit of {@link SpendAlert.budgetAmount}: `usd_cents` for monetary budgets, `count` for quota counts. */
  readonly currency: 'usd_cents' | 'count';
}

/**
 * The content-free record of a confidentiality incident sent to the independent alert channel. It names what
 * failed and the last verified public state, never any research body, bearer link, or recovery secret (R28.6,
 * R60.6).
 */
export interface ConfidentialityIncident {
  /** The Publisher generation that was attempting the removal. */
  readonly generation: string;
  /** The epoch under which the removal was authorized. */
  readonly epoch: number;
  /** The public addresses whose removal could not be confirmed. */
  readonly unverifiedTargets: readonly string[];
  /** Which control paths failed: removal verification, Containment, or both. */
  readonly failedActions: readonly ('removal' | 'containment')[];
  /** A short, content-free description of the last public state actually verified. */
  readonly lastVerifiedState: string;
}

/**
 * The narrow RPC surface of `rf-ops` for the single precreated WAF custom rule that blocks
 * `submit.researchforce.org` when the Public_Traffic_Budget is reached (task 34.1/34.2, design "Capacity,
 * cost, and public abuse budgets", R28.5, R28.6, R28.11). The `Budget` Durable Object (task 34.1) calls this
 * when a public counter crosses the Public_Traffic_Budget-minus-2%-margin threshold, and again at the 00:00
 * UTC reset to lift it. Like {@link OpsAccess}, the method throws when Cloudflare refuses or cannot be
 * reached. This is ordinary edge shedding, NOT confidentiality Containment ({@link OpsContainment}): it only
 * turns the optional, invocation-costing public submit API on or off; it never denies the static public
 * research hosts, their stored pages, file copies, or static search.
 */
export interface OpsWaf {
  /**
   * Enable (`true`) or disable (`false`) the precreated WAF custom rule that blocks the public submit host.
   * Idempotent: toggling the rule to the state it already holds is not an error. 34.2 implements the rf-ops
   * side (`apps/ops/src/waf.ts`); 34.1 only calls this.
   */
  setSubmitBlock(enabled: boolean): Promise<void>;
}

/**
 * The narrow RPC surface of `rf-ops` for deploying the assets-only `rf-site` Worker through the Cloudflare
 * Workers Static Assets Direct Upload API, under the serialized publication-epoch fence (task 32.1, design
 * "Public pages" + "Workers Static Assets", R24.7, R24.11, R24.12, R24.16, R24.17, R28.6, R60.2). `rf-site`
 * is deployed ONLY by the Publisher through rf-ops. rf-ops serializes promotion and rechecks the authoritative
 * publication epoch immediately before AND after it; a stale or raced promotion does not stand and any
 * independent containment stays in force — an obsolete operation can never reopen a contained host. For an
 * ambiguous answer the operation identity, exact version/manifest, and verified status are recorded so a later
 * reconciliation against actual provider state decides before any retry; rf-ops never blind-retries.
 */
export interface OpsDeploy {
  /**
   * Stepped deploy, step 1 (one platform fetch): record the epoch-labelled operation and register the manifest.
   * Answers `upload` (one-hour upload token + the platform's missing-hash buckets), `ready` (nothing to upload),
   * or `settled` when the operation already confirmed or is uncertain (never redone blindly).
   */
  beginSiteDeploy(input: {
    readonly manifest: Readonly<Record<string, { readonly hash: string; readonly size: number }>>;
    readonly run: string;
    readonly epoch: number;
    readonly operationId: string;
    readonly containmentActive: boolean;
  }): Promise<OpsDeployBegin>;
  /** Stepped deploy, step 2 (one multipart fetch): upload 1 to 100 files. `completionToken` is set once the platform issues it. */
  uploadSiteAssets(input: {
    readonly uploadToken: string;
    readonly files: Readonly<Record<string, { readonly base64: string; readonly contentType: string }>>;
  }): Promise<{ readonly completionToken: string | null }>;
  /** Stepped deploy, step 3 (two platform fetches): create the version, fence, promote, fence, settle. */
  finishSiteDeploy(input: {
    readonly run: string;
    readonly epoch: number;
    readonly operationId: string;
    readonly completionToken: string;
    readonly containmentActive: boolean;
  }): Promise<OpsDeployResult>;
}

/** The answer of the first stepped-deploy call. */
export type OpsDeployBegin =
  | { readonly state: 'upload'; readonly uploadToken: string; readonly buckets: readonly (readonly string[])[] }
  | { readonly state: 'ready'; readonly completionToken: string }
  | { readonly state: 'settled'; readonly result: OpsDeployResult };

/** The content-free result of an `rf-site` deploy attempt (R28.6): identities and states only, no research body. */
export interface OpsDeployResult {
  /** Whether the version was promoted to 100% and stands. False means stale/raced/uncertain or a refusal. */
  readonly promoted: boolean;
  /** Whether containment must remain in force after this operation. Never cleared on a stale/raced deploy. */
  readonly keepContainment: boolean;
  /** The created Worker version id, once the platform returned one (recorded even when not promoted). */
  readonly versionId: string | null;
  /** The durable operation identity this deploy ran under. */
  readonly operationId: string;
  /** The settled durable state: `confirmed`, `failed`, or `uncertain`. */
  readonly operationState: 'confirmed' | 'failed' | 'uncertain';
  /** Why the deploy ended the way it did. */
  readonly reason: 'promoted' | 'stale_before' | 'raced_after' | 'uncertain' | 'created_not_promoted';
}
