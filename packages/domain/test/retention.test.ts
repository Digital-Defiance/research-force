import { expect, it } from 'vitest';
import { RETENTION, retentionRows } from '../src/retention';

it('states decision-based and lifetime retention, including independent link and token lifetimes', () => {
  const rows = retentionRows();
  expect(rows).toHaveLength(19);
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
  const data = (kind: typeof rows[number]['kind']) => rows.find((row) => row.kind === kind)!.data;
  // The Submitter_Attribution (name and affiliation) is kept with the Items; the Submitter_Contact (email) is a separate row (R46.19).
  expect(data('acceptedOtherSubmissions')).toContain('Submitter Attribution');
  expect(data('submitterContact')).toContain('Submitter Contact');
  // The Submitter_Contact row: the email reviewed every 12 months, kept with a reason or erased within 24 hours (R46.19, R32.19).
  expect(text('submitterContact')).toContain('Reviewed every 12 months');
  expect(text('submitterContact')).toContain('24 hours after an Erase Contact Review');
  expect(text('finalDecisionText')).toMatch(/^No time limit/);
  // The Contact_Email and Consent_Request rows, kept for the Party's life with token hashes purged (R46.19, R51.1, R51.13).
  expect(text('contactEmails')).toContain('an Administrator erases it or the External Party is deleted');
  expect(text('consentRequests')).toContain('Keep until the External Party exists');
  expect(text('consentRequests')).toContain('Delete token hashes 30 days after the links expire');
  // The operational-records row (R60.8, task 67.3): reconciled payloads at 30 days, closed checkpoints at 30 days,
  // failure metadata aggregated then dropped at 90 days.
  expect(text('operationalRecords')).toContain('Expire reconciled payloads 30 days after reconciliation');
  expect(text('operationalRecords')).toContain('keep job checkpoints while active and then 30 days after the job closes');
  expect(text('operationalRecords')).toContain('aggregate then drop failure metadata 90 days after the failure');
});

it('refuses malformed retention windows and invalid periods rather than publishing inaccurate claims', () => {
  expect(() => retentionRows({ ...RETENTION, downloadLinks: { validMinutes: NaN } })).toThrow(RangeError);
  expect(() => retentionRows({ ...RETENTION, abandonedOutsideUploads: { minHours: 48, maxHours: 24 } })).toThrow(RangeError);
  expect(() => retentionRows({ ...RETENTION, pendingOutsideSubmissions: { until: '' } })).toThrow(RangeError);
});
