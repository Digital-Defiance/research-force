// Feature: research-collab-cms, Task 58.2 — the PURE tiered-retention selector for Internal_Backup independent
// recovery points (R36.3). These are pure unit tests of the 14-daily / 8-weekly / 12-monthly selection and the
// successor-verified-before-expiry rule; no D1 or R2 is touched.
import { describe, expect, it } from 'vitest';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { RETENTION, pointsToExpire, retentionKeep } from '../src/jobs/backup-retention';
import type { RetentionPoint } from '../src/jobs/backup-retention';

/** A verified recovery point with a given verification time. */
const point = (id: string, verifiedAt: string): RetentionPoint => ({ id, verifiedAt });

/** `n` daily points, one per consecutive UTC day ending at `lastDay` (inclusive), newest id first by day. */
function dailyRun(count: number, lastDay = '2026-12-31'): RetentionPoint[] {
  const base = new Date(`${lastDay}T12:00:00.000Z`).getTime();
  return Array.from({ length: count }, (_v, i) => point(`d${i}`, new Date(base - i * 24 * 60 * 60 * 1000).toISOString()));
}

describe('retention tier counts come from the one growth-model source (R36.3)', () => {
  it('keeps 14 daily, 8 weekly, 12 monthly', () => {
    expect(RETENTION.daily).toBe(14);
    expect(RETENTION.weekly).toBe(8);
    expect(RETENTION.monthly).toBe(12);
    expect(RETENTION.transientDays).toBe(7);
  });
});

describe('retentionKeep — the daily tier (R36.3)', () => {
  it('keeps the newest 14 distinct daily periods', () => {
    const points = dailyRun(20); // 20 consecutive days, newest = d0
    const keep = retentionKeep(points);
    // The 14 newest days are kept across tiers (also covered by weekly/monthly); the oldest 6 daily-only ones are not.
    for (let i = 0; i < 14; i++) expect(keep.has(`d${i}`)).toBe(true);
  });

  it('keeps the newest point of a day when two points verify on the same day', () => {
    const points = [
      point('early', '2026-12-10T01:00:00.000Z'),
      point('late', '2026-12-10T23:00:00.000Z'),
    ];
    const keep = retentionKeep(points);
    expect(keep.has('late')).toBe(true);
    expect(keep.has('early')).toBe(false); // the earlier same-day point is not the daily representative
  });
});

describe('retentionKeep — weekly and monthly tiers, shared points count across tiers (R36.3)', () => {
  it('keeps monthly representatives older than the daily/weekly horizon, dropping beyond 12 months', () => {
    // 14 recent daily points (filling the daily tier) PLUS one point per month going back further, so the monthly
    // tier is what decides the older points. The 12 newest months are kept; older months are not.
    const recent = dailyRun(14, '2027-04-14'); // 14 consecutive days in April 2027 -> fills daily, covers ~2 months
    const monthly = Array.from({ length: 16 }, (_v, i) => {
      const date = new Date(Date.UTC(2027, 1 - i, 1, 12)); // Feb 2027 going back, one per month
      return point(`m${i}`, date.toISOString());
    });
    const keep = retentionKeep([...recent, ...monthly]);
    // The monthly tier keeps the 12 newest distinct months among ALL points. April and March 2027 come from `recent`,
    // then Feb 2027 (m0) back through the 10th month; m9 is the 12th-newest month overall and is kept, m10+ are not.
    expect(keep.has('m9'), 'the 12th-newest month is kept').toBe(true);
    expect(keep.has('m12'), 'a month beyond the 12 newest is dropped').toBe(false);
    expect(keep.has('m15'), 'the oldest month is dropped').toBe(false);
  });

  it('a single point shared across tiers is kept once and counted for each tier', () => {
    const only = [point('solo', '2026-12-31T12:00:00.000Z')];
    const keep = retentionKeep(only);
    expect([...keep]).toEqual(['solo']); // it is the daily, weekly, and monthly representative, kept once
  });
});

describe('pointsToExpire — successor-verified-before-expiry (R36.3)', () => {
  it('never expires the single newest verified point (there is always a verified point)', () => {
    expect(pointsToExpire(dailyRun(1))).toEqual([]);
    const many = dailyRun(40);
    const expire = pointsToExpire(many);
    // d0 is the newest; it is never expired.
    expect(expire).not.toContain('d0');
  });

  it('expires only points outside the keep set that have a newer verified successor', () => {
    const points = dailyRun(20); // 20 consecutive days
    const expire = new Set(pointsToExpire(points));
    // The 14 newest daily representatives are kept; monthly/weekly tiers keep more of the recent ones, so only the
    // oldest daily-only points (beyond all tiers) with a newer successor are expired.
    expect(expire.has('d0')).toBe(false); // newest, no successor
    // Every expired point is strictly older than the newest and not in the keep set.
    const keep = retentionKeep(points);
    for (const id of expire) expect(keep.has(id)).toBe(false);
  });

  it('keeps everything while coverage is not yet full', () => {
    // 10 daily points: fewer than 14, so the daily tier keeps all of them; nothing expires.
    expect(pointsToExpire(dailyRun(10))).toEqual([]);
  });
});

describe('property: expiry preserves at least one verified point and never drops a kept point (R36.3)', () => {
  it('for any set of verified points, the newest survives and no kept point is expired', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 2000 }), { minLength: 1, maxLength: 60 }),
        (dayOffsets) => {
          const base = Date.parse('2027-01-01T12:00:00.000Z');
          const points = dayOffsets.map((offset, i) => point(`p${i}`, new Date(base - offset * 24 * 60 * 60 * 1000).toISOString()));
          const expire = new Set(pointsToExpire(points));
          const keep = retentionKeep(points);
          // No kept point is expired.
          for (const id of keep) expect(expire.has(id)).toBe(false);
          // At least one verified point always survives (the recovery set is never emptied).
          expect(expire.size).toBeLessThan(points.length);
          // The strictly-newest point (break ties by id) is never expired.
          const newest = [...points].sort((a, b) => (a.verifiedAt < b.verifiedAt ? 1 : a.verifiedAt > b.verifiedAt ? -1 : a.id < b.id ? 1 : -1))[0]!;
          expect(expire.has(newest.id)).toBe(false);
        },
      ),
      { numRuns: Math.min(FC_RUNS, 40) },
    );
  });
});
