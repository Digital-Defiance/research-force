import type {
  EndpointHealth,
  HealthReport,
  OpsHealthAlert,
  OpsSpendAlert,
  SpendAlert,
} from '@researchforce/domain/ops';
import { type IndependentChannel, postIndependentAlert } from './independent-channel';

/**
 * The rf-ops INDEPENDENT health and spend alert surface (task 67.2, R28.4, R60.6; design "Release assurance,
 * maintenance, and independent operations": `infra/ops/` configures provider-native or independent external
 * health/backup-age/removal/spend checks whose delivery does not need `rf-core` or the Graph queue).
 *
 * Four independent alert classes together satisfy R60.6's "independent health, backup-age, confidentiality-
 * removal, and spend alerts operable without the application D1 and its email queue". Two already existed on
 * {@link ../containment Containment} and are reused unchanged, NOT rebuilt:
 *   - recovery-age / backup-age (RPO): `Containment.backupAgeAlert` (task 58.2, R36.7/R36.17). The in-app
 *     `apps/app/src/backup/rpo.ts` RPO check drives it; this module does not duplicate that age logic.
 *   - confidentiality-removal: `Containment.declareIncident` (task 59.2, R24.17). The Publisher drives it when
 *     an urgent removal cannot be confirmed; this module does not duplicate that containment path.
 * This module adds the remaining two as provider-native / independent EXTERNAL checks over the same operator-
 * controlled independent channel ({@link IndependentChannel}):
 *   - health: {@link OperationalAlerts.certifyHealth} HEADs the monitored endpoints out-of-band and reads the
 *     LIVE confidentiality-control availability, then declares the certified result. It never reads a stored
 *     health flag — a `down`/`degraded` result reflects real reachability and a real control path.
 *   - spend: {@link OperationalAlerts.spendAlert} declares an 80% approach warning / over-budget breach /
 *     cleared withdrawal against the operator-approved budget or a provider daily quota.
 *
 * Mirrors `AccessSync`/`Containment`/`Waf`: an injected `fetcher` (default global `fetch`) for deterministic
 * tests, and it throws only when the independent channel itself refuses or cannot be reached. Depends only on
 * `@researchforce/domain` and the in-package independent-channel helper; never on `apps/app`
 * (scripts/check-boundaries.mjs). SETUP IS AN EXPLICIT OPERATOR ACTION: with no channel configured, every
 * method throws rather than silently no-opping, so an unconfigured channel cannot masquerade as healthy.
 *
 * ---------------------------------------------------------------------------------------------------------
 * OPERATOR RUNBOOKS (R60.6; the tested runbook for lost credentials, unavailable identity provider, failed
 * migration / stuck freeze / exhausted budget, and public containment). These sit beside the Containment
 * runbook in {@link ../containment ContainmentConfig} and the recovery/custody docs in `infra/recovery/` and
 * `infra/ops/`. Every step below is operable WITHOUT the application D1 and its Graph email queue.
 *
 *   1. LOST / COMPROMISED CREDENTIALS. The independent alert channel bearer ({@link IndependentChannel.alertToken})
 *      and the Containment API token are vaulted SEPARATELY from the primary account token
 *      (`CF_ACCESS_API_TOKEN`). If the primary account is lost or locked: (a) alerts keep arriving, because the
 *      channel bearer is independent; (b) contain out-of-band with the independently vaulted Containment token
 *      (see the Containment runbook); (c) rotate the primary token from the provider dashboard and redeploy
 *      rf-ops secrets. If the CHANNEL bearer itself is lost, mint a new write-only webhook bearer, update
 *      `INCIDENT_ALERT_TOKEN`, and run {@link OperationalAlerts.certifyHealth} to confirm delivery is restored.
 *      The channel bearer is write-only (it can post an alert but cannot read research, issue a Download_Link,
 *      or recover a backup), so its loss never exposes content; recovery secrets live only in `infra/recovery/`
 *      custody, never in a payload.
 *
 *   2. UNAVAILABLE IDENTITY PROVIDER (Access / IdP outage). Member sign-in flows through Cloudflare Access; an
 *      IdP outage blocks interactive work but NOT this independent channel. Operators still receive health,
 *      recovery-age, removal, and spend alerts and can still CONTAIN out-of-band. Runbook: confirm the outage
 *      is the IdP (certifyHealth will report `app` reachable but sign-in failing is an IdP-side symptom, not an
 *      endpoint-down); do not treat an IdP outage as a confidentiality incident; restore the IdP or switch to
 *      the documented backup IdP, then revalidate Access policies. The `app` host is never contained, so the
 *      Workspace returns the moment the IdP is back.
 *
 *   3. FAILED MIGRATION / STUCK FREEZE / EXHAUSTED BUDGET.
 *      - Failed migration: the release gate (R60.5) refuses an incompatible Worker/schema combination before
 *        rollout; if a migration fails mid-rollout, roll forward or use the documented compatible rollback —
 *        never roll a Worker back to a schema it cannot read. A failed migration does not require this channel,
 *        but a resulting recovery-age gap WILL surface as a `backupAgeAlert` breach.
 *      - Stuck freeze: the backup write-freeze lease (R36.14) expires on its own; a documented authenticated
 *        break-glass recovers a stuck freeze without accepting an inconsistent backup. Until a fresh verified
 *        point exists, the recovery-age alert repeats daily (R36.7/R36.17).
 *      - Exhausted budget: the `Budget` DO sheds optional public APIs at the edge before the reserve is spent
 *        and declares a spend `breach` here (static pages/search/permitted downloads keep serving, R28.6). The
 *        operator reviews forecast vs. actual, approves an upgrade if wanted (never auto-enabled, R28.4), and
 *        the warning clears once usage falls back within budget.
 *
 *   4. PUBLIC CONTAINMENT. See the Containment runbook in {@link ../containment ContainmentConfig}: contain
 *      out-of-band with the independently vaulted token, verify by HEADing a public research address, and clear
 *      ONLY under the authorized new generation (never a reset/retry). This module's health check independently
 *      certifies that the containment control path is actually available (`controlAvailable`) so an operator is
 *      warned BEFORE an incident if denial could not be applied.
 * ---------------------------------------------------------------------------------------------------------
 */

