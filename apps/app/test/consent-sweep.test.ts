// Feature: research-collab-cms, Task 56.6 — the hourly Consent_Request reminder, expiry, and token clean-up (R51.11, R51.13).
import { beforeEach, describe, expect, it } from 'vitest';
import { newULID } from '@researchforce/domain/identifiers';
import { CONSENT_REQUEST_LIMITS } from '@researchforce/domain/consent-requests';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import { sweepConsentExpiry, sweepConsentReminders, sweepConsentTokens } from '../src/consent/sweep';
import { itemWorld } from './items';

const world = itemWorld();
const DAY_MS = 24 * 60 * 60 * 1000;
const atDays = (days: number) => new Date(Date.parse(world.at) + days * DAY_MS).toISOString() as Timestamp;
const env = () => world.bindings;

// itemWorld's reset leaves the emailed-consent and outgoing-email tables alone, so this suite clears the rows it
// seeds to keep each test independent across the shared database.
beforeEach(async () => {
  await world.core().batch(['consent_withdrawals', 'consent_answers', 'consent_request_items', 'consent_requests', 'outgoing_emails']
    .map((table) => world.core().prepare(`DELETE FROM ${table}`)));
});

/** A 64-hex token hash unique to one request, so the unique token indexes never collide between seeds. */
const hashFor = (id: ULID, suffix: string) => (id + suffix).toLowerCase().replace(/[^0-9a-f]/g, '0').padEnd(64, '0').slice(0, 64);

interface RequestOptions {
  readonly state?: 'sent' | 'answered' | 'cancelled' | 'expired';
  /** Days after the world clock the request was sent; expiry is sending plus consentLinkDays. */
  readonly sentDaysAgo?: number;
  readonly remindedDaysAgo?: number | null;
  /** When answered, the Change_Link expiry; days after the world clock. */
  readonly changeExpiresDays?: number | null;
  /** Queue an original `consent` email carrying the Consent_Link, so a reminder can reuse it. */
  readonly withOriginalEmail?: boolean;
  readonly answeredDaysAgo?: number;
  readonly cancelledDaysAgo?: number;
  readonly expiredDaysAgo?: number;
}

/** An External_Party and a Consent_Request seeded directly, the way the send path would have stored them. */
async function seedRequest(options: RequestOptions = {}): Promise<{ id: ULID; partyId: ULID; consentUrl: string; tokenHash: string }> {
  const now = world.at;
  const id = newULID(now) as ULID;
  const partyId = newULID(now) as ULID;
  const sentAt = atDays(-(options.sentDaysAgo ?? 0));
  const expiresAt = new Date(Date.parse(sentAt) + CONSENT_REQUEST_LIMITS.consentLinkDays * DAY_MS).toISOString();
  const state = options.state ?? 'sent';
  const answered = state === 'answered';
  const changeExpiresAt = options.changeExpiresDays === undefined
    ? (answered ? atDays(365) : null)
    : options.changeExpiresDays === null ? null : atDays(options.changeExpiresDays);
  const tokenHash = hashFor(id, 'c');
  const changeTokenHash = changeExpiresAt === null ? null : hashFor(id, 'k');
  const remindedAt = options.remindedDaysAgo === undefined || options.remindedDaysAgo === null ? null : atDays(-options.remindedDaysAgo);
  const answeredAt = answered ? atDays(-(options.answeredDaysAgo ?? 0)) : null;
  const cancelledAt = state === 'cancelled' ? atDays(-(options.cancelledDaysAgo ?? 0)) : null;
  const expiredAt = state === 'expired' ? atDays(-(options.expiredDaysAgo ?? 0)) : null;

  await world.core().prepare('INSERT INTO external_parties (id, name, name_fold, contact_email, created_at, updated_seq) VALUES (?1, ?2, ?3, ?4, ?5, 0)')
    .bind(partyId, 'A synthetic correspondent', 'a synthetic correspondent', 'party@example.test', now).run();
  await world.core().prepare(
    `INSERT INTO consent_requests (id, party_id, requested_by, kind, contact_email, token_hash, change_token_hash, preview_digest, state, sent_at, expires_at, change_expires_at, reminded_at, answered_at, cancelled_at, expired_at, updated_seq)
     VALUES (?1, ?2, ?3, 'publication', 'party@example.test', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 0)`,
  ).bind(id, partyId, world.ids.admin, tokenHash, changeTokenHash, hashFor(id, 'p'), state, sentAt, expiresAt, changeExpiresAt, remindedAt, answeredAt, cancelledAt, expiredAt).run();

  const consentUrl = `https://submit.researchforce.org/consent#SYNTHETICTOKEN${id}`;
  if (options.withOriginalEmail) {
    await world.core().prepare(
      `INSERT INTO outgoing_emails (id, kind, recipient, payload_ref, state, created_at, sendable_at, updated_seq)
       VALUES (?1, 'consent', 'party@example.test', ?2, 'sent', ?3, ?3, 0)`,
    ).bind(newULID(now), `consent:${id}:${consentUrl}`, sentAt).run();
  }
  return { id, partyId, consentUrl, tokenHash };
}

