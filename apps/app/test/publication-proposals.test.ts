import { beforeEach, describe, expect, it } from 'vitest';
import { unitKey } from '@researchforce/kernel/views';
import type { PreviewResult } from '../src/disclosure/preview';
import { itemWorld } from './items';
import type { ItemView, Who } from './items';

const SECRET = 'synthetic-preview-hmac-secret-for-tests';
const LICENCE = 'Synthetic Content Licence 1.0';
const world = itemWorld(undefined, { contentLicence: LICENCE });

/**
 * A Public Full_Content Project with a finding owned by `author`, so the finding's Consenting_Member is a
 * Member other than the proposing Administrator. Both the author (the credited Owner) and the Administrator
 * hold a Licence_Agreement for the current Content_Licence, so the licence gate does not stand in the way.
 */
beforeEach(async () => {
  await world.core().batch([
    world.core().prepare('UPDATE profiles SET licence_name = ?1, licence_given_on = ?2 WHERE member_id IN (?3, ?4)')
      .bind(LICENCE, '2026-10-27', world.ids.admin, world.ids.author),
  ]);
});

/** A finding owned by `author` in a Public, Full_Content Project, ready to be proposed for publication. */
async function finding(): Promise<ItemView> {
  const item = await world.created('author', 'finding');
  await world.core().batch([
    world.core().prepare("UPDATE projects SET disclosure_level = 'public' WHERE id = ?1").bind(world.projectId),
    world.core().prepare("UPDATE research_items SET public_presentation = 'full_content' WHERE unit_id = ?1").bind(item.id),
    world.core().prepare('DELETE FROM outbox'),
    world.core().prepare('DELETE FROM notification_events'),
  ]);
  return item;
}

async function proposalsFor(item: ItemView, level = 'public'): Promise<string[]> {
  const response = await world.request('admin', 'POST', '/reviews/proposals', { units: [{ key: unitKey(item.id), level }], note: 'Please consent to publish this finding.' });
  if (response.status !== 201) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json<{ proposals: string[] }>()).proposals;
}

function decide(who: Who, id: string, outcome: 'approved' | 'declined'): Promise<Response> {
  return world.request(who, 'POST', `/reviews/proposals/${id}/decide`, { outcome, note: 'Noted.' });
}

async function preview(body: unknown): Promise<PreviewResult> {
  world.bindings.DOWNLOAD_HMAC_KEY = SECRET;
  const response = await world.request('admin', 'POST', '/disclosure/preview', body);
  if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return response.json<PreviewResult>();
}

function apply(token: string): Promise<Response> {
  world.bindings.DOWNLOAD_HMAC_KEY = SECRET;
  return world.request('admin', 'POST', '/disclosure/apply', { token });
}

async function consentRows(unitId: string): Promise<{ id: string; source: string; member: string; used: string | null; withdrawn: string | null }[]> {
  const rows = await world.core().prepare(
    'SELECT id, source, member_id AS member, used_at AS used, withdrawn_at AS withdrawn FROM publication_consents WHERE unit_id = ?1 ORDER BY id',
  ).bind(unitId).all<{ id: string; source: string; member: string; used: string | null; withdrawn: string | null }>();
  return rows.results;
}

