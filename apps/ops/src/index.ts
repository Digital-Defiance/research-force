import { WorkerEntrypoint } from 'cloudflare:workers';
import type {
  BackupAgeAlert,
  ConfidentialityIncident,
  ContainmentCapabilities,
  ContainmentState,
  HealthReport,
  OpsAccess,
  OpsBackupAlert,
  OpsContainment,
  OpsDeploy,
  OpsDeployResult,
  OpsAnalytics,
  OpsHealthAlert,
  OpsSpendAlert,
  OpsWaf,
  SpendAlert,
  UsageSnapshot,
  UsageWindow,
} from '@researchforce/domain/ops';
import type { Timestamp } from '@researchforce/domain/types';
import { AccessSync } from './access';
import { Analytics } from './analytics';
import { type MonitoredEndpoint, OperationalAlerts } from './alerts';
import { Containment } from './containment';
import { type AssetBody, SiteDeploy } from './deploy';
import { Waf } from './waf';

export interface OpsEnv {
  CF_ACCOUNT_ID: string;
  ACCESS_MEMBER_LIST_ID: string;
  /** Secret. */
  CF_ACCESS_API_TOKEN: string;

  // --- Platform usage analytics for the usage-alert check (task 44.1, R19.10). rf-ops is the SOLE holder of
  //     this account-scoped analytics-read token; rf-app's usage alerts (task 44.2) reach `usage()` over the
  //     OPS binding rather than holding the token themselves.
  /** Secret. An Account Analytics Read API token scoped to CF_ACCOUNT_ID only, for the GraphQL Analytics API. */
  CF_ANALYTICS_API_TOKEN: string;

  // --- rf-site assets-only deploy through the Direct Upload API (task 32.1, R24.7, R24.16, R24.17, R60.2) ---
  /** The `rf-site` script/dispatch name the assets-upload-session and version/deploy endpoints address. */
  CF_SITE_SCRIPT_NAME: string;
  /** Secret. The Workers deploy API token scoped to `rf-site` on this account only. */
  CF_SITE_DEPLOY_API_TOKEN: string;
  /** The `rf-core` D1 database, for the durable `external_operations` record and the publication epoch. */
  RF_CORE: D1Database;

  // --- Edge Containment on the public research hosts (task 59.2, R24.16, R24.17, R60.4, R60.6) ---
  /** The zone that serves the public research hosts. */
  CF_PUBLIC_ZONE_ID: string;
  /** The app host, which Containment must never deny (kept available while the public hosts are denied). */
  APP_HOST: string;
  /** The WAF ruleset id the precreated public-host deny rules live in. */
  CF_PUBLIC_DENY_RULESET_ID: string;
  /** Comma-separated ids of the PRECREATED public-host deny rules Containment enables/disables. */
  CF_PUBLIC_DENY_RULE_IDS: string;
  /** A public research address an out-of-band probe HEADs to confirm a denial is actually serving. */
  CONTAINMENT_PROBE_URL: string;
  /** Whether the configured plan can carry WAF custom deny rules at all (false blocks public launch, R60.4). */
  PLAN_CAN_DENY: string;
  /** The independent alert channel endpoint (a provider distinct from the app and its email queue, R28.6). */
  INCIDENT_ALERT_WEBHOOK_URL: string;
  /**
   * Secret. An independently recoverable API token scoped to the public-host zone's WAF only, held in a
   * separate credential store from CF_ACCESS_API_TOKEN so Containment stays operable if the primary account
   * is locked (R60.6).
   */
  CONTAINMENT_API_TOKEN: string;
  /** Secret. The bearer credential for the independent alert channel. */
  INCIDENT_ALERT_TOKEN: string;

