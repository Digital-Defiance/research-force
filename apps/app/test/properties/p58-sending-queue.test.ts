// Feature: research-collab-cms, Property 58: the sending queue respects every limit
import { describe, expect, it } from 'vitest';
import { asTimestamp, asULID } from '@researchforce/domain/types';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { ATTEMPTS_PER_MINUTE, MemoryAttemptLog, RECIPIENT_WINDOW_MS, runQueue } from '../../src/mail/mailer';
import type { EmailMessage, EmailProvider } from '../../src/mail/provider';
import { addMember } from '../api';
import { itemWorld } from '../items';
import { resetRecords } from '../units';

/**
 * Validates R20.15, R20.16, R20.17, R20.18: over any queue, cap, and run times, no 60 seconds hold more than 30 attempts, no 24 hours
 * address more recipients than the Recipient_Cap, emails go oldest first, and the time the limits held an email is what it is told.
 */
const world = itemWorld();
const MIN = 60_000;
const START = Date.parse(world.at);

describe('Property 58: the sending queue respects every limit', () => {
  it('sends oldest first within 30 attempts a minute and the Recipient_Cap a day, and records held time', async () => {
    const core = () => world.bindings.RF_CORE;
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 1, max: 70 }), fc.integer({ min: 1, max: 80 }), fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 70, maxLength: 70 }),
      async (count, cap, gaps) => {
        await resetRecords(core());
        await core().prepare('DELETE FROM outgoing_emails').run();
        await core().prepare("DELETE FROM members WHERE email LIKE 'queue%@example.test'").run();
        await core().prepare("INSERT INTO settings (key, value, updated_at, updated_seq) VALUES ('recipientCap', ?1, ?2, 0) ON CONFLICT (key) DO UPDATE SET value = ?1").bind(String(cap), world.at).run();
        const made: { email: string; createdAt: number; id: string }[] = [];
        let created = START;
        for (let index = 0; index < count; index++) {
          created += gaps[index]! * 1000;
          const at = new Date(created).toISOString();
          const email = `queue${index}@example.test`;
          const member = await addMember(core(), email, 'pending', asTimestamp(at));
          const id = asULID(`01M5Z89R80${index.toString(16).toUpperCase().padStart(16, '0')}`);
          await core().prepare("INSERT INTO outgoing_emails (id, kind, recipient, member_id, payload_ref, state, attempts, created_at, sendable_at, held_ms, updated_seq) VALUES (?1, 'invitation', ?2, ?3, ?4, 'queued', 0, ?5, ?5, 0, 0)")
            .bind(id, email, member, `invitation:${member}`, at).run();
          made.push({ email, createdAt: created, id });
        }
        let clock = created;
        const sent: { to: string; at: number }[] = [];
        const provider: EmailProvider = { async send(message: EmailMessage) { sent.push({ to: message.to, at: clock }); return { ok: true }; } };
        const log = new MemoryAttemptLog();
        const deps = { db: core(), origin: 'https://app.example.test', log, provider: () => provider };
        for (let pass = 0; pass < 100; pass++) {
          const wake = await runQueue(deps, clock);
          if (wake === null) break;
          clock = Math.max(wake, clock + 1);
        }
        // Oldest first.
        expect(sent.map((attempt) => attempt.to)).toEqual([...made].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).map((email) => email.email).slice(0, sent.length));
        // Sliding windows.
        for (const [index, attempt] of sent.entries()) {
          expect(sent.filter((other, at) => at <= index && other.at > attempt.at - MIN).length).toBeLessThanOrEqual(ATTEMPTS_PER_MINUTE);
          expect(sent.filter((other, at) => at <= index && other.at > attempt.at - RECIPIENT_WINDOW_MS).length).toBeLessThanOrEqual(cap);
        }
        expect(sent).toHaveLength(count); // nothing is lost, only delayed
        const held = new Map((await core().prepare('SELECT recipient, held_ms AS held, created_at AS createdAt FROM outgoing_emails').all<{ recipient: string; held: number; createdAt: string }>()).results.map((row) => [row.recipient, row]));
        for (const attempt of sent) {
          const row = held.get(attempt.to)!;
          // Held time never exceeds the time spent waiting, and an email sent the moment it was queued was held not at all.
          expect(row.held).toBeLessThanOrEqual(attempt.at - Date.parse(row.createdAt));
          if (attempt.at === Date.parse(row.createdAt)) expect(row.held).toBe(0);
        }
      }), { numRuns: Math.min(FC_RUNS, 12) });
  });
});