describe('POST /reviews/proposals', () => {
  it('needs the consent.propose permission', async () => {
    const item = await finding();
    const response = await world.request('author', 'POST', '/reviews/proposals', { units: [{ key: unitKey(item.id), level: 'public' }] });
    expect(response.status).toBe(403);
  });

  it('creates one Publication_Proposal per Consenting_Member, addressed by name, with a Review_Requested event', async () => {
    const item = await finding();
    const ids = await proposalsFor(item);
    expect(ids).toHaveLength(1);
    const row = await world.core().prepare('SELECT request_type AS type, state, root_id AS root FROM review_requests WHERE id = ?1').bind(ids[0]).first<{ type: string; state: string; root: string }>();
    expect(row?.type).toBe('proposal');
    expect(row?.state).toBe('needs_review');
    const addressee = await world.core().prepare("SELECT addressee_id AS id FROM review_addressees WHERE request_id = ?1 AND addressee_type = 'member'").bind(ids[0]).first<{ id: string }>();
    expect(addressee?.id).toBe(world.ids.author);
    const event = await world.core().prepare("SELECT count(*) AS n FROM notification_events WHERE event_type = 'review_requested' AND member_id = ?1").bind(world.ids.author).first<{ n: number }>();
    expect(event?.n).toBe(1);
  });

  it('stores the proposed values and the resulting Public_View in the proposal', async () => {
    const item = await finding();
    const [id] = await proposalsFor(item);
    const row = await world.core().prepare('SELECT proposal FROM review_requests WHERE id = ?1').bind(id).first<{ proposal: string }>();
    const payload = JSON.parse(row!.proposal) as { units: { key: string; values: { level: string }; view: unknown }[] };
    expect(payload.units).toHaveLength(1);
    expect(payload.units[0]!.key).toBe(unitKey(item.id));
    expect(payload.units[0]!.values.level).toBe('public');
    expect(payload.units[0]!.view).toBeTruthy();
  });

  it('refuses when no Disclosure_Unit has a Consenting_Member other than the proposer', async () => {
    // A finding owned by the Administrator has the Administrator as its own Consenting_Member.
    const own = await world.created('admin', 'finding');
    await world.core().prepare("UPDATE research_items SET public_presentation = 'full_content' WHERE unit_id = ?1").bind(own.id).run();
    const response = await world.request('admin', 'POST', '/reviews/proposals', { units: [{ key: unitKey(own.id), level: 'public' }] });
    expect(response.status).toBe(422);
    expect((await response.json<{ details: { rule: string } }>()).details.rule).toBe('no_consenting_member');
  });
});

describe('POST /reviews/proposals/:id/decide', () => {
  it('only the addressed Consenting_Member may decide', async () => {
    const item = await finding();
    const [id] = await proposalsFor(item);
    expect((await decide('admin', id!, 'approved')).status).toBe(403);
    expect((await decide('colleague', id!, 'approved')).status).toBe(403);
  });

  it('on approve writes one consent row per unit and a Review_Completed event for the proposer', async () => {
    const item = await finding();
    const [id] = await proposalsFor(item);
    const response = await decide('author', id!, 'approved');
    expect(response.status).toBe(200);
    const review = await world.core().prepare('SELECT state, outcome FROM review_requests WHERE id = ?1').bind(id).first<{ state: string; outcome: string }>();
    expect(review).toEqual({ state: 'reviewed', outcome: 'approved' });
    const consents = await consentRows(item.id);
    expect(consents).toHaveLength(1);
    expect(consents[0]).toMatchObject({ source: 'proposal', member: world.ids.author, used: null, withdrawn: null });
    const event = await world.core().prepare("SELECT count(*) AS n FROM notification_events WHERE event_type = 'review_completed' AND member_id = ?1").bind(world.ids.admin).first<{ n: number }>();
    expect(event?.n).toBe(1);
  });

  it('on decline writes no consent row but marks the proposal Reviewed Declined', async () => {
    const item = await finding();
    const [id] = await proposalsFor(item);
    const response = await decide('author', id!, 'declined');
    expect(response.status).toBe(200);
    const review = await world.core().prepare('SELECT outcome FROM review_requests WHERE id = ?1').bind(id).first<{ outcome: string }>();
    expect(review?.outcome).toBe('declined');
    expect(await consentRows(item.id)).toHaveLength(0);
  });

  it('refuses a second decision on an already Reviewed proposal', async () => {
    const item = await finding();
    const [id] = await proposalsFor(item);
    expect((await decide('author', id!, 'approved')).status).toBe(200);
    const again = await decide('author', id!, 'declined');
    expect(again.status).toBe(422);
    expect((await again.json<{ details: { rule: string } }>()).details.rule).toBe('reviewed');
  });
});

describe('POST /reviews/consents/:id/withdraw', () => {
  it('lets the Consenting_Member withdraw an unused consent', async () => {
    const item = await finding();
    const [id] = await proposalsFor(item);
    await decide('author', id!, 'approved');
    const consentId = (await consentRows(item.id))[0]!.id;
    const response = await world.request('author', 'POST', `/reviews/consents/${consentId}/withdraw`, {});
    expect(response.status).toBe(200);
    expect((await consentRows(item.id))[0]!.withdrawn).not.toBeNull();
  });

  it('only the Member who gave the consent may withdraw it', async () => {
    const item = await finding();
    const [id] = await proposalsFor(item);
    await decide('author', id!, 'approved');
    const consentId = (await consentRows(item.id))[0]!.id;
    expect((await world.request('colleague', 'POST', `/reviews/consents/${consentId}/withdraw`, {})).status).toBe(403);
  });

  it('refuses to withdraw a consent that has already been used', async () => {
    const item = await finding();
    const [id] = await proposalsFor(item);
    await decide('author', id!, 'approved');
    const consentId = (await consentRows(item.id))[0]!.id;
    // A used consent is spent: the apply records used_at, after which it can no longer be withdrawn.
    await world.core().prepare('UPDATE publication_consents SET used_at = ?1 WHERE id = ?2').bind(world.at, consentId).run();
    const response = await world.request('author', 'POST', `/reviews/consents/${consentId}/withdraw`, {});
    expect(response.status).toBe(422);
    expect((await response.json<{ details: { rule: string } }>()).details.rule).toBe('consent_used');
  });
});

