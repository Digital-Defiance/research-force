/**
 * Abuse_Profile & reserve staging verification (task 48.5; R28.1, R28.2, R28.6, R28.7, R28.17).
 * Gate: the public-release / abuse-resilience launch gate.
 *
 * Against the deployed staging install's operator Abuse_Profile harness, this suite runs the
 * distributed Abuse_Profile — the certified `ABUSE_PROFILE` from `@researchforce/domain/resource-
 * profile` (duration, requests/second, source identities, concurrent Members, and the minimum
 * authorized-success rate) — WHILE Members save and download, and compares the MEASURED resource and
 * spend reserve against the certified `resourceProfile(...).chosen.reserve`:
 *   - R28.1/R28.2: under the Abuse_Profile load, authorized Member saves/downloads keep succeeding at
 *     or above the certified minimum authorized-success rate (the abuse traffic does not starve
 *     legitimate work).
 *   - R28.6/R28.7: the measured resource reserve (member/public/urgent capacity kept in hand) and the
 *     measured spend reserve meet or exceed the certified reserve percentages, so the install has the
 *     certified headroom under abuse.
 *   - R28.17: the Abuse_Profile exercises the addressed/rejected-token traffic classes the certified
 *     profile names, and rejected invocations are counted.
 *
 * These checks require the real staging install and operator token; without them the gate is
 * reported BLOCKED (never skipped). The certified profile the measured values are compared against is
 * also asserted to be internally consistent so a profile drift is caught in enumeration/type-check.
 */
import { expect, test } from '@playwright/test';
import { ABUSE_PROFILE, resourceProfile } from '@researchforce/domain/resource-profile';
import { ABUSE_ENDPOINT, ABUSE_TOKEN, CERTIFIED_PROFILE } from './support/env';
import { describeGate, handle } from './support/gate';
import { flag, numberField, operatorPost } from './support/operator';

const GATE = 'Abuse-resilience gate (Abuse_Profile & reserve)';

const ready = describeGate(GATE, [
  handle('STAGING_ABUSE_ENDPOINT', ABUSE_ENDPOINT),
  handle('STAGING_ABUSE_TOKEN', ABUSE_TOKEN),
  handle('STAGING_OPERATING_PROFILE', CERTIFIED_PROFILE),
]);

test.describe('the certified Abuse_Profile and reserve are internally consistent', () => {
  test('the Abuse_Profile names its traffic classes and counts rejected invocations (R28.17)', () => {
    expect(ABUSE_PROFILE.durationSeconds).toBeGreaterThan(0);
    expect(ABUSE_PROFILE.requestsPerSecond).toBeGreaterThan(0);
    expect(ABUSE_PROFILE.countRejectedInvocations).toBe(true);
    expect(ABUSE_PROFILE.traffic.length).toBeGreaterThan(0);
    expect(ABUSE_PROFILE.concurrent).toContain('member saves');
    expect(ABUSE_PROFILE.concurrent).toContain('authorized downloads');
  });

  test('the certified reserve percentages are within bounds (R28.6, R28.7)', () => {
    const reserve = resourceProfile('Free_Qualified').chosen.reserve;
    expect(reserve.memberPercent + reserve.publicPercent + reserve.urgentPercent).toBeLessThanOrEqual(100);
    expect(reserve.memberPercent).toBeGreaterThan(0);
  });
});

if (ready) {
  const certified = resourceProfile(CERTIFIED_PROFILE);

  test.describe(GATE, () => {
    test('authorized saves/downloads survive the distributed Abuse_Profile at the certified success rate (R28.1, R28.2)', async ({ request }) => {
      const result = await operatorPost(
        request,
        ABUSE_ENDPOINT!,
        ABUSE_TOKEN!,
        { action: 'run-abuse-profile', profileVersion: ABUSE_PROFILE.version, concurrentMemberWork: ['saves', 'downloads'] },
        'run',
      );
      expect(result.ok, 'the Abuse_Profile harness must run').toBe(true);
      const authorizedSuccess = numberField(result.body, 'authorizedSuccessRate');
      expect(authorizedSuccess, 'the harness must report the authorized-success rate under load').toBeDefined();
      expect(authorizedSuccess!, 'authorized work must meet the certified minimum success rate under abuse').toBeGreaterThanOrEqual(ABUSE_PROFILE.minimumAuthorizedSuccess);
      expect(flag(result.body, 'rejectedInvocationsCounted'), 'rejected invocations must be counted (R28.17)').toBe(true);
    });

    test('the measured resource reserve meets or exceeds the certified reserve (R28.6)', async ({ request }) => {
      const result = await operatorPost(request, ABUSE_ENDPOINT!, ABUSE_TOKEN!, { action: 'measure-reserve', kind: 'resource' }, 'reserve');
      expect(result.ok).toBe(true);
      const measuredMember = numberField(result.body, 'measuredMemberReservePercent');
      const measuredUrgent = numberField(result.body, 'measuredUrgentReservePercent');
      expect(measuredMember, 'the measured member reserve must be reported').toBeDefined();
      expect(measuredMember!, 'the measured member reserve must meet the certified reserve').toBeGreaterThanOrEqual(certified.chosen.reserve.memberPercent);
      expect(measuredUrgent!, 'the measured urgent reserve must meet the certified reserve').toBeGreaterThanOrEqual(certified.chosen.reserve.urgentPercent);
    });

    test('the measured spend reserve meets or exceeds the certified reserve (R28.7)', async ({ request }) => {
      const result = await operatorPost(request, ABUSE_ENDPOINT!, ABUSE_TOKEN!, { action: 'measure-reserve', kind: 'spend' }, 'reserve');
      expect(result.ok).toBe(true);
      const measuredSpend = numberField(result.body, 'measuredSpendReservePercent');
      expect(measuredSpend, 'the measured spend reserve must be reported').toBeDefined();
      expect(measuredSpend!, 'the install must keep at least the certified spend reserve under abuse').toBeGreaterThanOrEqual(certified.chosen.reserve.publicPercent);
    });
  });
}
