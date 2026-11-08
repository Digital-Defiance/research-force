import type {
  BackupAgeAlert,
  ConfidentialityIncident,
  ContainmentCapabilities,
  ContainmentState,
  OpsBackupAlert,
  OpsContainment,
} from '@researchforce/domain/ops';
import {
  CONTAIN_AT_MS,
  type ContainmentStatus,
  type EscalationAction,
  type EscalationDecision,
  type Observation,
  VERIFY_BY_MS,
  escalate,
  mayReleaseContainment,
} from '@researchforce/db/containment';
import { PROBE_BATCH_MAX } from '@researchforce/domain/slice-budget';
import { CLOUDFLARE_API, CloudflareApiError } from './access';
import { postIndependentAlert } from './independent-channel';

// The pure escalation state machine and Containment-release guard moved to `@researchforce/db/containment`
// (task 32.5) so the Publisher in rf-app can share them without importing apps/ops. They are re-exported here
// unchanged, so 59.2's tests and every existing importer keep working against `./containment`.
export { CONTAIN_AT_MS, VERIFY_BY_MS, escalate, mayReleaseContainment };
export type { ContainmentStatus, EscalationAction, EscalationDecision, Observation };

/** Simultaneous HEAD probes in one {@link Containment.probePublicAddresses} call (the Workers connection limit). */
const PROBE_CONCURRENCY = 6;

/**
 * The rf-ops edge-Containment control surface and the urgent-removal incident state machine (task 59.2,
 * design "Publisher" step 7, R24.16, R24.17, R28.6, R60.4, R60.6).
 *
 * The Publisher (tasks 32.1 to 32.5) owns the deploy/verify pipeline; task 59.1 owns the durable publication
 * epoch and the pure fence/promote/reconcile decisions in `@researchforce/db/publication-epoch`. This module
 * owns only the narrow rf-ops control methods and the four-/five-minute escalation state machine that sits
 * between them. It depends on `@researchforce/domain` and (for the epoch results it consumes) may be driven
 * by `@researchforce/db` callers — never on `apps/app` (enforced by scripts/check-boundaries.mjs).
 *
 * Two things are kept strictly apart, exactly as 59.1 split pure `fence`/`reconcile` from the D1 helpers:
 *   1. {@link escalate} — a pure, exhaustively testable decision function over elapsed time and verification
 *      state. No I/O. It decides: verified-in-time → done; 4 min unverified → contain; 5 min → verify
 *      Containment; both control paths failed → unconfirmed-incident (never success); and that a reset/retry
 *      cannot clear active Containment.
 *   2. {@link Containment} — the thin Cloudflare WAF/deny-rule I/O and the independent alert/probe adapters,
 *      reusing `AccessSync`'s `#call` Bearer-token/success-flag pattern.
 */

// ---------------------------------------------------------------------------
// Cloudflare I/O + independent alert/probe adapters.
// ---------------------------------------------------------------------------

/**
 * rf-ops Containment configuration and the secrets/ids it needs, all independently recoverable from the
 * primary account (R60.6). The deny rules are PRECREATED: `publicDenyRuleIds` are ids of existing WAF custom
 * rules on the public-host zone that Containment only ENABLES/DISABLES, never creates at incident time.
 *
 * Operator runbook (R60.6, also surfaced in rf-ops/README style docs):
 *   - To CONTAIN out-of-band without the app: using the independently held Containment API token (stored in a
 *     separate credential vault from the primary CF_ACCESS_API_TOKEN, recoverable even if the primary account
 *     is locked), PATCH each rule in `publicDenyRuleIds` on zone `publicZoneId` to `enabled: true`. This is
 *     exactly what {@link Containment.containPublicHosts} does.
 *   - To VERIFY: HEAD a known public research address; a denied host returns a blocking status (see
 *     {@link Containment.verifyContainment}).
 *   - To CLEAR: Containment is cleared ONLY by the authorized new generation (R24.17). An operator does not
 *     "reset" Containment; they confirm the real public state is safe under a new authorized generation and
 *     then call {@link Containment.releaseContainment} with that generation id. A reset/retry has no such
 *     token and cannot clear Containment.
 *   - The alert webhook (`alertWebhookUrl` + `alertToken`) is an INDEPENDENT channel (a separate provider from
 *     the primary app and its email queue, R28.6/R60.6); an incident is declared through it even when the app
 *     and its D1 are unavailable.
 */
