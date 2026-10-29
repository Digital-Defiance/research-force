// Feature: research-collab-cms, Property 56: Email batching partitions events correctly
import { describe, expect, it } from 'vitest';
import { GuardedBatch } from '@researchforce/db/batch';
import { asTimestamp } from '@researchforce/domain/types';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { notifyAdministratorsReminder, notifyOwnersReminder } from '../../src/notifications/fanout';
import { itemWorld } from '../items';
import { addProject, resetRecords } from '../units';

/**
 * Validates R20.1, R20.2, R20.3, R20.12: every Immediate event belongs to exactly one email batch of its recipient and group;
 * a batch's window starts at its first event and keeps the length in force then; an event inside the window joins the batch
 * and an event after it opens a new one.
 */
const world = itemWorld();
const MIN = 60_000;
const START = Date.parse(world.at);
type Group = 'alert' | 'root0' | 'root1';
interface Step { readonly gapMinutes: number; readonly group: Group; readonly window: number | undefined }
const stepArb: fc.Arbitrary<Step> = fc.record({
  gapMinutes: fc.integer({ min: 0, max: 40 }), group: fc.constantFrom<Group>('alert', 'root0', 'root1'), window: fc.option(fc.integer({ min: 1, max: 60 }), { nil: undefined }),
});

describe('Property 56: Email batching partitions events correctly', () => {
  it('puts every event in one batch whose window copies the setting from its first event', async () => {
    const core = () => world.bindings.RF_CORE;
    await fc.assert(fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 10 }), async (steps) => {
      await resetRecords(core());
      await core().prepare("DELETE FROM settings WHERE key = 'emailBatchWindow'").run();
      const projectId = await addProject(core(), world.ids.admin, world.at);
      const roots = [(await world.created('author', 'finding', { projectId })).id, (await world.created('author', 'run', { projectId })).id];
      await core().prepare('DELETE FROM notification_events').run();
      await core().prepare('DELETE FROM email_batches').run();
      interface Model { key: string; start: number; minutes: number; events: number }
      const model = new Map<string, Model[]>();
      let clock = START;
      let minutes = 5;
      const expectedBatches: Model[] = [];
      for (const step of steps) {
        clock += step.gapMinutes * MIN;
        if (step.window !== undefined) {
          minutes = step.window;
          await core().prepare("INSERT INTO settings (key, value, updated_at, updated_seq) VALUES ('emailBatchWindow', ?1, ?2, 0) ON CONFLICT (key) DO UPDATE SET value = ?1").bind(String(minutes), world.at).run();
        }
        const batch = new GuardedBatch(core(), { id: null, now: asTimestamp(new Date(clock).toISOString()) });
        if (step.group === 'alert') notifyAdministratorsReminder(batch, 'backup_due', {});
        else notifyOwnersReminder(batch, [roots[step.group === 'root0' ? 0 : 1]!], { reminder: 'x' });
        await batch.commit();
        const member = step.group === 'alert' ? world.ids.admin : world.ids.author;
        const key = `${member}|${step.group === 'alert' ? 'alert' : `root:${roots[step.group === 'root0' ? 0 : 1]}`}`;
        const list = model.get(key) ?? [];
        const open = list.at(-1);
        if (open !== undefined && clock < open.start + open.minutes * MIN) open.events += 1;
        else { const next = { key, start: clock, minutes, events: 1 }; list.push(next); expectedBatches.push(next); }
        model.set(key, list);
      }
      const stored = (await core().prepare("SELECT member_id AS member, group_key AS key, window_start AS start, window_minutes AS minutes, window_end AS end, id FROM email_batches ORDER BY window_start, id").all<{ member: string; key: string; start: string; minutes: number; end: string; id: string }>()).results;
      const counts = Object.fromEntries((await core().prepare('SELECT email_batch_id AS id, count(*) AS n FROM notification_events GROUP BY email_batch_id').all<{ id: string | null; n: number }>()).results.map((row) => [row.id, row.n]));
      expect(counts['null' as never], 'events outside any batch').toBeUndefined();
      expect(stored).toHaveLength(expectedBatches.length);
      const wanted = expectedBatches.map((entry) => `${entry.key}|${new Date(entry.start).toISOString()}|${entry.minutes}|${entry.events}`).sort();
      const found = stored.map((row) => `${row.member}|${row.key}|${row.start}|${row.minutes}|${counts[row.id] ?? 0}`).sort();
      expect(found).toEqual(wanted);
      for (const row of stored) expect(Date.parse(row.end) - Date.parse(row.start)).toBe(row.minutes * MIN);
      expect((await core().prepare('SELECT count(*) AS n FROM notification_events WHERE email_batch_id IS NULL').first<number>('n'))).toBe(0);
    }), { numRuns: Math.min(FC_RUNS, 40) });
  }, 600 * FC_RUNS);
});
