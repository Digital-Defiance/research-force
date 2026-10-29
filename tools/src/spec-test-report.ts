import { relative } from 'node:path';
import { z } from 'zod';
import { safePath, testReportSchema } from './specs';

const rawSchema = z.object({
  success: z.literal(true), startTime: z.number().finite().positive(),
  numFailedTests: z.literal(0), numPendingTests: z.literal(0), numTodoTests: z.literal(0),
  numPassedTests: z.number().int().positive(), numTotalTests: z.number().int().positive(),
  testResults: z.array(z.object({ name: z.string(), status: z.literal('passed'),
    assertionResults: z.array(z.object({ status: z.literal('passed') })).min(1) })).min(1),
});

/** Retain counts and checkout-relative fingerprints, never test inputs, console output or failure messages. */
export function sanitizeTestReport(raw: unknown, root: string, files: Readonly<Record<string, string>>) {
  const result = rawSchema.parse(raw);
  const suites = result.testResults.map((suite) => {
    const path = relative(root, suite.name).replaceAll('\\', '/');
    if (!safePath(path) || !/\/test\/.*\.test\.[cm]?[jt]sx?$/u.test(path)) throw new Error('Executed suites must be test files inside this checkout.');
    return { path, passed: suite.assertionResults.length, failed: 0 as const, skipped: 0 as const };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const total = suites.reduce((sum, suite) => sum + suite.passed, 0);
  if (total !== result.numTotalTests || total !== result.numPassedTests || new Set(suites.map((s) => s.path)).size !== suites.length) throw new Error('Inconsistent executed test counts or duplicate suites.');
  return testReportSchema.parse({ schemaVersion: 1,
    command: 'npm test -- --reporter=json --outputFile=<temporary report>',
    recordedAt: new Date(result.startTime).toISOString(), scope: 'local-synthetic', success: true, suites, files });
}
