import { WorkerEntrypoint } from 'cloudflare:workers';
import type {
  ConfidentialityIncident,
  ContainmentCapabilities,
  ContainmentState,
  OpsAccess,
  OpsContainment,
  OpsDeploy,
  OpsDeployResult,
  OpsWaf,
} from '@researchforce/domain/ops';
import type { Timestamp } from '@researchforce/domain/types';
import { AccessSync } from './access';
import { Containment } from './containment';
import { type AssetBody, SiteDeploy } from './deploy';
import { Waf } from './waf';

export interface OpsEnv {
  CF_ACCOUNT_ID: string;
  ACCESS_MEMBER_LIST_ID: string;
  /** Secret. */
  CF_ACCESS_API_TOKEN: string;

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

/** Reachable only through service bindings: no fetch handler and no route. */
export default class Ops extends WorkerEntrypoint<OpsEnv> implements OpsAccess, OpsContainment, OpsDeploy, OpsWaf {
  #access(): AccessSync {
    return new AccessSync({ accountId: this.env.CF_ACCOUNT_ID, memberListId: this.env.ACCESS_MEMBER_LIST_ID, apiToken: this.env.CF_ACCESS_API_TOKEN });
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

  async containmentCapabilities(): Promise<ContainmentCapabilities> { return this.#containment().containmentCapabilities(); }
  async containPublicHosts(): Promise<void> { await this.#containment().containPublicHosts(); }
  async releaseContainment(authorizedGeneration: string): Promise<void> { await this.#containment().releaseContainment(authorizedGeneration); }
  async verifyContainment(): Promise<ContainmentState> { return this.#containment().verifyContainment(); }
  async probePublicAddress(url: string): Promise<'present' | 'absent' | 'unknown'> { return this.#containment().probePublicAddress(url); }
  async declareIncident(incident: ConfidentialityIncident): Promise<void> { await this.#containment().declareIncident(incident); }

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