const requestRow = (id: ULID) => world.core().prepare(
  'SELECT state, reminded_at AS remindedAt, expired_at AS expiredAt, token_hash AS tokenHash, change_token_hash AS changeTokenHash, tokens_deleted_at AS tokensDeletedAt FROM consent_requests WHERE id = ?1',
).bind(id).first<{ state: string; remindedAt: string | null; expiredAt: string | null; tokenHash: string | null; changeTokenHash: string | null; tokensDeletedAt: string | null }>();

const queuedReminders = (id: ULID) => world.core().prepare(
  "SELECT count(*) AS n FROM outgoing_emails WHERE kind = 'consent' AND state = 'queued' AND payload_ref LIKE 'consent:' || ?1 || ':%'",
).bind(id).first<number>('n');

describe('Consent_Request reminders (R51.11)', () => {
  it('sends one reminder with the same Consent_Link 14 days after sending and records reminded_at', async () => {
    const reminderDays = CONSENT_REQUEST_LIMITS.reminderDays;
    const { id, consentUrl } = await seedRequest({ sentDaysAgo: reminderDays, withOriginalEmail: true });
    expect(await sweepConsentReminders(env(), world.at)).toBe(1);
    const row = await requestRow(id);
    expect(row?.remindedAt).toBe(world.at);
    expect(await queuedReminders(id)).toBe(1);
    const reminder = await world.core().prepare("SELECT recipient, payload_ref AS ref FROM outgoing_emails WHERE kind = 'consent' AND state = 'queued'").first<{ recipient: string; ref: string }>();
    expect(reminder?.recipient).toBe('party@example.test');
    // The reminder carries the same Consent_Link URL as the original email (R51.11).
    expect(reminder?.ref).toBe(`consent:${id}:${consentUrl}`);
  });

  it('does not remind before 14 days have passed', async () => {
    const { id } = await seedRequest({ sentDaysAgo: CONSENT_REQUEST_LIMITS.reminderDays - 1, withOriginalEmail: true });
    expect(await sweepConsentReminders(env(), world.at)).toBe(0);
    expect((await requestRow(id))?.remindedAt).toBeNull();
    expect(await queuedReminders(id)).toBe(0);
  });

  it('sends the reminder exactly once across repeated hourly sweeps', async () => {
    const { id } = await seedRequest({ sentDaysAgo: CONSENT_REQUEST_LIMITS.reminderDays, withOriginalEmail: true });
    expect(await sweepConsentReminders(env(), world.at)).toBe(1);
    expect(await sweepConsentReminders(env(), atDays(1))).toBe(0);
    expect(await queuedReminders(id)).toBe(1);
  });

  it('never reminds an answered, cancelled, or expired request', async () => {
    const days = CONSENT_REQUEST_LIMITS.reminderDays;
    await seedRequest({ sentDaysAgo: days, state: 'answered', withOriginalEmail: true });
    await seedRequest({ sentDaysAgo: days, state: 'cancelled', withOriginalEmail: true });
    await seedRequest({ sentDaysAgo: days, state: 'expired', withOriginalEmail: true });
    expect(await sweepConsentReminders(env(), world.at)).toBe(0);
  });
});