  // --- Independent health + spend alerts (task 67.2, R28.4, R60.6). Delivered over the SAME independent alert
  //     channel as the incident/backup-age alerts (INCIDENT_ALERT_WEBHOOK_URL + INCIDENT_ALERT_TOKEN), so they
  //     stay operable without rf-core D1 and the Graph email queue. Setup is an explicit operator action.
  /**
   * Comma-separated `name=url` pairs the independent health check HEADs out-of-band to certify ACTUAL
   * endpoint reachability (e.g. `app=https://app.researchforce.org/,public=https://researchforce.org/`).
   * Empty means health cannot be certified and `certifyHealth` reports `degraded`.
   */
  HEALTH_CHECK_ENDPOINTS: string;

  // --- Public submit-host WAF budget shed (task 34.2, R28.5, R28.6). Ordinary edge shedding, NOT Containment:
  //     its own zone/ruleset/rule id and its own WAF token, never the independently-vaulted Containment token.
  /** The zone that serves the public submit host `submit.researchforce.org`. */
  CF_SUBMIT_ZONE_ID: string;
  /** The WAF ruleset id the precreated submit-block rule lives in. */
  CF_SUBMIT_BLOCK_RULESET_ID: string;
  /** The id of the PRECREATED submit-block WAF custom rule `setSubmitBlock` enables/disables (never creates). */
  CF_SUBMIT_BLOCK_RULE_ID: string;
  /** Secret. An API token scoped to the submit host zone's WAF only, for toggling the precreated block rule. */
  CF_SUBMIT_WAF_API_TOKEN: string;
}

/** Parse the `name=url,name=url` health-endpoint config into monitored endpoints, dropping malformed pairs. */
function parseEndpoints(raw: string): MonitoredEndpoint[] {
  return (raw ?? '')
    .split(',')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .flatMap((pair) => {
      const index = pair.indexOf('=');
      if (index <= 0) return [];
      const name = pair.slice(0, index).trim();
      const url = pair.slice(index + 1).trim();
      return name && url ? [{ name, url }] : [];
    });
}

/**
 * Reachable only through service bindings: no route, no custom domain and workers.dev is off.
 * Cloudflare rejects a Worker with no registered handler (error 10068), so `fetch` exists only to
 * answer 404 to anything that could ever reach it; it never serves content.
 */
export default class Ops extends WorkerEntrypoint<OpsEnv> implements OpsAccess, OpsAnalytics, OpsContainment, OpsBackupAlert, OpsHealthAlert, OpsSpendAlert, OpsDeploy, OpsWaf {
  override fetch(): Response {
    return new Response('Not found', { status: 404 });
  }