export interface ContainmentConfig {
  /** The zone that serves the public research hosts (e.g. the `researchforce.org` public zone). */
  readonly publicZoneId: string;
  /** The app host, which Containment must NEVER deny: kept available while the public hosts are denied (R24.16). */
  readonly appHost: string;
  /** Ids of the PRECREATED public-host WAF deny rules that Containment enables/disables (never creates). */
  readonly publicDenyRuleIds: readonly string[];
  /** The WAF ruleset id the precreated deny rules live in (the zone's custom http_request_firewall ruleset). */
  readonly denyRulesetId: string;
  /** A public research address an out-of-band probe can HEAD to confirm a denial is actually serving. */
  readonly probeUrl: string;
  /**
   * Secret. An independently recoverable API token scoped to the public-host zone's WAF only. Held in a
   * separate credential store from the primary account so Containment stays operable when the primary account
   * is locked (R60.6).
   */
  readonly containmentApiToken: string;
  /** The independent alert channel endpoint (a provider distinct from the app and its email queue, R28.6). */
  readonly alertWebhookUrl: string;
  /** Secret. The bearer credential for the independent alert channel. */
  readonly alertToken: string;
  /**
   * Whether the configured plan can carry WAF custom deny rules at all. False is a public-launch blocker
   * (R60.4): rf-ops cannot provide the required denial, so Containment is unavailable.
   */
  readonly planCanDeny: boolean;
}

/**
 * The edge-Containment control surface. Mirrors `AccessSync`: an injected `fetcher` (default global `fetch`)
 * for deterministic tests, a `CloudflareApiError` on refusal, and a private `#call` helper. The status store
 * is injected so the authorized-generation guard (R24.17) can be backed by whatever durable store the caller
 * uses; the default is in-memory and suits the per-invocation RPC entrypoint plus tests.
 */
export class Containment implements OpsContainment, OpsBackupAlert {
  readonly #fetch: typeof fetch;
  #status: ContainmentStatus;

  constructor(
    readonly config: ContainmentConfig,
    fetcher: typeof fetch = (input, init) => fetch(input, init),
    status: ContainmentStatus = { containmentActive: false, authorizedGeneration: null },
  ) {
    this.#fetch = fetcher;
    this.#status = status;
  }

  async containmentCapabilities(): Promise<ContainmentCapabilities> {
    const configured = !!this.config.publicZoneId && !!this.config.denyRulesetId
      && this.config.publicDenyRuleIds.length > 0 && !!this.config.containmentApiToken;
    const canDeny = this.config.planCanDeny && configured;
    return {
      canDeny,
      verifiable: !!this.config.probeUrl,
      canAlert: !!this.config.alertWebhookUrl && !!this.config.alertToken,
      blockingReason: canDeny
        ? null
        : !this.config.planCanDeny
          ? 'The configured plan cannot carry WAF custom deny rules on the public hosts.'
          : 'Containment deny rules are not configured.',
    };
  }

  async containPublicHosts(): Promise<void> {
    const capabilities = await this.containmentCapabilities();
    // Inability to provide the required denial is a launch blocker, surfaced as a throw at the point of use
    // (R24.16, R60.4): we must never silently "succeed" without denying.
    if (!capabilities.canDeny) throw new Error(`Containment is unavailable: ${capabilities.blockingReason}`);
    // Enable each PRECREATED deny rule. The rules target the public research hosts only; the app host
    // (config.appHost) is never part of a deny rule, so the app stays available (R24.16).
    for (const ruleId of this.config.publicDenyRuleIds) await this.#setRuleEnabled(ruleId, true);
    this.#status = { containmentActive: true, authorizedGeneration: this.#status.authorizedGeneration };
  }

