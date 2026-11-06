/**
 * Team walkthrough staging verification (task 48.5; R60.9). Gate: the team-acceptance launch gate.
 *
 * Against the deployed staging install's operator walkthrough-evidence route, this suite confirms
 * the required team walkthroughs were performed against the deployed staging versions and recorded
 * — the human acceptance R60.9 requires. The route returns a SANITIZED summary: which walkthroughs
 * ran, that each has a recorded result, and that none is outstanding. It carries no research, PII, or
 * participant personal data.
 *
 * This check requires the real staging install and operator token; without it the team-acceptance
 * gate is reported BLOCKED (never skipped). A full run belongs in CI/operator context.
 */
import { expect, test } from '@playwright/test';
import { WALKTHROUGH_ENDPOINT, WALKTHROUGH_TOKEN } from './support/env';
import { describeGate, handle } from './support/gate';
import { flag, numberField, operatorGet } from './support/operator';

const GATE = 'Team-acceptance gate (walkthroughs)';

const ready = describeGate(GATE, [
  handle('STAGING_WALKTHROUGH_ENDPOINT', WALKTHROUGH_ENDPOINT),
  handle('STAGING_WALKTHROUGH_TOKEN', WALKTHROUGH_TOKEN),
]);

if (ready) {
  test.describe(GATE, () => {
    test('the required team walkthroughs ran against the deployed staging versions and are recorded (R60.9)', async ({ request }) => {
      const result = await operatorGet(request, WALKTHROUGH_ENDPOINT!, WALKTHROUGH_TOKEN!, 'summary');
      expect(result.ok, 'the walkthrough-evidence route must respond').toBe(true);
      const recorded = numberField(result.body, 'recordedWalkthroughs');
      const outstanding = numberField(result.body, 'outstandingWalkthroughs');
      expect(recorded, 'the summary must report the count of recorded walkthroughs').toBeDefined();
      expect(recorded!, 'at least one team walkthrough must be recorded').toBeGreaterThan(0);
      expect(outstanding, 'the summary must report the outstanding count').toBeDefined();
      expect(outstanding!, 'no required team walkthrough may be outstanding').toBe(0);
      expect(flag(result.body, 'ranAgainstDeployedStagingVersions'), 'walkthroughs must have run against the deployed staging versions').toBe(true);
      expect(flag(result.body, 'sanitized'), 'the walkthrough evidence must be sanitized (no PII)').toBe(true);
    });
  });
}
