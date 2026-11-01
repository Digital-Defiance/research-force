import type {
  ConfidentialityIncident,
  ContainmentCapabilities,
  ContainmentState,
  OpsContainment,
} from '@researchforce/domain/ops';
import { CLOUDFLARE_API, CloudflareApiError } from './access';

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
// Pure escalation state machine (no I/O).
// ---------------------------------------------------------------------------

/** The Containment deadlines, in milliseconds from the save, from design "Publisher" step 7 (R24.16). */
export const CONTAIN_AT_MS = 4 * 60_000;
export const VERIFY_BY_MS = 5 * 60_000;

/**
 * What a fresh observation of an urgent removal reports to the escalation state machine. `elapsedMs` is the
 * time since the save; `removalVerified` is whether the Publisher's HEAD checks confirmed the removed
 * addresses now return not-found; `containmentActive`/`containmentVerified` are the current edge-Containment
 * state (from a prior {@link Containment.verifyContainment}); `canContain` is whether the plan can deny at all
 * (false is a launch blocker, R60.4). `providerDown` means the control paths themselves are unreachable, so
 * neither removal nor denial can be confirmed.
 */
export interface Observation {
  readonly elapsedMs: number;
  readonly removalVerified: boolean;
  readonly containmentActive: boolean;
  readonly containmentVerified: boolean;
  readonly canContain: boolean;
  readonly providerDown: boolean;
}

/**
 * The action the Publisher must take next for an urgent removal. `wait` keeps watching before the 4-minute
 * deadline. `contain` enables the precreated deny rules. `verify_containment` checks the denial is actually
 * serving at 5 minutes. `resolved` means removal (or verified Containment) confirmed the public state is safe.
 * `incident` means neither removal nor Containment could be confirmed: an unconfirmed-exposure incident is
 * declared, never success (R24.17).
 */
export type EscalationAction = 'wait' | 'contain' | 'verify_containment' | 'resolved' | 'incident';

export interface EscalationDecision {
  readonly action: EscalationAction;
  /** Whether Containment must remain in force after this step. Never cleared while removal is unconfirmed (R24.17). */
  readonly keepContainment: boolean;
  readonly reason:
    | 'removal_verified'
    | 'containment_verified'
    | 'within_deadline'
    | 'contain_now'
    | 'verify_containment'
    | 'both_failed'
    | 'cannot_contain';
}

/**
 * The pure escalation decision for an urgent removal, given one observation (R24.16, R24.17).
 *
 * Order matters and is confidentiality-first:
 *   - A verified removal resolves the step at any time; the removed material is provably gone, so Containment
 *     is no longer needed and need not be kept.
 *   - A verified Containment also resolves the step: the public research hosts are provably denied, which is
 *     an acceptable safe state (R24.16), and Containment is kept in force.
 *   - If the plan cannot contain at all and removal is unverified past the deadline, that is an incident: we
 *     can neither remove nor deny (R60.4 makes this a launch blocker, but at runtime it is an incident).
 *   - If the provider is unreachable past the 5-minute mark with nothing verified, neither control path
 *     worked: declare an unconfirmed-exposure incident, never success (R24.17). Any Containment already in
 *     force stays in force.
 *   - At or past 5 minutes with Containment active but not yet verified, verify it.
 *   - At or past 4 minutes with removal still unverified, initiate Containment.
 *   - Before 4 minutes, keep watching.
 */
