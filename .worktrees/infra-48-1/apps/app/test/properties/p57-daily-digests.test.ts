// Feature: research-collab-cms, Property 57: Daily_Digests list each event once
import { describe, expect, it } from 'vitest';
import { GuardedBatch } from '@researchforce/db/batch';
import { asTimestamp } from '@researchforce/domain/types';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { queueDigests } from '../../src/mail/digest';
import { notifyAdministratorsReminder } from '../../src/notifications/fanout';
import { itemWorld } from '../items';
import { resetRecords } from '../units';

/**
 * Validates R20.4, R20.5, R20.13: a Member's Daily_Digest events are listed in one digest once their local digest hour has passed,
 * each event in exactly one digest and none after its digest hour has yet to pass, and no digest is made when nothing qualifies.
 */
const world = itemWorld();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const START = Date.parse(world.at);
/** Zones that keep one offset all year, so that the model can compute the digest hour without `Intl`. */
const ZONES: readonly (readonly [string, number])[] = [['UTC', 0], ['Asia/Kolkata', 5.5 * HOUR], ['Asia/Kathmandu', 5.75 * HOUR], ['Etc/GMT+5', -5 * HOUR], ['Asia/Tokyo', 9 * HOUR]];
type Step = { readonly t: 'event' | 'check'; readonly advance: number };
const stepArb: fc.Arbitrary<Step> = fc.record({ t: fc.constantFrom<'event' | 'check'>('event', 'check', 'check'), advance: fc.integer({ min: 0, max: 20 * 60 }) });

/** The latest instant at or before `at` when the zone's clock shows `hour`:00. */
const boundary = (at: number, offset: number, hour: number): number => {
  const local = at + offset;
  const day = Math.floor(local / DAY) * DAY + hour * HOUR;
  return (day <= local ? day : day - DAY) - offset;
};

describe('Property 57: Daily_Digests list each event once', () => {
  it('queues one digest per passed digest hour with exactly the unlisted earlier events', async () => {
    const core = () => world.bindings.RF_CORE;
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: ZONES.length - 1 }), fc.integer({ min: 0, max: 23 }), fc.array(stepArb, { minLength: 1, maxLength: 12 }), async (zoneIndex, hour, steps) => {
      const [zone, offset] = ZONES[zoneIndex]!;
      await resetRecords(core());
      await core().prepare('DELETE FROM notification_prefs').run();
      await core().prepare("INSERT INTO notification_prefs (member_id, event_type, in_app, email) VALUES (?1, 'reminder', 1, 'daily_digest')").bind(world.ids.admin).run();
      await core().prepare('UPDATE profiles SET time_zone = ?2, digest_hour = ?3 WHERE member_id = ?1').bind(world.ids.admin, zone, hour).run();
      const events: { at: number; listed: boolean }[] = [];
      let lastBoundary = -Infinity;
      let digests = 0;
      let clock = START;
      for (const step of steps) {
        clock += step.advance * MIN;
        if (step.t === 'event') {
          const batch = new GuardedBatch(core(), { id: null, now: asTimestamp(new Date(clock).toISOString()) });
          notifyAdministratorsReminder(batch, 'backup_due', {});
          await batch.commit();
          events.push({ at: clock, listed: false });
        } else {
          const made = await queueDigests(core(), asTimestamp(new Date(clock).toISOString()));
          const b = boundary(clock, offset, hour);
          const due = events.filter((event) => !event.listed && event.at < b);
          if (b > lastBoundary && due.length > 0) {
            for (const event of due) event.listed = true;
            lastBoundary = b;
            digests += 1;
            expect(made).toBe(1);
          } else {
            expect(made).toBe(0);
          }
        }
      }
      const rows = (await core().prepare("SELECT at, email_batch_id AS batch, digest_sent_at AS sent FROM notification_events ORDER BY at, id").all<{ at: string; batch: string | null; sent: string | null }>()).results;
      expect(rows).toHaveLength(events.length);
      const batches = (await core().prepare("SELECT id, group_key AS key FROM email_batches").all<{ id: string; key: string }>()).results;
      expect(batches).toHaveLength(digests);
      for (const batch of batches) {
        const mine = rows.filter((row) => row.batch === batch.id);
        const limit = Date.parse(batch.key.slice('digest:'.length));
        expect(mine.length).toBeGreaterThan(0);
        for (const row of mine) { expect(Date.parse(row.at)).toBeLessThan(limit); expect(row.sent).not.toBeNull(); }
      }
      expect(rows.filter((row) => row.batch !== null)).toHaveLength(events.filter((event) => event.listed).length);
      expect(rows.filter((row) => row.batch === null && row.sent !== null)).toEqual([]);
    }), { numRuns: Math.min(FC_RUNS, 60) });
  }, 600 * FC_RUNS);
});