  #access(): AccessSync {
    return new AccessSync({ accountId: this.env.CF_ACCOUNT_ID, memberListId: this.env.ACCESS_MEMBER_LIST_ID, apiToken: this.env.CF_ACCESS_API_TOKEN });
  }

  #analytics(): Analytics {
    return new Analytics({ accountId: this.env.CF_ACCOUNT_ID, apiToken: this.env.CF_ANALYTICS_API_TOKEN });
  }

  #deploy(): SiteDeploy {
    return new SiteDeploy(
      { accountId: this.env.CF_ACCOUNT_ID, scriptName: this.env.CF_SITE_SCRIPT_NAME, apiToken: this.env.CF_SITE_DEPLOY_API_TOKEN },
      this.env.RF_CORE,
    );
  }

  #containment(): Containment {
    return new Containment({
      publicZoneId: this.env.CF_PUBLIC_ZONE_ID,
      appHost: this.env.APP_HOST,
      denyRulesetId: this.env.CF_PUBLIC_DENY_RULESET_ID,
      publicDenyRuleIds: (this.env.CF_PUBLIC_DENY_RULE_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean),
      probeUrl: this.env.CONTAINMENT_PROBE_URL,
      containmentApiToken: this.env.CONTAINMENT_API_TOKEN,
      alertWebhookUrl: this.env.INCIDENT_ALERT_WEBHOOK_URL,
      alertToken: this.env.INCIDENT_ALERT_TOKEN,
      planCanDeny: this.env.PLAN_CAN_DENY === 'true',
    });
  }

  #alerts(): OperationalAlerts {
    // The health check certifies ACTUAL control availability by reading the live Containment capability
    // (`canDeny`), never a stored flag; both share the one independent alert channel (R60.6).
    const containment = this.#containment();
    return new OperationalAlerts(
      {
        alertWebhookUrl: this.env.INCIDENT_ALERT_WEBHOOK_URL,
        alertToken: this.env.INCIDENT_ALERT_TOKEN,
        monitoredEndpoints: parseEndpoints(this.env.HEALTH_CHECK_ENDPOINTS),
      },
      async () => (await containment.containmentCapabilities()).canDeny,
    );
  }

  #waf(): Waf {
    return new Waf({
      submitZoneId: this.env.CF_SUBMIT_ZONE_ID,
      submitBlockRulesetId: this.env.CF_SUBMIT_BLOCK_RULESET_ID,
      submitBlockRuleId: this.env.CF_SUBMIT_BLOCK_RULE_ID,
      apiToken: this.env.CF_SUBMIT_WAF_API_TOKEN,
    });
  }

  async addMember(email: string): Promise<void> { await this.#access().addMember(email); }
  async removeMember(email: string): Promise<void> { await this.#access().removeMember(email); }
  async revokeSessions(email: string): Promise<void> { await this.#access().revokeSessions(email); }

  // Platform usage from the Cloudflare GraphQL Analytics API (task 44.1, R19.10): rf-ops holds the
  // analytics-read token; rf-app's usage alerts (task 44.2) read this over the OPS binding.
  async usage(window: UsageWindow): Promise<UsageSnapshot> { return this.#analytics().usage(window); }

  async containmentCapabilities(): Promise<ContainmentCapabilities> { return this.#containment().containmentCapabilities(); }
  async containPublicHosts(): Promise<void> { await this.#containment().containPublicHosts(); }
  async releaseContainment(authorizedGeneration: string): Promise<void> { await this.#containment().releaseContainment(authorizedGeneration); }
  async verifyContainment(): Promise<ContainmentState> { return this.#containment().verifyContainment(); }
  async probePublicAddress(url: string): Promise<'present' | 'absent' | 'unknown'> { return this.#containment().probePublicAddress(url); }
  async declareIncident(incident: ConfidentialityIncident): Promise<void> { await this.#containment().declareIncident(incident); }
  async backupAgeAlert(alert: BackupAgeAlert): Promise<void> { await this.#containment().backupAgeAlert(alert); }

  // Independent health + spend alerts (task 67.2, R28.4, R60.6): provider-native/independent external checks
  // delivered over the operator-controlled independent channel, operable without rf-core D1 and the Graph queue.
  async certifyHealth(): Promise<HealthReport> { return this.#alerts().certifyHealth(); }
  async spendAlert(alert: SpendAlert): Promise<void> { await this.#alerts().spendAlert(alert); }

  // Public submit-host WAF budget shed (task 34.2, R28.5, R28.6): the `Budget` DO (34.1) flips this on at the
  // Public_Traffic_Budget-minus-margin threshold and off at the 00:00 UTC reset.
  async setSubmitBlock(enabled: boolean): Promise<void> { await this.#waf().setSubmitBlock(enabled); }

  async deploySite(input: Parameters<OpsDeploy['deploySite']>[0]): Promise<OpsDeployResult> {
    // The 32.5 caller passes the bytes of only the missing files keyed by hash; adapt them to the AssetSource.
    const missing: Record<string, AssetBody> = { ...input.missing };
    return this.#deploy().deploySite({
      manifest: input.manifest,
      generation: { run: input.run, epoch: input.epoch },
      operationId: input.operationId,
      assets: async (hash) => missing[hash] ?? null,
      containmentActive: input.containmentActive,
      now: new Date().toISOString() as Timestamp,
    });
  }
}