export function escalate(o: Observation): EscalationDecision {
  if (o.removalVerified) return { action: 'resolved', keepContainment: o.containmentActive, reason: 'removal_verified' };
  if (o.containmentActive && o.containmentVerified) {
    return { action: 'resolved', keepContainment: true, reason: 'containment_verified' };
  }
  // Past the Containment deadline with no verified safe state and no way to deny: an incident.
  if (!o.canContain && o.elapsedMs >= CONTAIN_AT_MS) {
    return { action: 'incident', keepContainment: o.containmentActive, reason: 'cannot_contain' };
  }
  // Past the verification deadline with the control paths themselves down: neither removal nor denial could
  // be confirmed. Record an unconfirmed incident; keep any Containment already in force.
  if (o.providerDown && o.elapsedMs >= VERIFY_BY_MS) {
    return { action: 'incident', keepContainment: o.containmentActive, reason: 'both_failed' };
  }
  // Past the verification deadline with Containment enabled but not yet confirmed serving: verify it.
  if (o.elapsedMs >= VERIFY_BY_MS && o.containmentActive && !o.containmentVerified) {
    return { action: 'verify_containment', keepContainment: true, reason: 'verify_containment' };
  }
  // At or past 4 minutes with removal still unverified and no active Containment: initiate Containment now.
  if (o.elapsedMs >= CONTAIN_AT_MS && !o.containmentActive) {
    return { action: 'contain', keepContainment: true, reason: 'contain_now' };
  }
  // At or past 4 minutes, Containment already active but not yet at the 5-minute verify point: hold it.
  if (o.elapsedMs >= CONTAIN_AT_MS && o.containmentActive) {
    return { action: 'wait', keepContainment: true, reason: 'contain_now' };
  }
  // Still inside the 4-minute window: keep watching. Keep any Containment already active.
  return { action: 'wait', keepContainment: o.containmentActive, reason: 'within_deadline' };
}

/**
 * Whether a plain reset/retry may clear active Containment. It may NOT: Containment is cleared only by an
 * authorized new generation that has verified the real public state (R24.17, R60.6). This pure guard backs
 * {@link Containment.releaseContainment}; it is exported so the Publisher and its tests share one definition.
 *
 * `requestedGeneration` is the generation the caller presents; `authorizedGeneration` is the latest generation
 * rf-ops recognises as authorized to clear Containment. A reset/retry presents an empty or stale token and is
 * refused. Containment that is not active needs no authorization to "clear".
 */
export function mayReleaseContainment(
  state: { readonly containmentActive: boolean; readonly authorizedGeneration: string | null },
  requestedGeneration: string,
): boolean {
  if (!state.containmentActive) return true;
  if (!requestedGeneration) return false;
  return state.authorizedGeneration === requestedGeneration;
}

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

/** The subset of state rf-ops keeps about active Containment, so a release can be authorized against it (R24.17). */
export interface ContainmentStatus {
  readonly containmentActive: boolean;
  /** The generation currently authorized to clear Containment, or null when none is. */
  readonly authorizedGeneration: string | null;
}

/**
 * The edge-Containment control surface. Mirrors `AccessSync`: an injected `fetcher` (default global `fetch`)
 * for deterministic tests, a `CloudflareApiError` on refusal, and a private `#call` helper. The status store
 * is injected so the authorized-generation guard (R24.17) can be backed by whatever durable store the caller
 * uses; the default is in-memory and suits the per-invocation RPC entrypoint plus tests.
 */
export class Containment implements OpsContainment {
  readonly #fetch: typeof fetch;
  #status: ContainmentStatus;

  constructor(
    readonly config: ContainmentConfig,
    fetcher: typeof fetch = fetch,
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

  async declareIncident(incident: ConfidentialityIncident): Promise<void> {
    if (!this.config.alertWebhookUrl || !this.config.alertToken) {
      throw new Error('No independent alert channel is configured for confidentiality incidents.');
    }
    // Content-free payload: operation identities and states only, never a research body, bearer link, or
    // recovery secret (R28.6, R60.6).
    const response = await this.#fetch(this.config.alertWebhookUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.config.alertToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'confidentiality_incident',
        generation: incident.generation,
        epoch: incident.epoch,
        unverifiedTargets: incident.unverifiedTargets,
        failedActions: incident.failedActions,
        lastVerifiedState: incident.lastVerifiedState,
        removalUnconfirmed: true,
      }),
    }).catch(() => null);
    if (!response || !response.ok) throw new Error('The independent alert channel did not accept the incident.');
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
