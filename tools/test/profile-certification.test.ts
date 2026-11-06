import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { certificationReport } from '../certify-profile';
import { growthForecast, installationProfileSchema, measuredGrowthReport } from '../src/profile-certification';

const example = (name = 'Free_Qualified'): unknown => JSON.parse(readFileSync(new URL(`../../infra/profiles/${name}.example.json`, import.meta.url), 'utf8'));

describe('installation resource certification', () => {
  it('produces dated, fingerprinted local bounds and three growth forecasts without claiming runtime acceptance', () => {
    const report = certificationReport(example());
    expect(report).toMatchObject({ status: 'local_bounds_verified', productionCertified: false, profile: { version: 'resource-v1' } });
    expect(report.pendingProductionEvidence).toHaveLength(6);
    expect(report.sourceSha256['packages/domain/src/resource-profile.ts']).toMatch(/^[a-f0-9]{64}$/);
    expect(report.boundaries).toHaveLength(7);
    expect(report.boundaries.every((b) => b.requiresFragments)).toBe(true);
    expect(report.forecasts.map((f) => f.years)).toEqual([1, 3, 5]);
    expect(report.installation.productionApproved).toBe(false);
    expect(report.installation.curatorCorpusMeasured).toBe(false);
  }, 30_000);

  it('validates free daily caps, paid monthly quotas, input versions and explicit budget approval', () => {
    const free = installationProfileSchema.parse(example());
    const paid = installationProfileSchema.parse(example('Paid_Standard'));
    expect(paid.budgetApproved).toBe(false);
    const invalid = [
      { ...free, operatingProfile: 'Automatic' }, { ...free, productionApproved: true },
      { ...free, quotas: { ...free.quotas, requests: 100_001 } },
      { ...paid, quotas: { ...paid.quotas, period: 'day' } },
      { ...paid, productionApproved: true, curatorCorpusMeasured: true },
      { ...paid, budgetApproved: true, productionApproved: true, curatorCorpusMeasured: true, monthlyBudget: { ...paid.monthlyBudget, platformAlertCents: 0 } },
      { ...free, growthVersion: 'growth-v2' }, { ...free, autoBuyPlan: true },
      { ...free, growth: { ...free.growth, originals: { initialBytes: -1, annualBytes: 0 } } },
    ];
    for (const value of invalid) expect(installationProfileSchema.safeParse(value).success).toBe(false);
    expect(installationProfileSchema.safeParse({ ...paid, productionApproved: true, budgetApproved: true, curatorCorpusMeasured: true }).success).toBe(true);
  });

  it('counts metadata/history, public/release/export copies, full backup tiers and transient storage independently', () => {
    const input = installationProfileSchema.parse(example());
    for (const category of ['originals', 'derivatives', 'metadata', 'history', 'publicCopies', 'releases', 'exports'] as const) input.growth[category] = { initialBytes: 10, annualBytes: 2 };
    const [first] = growthForecast(input);
    expect(first).toMatchObject({ years: 1, recoveryPointBytes: 48, independentBackupBytes: 48 * 34, transientBytes: 96, fullRecoveryTransferBytes: 48, totalStoredBytes: 7 * 12 + 48 * 34 + 96 });
    input.growth.originals.annualBytes = Number.MAX_SAFE_INTEGER;
    expect(() => growthForecast(input)).toThrow(/safe byte arithmetic/);
  });

  it('reports measured current (year 0) plus the 1/3/5-year forecast, each counting all current/transient copies (task 67.3, R28.8, R28.17, R60.7)', () => {
    const input = installationProfileSchema.parse(example());
    const report = measuredGrowthReport(input);
    // Year 0 is the MEASURED current corpus: every category equals its measured initial bytes, no annual growth added.
    expect(report.measuredCurrent.years).toBe(0);
    expect(report.measuredCurrent.bytes.originals).toBe(input.growth.originals.initialBytes);
    // The measured current total counts all current/transient copies and the independent-backup tiers (14+8+12 = 34).
    const recoveryPoint = input.growth.originals.initialBytes + input.growth.derivatives.initialBytes + input.growth.metadata.initialBytes + input.growth.history.initialBytes;
    const storedNow = input.growth.originals.initialBytes + input.growth.derivatives.initialBytes + input.growth.metadata.initialBytes + input.growth.history.initialBytes + input.growth.publicCopies.initialBytes + input.growth.releases.initialBytes + input.growth.exports.initialBytes;
    expect(report.measuredCurrent.transientBytes).toBe(recoveryPoint * input.growth.transientCopies);
    expect(report.measuredCurrent.independentBackupBytes).toBe(recoveryPoint * 34 * input.growth.independentBackupCopies);
    expect(report.measuredCurrent.totalStoredBytes).toBe(storedNow + report.measuredCurrent.transientBytes + report.measuredCurrent.independentBackupBytes);
    // The forecast points are exactly the 1/3/5-year forecast, so the report does not rebuild the forecaster.
    expect(report.forecasts).toEqual(growthForecast(input));
    expect(report.forecasts.map((f) => f.years)).toEqual([1, 3, 5]);
    // The copy model ties the report to the operational-retention transient window and the backup tiers.
    expect(report.copyModel).toMatchObject({ transientDays: 7, transientCopies: input.growth.transientCopies, independentBackupTiers: 34 });
  });
});
