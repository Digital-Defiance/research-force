/**
 * Mandatory distributed-abuse & removal-failure staging verification (task 59.4; R24.16, R24.17,
 * R28.5, R28.6, R28.7, R28.17, R60.4, R60.7). Gate: the public launch gate's distributed-abuse,
 * urgent-removal/Containment, and profile-certification legs (R60.4, R60.7).
 *
 * Against the deployed staging install's operator distributed-abuse / removal-failure harness, this
 * suite runs the MANDATORY launch-gate scenarios that cannot be certified by unit/property tests
 * because they require the real deployed install, its edge/deployment controls, and its independent
 * alert channel:
 *
 *   1. The initial certification flood (R28.5, R28.6, R28.7, R28.17): the certified `ABUSE_PROFILE`
 *      — 100 requests/second from 1,000 distributed source identities over 30 minutes — run WHILE
 *      ten Members save/download AND a Confidentiality_Hold is applied during a long addition run.
 *      The measured declared reserve (member/public/urgent capacity kept in hand) must meet or
 *      exceed the certified `resourceProfile(...).chosen.reserve`; authorized interactive success
 *      must stay at or above the certified ≥ 99.9% minimum; rejected/invalid-download invocations
 *      must be counted (never represented as prevented by an in-Worker check); and removal/
 *      Containment must work under the available control paths.
 *
 *   2. Fault injection (R24.16, R24.17): a provider outage, exhausted quotas, false HEAD results (a
 *      removed address that still probes present, and an unreachable probe), a stale job, and a late
 *      deploy response are injected. The suite proves a FIXED denial carries NO canaries and CANNOT
 *      block the app (the Workspace stays available; containment returns the generic fixed denial
 *      without exposing research), and that an UNCONFIRMED removal escalates to an incident rather
 *      than ever claiming success.
 *
 *   3. Profile-failure gating (R28.5, R60.7): a FAILED Free_Qualified profile DISABLES that scope
 *      until an approved stronger profile / isolation passes — the scope is not certified while the
 *      profile fails.
 *
 * These checks require the real staging install and operator token; without them the gate is
 * reported BLOCKED (never skipped), exactly as the 48.5 abuse-reserve and containment suites do. The
 * certified envelope the measured run is compared against — pure facts of `ABUSE_PROFILE` and the
 * reserve — is also asserted to be internally consistent in EVERY environment, so a profile drift is
 * caught at type-check/enumeration even where no staging install exists. No measured flood/removal
 * number is fabricated here: a measured value is only ever read back from the deployed harness.
 */
import { expect, test } from '@playwright/test';
import { ABUSE_PROFILE, resourceProfile } from '@researchforce/domain/resource-profile';
import { DISTRIBUTED_ABUSE_ENDPOINT, DISTRIBUTED_ABUSE_TOKEN } from './support/env';
import { describeGate, handle } from './support/gate';
import { field, flag, numberField, operatorPost } from './support/operator';

const GATE = 'Public launch gate (distributed abuse, removal failure & profile certification)';

/**
 * The fault classes the removal/Containment path must survive without ever claiming success or
 * blocking the app (R24.16, R24.17). `false_head_present` is a removed address whose HEAD probe
 * still reports present; `false_head_unreachable` is a probe the control path cannot reach — both
 * leave the removal UNVERIFIED so the escalation keeps going to Containment or an incident.
 */
const FAULTS = [
  'provider_outage',
  'exhausted_quotas',
  'false_head_present',
  'false_head_unreachable',
  'stale_job',
  'late_deploy_response',
] as const;

const ready = describeGate(GATE, [
  handle('STAGING_DISTRIBUTED_ABUSE_ENDPOINT', DISTRIBUTED_ABUSE_ENDPOINT),
  handle('STAGING_DISTRIBUTED_ABUSE_TOKEN', DISTRIBUTED_ABUSE_TOKEN),
]);

/**
 * The certified envelope the measured flood is compared against is internally consistent. These are
 * pure facts of the published `ABUSE_PROFILE` and the Free_Qualified reserve — no staging install is
 * needed — so they run in every environment and a profile drift fails type-check/enumeration before
 * the live gate is ever reached.
 */
