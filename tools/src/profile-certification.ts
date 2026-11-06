import { z } from 'zod';
import { ABUSE_PROFILE, GROWTH_PROFILE, REFERENCE_ARCHIVE, encodedJsonBytes, resourceProfile, operatingProfileSchema, assertPayloadBudget, assertInvocationBudget } from '@researchforce/domain/resource-profile';
import { resourceBoundaryFixtures } from '@researchforce/testing/resource-fixtures';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const volume = z.strictObject({ initialBytes: count, annualBytes: count });
export const installationProfileSchema = z.strictObject({
  schemaVersion: z.literal(1), operatingProfile: operatingProfileSchema,
  productionApproved: z.boolean(), budgetApproved: z.boolean(),
  monthlyBudget: z.strictObject({ currency: z.literal('USD'), platformAlertCents: count, r2AlertCents: count, independentBackupAlertCents: count }),
  quotas: z.strictObject({ period: z.enum(['day', 'month']), requests: count.positive(), rowsRead: count.positive(), rowsWritten: count.positive() }),
  referenceArchiveVersion: z.literal('reference-archive-v1'), growthVersion: z.literal('growth-v1'), abuseVersion: z.literal('abuse-v1'),
  curatorCorpusMeasured: z.boolean(),
  growth: z.strictObject({ originals: volume, derivatives: volume, metadata: volume, history: volume, publicCopies: volume, releases: volume, exports: volume,
    // Full copies, no assumed deduplication or compression. Recovery snapshots include private source+history+derivatives.
    transientCopies: count.positive(), independentBackupCopies: count.positive() }),
}).superRefine((p, ctx) => {
  const issue = (path: string, message: string): void => { ctx.addIssue({ code: 'custom', path: path.split('.'), message }); };
  if (p.productionApproved && (!p.budgetApproved || !p.curatorCorpusMeasured)) issue('productionApproved', 'Production needs approved spending and a measured curator corpus; runtime release gates also remain required.');
  if (p.operatingProfile === 'Paid_Standard' && p.productionApproved && p.monthlyBudget.platformAlertCents === 0) issue('monthlyBudget.platformAlertCents', 'An approved paid installation needs a non-zero platform alert threshold.');
  if (p.operatingProfile === 'Paid_Standard' && p.quotas.period !== 'month') issue('quotas.period', 'Paid_Standard declares explicit monthly operator quotas.');
  if (p.operatingProfile === 'Free_Qualified') {
    const caps = resourceProfile('Free_Qualified').provider.daily;
    if (p.quotas.period !== 'day' || p.quotas.requests > caps.requests! || p.quotas.rowsRead > caps.rowsRead! || p.quotas.rowsWritten > caps.rowsWritten!) issue('quotas', 'Free daily quotas cannot exceed provider allowances.');
  }
});
export type InstallationProfile = z.infer<typeof installationProfileSchema>;

const safeBytes = (n: number): number => { if (!Number.isSafeInteger(n)) throw new RangeError('Growth forecast exceeds safe byte arithmetic.'); return n; };

/**
 * One growth point at `years` from the measured corpus: every stored category plus ALL retained and transient copies.
 * `years === 0` is the MEASURED CURRENT storage (the corpus as it is now); `years > 0` adds `annualBytes * years` to
 * each category. The total deliberately counts the independent-backup tiers (14 daily + 8 weekly + 12 monthly, per the
 * one GROWTH_PROFILE) and every transient package, with no deduplication or compression, so the report never
 * understates what the installation must store and spend for (R28.8, R60.7).
 */
function growthPoint(input: InstallationProfile, years: number) {
  const g = input.growth;
  const category = (v: { initialBytes: number; annualBytes: number }): number => safeBytes(v.initialBytes + v.annualBytes * years);
  const bytes = { originals: category(g.originals), derivatives: category(g.derivatives), metadata: category(g.metadata), history: category(g.history), publicCopies: category(g.publicCopies), releases: category(g.releases), exports: category(g.exports) };
  const recoveryPointBytes = safeBytes(bytes.originals + bytes.derivatives + bytes.metadata + bytes.history);
  const tiers = GROWTH_PROFILE.dailyRetention + GROWTH_PROFILE.weeklyRetention + GROWTH_PROFILE.monthlyRetention;
  const independentBackupBytes = safeBytes(recoveryPointBytes * tiers * g.independentBackupCopies);
  const transientBytes = safeBytes(recoveryPointBytes * g.transientCopies);
  return { years, bytes, recoveryPointBytes, independentBackupBytes, transientBytes,
    totalStoredBytes: safeBytes(Object.values(bytes).reduce((a, b) => a + b, 0) + independentBackupBytes + transientBytes),
    fullRecoveryTransferBytes: recoveryPointBytes,
  };
}

