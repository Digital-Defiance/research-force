import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeEntry, EvidenceRejection, recordEvidence } from './src/evidence-recorder';
import { planFromReport, type PlaywrightReport, type ResultSuite } from './src/staging-results';

/**
 * Turn a Playwright JSON report into launch-evidence entries. Dry-run by default: it prints the plan
 * and records nothing unless `--write` is given. Makes no network or account call.
 *
 *   PLAYWRIGHT_JSON_OUTPUT_NAME=staging-results.json npx playwright test \
 *     --config playwright.staging.config.ts --reporter=json
 *   npm run -s record:staging-results -- --results staging-results.json --release <releaseId> \
 *     --evidence-ref <path-to-sanitized-report> [--write] [--replace]
 *
 * The raw Playwright report can contain response text, so write a sanitized summary and point
 * `--evidence-ref` at that; do not commit the raw report.
 */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/u, '');
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        results: { type: 'string' }, release: { type: 'string' }, 'evidence-ref': { type: 'string' }, suite: { type: 'string', default: 'staging' },
        write: { type: 'boolean', default: false }, replace: { type: 'boolean', default: false },
      },
      strict: true,
    });
    if (!values.results || !values.release || !values['evidence-ref'] || !['staging', 'security', 'presentation'].includes(values.suite ?? '')) {
      console.error('Usage: record-staging-results --results <playwright-json> --release <releaseId> --evidence-ref <path> [--suite staging] [--write] [--replace]');
      process.exitCode = 2;
    } else {
      const report = JSON.parse(readFileSync(resolve(values.results), 'utf8')) as PlaywrightReport;
      const plan = planFromReport(report, { suite: values.suite as ResultSuite, releaseId: values.release, evidenceRef: values['evidence-ref'] });
      for (const item of plan) {
        console.log(`${item.mapping.file} -> ${item.mapping.gate}/${item.mapping.requirement}: ${item.outcome}; ${item.reason}`);
        if (item.input && values.write) console.log(`  Recorded: ${describeEntry(recordEvidence(root, item.input, { replace: values.replace }))}`);
        else if (item.input) console.log('  (dry run; add --write to record)');
      }
    }
  } catch (error) {
    console.error(error instanceof EvidenceRejection ? error.message : error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
