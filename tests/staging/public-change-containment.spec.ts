/**
 * Public change timing & containment staging verification (task 48.5; R24.11, R24.12, R24.16,
 * R24.17). Gate: the public-release launch gate.
 *
 * Against the deployed staging install's operator containment/timing route, this suite certifies the
 * REAL public-change behaviour:
 *   - Change timing (R24.11): a public change (a copy-only release) becomes visible within the
 *     certified timing bound, and the report records the measured time to visibility.
 *   - Independently verified containment (R24.12): after a change, containment is verified by an
 *     INDEPENDENT reader (not the writer) across every public surface — pages, the search index,
 *     files, People, policy, and release assets — so a surface that kept stale or leaked content is
 *     caught.
 *   - Injected deploy/quota failures (R24.16): a deploy failure and a quota failure are injected and
 *     the report confirms the change is contained (no partial/leaked publication) and the failure is
 *     surfaced, not silently dropped.
 *   - Old-generation retries (R24.17): a retry carrying an OLD generation token is refused, so a
 *     stale retry cannot republish superseded content.
 *
 * These checks require the real staging install and operator token; without them the public-release
 * gate is reported BLOCKED (never skipped). A full run belongs in CI/operator context.
 */
import { expect, test } from '@playwright/test';
import { CONTAINMENT_ENDPOINT, CONTAINMENT_TOKEN } from './support/env';
import { describeGate, handle } from './support/gate';
import { field, flag, numberField, operatorPost } from './support/operator';

const GATE = 'Public-release gate (change timing & containment)';

/** Every public surface containment must be independently verified across (R24.12). */
const SURFACES = ['pages', 'searchIndex', 'files', 'people', 'policy', 'releaseAssets'] as const;

const ready = describeGate(GATE, [
  handle('STAGING_CONTAINMENT_ENDPOINT', CONTAINMENT_ENDPOINT),
  handle('STAGING_CONTAINMENT_TOKEN', CONTAINMENT_TOKEN),
]);

if (ready) {
  test.describe(GATE, () => {
    test('a public change becomes visible within the certified timing bound (R24.11)', async ({ request }) => {
      const result = await operatorPost(request, CONTAINMENT_ENDPOINT!, CONTAINMENT_TOKEN!, { action: 'copy-only-release', measure: 'timing' }, 'release');
      expect(result.ok, 'the copy-only release must run').toBe(true);
      const observedMs = numberField(result.body, 'timeToVisibleMs');
      const boundMs = numberField(result.body, 'certifiedBoundMs');
      expect(observedMs, 'the report must record the measured time to visibility').toBeDefined();
      expect(boundMs, 'the report must record the certified timing bound').toBeDefined();
      expect(observedMs!, 'the public change must become visible within the certified bound').toBeLessThanOrEqual(boundMs!);
    });

    test('containment is independently verified across every public surface (R24.12)', async ({ request }) => {
      const result = await operatorPost(request, CONTAINMENT_ENDPOINT!, CONTAINMENT_TOKEN!, { action: 'verify-containment', independent: true, surfaces: SURFACES }, 'containment');
      expect(result.ok).toBe(true);
      expect(field(result.body, 'verifier'), 'containment must be checked by an independent reader, not the writer').toBe('independent');
      for (const surface of SURFACES) {
        expect(flag(result.body, `contained_${surface}`), `${surface} must contain the change (no stale or leaked content)`).toBe(true);
      }
    });

    test('an injected deploy failure is contained and surfaced, not silently dropped (R24.16)', async ({ request }) => {
      const result = await operatorPost(request, CONTAINMENT_ENDPOINT!, CONTAINMENT_TOKEN!, { action: 'inject-failure', failure: 'deploy' }, 'inject');
      expect(result.ok).toBe(true);
      expect(flag(result.body, 'contained'), 'a deploy failure must leave no partial/leaked publication').toBe(true);
      expect(flag(result.body, 'failureSurfaced'), 'the deploy failure must be surfaced, not swallowed').toBe(true);
    });

    test('an injected quota failure is contained and surfaced (R24.16)', async ({ request }) => {
      const result = await operatorPost(request, CONTAINMENT_ENDPOINT!, CONTAINMENT_TOKEN!, { action: 'inject-failure', failure: 'quota' }, 'inject');
      expect(result.ok).toBe(true);
      expect(flag(result.body, 'contained'), 'a quota failure must leave no partial/leaked publication').toBe(true);
      expect(flag(result.body, 'failureSurfaced'), 'the quota failure must be surfaced, not swallowed').toBe(true);
    });

    test('a retry carrying an old generation token is refused (R24.17)', async ({ request }) => {
      const result = await operatorPost(request, CONTAINMENT_ENDPOINT!, CONTAINMENT_TOKEN!, { action: 'retry', generation: 'old' }, 'retry');
      // A stale retry must be refused so superseded content cannot be republished; the route reports it.
      expect(flag(result.body, 'oldGenerationRetryRefused'), 'an old-generation retry must be refused').toBe(true);
    });
  });
}
