// Feature: research-collab-cms, Task 67.3 — the PURE decisions for reference-safe operational retention (R28.8,
// R28.17, R57.2, R60.7, R60.8): the 30d/90d windows sourced from the one retention-config, the reference-safety guard
// that refuses to remove anything a live citation/release/proposal/backup still references, the operational-record
// partition, and the 90-day failure-metadata aggregation. No D1 or R2 is touched.
import { describe, expect, it } from 'vitest';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { RETENTION } from '@researchforce/domain/retention';
import {
  NO_LIVE_REFERENCES, OPERATIONAL_RETENTION, RECONCILED_EXTERNAL_STATES, UNRECONCILED_EXTERNAL_STATES,
  failureMetadataToAggregate, isReconciled, partitionOperationalRecords, referenceSafe, referencedBy, retentionCutoff,
} from '../src/jobs/operational-retention';
import type { FailureRecord, LiveReferences, OperationalRecord } from '../src/jobs/operational-retention';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = '2027-06-01T00:00:00.000Z';
const atDays = (days: number): string => new Date(Date.parse(NOW) - days * DAY_MS).toISOString();
const live = (over: Partial<Record<keyof LiveReferences, string[]>> = {}): LiveReferences => ({
  citations: new Set(over.citations ?? []), releases: new Set(over.releases ?? []),
  proposals: new Set(over.proposals ?? []), backups: new Set(over.backups ?? []),
});

describe('the retention windows come from the one retention-config source (R60.8)', () => {
  it('reads 30d reconciled payloads, 30d closed checkpoints, 90d failure metadata from RETENTION, not a literal', () => {
    expect(OPERATIONAL_RETENTION.reconciledPayloadDays).toBe(RETENTION.operationalRecords.reconciledPayloadDays);
    expect(OPERATIONAL_RETENTION.closedCheckpointDays).toBe(RETENTION.operationalRecords.closedCheckpointDays);
    expect(OPERATIONAL_RETENTION.failureMetadataDays).toBe(RETENTION.operationalRecords.failureMetadataDays);
    expect(OPERATIONAL_RETENTION).toMatchObject({ reconciledPayloadDays: 30, closedCheckpointDays: 30, failureMetadataDays: 90 });
  });

  it('computes an ISO cutoff `now - days` and rejects a bad clock', () => {
    expect(retentionCutoff(NOW, 30)).toBe(atDays(30));
    expect(() => retentionCutoff('not-a-time', 30)).toThrow(RangeError);
  });
});

describe('reconciled vs in-flight side-effect states (R60.2, R60.8)', () => {
  it('treats accepted/confirmed/failed as reconciled and pending/uncertain as in flight', () => {
    for (const state of RECONCILED_EXTERNAL_STATES) expect(isReconciled(state)).toBe(true);
    for (const state of UNRECONCILED_EXTERNAL_STATES) expect(isReconciled(state)).toBe(false);
  });
});

describe('the reference-safety guard refuses to remove a live dependency (R28.8, R60.8)', () => {
  it('reports which live dependency pins an id, or null when none does, in a deterministic order', () => {
    expect(referencedBy('v1', live({ citations: ['v1'] }))).toBe('citation');
    expect(referencedBy('v1', live({ releases: ['v1'] }))).toBe('release');
    expect(referencedBy('v1', live({ proposals: ['v1'] }))).toBe('proposal');
    expect(referencedBy('v1', live({ backups: ['v1'] }))).toBe('backup');
    expect(referencedBy('v1', live())).toBeNull();
    // Citation wins the deterministic order when several sets name the same id.
    expect(referencedBy('v1', live({ citations: ['v1'], backups: ['v1'] }))).toBe('citation');
  });

  it('refuses a candidate whose own id is referenced by any live dependency', () => {
    for (const key of ['citations', 'releases', 'proposals', 'backups'] as const) {
      expect(referenceSafe('x', live({ [key]: ['x'] }))).toBe(false);
    }
    expect(referenceSafe('x', NO_LIVE_REFERENCES)).toBe(true);
  });

  it('refuses a candidate that would FREE a referenced id when removed', () => {
    // The candidate id is free, but removing it would free `v9`, which a live citation pins.
    expect(referenceSafe('op1', live({ citations: ['v9'] }), ['v9'])).toBe(false);
    // With no live reference on the freed id, the removal is safe.
    expect(referenceSafe('op1', live({ citations: ['other'] }), ['v9'])).toBe(true);
  });
});