describe('Consent_Request expiry (R51.11)', () => {
  it('expires a Sent request once its Consent_Link expiry has passed, recording expired_at', async () => {
    const { id, partyId } = await seedRequest({ sentDaysAgo: CONSENT_REQUEST_LIMITS.consentLinkDays });
    expect(await sweepConsentExpiry(env(), world.at)).toBe(1);
    const row = await requestRow(id);
    expect(row?.state).toBe('expired');
    expect(row?.expiredAt).toBe(world.at);
    // No Consent_Status or Rights_Status is changed; the Party row is untouched by the sweep.
    const party = await world.core().prepare('SELECT contact_email AS email FROM external_parties WHERE id = ?1').bind(partyId).first<{ email: string }>();
    expect(party?.email).toBe('party@example.test');
  });

  it('does not expire a request before its expiry', async () => {
    const { id } = await seedRequest({ sentDaysAgo: CONSENT_REQUEST_LIMITS.consentLinkDays - 1 });
    expect(await sweepConsentExpiry(env(), world.at)).toBe(0);
    expect((await requestRow(id))?.state).toBe('sent');
  });

  it('leaves an already answered or cancelled request alone', async () => {
    await seedRequest({ sentDaysAgo: CONSENT_REQUEST_LIMITS.consentLinkDays, state: 'answered' });
    await seedRequest({ sentDaysAgo: CONSENT_REQUEST_LIMITS.consentLinkDays, state: 'cancelled' });
    expect(await sweepConsentExpiry(env(), world.at)).toBe(0);
  });
});

describe('Consent_Request token clean-up (R51.13)', () => {
  const keep = CONSENT_REQUEST_LIMITS.tokenKeepDays;
  const link = CONSENT_REQUEST_LIMITS.consentLinkDays;

  it('deletes both token hashes 30 days after the Consent_Link expires for an expired request', async () => {
    // Sent so long ago that expiry (sending + 30d) is itself more than 30 days before the clock.
    const { id } = await seedRequest({ sentDaysAgo: link + keep, state: 'expired', changeExpiresDays: null });
    expect(await sweepConsentTokens(env(), world.at)).toBe(1);
    const row = await requestRow(id);
    expect(row?.tokenHash).toBeNull();
    expect(row?.changeTokenHash).toBeNull();
    expect(row?.tokensDeletedAt).toBe(world.at);
    // The request row itself stays for the Party's life.
    expect(row?.state).toBe('expired');
  });

  it('does not delete the hashes until the keep window has fully passed', async () => {
    const { id, tokenHash } = await seedRequest({ sentDaysAgo: link + keep - 1, state: 'expired', changeExpiresDays: null });
    expect(await sweepConsentTokens(env(), world.at)).toBe(0);
    expect((await requestRow(id))?.tokenHash).toBe(tokenHash);
  });

  it('waits for the Change_Link to have expired 30 days too, for an answered request', async () => {
    // Consent_Link expired long ago, but the Change_Link expires only 10 days before the clock.
    const { id, tokenHash } = await seedRequest({ sentDaysAgo: link + keep + 5, state: 'answered', changeExpiresDays: -10 });
    expect(await sweepConsentTokens(env(), world.at)).toBe(0);
    expect((await requestRow(id))?.tokenHash).toBe(tokenHash);
    // Once the Change_Link has also been expired for 30 days, the hashes go.
    const later = await seedRequest({ sentDaysAgo: link + keep + 40, state: 'answered', changeExpiresDays: -(keep + 1) });
    expect(await sweepConsentTokens(env(), world.at)).toBe(1);
    expect((await requestRow(later.id))?.tokenHash).toBeNull();
  });

  it('never deletes the hashes of a still-open Sent request', async () => {
    const { id, tokenHash } = await seedRequest({ sentDaysAgo: link + keep, state: 'sent' });
    expect(await sweepConsentTokens(env(), world.at)).toBe(0);
    expect((await requestRow(id))?.tokenHash).toBe(tokenHash);
  });

  it('cleans each request once across repeated sweeps', async () => {
    const { id } = await seedRequest({ sentDaysAgo: link + keep, state: 'cancelled', changeExpiresDays: null, cancelledDaysAgo: keep });
    expect(await sweepConsentTokens(env(), world.at)).toBe(1);
    const row = await requestRow(id);
    expect(row?.tokenHash).toBeNull();
    expect(row?.tokensDeletedAt).toBe(world.at);
    expect(await sweepConsentTokens(env(), atDays(1))).toBe(0);
  });
});
