import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { certifyLocalProfile } from './src/profile-certification';

export function certificationReport(installation: unknown) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const evidence = ['packages/domain/src/resource-profile.ts', 'packages/testing/src/resource-fixtures.ts', 'tools/src/profile-certification.ts', 'tools/certify-profile.ts'];
  return { ...certifyLocalProfile(installation), recordedAt: new Date().toISOString(),
    sourceSha256: Object.fromEntries(evidence.map((path) => [path, createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')])) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1 && !(args.length === 3 && args[1] === '--output')) throw new Error('Usage: tools/certify-profile.ts <installation.json> [--output <report.json>]');
    const report = certificationReport(JSON.parse(readFileSync(resolve(args[0]!), 'utf8')));
    const serialized = JSON.stringify(report, null, 2) + '\n';
    if (args[2]) {
      // Avoid overwriting an installation or other file. Reports are immutable evidence.
      writeFileSync(resolve(args[2]), serialized, { flag: 'wx' });
      console.log(`Local boundary report written to ${args[2]}; production certification remains pending.`);
    } else process.stdout.write(serialized);
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
