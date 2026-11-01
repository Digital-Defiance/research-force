import { beforeEach, describe, expect, it } from 'vitest';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { unitKey } from '@researchforce/kernel/views';
import type { PreviewResult } from '../src/disclosure/preview';
import { itemWorld } from './items';
import type { ItemView, Who } from './items';

const SECRET = 'synthetic-preview-hmac-secret-for-tests';
const LICENCE = 'Synthetic Content Licence 1.0';
const world = itemWorld(undefined, { contentLicence: LICENCE });

/**
 * Both the author (the credited Owner of the finding) and the Administrator hold a Licence_Agreement for the
 * current Content_Licence, so the licence gate never stands in the way of a Public widening.
 */
beforeEach(async () => {
  await world.core().prepare('UPDATE profiles SET licence_name = ?1, licence_given_on = ?2 WHERE member_id IN (?3, ?4)')
    .bind(LICENCE, '2026-10-27', world.ids.admin, world.ids.author).run();
});

/** A finding owned by `author` in a Public, Full_Content Project, ready to be proposed for publication. */
async function finding(owner: Who = 'author'): Promise<ItemView> {
  const item = await world.created(owner, 'finding');
  await world.core().batch([
    world.core().prepare("UPDATE projects SET disclosure_level = 'public' WHERE id = ?1").bind(world.projectId),
    world.core().prepare("UPDATE research_items SET public_presentation = 'full_content' WHERE unit_id = ?1").bind(item.id),
    world.core().prepare('DELETE FROM outbox'),
    world.core().prepare('DELETE FROM notification_events'),
  ]);
  return item;
}

interface RequestBody { unit: { key: string; level?: string; publicSummary?: unknown }; note?: string }

async function propose(who: Who, body: RequestBody): Promise<{ request: string; consent: string | null }> {
  const response = await world.request(who, 'POST', '/reviews/publication-requests', body);
  if (response.status !== 201) throw new Error(`${response.status} ${await response.text()}`);
  return response.json<{ request: string; consent: string | null }>();
}

async function preview(body: unknown): Promise<PreviewResult> {
  world.bindings.DOWNLOAD_HMAC_KEY = SECRET;
  const response = await world.request('admin', 'POST', '/disclosure/preview', body);
  if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return response.json<PreviewResult>();
}

function applyRequest(who: Who, id: string, token: string): Promise<Response> {
  world.bindings.DOWNLOAD_HMAC_KEY = SECRET;
  return world.request(who, 'POST', `/reviews/publication-requests/${id}/apply`, { token });
}

function declineRequest(who: Who, id: string, note: unknown): Promise<Response> {
  return world.request(who, 'POST', `/reviews/publication-requests/${id}/decline`, { note });
}

async function reviewRow(id: string): Promise<{ state: string; outcome: string | null; note: string | null; applied: string | null }> {
  return (await world.core().prepare('SELECT state, outcome, review_note AS note, applied FROM review_requests WHERE id = ?1')
    .bind(id).first<{ state: string; outcome: string | null; note: string | null; applied: string | null }>())!;
}

describe('POST /reviews/publication-requests (propose)', () => {
  it('needs the review.request permission', async () => {
    const item = await finding();
    // A revoked Member holds no Permission, so a Member whose access is removed cannot propose.
    await world.core().prepare("UPDATE members SET status = 'revoked' WHERE id = ?1").bind(world.ids.colleague).run();
    const response = await world.request('colleague', 'POST', '/reviews/publication-requests', { unit: { key: unitKey(item.id), level: 'public' } });
    expect(response.status).toBe(403);
  });

  it('creates a Publication_Request addressed to the Administrator Role with a Review_Requested event', async () => {
    const item = await finding();
    const { request } = await propose('author', { unit: { key: unitKey(item.id), level: 'public' }, note: 'Please publish my finding.' });
    const review = await world.core().prepare('SELECT request_type AS type, is_publication_request AS flag, state FROM review_requests WHERE id = ?1')
      .bind(request).first<{ type: string; flag: number; state: string }>();
    expect(review).toEqual({ type: 'publication_request', flag: 1, state: 'needs_review' });
    const addressee = await world.core().prepare("SELECT addressee_id AS id FROM review_addressees WHERE request_id = ?1 AND addressee_type = 'role'")
      .bind(request).first<{ id: string }>();
    expect(addressee?.id).toBe(ROLE_IDS.administrator);
    // Every active Administrator gets exactly one Review_Requested event; the admin here is the only one.
    const event = await world.core().prepare("SELECT count(*) AS n FROM notification_events WHERE event_type = 'review_requested' AND member_id = ?1")
      .bind(world.ids.admin).first<{ n: number }>();
    expect(event?.n).toBe(1);
  });

  it('records the proposer’s own-unit Publication_Consent for the proposed values', async () => {
    const item = await finding();
    const { consent } = await propose('author', { unit: { key: unitKey(item.id), level: 'public' } });
    expect(consent).toBeTruthy();
    const row = await world.core().prepare('SELECT source, member_id AS member, used_at AS used FROM publication_consents WHERE id = ?1')
      .bind(consent).first<{ source: string; member: string; used: string | null }>();
    expect(row).toMatchObject({ source: 'request', member: world.ids.author, used: null });
  });

  it('records no consent for a proposal about another Member’s Disclosure_Unit', async () => {
    const item = await finding('author');
    // `colleague` is not the Consenting_Member of the author's finding, but may still propose (R23.10).
    const { request, consent } = await propose('colleague', { unit: { key: unitKey(item.id), level: 'public' } });
    expect(consent).toBeNull();
    expect(await world.core().prepare('SELECT count(*) AS n FROM publication_consents WHERE source_id = ?1').bind(request).first<{ n: number }>()).toMatchObject({ n: 0 });
  });
});