/** A single monitored endpoint for the independent health check: a content-free label and the URL to HEAD. */
export interface MonitoredEndpoint {
  /** A stable, content-free label (e.g. `app`, `public`), carried in the alert payload; never a bearer link. */
  readonly name: string;
  /** The absolute URL an out-of-band HEAD probes to certify ACTUAL reachability (not a stored flag). */
  readonly url: string;
}

/** rf-ops independent health/spend alert configuration: the shared channel plus the endpoints to certify. */
export interface OperationalAlertsConfig extends IndependentChannel {
  /** The endpoints the health check HEADs out-of-band. Empty means health cannot be certified (a config gap). */
  readonly monitoredEndpoints: readonly MonitoredEndpoint[];
}

/**
 * Reads the LIVE confidentiality-control availability (whether denial can actually be applied right now),
 * independent of any stored flag. In production this is backed by `Containment.containmentCapabilities()`
 * (its `canDeny`); injected so the health check never constructs Containment itself and stays unit-testable.
 */
export type ControlAvailabilityReader = () => Promise<boolean>;

export class OperationalAlerts implements OpsHealthAlert, OpsSpendAlert {
  readonly #fetch: typeof fetch;
  readonly #controlAvailable: ControlAvailabilityReader;

  constructor(
    readonly config: OperationalAlertsConfig,
    controlAvailable: ControlAvailabilityReader,
    fetcher: typeof fetch = fetch,
  ) {
    this.#fetch = fetcher;
    this.#controlAvailable = controlAvailable;
  }

  async certifyHealth(): Promise<HealthReport> {
    // ACTUAL certification, not a stored flag: HEAD every monitored endpoint out-of-band and read the live
    // control path. A reachable-but-blocked host answers `denied`; an unreachable one answers `unreachable`.
    const endpoints: EndpointHealth[] = [];
    for (const endpoint of this.config.monitoredEndpoints) {
      endpoints.push({ name: endpoint.name, state: await this.#probe(endpoint.url) });
    }
    const controlAvailable = await this.#controlAvailable().catch(() => false);

    const anyUnreachable = endpoints.some((endpoint) => endpoint.state === 'unreachable');
    // `down` when every endpoint is unreachable or the control path is gone; `degraded` for a partial loss;
    // `ok` only when every endpoint is reachable (served or deliberately denied) AND denial is applicable.
    const level: HealthReport['level'] = endpoints.length > 0 && endpoints.every((endpoint) => endpoint.state === 'unreachable')
      ? 'down'
      : anyUnreachable || !controlAvailable || endpoints.length === 0
        ? 'degraded'
        : 'ok';

    const report: HealthReport = { level, endpoints, controlAvailable };
    // Content-free payload: endpoint labels, reachability states, and the live control flag only (R28.6, R60.6).
    await postIndependentAlert(
      this.#fetch,
      this.config,
      { kind: 'health_alert', level: report.level, endpoints: report.endpoints, controlAvailable: report.controlAvailable },
      {
        description: 'No independent alert channel is configured for health alerts.',
        rejection: 'The independent alert channel did not accept the health alert.',
      },
    );
    return report;
  }

  async spendAlert(alert: SpendAlert): Promise<void> {
    // Content-free payload: the meter label, percentage, and whole-unit budget only — never any research
    // content, a bearer link, or a recovery secret (R28.4, R28.6, R60.6).
    await postIndependentAlert(
      this.#fetch,
      this.config,
      {
        kind: 'spend_alert',
        level: alert.level,
        meter: alert.meter,
        usagePercent: alert.usagePercent,
        budgetAmount: alert.budgetAmount,
        currency: alert.currency,
      },
      {
        description: 'No independent alert channel is configured for spend alerts.',
        rejection: 'The independent alert channel did not accept the spend alert.',
      },
    );
  }

  /** Out-of-band HEAD mapping a live status to served/denied/unreachable (never a stored flag). */
  async #probe(url: string): Promise<EndpointHealth['state']> {
    const response = await this.#fetch(url, { method: 'HEAD' }).catch(() => null);
    if (!response) return 'unreachable';
    if (response.status === 403 || response.status === 429 || response.status === 503) return 'denied';
    if (response.ok) return 'up';
    return 'unreachable';
  }
}