describe('partitionOperationalRecords applies both the window and the guard (R60.8)', () => {
  const cutoff = atDays(30);
  const records: OperationalRecord[] = [
    { id: 'due-safe', at: atDays(31) },
    { id: 'due-referenced', at: atDays(40), frees: ['v-cited'] },
    { id: 'not-due', at: atDays(10) },
  ];

  it('removes only due AND reference-safe records, recording why each retained record stayed', () => {
    const { remove, retained } = partitionOperationalRecords(records, cutoff, live({ citations: ['v-cited'] }));
    expect(remove).toEqual(['due-safe']);
    expect(retained).toEqual(expect.arrayContaining([
      { id: 'due-referenced', reason: 'referenced' },
      { id: 'not-due', reason: 'not_due' },
    ]));
  });

  it('never returns a referenced id in `remove`, for any window and reference set (property)', () => {
    fc.assert(
      fc.property(
        // Record ids are unique in every real table, so the generator keeps them unique; a duplicated id would make
        // the lookup below find the wrong record and fail at random.
        fc.uniqueArray(fc.record({ id: fc.string({ minLength: 1, maxLength: 6 }), dayOffset: fc.integer({ min: 0, max: 400 }) }), { maxLength: 40, selector: (row) => row.id }),
        fc.array(fc.string({ minLength: 1, maxLength: 6 }), { maxLength: 20 }),
        fc.integer({ min: 0, max: 400 }),
        (rows, referencedIds, cutoffDays) => {
          const referenced = new Set(referencedIds);
          const cut = atDays(cutoffDays);
          const candidates: OperationalRecord[] = rows.map((row) => ({ id: row.id, at: atDays(row.dayOffset) }));
          const liveSet = live({ citations: [...referenced] });
          const { remove } = partitionOperationalRecords(candidates, cut, liveSet);
          // No referenced id is ever removed, regardless of age.
          for (const id of remove) expect(referenced.has(id)).toBe(false);
          // Everything removed was due (at <= cutoff) and reference-safe.
          for (const id of remove) {
            const record = candidates.find((candidate) => candidate.id === id)!;
            expect(record.at <= cut).toBe(true);
            expect(referenceSafe(id, liveSet)).toBe(true);
          }
        },
      ),
      { numRuns: Math.min(FC_RUNS, 60) },
    );
  });
});

describe('failure-metadata aggregation folds then drops at 90 days (R60.6, R60.8)', () => {
  const cutoff = atDays(90);
  const failure = (id: string, kind: string, detail: string, days: number): FailureRecord => ({ id, kind, detail, at: atDays(days) });

  it('folds expired failures into content-free (kind, detail) buckets with counts and windows, dropping the rows', () => {
    const failures = [
      failure('f1', 'mail', 'status-503', 120),
      failure('f2', 'mail', 'status-503', 100),
      failure('f3', 'mail', 'not-sent', 95),
      failure('recent', 'mail', 'status-503', 10), // within the 90-day window: untouched
    ];
    const { aggregates, dropIds } = failureMetadataToAggregate(failures, cutoff);
    expect(dropIds).toEqual(['f1', 'f2', 'f3']);
    // Buckets are stable by (kind, detail); the 503 bucket counts two, its window spans the oldest to newest folded.
    expect(aggregates).toEqual([
      { kind: 'mail', detail: 'not-sent', count: 1, firstAt: atDays(95), lastAt: atDays(95) },
      { kind: 'mail', detail: 'status-503', count: 2, firstAt: atDays(120), lastAt: atDays(100) },
    ]);
  });

  it('keeps no detail body larger than a content-free code and leaves rows within the window', () => {
    const { aggregates, dropIds } = failureMetadataToAggregate([failure('recent', 'mail', 'status-503', 30)], cutoff);
    expect(aggregates).toEqual([]);
    expect(dropIds).toEqual([]);
  });
});
