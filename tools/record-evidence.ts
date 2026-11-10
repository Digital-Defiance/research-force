import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeEntry, EVIDENCE_LEDGER_FILE, EvidenceRejection, recordEvidence } from './src/evidence-recorder';

/**
 * Evidence recorder CLI: appends ONE validated entry to docs/acceptance/launch-evidence.json.
 * It makes no network or account call. Record only what a real run produced.
 *
 *   npm run -s record:evidence -- --gate team_archive --requirement drafts_files \
 *     --result passed --scope deployed-staging --release <releaseId> --evidence-ref <path-to-sanitized-report>
 *
 * `--kind` is optional (it defaults to the kind the requirement needs). `--replace` overwrites an
 * existing entry for the same gate + requirement + release. `--note` and `--remediation 48.12,48.3`
 * are optional.
 */
const USAGE = 'Usage: record-evidence --gate <id> --requirement <id> --result passed|failed|blocked --scope deployed-staging|deployed-production|local-synthetic --release <releaseId> --evidence-ref <path> [--kind <kind>] [--note <text>] [--remediation <48.12,...>] [--replace]';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/u, '');
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        gate: { type: 'string' }, requirement: { type: 'string' }, kind: { type: 'string' }, result: { type: 'string' },
        scope: { type: 'string' }, release: { type: 'string' }, 'evidence-ref': { type: 'string' }, note: { type: 'string' },
        remediation: { type: 'string' }, replace: { type: 'boolean', default: false },
      },
      strict: true,
    });
    if (!values.gate || !values.requirement || !values.result || !values.scope) {
      console.error(USAGE);
      process.exitCode = 2;
    } else {
      const entry = recordEvidence(root, {
        gate: values.gate, requirement: values.requirement, result: values.result, scope: values.scope,
        ...(values.kind === undefined ? {} : { kind: values.kind }),
        ...(values.release === undefined ? {} : { releaseId: values.release }),
        ...(values['evidence-ref'] === undefined ? {} : { evidenceRef: values['evidence-ref'] }),
        ...(values.note === undefined ? {} : { note: values.note }),
        remediationTasks: values.remediation ? values.remediation.split(',').map((id) => id.trim()).filter(Boolean) : [],
      }, { replace: values.replace });
      console.log(`Recorded in ${EVIDENCE_LEDGER_FILE}:\n  ${describeEntry(entry)}`);
    }
  } catch (error) {
    console.error(error instanceof EvidenceRejection ? error.message : `${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    process.exitCode = 1;
  }
}