describe('GET /reviews/publication-requests/:id', () => {
  it('returns the proposed values, target, and proposer for an Administrator to pre-fill the change (R23.11)', async () => {
    const item = await finding();
    const { request } = await propose('author', { unit: { key: unitKey(item.id), level: 'public', publicSummary: { text: 'A public summary.', spans: [] } } });
    const response = await world.request('admin', 'GET', `/reviews/publication-requests/${request}`);
    expect(response.status).toBe(200);
    const body = await response.json<{ request: { state: string; target: { id: string; key: string }; proposer: { id: string }; proposed: { level: string; publicSummary?: { text: string } } } }>();
    expect(body.request.state).toBe('needs_review');
    expect(body.request.target).toMatchObject({ id: item.id, key: unitKey(item.id) });
    expect(body.request.proposer.id).toBe(world.ids.author);
    expect(body.request.proposed).toMatchObject({ level: 'public', publicSummary: { text: 'A public summary.' } });
  });

  it('needs the disclosure.set permission and is not found for a non-publication request', async () => {
    const item = await finding();
    const { request } = await propose('author', { unit: { key: unitKey(item.id), level: 'public' } });
    expect((await world.request('author', 'GET', `/reviews/publication-requests/${request}`)).status).toBe(403);
    // An ordinary Review_Request id is not a Publication_Request, so the endpoint reports not found.
    const ordinary = await world.request('author', 'POST', '/reviews', { targetId: item.id, roleIds: [ROLE_IDS.administrator] });
    const { review } = await ordinary.json<{ review: { id: string } }>();
    expect((await world.request('admin', 'GET', `/reviews/publication-requests/${review.id}`)).status).toBe(404);
  });
});

