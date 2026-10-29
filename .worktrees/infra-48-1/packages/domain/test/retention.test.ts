import { expect, it } from 'vitest';
import { RETENTION, retentionRows } from '../src/retention';

it('states decision-based and lifetime retention, including independent link and token lifetimes', () => {
  const rows = retentionRows();
  expect(rows).toHaveLength(15);
  const text = (kind: typeof rows[number]['kind']) => rows.find((row) => row.kind === kind)!.statement;
  expect(text('sessions')).toContain('earlier on logout');
  expect(text('sessions')).toContain('7 days after the session ends');
  expect(text('responseLinks')).toContain('30 days after sending');
  expect(text('responseLinks')).toContain('30 days after expiry');
  expect(text('publicExports')).toContain('7 days after the requested export starts');
  expect(text('publicExports')).toContain('3 most recent complete scheduled exports');
  expect(text('internalBackups')).toContain('7 days after the backup is produced or marked incomplete');
  expect(text('internalBackups')).toContain('1 hour after that retention period ends');
  expect(text('acceptedOtherSubmissions')).toContain('neither the Outside Submission nor a credited Item exists');
  expect(text('finalDecisionText')).toMatch(/^No time limit/);
});

it('refuses malformed retention windows and invalid periods rather than publishing inaccurate claims', () => {
  expect(() => retentionRows({ ...RETENTION, downloadLinks: { validMinutes: NaN } })).toThrow(RangeError);
  expect(() => retentionRows({ ...RETENTION, abandonedOutsideUploads: { minHours: 48, maxHours: 24 } })).toThrow(RangeError);
  expect(() => retentionRows({ ...RETENTION, pendingOutsideSubmissions: { until: '' } })).toThrow(RangeError);
});