test.describe('the certified distributed-abuse envelope and reserve are internally consistent', () => {
  test('the certified flood matches the task 59.4 shape: 100 req/s, 1,000 sources, 30 min, ten Members (R28.17)', () => {
    // 30 minutes at 100 requests/second from 1,000 distributed source identities (the initial flood).
    expect(ABUSE_PROFILE.durationSeconds).toBe(30 * 60);
    expect(ABUSE_PROFILE.requestsPerSecond).toBe(100);
    expect(ABUSE_PROFILE.sourceIdentities).toBe(1000);
    expect(ABUSE_PROFILE.concurrentMembers).toBe(10);
    // The flood names its distributed invalid-download/rejected traffic classes and the concurrent
    // authorized work (member saves, authorized downloads) and the urgent removal it runs alongside.
    expect(ABUSE_PROFILE.traffic.length).toBeGreaterThan(0);
    expect(ABUSE_PROFILE.concurrent).toContain('member saves');
    expect(ABUSE_PROFILE.concurrent).toContain('authorized downloads');
    expect(ABUSE_PROFILE.concurrent).toContain('urgent removal');
  });

  test('the certified minimum authorized-interactive success is at least 99.9% (R28.7)', () => {
    // The measured authorized success rate is compared against this exact certified minimum; a drift
    // below 99.9% here would mean the gate was certifying a weaker guarantee than task 59.4 states.
    expect(ABUSE_PROFILE.minimumAuthorizedSuccess).toBeGreaterThanOrEqual(0.999);
  });

  test('rejected/invalid-download invocations are counted, never represented as prevented (R28.5, R28.17)', () => {
    // R28.5: a budget check after invocation is not a prevention of that invocation's charge, so the
    // certified profile counts rejected and invalid-download invocations in the account totals.
    expect(ABUSE_PROFILE.countRejectedInvocations).toBe(true);
  });

  test('the certified reserve keeps Member, public, and urgent-removal capacity within bounds (R28.6, R28.7)', () => {
    const reserve = resourceProfile('Free_Qualified').chosen.reserve;
    // The reservations cannot exceed the whole capacity, and the Member and urgent-removal reserves
    // the flood must preserve are strictly positive (static public search stays independent of the
    // optional API budget; dynamic forms and addressed views have their own admission — R28.6).
    expect(reserve.memberPercent + reserve.publicPercent + reserve.urgentPercent).toBeLessThanOrEqual(100);
    expect(reserve.memberPercent).toBeGreaterThan(0);
    expect(reserve.urgentPercent).toBeGreaterThan(0);
  });

  test('the certified profile names Free_Qualified so a profile failure can disable that scope (R60.7)', () => {
    // The profile-failure gating scenario disables the Free_Qualified scope until a stronger profile
    // passes; the scope name the live scenario drives is a fact of the certified profile set.
    expect(resourceProfile('Free_Qualified').operatingProfile).toBe('Free_Qualified');
  });
});