  async releaseContainment(authorizedGeneration: string): Promise<void> {
    // A reset/retry cannot clear active Containment; only the authorized new generation can (R24.17, R60.6).
    if (!mayReleaseContainment(this.#status, authorizedGeneration)) {
      throw new Error('Active Containment can be cleared only by the authorized new generation, not a reset or retry.');
    }
    for (const ruleId of this.config.publicDenyRuleIds) await this.#setRuleEnabled(ruleId, false);
    this.#status = { containmentActive: false, authorizedGeneration: null };
  }

  /** Record which generation is authorized to clear Containment once it has verified the real public state (R24.17). */
  authorize(generation: string): void {
    this.#status = { containmentActive: this.#status.containmentActive, authorizedGeneration: generation };
  }

  async verifyContainment(): Promise<ContainmentState> {
    const active = this.#status.containmentActive;
    if (!active) return { active: false, verified: false };
    // Out-of-band HEAD of a known public research address: a denied host answers with a blocking status
    // (403/503/429) rather than serving (2xx) or a plain 404. Independent of the primary app's health.
    const outcome = await this.#head(this.config.probeUrl);
    return { active: true, verified: outcome === 'denied' };
  }

  async probePublicAddress(url: string): Promise<'present' | 'absent' | 'unknown'> {
    const outcome = await this.#head(url);
    if (outcome === 'present') return 'present';
    if (outcome === 'absent') return 'absent';
    if (outcome === 'denied') return 'present'; // A denied-but-reachable host still "exists"; it is not removed.
    return 'unknown';
  }

  /**
   * Probe up to {@link PROBE_BATCH_MAX} addresses in one call: one HEAD per address (exactly `urls.length` fetches), at
   * most six in flight at once (the Workers simultaneous-connection limit), each mapped exactly as
   * {@link probePublicAddress} maps it, so a denied host is still 'present'.
   */
  async probePublicAddresses(urls: readonly string[]): Promise<Record<string, 'present' | 'absent' | 'unknown'>> {
    if (urls.length > PROBE_BATCH_MAX) throw new RangeError(`At most ${PROBE_BATCH_MAX} addresses may be probed per call.`);
    const statuses: Record<string, 'present' | 'absent' | 'unknown'> = {};
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const url = urls[next++];
        if (url === undefined) return;
        statuses[url] = await this.probePublicAddress(url);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, urls.length) }, worker));
    return statuses;
  }

  async declareIncident(incident: ConfidentialityIncident): Promise<void> {
    // Content-free payload: operation identities and states only, never a research body, bearer link, or
    // recovery secret (R28.6, R60.6). Sent over the same independent channel as every other rf-ops alert.
    await postIndependentAlert(
      this.#fetch,
      this.config,
      {
        kind: 'confidentiality_incident',
        generation: incident.generation,
        epoch: incident.epoch,
        unverifiedTargets: incident.unverifiedTargets,
        failedActions: incident.failedActions,
        lastVerifiedState: incident.lastVerifiedState,
        removalUnconfirmed: true,
      },
      {
        description: 'No independent alert channel is configured for confidentiality incidents.',
        rejection: 'The independent alert channel did not accept the incident.',
      },
    );
  }

  /**
   * Declare the INDEPENDENT backup-age / RPO alert on the same out-of-band channel (task 58.2, R36.7, R60.6). The
   * payload is content-free — the alert level and ages only, never a research body or recovery secret. A `warning`
   * crosses the 18-hour threshold, a `breach` the 24-hour RPO objective (repeated daily), and `cleared` withdraws a
   * prior alert once a fresh verified point restores the RPO.
   */
  async backupAgeAlert(alert: BackupAgeAlert): Promise<void> {
    await postIndependentAlert(
      this.#fetch,
      this.config,
      { kind: 'backup_age_alert', level: alert.level, ageHours: alert.ageHours, thresholdHours: alert.thresholdHours },
      {
        description: 'No independent alert channel is configured for backup-age alerts.',
        rejection: 'The independent alert channel did not accept the backup-age alert.',
      },
    );
  }

  /** PATCH a precreated WAF custom rule's `enabled` flag on the public-host zone (reuses the AccessSync pattern). */
  async #setRuleEnabled(ruleId: string, enabled: boolean): Promise<void> {
    await this.#call(
      'PATCH',
      `/zones/${this.config.publicZoneId}/rulesets/${this.config.denyRulesetId}/rules/${ruleId}`,
      { enabled },
    );
  }

  async #head(url: string): Promise<'present' | 'absent' | 'denied' | 'unknown'> {
    const response = await this.#fetch(url, { method: 'HEAD' }).catch(() => null);
    if (!response) return 'unknown';
    if (response.status === 404 || response.status === 410) return 'absent';
    if (response.status === 403 || response.status === 429 || response.status === 503) return 'denied';
    if (response.ok) return 'present';
    return 'unknown';
  }

  async #call(method: string, path: string, body: unknown): Promise<void> {
    if (!this.config.publicZoneId || !this.config.denyRulesetId || !this.config.containmentApiToken) {
      throw new Error('Containment is not configured.');
    }
    const response = await this.#fetch(`${CLOUDFLARE_API}${path}`, {
      method,
      body: JSON.stringify(body),
      headers: { authorization: `Bearer ${this.config.containmentApiToken}`, 'content-type': 'application/json' },
    });
    const result = await response.json<{ success?: boolean; errors?: { code?: number }[] }>().catch(() => ({ success: false, errors: [] }));
    if (!response.ok || result.success !== true) {
      throw new CloudflareApiError(response.status, (result.errors ?? []).flatMap((error) => (typeof error.code === 'number' ? [error.code] : [])));
    }
  }
}
