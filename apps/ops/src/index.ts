import { WorkerEntrypoint } from 'cloudflare:workers';
import type {
  ConfidentialityIncident,
  ContainmentCapabilities,
  ContainmentState,
  OpsAccess,
  OpsContainment,
} from '@researchforce/domain/ops';
import { AccessSync } from './access';
import { Containment } from './containment';

export interface OpsEnv {
  CF_ACCOUNT_ID: string;
  ACCESS_MEMBER_LIST_ID: string;
  /** Secret. */
  CF_ACCESS_API_TOKEN: string;

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
}

/** Reachable only through service bindings: no fetch handler and no route. */
export default class Ops extends WorkerEntrypoint<OpsEnv> implements OpsAccess, OpsContainment {
  #access(): AccessSync {
    return new AccessSync({ accountId: this.env.CF_ACCOUNT_ID, memberListId: this.env.ACCESS_MEMBER_LIST_ID, apiToken: this.env.CF_ACCESS_API_TOKEN });
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

  async addMember(email: string): Promise<void> { await this.#access().addMember(email); }
  async removeMember(email: string): Promise<void> { await this.#access().removeMember(email); }
  async revokeSessions(email: string): Promise<void> { await this.#access().revokeSessions(email); }

  async containmentCapabilities(): Promise<ContainmentCapabilities> { return this.#containment().containmentCapabilities(); }
  async containPublicHosts(): Promise<void> { await this.#containment().containPublicHosts(); }
  async releaseContainment(authorizedGeneration: string): Promise<void> { await this.#containment().releaseContainment(authorizedGeneration); }
  async verifyContainment(): Promise<ContainmentState> { return this.#containment().verifyContainment(); }
  async probePublicAddress(url: string): Promise<'present' | 'absent' | 'unknown'> { return this.#containment().probePublicAddress(url); }
  async declareIncident(incident: ConfidentialityIncident): Promise<void> { await this.#containment().declareIncident(incident); }
}