if (ready) {
  // The Free_Qualified reserve the measured flood is compared against (the certified envelope).
  const certified = resourceProfile('Free_Qualified');

  test.describe(GATE, () => {
    // --- Scenario 1: the initial certification flood (R28.5, R28.6, R28.7, R28.17) -------------------

    test('the initial flood preserves the declared reserve with ten Members working under a hold (R28.6)', async ({ request }) => {
      const result = await operatorPost(
        request,
        DISTRIBUTED_ABUSE_ENDPOINT!,
        DISTRIBUTED_ABUSE_TOKEN!,
        {
          action: 'run-initial-flood',
          profileVersion: ABUSE_PROFILE.version,
          requestsPerSecond: ABUSE_PROFILE.requestsPerSecond,
          sourceIdentities: ABUSE_PROFILE.sourceIdentities,
          durationSeconds: ABUSE_PROFILE.durationSeconds,
          concurrentMembers: ABUSE_PROFILE.concurrentMembers,
          concurrentMemberWork: ['saves', 'downloads'],
          confidentialityHold: 'during-long-addition-run',
          measure: 'reserve',
        },
        'flood',
      );
      expect(result.ok, 'the distributed-abuse harness must run the initial flood').toBe(true);
      const measuredMember = numberField(result.body, 'measuredMemberReservePercent');
      const measuredUrgent = numberField(result.body, 'measuredUrgentReservePercent');
      const measuredPublic = numberField(result.body, 'measuredPublicReservePercent');
      expect(measuredMember, 'the harness must report the measured member reserve under the flood').toBeDefined();
      expect(measuredUrgent, 'the harness must report the measured urgent-removal reserve under the flood').toBeDefined();
      expect(measuredPublic, 'the harness must report the measured public reserve under the flood').toBeDefined();
      // The MEASURED reserve must meet or exceed the certified declared reserve: the flood, the ten
      // Members, and the hold do not erode the capacity the install keeps in hand.
      expect(measuredMember!, 'the measured member reserve must meet the certified declared reserve').toBeGreaterThanOrEqual(certified.chosen.reserve.memberPercent);
      expect(measuredUrgent!, 'the measured urgent-removal reserve must meet the certified declared reserve').toBeGreaterThanOrEqual(certified.chosen.reserve.urgentPercent);
      expect(measuredPublic!, 'the measured public reserve must meet the certified declared reserve').toBeGreaterThanOrEqual(certified.chosen.reserve.publicPercent);
    });

    test('authorized interactive success stays at or above the certified ≥99.9% during the flood (R28.7)', async ({ request }) => {
      const result = await operatorPost(
        request,
        DISTRIBUTED_ABUSE_ENDPOINT!,
        DISTRIBUTED_ABUSE_TOKEN!,
        { action: 'run-initial-flood', profileVersion: ABUSE_PROFILE.version, concurrentMemberWork: ['saves', 'downloads'], measure: 'authorized-success' },
        'flood',
      );
      expect(result.ok).toBe(true);
      const authorizedSuccess = numberField(result.body, 'authorizedInteractiveSuccessRate');
      expect(authorizedSuccess, 'the harness must report the authorized interactive success rate under the flood').toBeDefined();
      // Compared against the certified minimum (≥ 0.999); the measured value comes only from the run.
      expect(authorizedSuccess!, 'authorized interactive success must stay at or above the certified minimum under the flood').toBeGreaterThanOrEqual(ABUSE_PROFILE.minimumAuthorizedSuccess);
    });

    test('rejected and invalid-download invocations are counted during the flood, not treated as prevented (R28.5, R28.17)', async ({ request }) => {
      const result = await operatorPost(
        request,
        DISTRIBUTED_ABUSE_ENDPOINT!,
        DISTRIBUTED_ABUSE_TOKEN!,
        { action: 'run-initial-flood', profileVersion: ABUSE_PROFILE.version, measure: 'rejected-accounting' },
        'flood',
      );
      expect(result.ok).toBe(true);
      // R28.17 / R28.5: the install counts the distributed invalid-download and rejected requests in
      // the account totals and does NOT represent an in-Worker budget check as preventing the charge.
      expect(flag(result.body, 'rejectedInvocationsCounted'), 'rejected/invalid-download invocations must be counted').toBe(true);
      expect(flag(result.body, 'inWorkerCheckRepresentedAsPreventingCharge'), 'an in-Worker check must NOT be represented as preventing the invocation charge (R28.5)').toBe(false);
    });

    test('urgent removal/Containment works under the available control paths during the flood (R24.16)', async ({ request }) => {
      const result = await operatorPost(
        request,
        DISTRIBUTED_ABUSE_ENDPOINT!,
        DISTRIBUTED_ABUSE_TOKEN!,
        { action: 'run-initial-flood', profileVersion: ABUSE_PROFILE.version, measure: 'removal-under-load' },
        'flood',
      );
      expect(result.ok).toBe(true);
      // Under the flood, the urgent removal reaches the public surfaces or Containment denies them
      // via the available control path; the install never reports plain success without one of those.
      expect(flag(result.body, 'removalOrContainmentConfirmed'), 'removal or Containment must be confirmed under the available control paths during the flood').toBe(true);
      // Static public search stays available independent of the optional API budget (R28.6).
      expect(flag(result.body, 'staticPublicSearchAvailable'), 'static public search must stay available independent of the optional API budget').toBe(true);
    });

    // --- Scenario 2: fault injection (R24.16, R24.17) ------------------------------------------------

    for (const fault of FAULTS) {
      test(`injecting ${fault}: the app stays available and the fixed denial carries no canaries (R24.16, R24.17)`, async ({ request }) => {
        const result = await operatorPost(
          request,
          DISTRIBUTED_ABUSE_ENDPOINT!,
          DISTRIBUTED_ABUSE_TOKEN!,
          { action: 'inject-fault', fault },
          'inject',
        );
        expect(result.ok, `the harness must process the injected ${fault}`).toBe(true);
        // A fixed denial cannot block the app: the Workspace stays available even while containment
        // is in force (R24.16 — "while leaving app available").
        expect(flag(result.body, 'workspaceAvailable'), `the Workspace must stay available under ${fault}`).toBe(true);
        // The denial is the generic fixed notice: no canary token and no research content leaks
        // through it (R24.16/R24.17 — containment exposes no research).
        expect(flag(result.body, 'deniedWithFixedNotice'), `containment must return the generic fixed denial under ${fault}`).toBe(true);
        expect(flag(result.body, 'denialCarriesCanaries'), `the fixed denial must carry NO canaries under ${fault}`).toBe(false);
        expect(flag(result.body, 'researchExposed'), `containment must expose no research under ${fault}`).toBe(false);
      });
    }

    test('an unconfirmed removal escalates to an incident rather than ever claiming success (R24.16, R24.17)', async ({ request }) => {
      // Inject the fault combination that leaves removal unverifiable (a false-present HEAD plus an
      // unreachable probe under a provider outage): neither removal nor Containment can be confirmed.
      const result = await operatorPost(
        request,
        DISTRIBUTED_ABUSE_ENDPOINT!,
        DISTRIBUTED_ABUSE_TOKEN!,
        { action: 'inject-fault', fault: 'false_head_present', alsoInject: ['false_head_unreachable', 'provider_outage'], measure: 'escalation' },
        'inject',
      );
      expect(result.ok).toBe(true);
      // The escalation NEVER claims success on an unconfirmed removal; it declares an unconfirmed
      // confidentiality incident through the independent channel (R24.17).
      expect(flag(result.body, 'claimedSuccess'), 'an unconfirmed removal must NEVER be reported as success').toBe(false);
      expect(field(result.body, 'escalation'), 'an unconfirmed removal must escalate to a declared incident').toBe('incident');
      expect(flag(result.body, 'incidentDeclaredIndependently'), 'the incident must be declared through the independent alert channel').toBe(true);
    });

    test('a stale job and a late deploy response cannot restore a removed address or reopen containment (R24.17)', async ({ request }) => {
      const result = await operatorPost(
        request,
        DISTRIBUTED_ABUSE_ENDPOINT!,
        DISTRIBUTED_ABUSE_TOKEN!,
        { action: 'inject-fault', fault: 'stale_job', alsoInject: ['late_deploy_response'], measure: 'generation-guard' },
        'inject',
      );
      expect(result.ok).toBe(true);
      // A stale generation / late provider response is fenced out: it cannot promote back suppressed
      // output nor clear active Containment (R24.17).
      expect(flag(result.body, 'staleRestoredRemovedAddress'), 'a stale job must NOT restore a removed address').toBe(false);
      expect(flag(result.body, 'staleReopenedContainment'), 'a stale retry must NOT reopen/clear active Containment').toBe(false);
    });

    // --- Scenario 3: profile-failure gating (R28.5, R60.7) ------------------------------------------

    test('a failed Free_Qualified profile disables that scope until a stronger profile/isolation passes (R60.7)', async ({ request }) => {
      const result = await operatorPost(
        request,
        DISTRIBUTED_ABUSE_ENDPOINT!,
        DISTRIBUTED_ABUSE_TOKEN!,
        { action: 'certify-profile', profile: 'Free_Qualified', outcome: 'failed' },
        'profile',
      );
      expect(result.ok).toBe(true);
      // A FAILED Free_Qualified profile leaves its scope NOT certified: the scope is disabled until an
      // approved stronger profile / isolation passes. The harness must report the scope is not
      // certified and is disabled; it must not auto-upgrade services.
      expect(flag(result.body, 'scopeCertified'), 'a failed Free_Qualified profile must leave its scope NOT certified').toBe(false);
      expect(flag(result.body, 'scopeDisabled'), 'a failed Free_Qualified profile must disable that scope').toBe(true);
      expect(flag(result.body, 'autoUpgraded'), 'a failed profile must NOT auto-upgrade services').toBe(false);
    });

    test('the disabled scope is re-enabled only when an approved stronger profile/isolation passes (R60.7)', async ({ request }) => {
      const result = await operatorPost(
        request,
        DISTRIBUTED_ABUSE_ENDPOINT!,
        DISTRIBUTED_ABUSE_TOKEN!,
        { action: 'certify-profile', profile: 'Paid_Standard', outcome: 'passed', approved: true },
        'profile',
      );
      expect(result.ok).toBe(true);
      // Only an APPROVED, PASSING stronger profile / isolation re-certifies the scope (R60.7).
      expect(flag(result.body, 'scopeCertified'), 'the scope must be certified only when an approved stronger profile passes').toBe(true);
      expect(field(result.body, 'certifiedProfile'), 'the re-certified scope must record the approved stronger profile').toBe('Paid_Standard');
    });
  });
}
