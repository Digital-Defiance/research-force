// Feature: research-collab-cms, Property 97: Retention_Table matches the retention constants
import { expect, it } from 'vitest';
import { fc } from '@researchforce/testing/fc';
import { RETENTION, retentionRows } from '../../src/retention';
import type { RetentionConfiguration, RetentionKind, RetentionRule } from '../../src/retention';

function numbers(rule: RetentionRule): number[] {
  if (rule.kind === 'combined') return rule.rules.flatMap(numbers);
  if (rule.kind === 'period') return [rule.amount];
  if (rule.kind === 'window') return [rule.minimum, rule.maximum];
  if (rule.kind === 'count') return [rule.count];
  return [];
}

it('generates exactly the configured periods, windows, ending events and unlimited policies', () => {
  fc.assert(fc.property(fc.array(fc.integer({ min: 1, max: 500 }), { minLength: 16, maxLength: 16 }), fc.boolean(), (values, variant) => {
    const n = (i: number) => values[i]!;
    const upload = [n(3), n(4)].sort((a, b) => a - b);
    const email = [n(7), n(8)].sort((a, b) => a - b);
    const config: RetentionConfiguration = {
      ...RETENTION, sessions: { validHours: n(0), purgeDaysAfterEnd: n(1) }, downloadLinks: { validMinutes: n(2) },
      abandonedOutsideUploads: { minHours: upload[0]!, maxHours: upload[1]! }, networkAddresses: { maxHours: n(5) },
      pendingOutsideSubmissions: { until: variant ? 'a synthetic final decision' : 'a final review' },
      finalDecisionFilesAndEmail: { filesWithinHours: n(6), emailMinDays: email[0]!, emailMaxDays: email[1]! },
      finalDecisionText: { reason: variant ? 'retained as a decision record' : 'retained as research history' },
      acceptedOtherSubmissions: { until: variant ? 'neither a submission nor a credited Item exists' : 'both referenced records are gone' },
      responseLinks: { validDays: n(9), tokenPurgeDaysAfterExpiry: n(10) }, publicExports: { requestedDays: n(11), scheduledCompleteCount: n(12) },
      internalBackups: { days: n(13), deleteWithinHours: n(14) }, timeTravel: { days: n(15) }, deletedItemFiles: { withinHours: n(0) },
    };
    const expected: Record<RetentionKind, number[]> = {
      sessions: [n(0), n(1)], downloadLinks: [n(2)], abandonedOutsideUploads: upload, networkAddresses: [n(5)],
      pendingOutsideSubmissions: [], finalDecisionFilesAndEmail: [n(6), ...email], finalDecisionText: [], acceptedOtherSubmissions: [],
      responseLinks: [n(9), n(10)], publicExports: [n(11), n(12)], internalBackups: [n(13), n(14)], timeTravel: [n(15)],
      deletedItemFiles: [n(0)], memberAccountsAndProfiles: [], externalParties: [],
    };
    const rows = retentionRows(config);
    expect(rows.map((row) => row.kind).sort()).toEqual(Object.keys(expected).sort());
    expect(new Set(rows.map((row) => row.kind)).size).toBe(rows.length);
    for (const row of rows) {
      expect(numbers(row.rule)).toEqual(expected[row.kind]);
      expect((row.statement.match(/\d+/g) ?? []).map(Number)).toEqual(expected[row.kind]);
      expect(row.data.length).toBeGreaterThan(0);
      if (row.rule.kind === 'unlimited') expect(row.statement).toContain('No time limit');
    }
    const statement = (kind: RetentionKind) => rows.find((row) => row.kind === kind)!.statement;
    expect(statement('pendingOutsideSubmissions')).toContain(config.pendingOutsideSubmissions.until);
    expect(statement('acceptedOtherSubmissions')).toContain(config.acceptedOtherSubmissions.until);
    expect(statement('finalDecisionText')).toContain(config.finalDecisionText.reason);
    expect(statement('memberAccountsAndProfiles')).toContain(config.memberAccountsAndProfiles.reason);
    expect(statement('externalParties')).toContain(config.externalParties.reason);
  }));
});
