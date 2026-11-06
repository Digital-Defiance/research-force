/**
 * The capacity/performance harness runner (task 46.2; R21.2, R28.*, R30.6, R36.17, R60.7).
 *
 * A node/tsx-standalone harness (no Vitest pool: `tests/perf/**` is deliberately outside the unit
 * pools, exactly like `tests/staging`). It enumerates every certification case, asserts the PURE /
 * derivable ones here with real deterministic checks, and reports the real-environment MEASUREMENTS
 * as BLOCKED when their environment/Reference_Archive is absent — never a green skip, never a
 * fabricated measured number.
 *
 * Exit contract:
 *   - Default (dry enumeration / pure-check run, the build-checkout mode): the run SUCCEEDS (exit 0)
 *     when every pure case passes and every measured case is HONESTLY reported (measured with real
 *     evidence, or blocked-pending-environment). A pure-check failure, or a case that claims
 *     `measured` with no evidence, throws and exits non-zero. The profile is reported NOT certified
 *     while any case is blocked — that is the correct, honest state in a checkout, not a harness
 *     error. A profile that is NOT certified cannot be advertised or deployed for the blocked scope.
 *   - `--assert-certified`: the operator/CI mode against the real environment. Exits non-zero unless
 *     EVERY certification is measured (the profile is fully certified). This is how a failing profile
 *     fails its launch gate (R28.17, R60.7).
 *
 * Run it with:
 *   node --import tsx tests/perf/run.ts                 # dry enumeration + pure checks (this checkout)
 *   node --import tsx tests/perf/run.ts --json          # machine-readable evidence record
 *   PERF_...=... node --import tsx tests/perf/run.ts --assert-certified   # real environment, full gate
 */
import { resourceProfile } from '@researchforce/domain/resource-profile';
import type { OperatingProfile } from '@researchforce/domain/resource-profile';
import { certify } from './support/measurement';
import type { Certification } from './support/measurement';
import { profileBudgetCertifications } from './cases/profile-budgets.perf';
import { providerMarginCertifications } from './cases/provider-margins.perf';
import { abuseReserveCertifications } from './cases/abuse-reserve.perf';
import { growthCertifications } from './cases/growth.perf';
import { measuredEnvironmentCertifications } from './cases/measured-environment.perf';

/** Collect every certification case for a profile, running the pure checks (which throw on failure). */
export function collectCertifications(name: OperatingProfile = 'Free_Qualified'): readonly Certification[] {
  return [
    ...profileBudgetCertifications(name),
    ...providerMarginCertifications(name),
    ...abuseReserveCertifications(name),
    ...growthCertifications(),
    ...measuredEnvironmentCertifications(),
  ];
}

/** The evidence record for one profile: the certified version/assumptions and every case's state/data. */
export function evidenceRecord(name: OperatingProfile) {
  const profile = resourceProfile(name);
  const cases = collectCertifications(name);
  const verdict = certify(cases);
  return {
    harness: 'tests/perf',
    recordedAt: new Date().toISOString(),
    operatingProfile: name,
    versions: {
      resourceProfile: profile.version,
      referenceArchive: profile.referenceArchiveVersion,
      abuse: profile.abuseVersion,
      growth: profile.growthVersion,
    },
    assumptions: 'Pure cases are recomputed from the resource-profile contract this run; measured cases require the real deployed/benchmark environment and Reference_Archive and are reported BLOCKED when absent. No measured number is fabricated. Chosen margins are never represented as provider guarantees.',
    verdict,
    certifications: cases,
  };
}

function kindMark(state: Certification['state']): string {
  return state === 'measured' ? 'MEASURED-here' : 'BLOCKED-pending-real-environment';
}

/** Validate that no case dishonestly claims `measured` without any evidence datum. */
function assertHonest(cases: readonly Certification[]): void {
  for (const item of cases) {
    if (item.state === 'measured' && item.data.length === 0) {
      throw new Error(`Case "${item.name}" claims measured but carries no evidence — refusing a hollow pass.`);
    }
  }
}

function printSummary(name: OperatingProfile, cases: readonly Certification[]): void {
  const verdict = certify(cases);
  console.log(`\nResource_Profile capacity certification — ${name}`);
  console.log('='.repeat(72));
  for (const item of cases) {
    console.log(`  [${kindMark(item.state)}] ${item.name}`);
    console.log(`      requirements: ${item.requirements.join(', ')}`);
    for (const datum of item.data) {
      console.log(`      - ${datum.label}: ${datum.value} ${datum.unit} (${datum.kind})`);
    }
  }
  console.log('-'.repeat(72));
  console.log(`  measured here: ${verdict.measuredCount}/${verdict.total}`);
  if (verdict.certified) {
    console.log('  VERDICT: CERTIFIED — every certification is measured.');
  } else {
    console.log(`  VERDICT: NOT CERTIFIED — ${verdict.blocked.length} certification(s) BLOCKED pending the real environment:`);
    for (const blocked of verdict.blocked) console.log(`      • ${blocked}`);
    console.log('  A NOT-CERTIFIED profile cannot be advertised or deployed for the blocked scope (R28.17, R60.7).');
  }
}

function main(argv: readonly string[]): number {
  const json = argv.includes('--json');
  const assertCertified = argv.includes('--assert-certified');
  const profiles: OperatingProfile[] = ['Free_Qualified', 'Paid_Standard'];

  const records = profiles.map((name) => {
    const cases = collectCertifications(name);
    assertHonest(cases);
    return { name, cases };
  });

  if (json) {
    process.stdout.write(JSON.stringify(profiles.map((name) => evidenceRecord(name)), null, 2) + '\n');
  } else {
    for (const record of records) printSummary(record.name, record.cases);
  }

  if (assertCertified) {
    const notCertified = records.filter((record) => !certify(record.cases).certified).map((record) => record.name);
    if (notCertified.length > 0) {
      console.error(`\n--assert-certified: ${notCertified.join(', ')} are NOT certified. Run against the real environment with every PERF_* handle set. Failing the launch gate.`);
      return 1;
    }
    console.log('\n--assert-certified: every profile is fully certified against the measured environment.');
  }

  // Dry/pure run succeeded: pure checks passed and every measured case is honestly measured or blocked.
  return 0;
}

const code = main(process.argv.slice(2));
if (code !== 0) process.exitCode = code;
