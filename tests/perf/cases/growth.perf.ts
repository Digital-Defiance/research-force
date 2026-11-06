/**
 * Growth-forecast & recovery-objective certifications (task 46.2; R28.4, R28.8, R28.17, R36.17,
 * R60.7).
 *
 * Two layers, honestly separated:
 *   - VERIFIED HERE: the 1/3/5-year growth scenarios reproduced from a declared installation input
 *     via the certification tool's own forecaster (so the harness and `profile:certify` agree), each
 *     point counting all stored categories plus every retained/transient and independent-backup copy
 *     with no deduplication (R28.8, R60.7).
 *   - BLOCKED: the MEASURED current corpus (the real Reference_Archive volumes), the publisher
 *     epoch/removal and retained/transient export/backup/release copy MEASUREMENTS, and the actual
 *     RESTORE demonstrating the <=24h RPO and <=8h RTO against the Reference_Archive require the real
 *     environment and are reported BLOCKED (never a fabricated restore result).
 */
import { readFileSync } from 'node:fs';
import { GROWTH_PROFILE } from '@researchforce/domain/resource-profile';
import { handle, measuredOrBlocked, verifiedHere } from '../support/measurement';
import type { Certification } from '../support/measurement';
import { growthData, parseGrowthInput, recoveryObjectiveData, reproduceGrowth } from '../support/growth';

/** The illustrative installation template the growth reproduction runs against (template inputs, not a corpus). */
function templateInput(): unknown {
  // The Free_Qualified template's growth inputs are illustrative byte estimates (productionApproved and
  // curatorCorpusMeasured are both false). Reproducing the forecast from them is a pure arithmetic check;
  // it does NOT certify the real corpus, which is the BLOCKED measured-current case below.
  return JSON.parse(readFileSync(new URL('../../../infra/profiles/Free_Qualified.example.json', import.meta.url), 'utf8'));
}

/** The growth & recovery certifications: the forecast arithmetic here, the corpus/restore BLOCKED. */
export function growthCertifications(): readonly Certification[] {
  const input = parseGrowthInput(templateInput());
  const report = reproduceGrowth(input);

  // The forecast reproduces the 1/3/5-year horizons and ties to the operational transient/tier model.
  const years = report.forecasts.map((point) => point.years);
  if (JSON.stringify(years) !== JSON.stringify([...GROWTH_PROFILE.years])) {
    throw new Error(`Growth reproduction did not produce the 1/3/5-year horizons: ${years.join(', ')}.`);
  }
  // Every point's total counts all categories plus the backup tiers and transient copies, monotonically.
  let previous = report.measuredCurrent.totalStoredBytes;
  for (const point of report.forecasts) {
    if (point.totalStoredBytes < previous) {
      throw new Error('Forecast total stored bytes must not decrease over the horizons.');
    }
    if (point.independentBackupBytes <= 0 || point.transientBytes <= 0) {
      throw new Error('Each forecast point must count independent-backup and transient copies.');
    }
    previous = point.totalStoredBytes;
  }
  const tiers = GROWTH_PROFILE.dailyRetention + GROWTH_PROFILE.weeklyRetention + GROWTH_PROFILE.monthlyRetention;
  if (report.copyModel.independentBackupTiers !== tiers) {
    throw new Error('The copy model must tie to the 14+8+12 independent-backup tiers.');
  }

  const forecast = verifiedHere(
    '1/3/5-year growth forecast with all retained/transient & independent-backup copies',
    ['R28.4', 'R28.8', 'R28.17', 'R60.7'],
    growthData(input),
    'Reproduced from the certification tool forecaster (uncompressed full copies at forecast-year volume, no deduplication); counts every category plus the 14+8+12 backup tiers and transient packages.',
  );

  // The MEASURED current corpus against the real Reference_Archive (the real originals/derivatives/
  // metadata/history/public/release/export volumes and the publisher epoch/removal copy measurements).
  const measuredCorpus = measuredOrBlocked(
    'measured current corpus & retained/transient export/backup/release copies (Reference_Archive)',
    ['R28.8', 'R28.17', 'R60.7'],
    [
      handle('PERF_REFERENCE_ARCHIVE', process.env['PERF_REFERENCE_ARCHIVE']),
      handle('PERF_CORPUS_ENDPOINT', process.env['PERF_CORPUS_ENDPOINT']),
    ],
    [
      { label: 'required measured current stored bytes (real corpus)', value: 0, unit: 'bytes', kind: 'required_measurement' },
      { label: 'required measured D1 database growth', value: 0, unit: 'bytes', kind: 'required_measurement' },
      { label: 'required measured full-transfer recovery bytes', value: 0, unit: 'bytes', kind: 'required_measurement' },
    ],
    () => {
      throw new Error('The measured current-corpus volumes are read only against the real Reference_Archive environment.');
    },
    'Measures the real current corpus (originals/derivatives/metadata/history/public/release/export), publisher epochs/removal, and D1 growth against the Reference_Archive; the template forecast above is not a measured corpus.',
  );

  // The actual independent-restore RPO/RTO demonstration (R36.17): delivery of bytes is not a recovery test.
  const recovery = measuredOrBlocked(
    'verified independent RPO (<=24h) and reference restore RTO (<=8h)',
    ['R36.17', 'R60.7'],
    [
      handle('PERF_RESTORE_ENDPOINT', process.env['PERF_RESTORE_ENDPOINT']),
      handle('PERF_RESTORE_TOKEN', process.env['PERF_RESTORE_TOKEN']),
      handle('PERF_RECOVERY_KEY_ID', process.env['PERF_RECOVERY_KEY_ID']),
    ],
    recoveryObjectiveData(),
    () => {
      throw new Error('The RPO/RTO restore demonstration runs only against the real isolated fresh-restore environment.');
    },
    'Demonstrates a verified independent recovery point at most 24h old and a fresh reference restore within 8h, recording independent-copy age, counts/hashes, and elapsed time; package delivery alone is not a recovery test.',
  );

  return [forecast, measuredCorpus, recovery];
}