describe('POST /reviews/publication-requests/:id/apply', () => {
  it('needs the disclosure.set permission', async () => {
    const item = await finding();
    const { request } = await propose('author', { unit: { key: unitKey(item.id), level: 'public' } });
    const previewed = await preview({ units: [{ key: unitKey(item.id), level: 'public' }] });
    const response = await applyRequest('author', request, previewed.token!);
    expect(response.status).toBe(403);
  });

  it('applies the proposed values, changing the disclosure and marking the request Reviewed Applied with the applied values', async () => {
    const item = await finding();
    const { request } = await propose('author', { unit: { key: unitKey(item.id), level: 'public' } });
    // The author's own-unit consent covers the Administrator applying the requested values.
    const previewed = await preview({ units: [{ key: unitKey(item.id), level: 'public' }] });
    expect(previewed.failures).toEqual([]);
    const response = await applyRequest('admin', request, previewed.token!);
    expect(response.status).toBe(200);
    const unit = await world.core().prepare('SELECT disclosure_level AS level FROM units WHERE id = ?1').bind(item.id).first<{ level: string }>();
    expect(unit?.level).toBe('public');
    const review = await reviewRow(request);
    expect(review.state).toBe('reviewed');
    expect(review.outcome).toBe('applied');
    expect(JSON.parse(review.applied!)).toMatchObject({ level: 'public' });
    // The requester gets a Review_Completed event.
    const event = await world.core().prepare("SELECT count(*) AS n FROM notification_events WHERE event_type = 'review_completed' AND member_id = ?1")
      .bind(world.ids.author).first<{ n: number }>();
    expect(event?.n).toBe(1);
  });

  it('leaves the request Needs_Review when a consent refusal fails the Owner-consent gate', async () => {
    const item = await finding();
    // `colleague` proposes for the author's finding, so no consent is recorded; the Administrator still previews.
    const { request } = await propose('colleague', { unit: { key: unitKey(item.id), level: 'public' } });
    const previewed = await preview({ units: [{ key: unitKey(item.id), level: 'public' }] });
    // The Owner-consent gate refuses the preview, so no token is issued; the apply cannot proceed.
    expect(previewed.token).toBeNull();
    expect(previewed.failures.some((f) => f.reason === 'owner_consent')).toBe(true);
    // Even a forged token is rejected, so the request stays Needs_Review and the unit stays Not_Published.
    const response = await applyRequest('admin', request, 'not.a.token');
    expect(response.status).toBe(409);
    const review = await reviewRow(request);
    expect(review.state).toBe('needs_review');
    expect(review.outcome).toBeNull();
    const unit = await world.core().prepare('SELECT disclosure_level AS level FROM units WHERE id = ?1').bind(item.id).first<{ level: string }>();
    expect(unit?.level).toBe('not_published');
  });

  it('refuses a token whose change does not include the request’s Disclosure_Unit', async () => {
    const item = await finding();
    // A finding owned by the Administrator needs no consent, so its preview yields a usable token.
    const other = await finding('admin');
    const { request } = await propose('author', { unit: { key: unitKey(item.id), level: 'public' } });
    // A valid token for a different unit cannot apply this request.
    const previewed = await preview({ units: [{ key: unitKey(other.id), level: 'public' }] });
    expect(previewed.token).toBeTruthy();
    const response = await applyRequest('admin', request, previewed.token!);
    expect(response.status).toBe(422);
    expect((await response.json<{ details: { rule: string } }>()).details.rule).toBe('request_unit');
    expect((await reviewRow(request)).state).toBe('needs_review');
  });

  it('refuses to apply an already Reviewed request', async () => {
    const item = await finding();
    const { request } = await propose('author', { unit: { key: unitKey(item.id), level: 'public' } });
    const first = await preview({ units: [{ key: unitKey(item.id), level: 'public' }] });
    expect((await applyRequest('admin', request, first.token!)).status).toBe(200);
    // A second apply finds the request already Reviewed.
    const second = await preview({ units: [{ key: unitKey(item.id), level: 'public' }] });
    const response = await applyRequest('admin', request, second.token ?? 'x.y');
    expect(response.status).toBe(422);
    expect((await response.json<{ details: { rule: string } }>()).details.rule).toBe('reviewed');
  });
});

describe('POST /reviews/publication-requests/:id/decline', () => {
  it('needs the disclosure.set permission', async () => {
    const item = await finding();
    const { request } = await propose('author', { unit: { key: unitKey(item.id), level: 'public' } });
    expect((await declineRequest('author', request, 'No, keep this private.')).status).toBe(403);
  });

  it('requires a note of 1 to 2,000 characters', async () => {
    const item = await finding();
    const { request } = await propose('author', { unit: { key: unitKey(item.id), level: 'public' } });
    // An empty note is refused.
    expect((await declineRequest('admin', request, '   ')).status).toBe(422);
    // A note beyond 2,000 characters is refused.
    expect((await declineRequest('admin', request, 'x'.repeat(2001))).status).toBe(422);
    // The request is unchanged by the refused declines.
    expect((await reviewRow(request)).state).toBe('needs_review');
  });

  it('marks the request Reviewed Declined with the note and changes no disclosure value', async () => {
    const item = await finding();
    const { request } = await propose('author', { unit: { key: unitKey(item.id), level: 'public' } });
    const response = await declineRequest('admin', request, 'We cannot publish this yet.');
    expect(response.status).toBe(200);
    const review = await reviewRow(request);
    expect(review.state).toBe('reviewed');
    expect(review.outcome).toBe('declined');
    expect(review.note).toBe('We cannot publish this yet.');
    // The Disclosure_Level is unchanged.
    const unit = await world.core().prepare('SELECT disclosure_level AS level FROM units WHERE id = ?1').bind(item.id).first<{ level: string }>();
    expect(unit?.level).toBe('not_published');
    // The requester gets a Review_Completed event.
    const event = await world.core().prepare("SELECT count(*) AS n FROM notification_events WHERE event_type = 'review_completed' AND member_id = ?1")
      .bind(world.ids.author).first<{ n: number }>();
    expect(event?.n).toBe(1);
  });

  it('refuses to decline an already Reviewed request', async () => {
    const item = await finding();
    const { request } = await propose('author', { unit: { key: unitKey(item.id), level: 'public' } });
    expect((await declineRequest('admin', request, 'Declining once.')).status).toBe(200);
    const again = await declineRequest('admin', request, 'Declining twice.');
    expect(again.status).toBe(422);
    expect((await again.json<{ details: { rule: string } }>()).details.rule).toBe('reviewed');
  });
});