describe('the owner-consent gate end to end', () => {
  it('refuses a widening before approval and allows it after, naming the Consenting_Member', async () => {
    const item = await finding();
    // Before any consent, the Administrator's widening of the author's finding is refused, naming the author.
    const before = await preview({ units: [{ key: unitKey(item.id), level: 'public' }] });
    expect(before.token).toBeNull();
    expect(before.failures.some((f) => f.reason === 'owner_consent' && f.memberId === world.ids.author)).toBe(true);

    // The author approves the proposal, recording their Publication_Consent for exactly those values.
    const [id] = await proposalsFor(item);
    await decide('author', id!, 'approved');

    // The same change now previews cleanly and applies, spending the consent.
    const after = await preview({ units: [{ key: unitKey(item.id), level: 'public' }] });
    expect(after.failures).toEqual([]);
    expect(after.token).toBeTruthy();
    const applied = await apply(after.token!);
    expect(applied.status).toBe(200);
    const unit = await world.core().prepare('SELECT disclosure_level AS level FROM units WHERE id = ?1').bind(item.id).first<{ level: string }>();
    expect(unit?.level).toBe('public');
    const consent = (await consentRows(item.id))[0]!;
    expect(consent.used).not.toBeNull();
  });
});

describe('POST /reviews/publication-requests', () => {
  it('records the Consenting_Member’s own Publication_Request as a consent with source request', async () => {
    const item = await finding();
    const response = await world.request('author', 'POST', '/reviews/publication-requests', { unit: { key: unitKey(item.id), level: 'public' }, note: 'I consent to publishing my finding.' });
    expect(response.status).toBe(201);
    const body = await response.json<{ request: string; consent: string }>();
    const review = await world.core().prepare('SELECT request_type AS type, is_publication_request AS flag FROM review_requests WHERE id = ?1').bind(body.request).first<{ type: string; flag: number }>();
    expect(review).toEqual({ type: 'publication_request', flag: 1 });
    const consents = await consentRows(item.id);
    expect(consents).toHaveLength(1);
    expect(consents[0]).toMatchObject({ source: 'request', member: world.ids.author });
  });

  it('records no consent for a Publication_Request about a unit the Member is not the Consenting_Member of', async () => {
    const item = await finding();
    // The item is owned by `author`; `colleague` is not its Consenting_Member, but may still propose (R23.10).
    const response = await world.request('colleague', 'POST', '/reviews/publication-requests', { unit: { key: unitKey(item.id), level: 'public' } });
    expect(response.status).toBe(201);
    const body = await response.json<{ request: string; consent: string | null }>();
    expect(body.consent).toBeNull();
    // The Publication_Request exists and is addressed to the Administrator Role, but records no consent.
    expect(await consentRows(item.id)).toHaveLength(0);
  });

  it('the recorded consent covers the Administrator applying the proposed values, and edited values are refused', async () => {
    const item = await finding();
    await world.request('author', 'POST', '/reviews/publication-requests', { unit: { key: unitKey(item.id), level: 'public' } });
    // The Administrator applies exactly the requested values: the open request's consent covers it.
    const covered = await preview({ units: [{ key: unitKey(item.id), level: 'public' }] });
    expect(covered.failures).toEqual([]);
    expect(covered.token).toBeTruthy();
    // Editing the values beyond the consent (adding a Public_Summary) needs a new consent; the gate refuses it.
    const edited = await preview({ units: [{ key: unitKey(item.id), level: 'public', publicSummary: { text: 'An edited summary the request did not cover.', spans: [] } }] });
    expect(edited.token).toBeNull();
    expect(edited.failures.some((f) => f.reason === 'owner_consent')).toBe(true);
  });
});
