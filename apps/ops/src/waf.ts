import type { OpsWaf } from '@researchforce/domain/ops';
import { CLOUDFLARE_API, CloudflareApiError } from './access';

/**
 * rf-ops configuration for the single PRECREATED WAF custom rule that blocks the public submit host
 * `submit.researchforce.org` when the Public_Traffic_Budget is reached (task 34.2, design "Capacity, cost,
 * and public abuse budgets", R28.5, R28.6, R28.11).
 *
 * This is ORDINARY edge shedding, NOT confidentiality Containment (see {@link ../containment Containment}): it
 * only turns the optional, invocation-costing public submit API on or off, so it carries its OWN zone/ruleset/
 * rule id and its OWN WAF-scoped token — it deliberately does NOT reuse the independently-recoverable
 * Containment token (that token is held in a separate vault only so confidentiality denial survives a primary
 * account lockout; routine budget shedding must not borrow it). The rule is precreated in provisioning
 * (initially disabled); `setSubmitBlock` only flips its `enabled` flag.
 */
export interface WafConfig {
  /** The zone that serves the public submit host `submit.researchforce.org`. */
  readonly submitZoneId: string;
  /** The WAF ruleset id the precreated submit-block rule lives in (the zone's http_request_firewall ruleset). */
  readonly submitBlockRulesetId: string;
  /** The id of the PRECREATED submit-block WAF custom rule that `setSubmitBlock` enables/disables (never creates). */
  readonly submitBlockRuleId: string;
  /** Secret. An API token scoped to the submit host zone's WAF only, for toggling the precreated block rule. */
  readonly apiToken: string;
}

/**
 * The rf-ops submit-block control surface. Mirrors `AccessSync`/`Containment`: an injected `fetcher` (default
 * global `fetch`) for deterministic tests, a `CloudflareApiError` on refusal, and a private `#call` helper
 * reusing the Bearer-token/success-flag pattern and the shared {@link CLOUDFLARE_API} base.
 *
 * Depends only on `@researchforce/domain` (the {@link OpsWaf} contract from task 34.1) and `./access`
 * (the shared Cloudflare transport); never on `apps/app` (scripts/check-boundaries.mjs).
 */
export class Waf implements OpsWaf {
  readonly #fetch: typeof fetch;
  constructor(readonly config: WafConfig, fetcher: typeof fetch = fetch) {
    this.#fetch = fetcher;
  }

  /**
   * Toggle the precreated submit-block rule to `{ enabled }` (R28.5, R28.6). The Cloudflare PATCH is naturally
   * idempotent: setting the rule to the state it already holds is not an error. Throws `CloudflareApiError`
   * when Cloudflare refuses or cannot be reached.
   */
  async setSubmitBlock(enabled: boolean): Promise<void> {
    await this.#call(
      'PATCH',
      `/zones/${this.config.submitZoneId}/rulesets/${this.config.submitBlockRulesetId}/rules/${this.config.submitBlockRuleId}`,
      { enabled },
    );
  }

  async #call(method: string, path: string, body: unknown): Promise<void> {
    if (!this.config.submitZoneId || !this.config.submitBlockRulesetId || !this.config.submitBlockRuleId || !this.config.apiToken) {
      throw new Error('WAF is not configured.');
    }
    const response = await this.#fetch(`${CLOUDFLARE_API}${path}`, {
      method, body: JSON.stringify(body), headers: { authorization: `Bearer ${this.config.apiToken}`, 'content-type': 'application/json' },
    });
    const result = await response.json<{ success?: boolean; errors?: { code?: number }[] }>().catch(() => ({ success: false, errors: [] }));
    if (!response.ok || result.success !== true) throw new CloudflareApiError(response.status, (result.errors ?? []).flatMap((error) => (typeof error.code === 'number' ? [error.code] : [])));
  }
}