/** The 1/3/5-year forecast points, each including all retained and transient copies (R28.8, R60.7). */
export function growthForecast(input: InstallationProfile) {
  return GROWTH_PROFILE.years.map((years) => growthPoint(input, years));
}

/**
 * The MEASURED growth report (task 67.3, R28.8, R28.17, R60.7): the measured CURRENT storage (year 0) and the 1/3/5-
 * year forecast, every point counting all current/transient copies and the independent-backup tiers. It ties the
 * report to the operational-retention transient window (`GROWTH_PROFILE.transientDays`, the 7-day retained/transient
 * staging the operational sweeps bound) so the reported transient copies and the swept operational copies are the one
 * model. This is the report wiring certification surfaces; it does not rebuild the forecaster.
 */
export function measuredGrowthReport(input: InstallationProfile) {
  return {
    version: GROWTH_PROFILE.version,
    /** The measured corpus as it is now, including all current/transient and independent-backup copies. */
    measuredCurrent: growthPoint(input, 0),
    /** The 1/3/5-year forecast points (R28.17). */
    forecasts: growthForecast(input),
    /** The horizons the copies counted here are governed by: the transient-staging days and the independent-backup tiers. */
    copyModel: {
      transientDays: GROWTH_PROFILE.transientDays,
      transientCopies: input.growth.transientCopies,
      independentBackupCopies: input.growth.independentBackupCopies,
      independentBackupTiers: GROWTH_PROFILE.dailyRetention + GROWTH_PROFILE.weeklyRetention + GROWTH_PROFILE.monthlyRetention,
    },
  };
}

/** Local geometry evidence only. Staging capacity/recovery/abuse measurements belong to task 48.3. */
export function certifyLocalProfile(raw: unknown) {
  const installation = installationProfileSchema.parse(raw);
  const profile = resourceProfile(installation.operatingProfile);
  const boundaries = [];
  // Exact inclusive transfer limit and independent call/statement counters are executable checks.
  assertPayloadBudget('a'.repeat(profile.chosen.bytes.request - 2), 'request', profile);
  assertInvocationBudget({ d1Calls: 1, statements: profile.chosen.statementsPerSave, maxParameters: profile.chosen.parametersPerStatement, externalSubrequests: 0 }, profile);
  let oversizedRefused = false;
  try { assertPayloadBudget('a'.repeat(profile.chosen.bytes.request - 1), 'request', profile); }
  catch { oversizedRefused = true; }
  if (!oversizedRefused) throw new Error('The transfer boundary failed to refuse an extra byte.');
  for (const fixture of resourceBoundaryFixtures()) {
    const encodedBytes = encodedJsonBytes(fixture.value);
    boundaries.push({ name: fixture.name, codePoints: fixture.codePoints, spans: fixture.spans, encodedBytes,
      requiresFragments: encodedBytes > profile.chosen.bytes.request });
  }
  return { schemaVersion: 1, status: 'local_bounds_verified', productionCertified: false,
    profile, installation, referenceArchive: REFERENCE_ARCHIVE, abuse: ABUSE_PROFILE, growth: GROWTH_PROFILE,
    forecastAssumptions: 'Uncompressed full copies at forecast-year volume; retention tiers added without deduplication. No storage purchase or spend cap is inferred. Replace example inputs with measured corpus/metadata volumes.',
    forecasts: growthForecast(installation),
    // The measured current + 1/3/5-year growth report, each point counting all current/transient and independent-backup
    // copies, tied to the operational-retention transient/tier model (task 67.3, R28.8, R28.17, R60.7).
    measuredGrowth: measuredGrowthReport(installation), boundaries,
    pendingProductionEvidence: ['maximum-input CPU and concurrent isolate memory', 'actual D1 calls/statements/rows and database growth', 'bounded preview/search/100-file paths', 'independent restore RPO/RTO', 'distributed abuse with authorized saves/downloads and removal', 'operator deployment limits and edge/account controls'],
  };
}
