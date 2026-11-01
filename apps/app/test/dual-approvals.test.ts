import { beforeEach, describe, expect, it } from 'vitest';
import { unitKey } from '@researchforce/kernel/views';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import type { PreviewResult } from '../src/disclosure/preview';
import { itemWorld } from './items';
import type { ItemView, Who } from './items';

const SECRET = 'synthetic-preview-hmac-secret-for-tests';
const LICENCE = 'Synthetic Content Licence 1.0';
const world = itemWorld(undefined, { contentLicence: LICENCE });

/**
 * Two active Administrators (`admin` and `colleague`, promoted here) and one Contributor (`author`), so a
 * Dual_Approval has a proposer and a distinct second approver. The licence gate does not stand in the way
 * of making the Contributor's finding Public.
 */
beforeEach(async () => {
  await world.core().batch([
    world.core().prepare('UPDATE members SET role_id = ?1 WHERE id = ?2').bind(ROLE_IDS.administrator, world.ids.colleague),
    world.core().prepare('UPDATE profiles SET licence_name = ?1, licence_given_on = ?2 WHERE member_id IN (?3, ?4, ?5)')
      .bind(LICENCE, '2026-10-27', world.ids.admin, world.ids.colleague, world.ids.author),
  ]);
});

const rows = async <T>(query: string, ...binds: unknown[]): Promise<T[]> => (await world.core().prepare(query).bind(...binds).all<T>()).results;
const approvalRow = (id: string) => world.core().prepare(
  'SELECT state, decided_by AS decidedBy, decision_reason AS decisionReason FROM dual_approvals WHERE id = ?1',
).bind(id).first<{ state: string; decidedBy: string | null; decisionReason: string | null }>();

/** Make the author a Revoked Member (a departed Owner), keeping the Member row. */
async function revoke(id: string): Promise<void> {
  await world.core().prepare("UPDATE members SET status = 'revoked' WHERE id = ?1").bind(id).run();
}

/** A finding owned by `author` in a Public, Full_Content Project, with its creation outbox and events cleared. */
async function finding(owner: Who = 'author', overrides: Record<string, unknown> = {}): Promise<ItemView> {
  const item = await world.created(owner, 'finding', overrides);
  await world.core().batch([
    world.core().prepare("UPDATE projects SET disclosure_level = 'public' WHERE id = ?1").bind(world.projectId),
    world.core().prepare("UPDATE research_items SET public_presentation = 'full_content' WHERE unit_id = ?1").bind(item.id),
    world.core().prepare('DELETE FROM outbox'),
    world.core().prepare('DELETE FROM notification_events'),
  ]);
  return item;
}

/** Place a Confidentiality_Hold on an Item, returning its id. */
async function placeHold(who: Who, itemId: string, note = 'Held pending a confidentiality review.'): Promise<string> {
  const previewResp = await world.request(who, 'POST', `/items/${itemId}/holds/preview`, {});
  const { confirmation } = await previewResp.json<{ confirmation: string | null }>();
  const response = await world.request(who, 'POST', `/items/${itemId}/holds`, { note, ...(confirmation === null ? {} : { confirmation }) });
  if (response.status !== 201) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json<{ hold: string }>()).hold;
}

function propose(who: Who, body: Record<string, unknown>): Promise<Response> {
  return world.request(who, 'POST', '/dual-approvals', body);
}
async function proposed(who: Who, body: Record<string, unknown>): Promise<string> {
  const response = await propose(who, body);
  if (response.status !== 201) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json<{ dualApproval: string }>()).dualApproval;
}
function approve(who: Who, id: string, reason = 'Approved by a second Administrator.'): Promise<Response> {
  return world.request(who, 'POST', `/dual-approvals/${id}/approve`, { reason });
}
function decline(who: Who, id: string, reason = 'Declined.'): Promise<Response> {
  return world.request(who, 'POST', `/dual-approvals/${id}/decline`, { reason });
}
function withdraw(who: Who, id: string, reason = 'Withdrawn.'): Promise<Response> {
  return world.request(who, 'POST', `/dual-approvals/${id}/withdraw`, { reason });
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

describe('POST /dual-approvals (propose)', () => {
  it('needs the dual.propose permission, which a Contributor lacks', async () => {
    const item = await finding();
    const holdId = await placeHold('admin', item.id);
    expect((await propose('author', { action: 'hold_override', target: { itemId: item.id, holdId }, reason: 'Please override.' })).status).toBe(403);
  });

  it('requires an immutable reason of 1 to 2,000 characters', async () => {
    const item = await finding();
    const holdId = await placeHold('admin', item.id);
    expect((await propose('admin', { action: 'hold_override', target: { itemId: item.id, holdId }, reason: '' })).status).toBe(422);
    expect((await propose('admin', { action: 'hold_override', target: { itemId: item.id, holdId }, reason: 'x'.repeat(2001) })).status).toBe(422);
  });

  it('records an open proposal with its action, target, and effect', async () => {
    const item = await finding();
    const holdId = await placeHold('admin', item.id);
    const id = await proposed('admin', { action: 'hold_override', target: { itemId: item.id, holdId }, reason: 'Please override.' });
    const row = await world.core().prepare('SELECT action, state, proposed_by AS proposer, proposal_reason AS reason, effect_hash AS effectHash FROM dual_approvals WHERE id = ?1').bind(id).first<{ action: string; state: string; proposer: string; reason: string; effectHash: string }>();
    expect(row).toMatchObject({ action: 'hold_override', state: 'open', proposer: world.ids.admin, reason: 'Please override.' });
    expect(row?.effectHash).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe('each action: propose then approve by two distinct Administrators', () => {
  it('hold_override: a second Administrator approves, overriding the hold and letting a held widening through', async () => {
    // A finding made Unclassified Not_Published, with a hold the admin placed blocking its widening.
    const item = await finding('admin');
    await world.core().prepare("UPDATE units SET classification_state = 'unclassified' WHERE id = ?1").bind(item.id).run();
    const holdId = await placeHold('admin', item.id);

    // Before the override, the hold blocks a widening to Public (R48.4).
    const held = await preview({ units: [{ key: unitKey(item.id), level: 'public' }] });
    expect(held.failures.some((f) => f.reason === 'hold')).toBe(true);

    const id = await proposed('admin', { action: 'hold_override', target: { itemId: item.id, holdId }, reason: 'The group agrees to lift it.' });
    // The proposer cannot approve their own proposal (R49.4).
    expect((await approve('admin', id)).status).toBe(403);
    expect((await approve('colleague', id)).status).toBe(200);
    expect(await approvalRow(id)).toMatchObject({ state: 'approved', decidedBy: world.ids.colleague });
    // The hold is now overridden by this approval, with no Disclosure_Level change (R48.7, R48.9).
    expect(await rows('SELECT override_id AS o, lifted_at AS l FROM confidentiality_holds WHERE id = ?1', holdId)).toEqual([{ o: id, l: null }]);

    // The previously-held widening now goes through (R48.9).
    const free = await preview({ units: [{ key: unitKey(item.id), level: 'public' }] });
    expect(free.failures.some((f) => f.reason === 'hold')).toBe(false);
    expect(free.token).toBeTruthy();
    expect((await apply(free.token!)).status).toBe(200);
  });

  it('access_widen: widens a Revoked Owner\u2019s Restricted item through two Administrators', async () => {
    const item = await world.created('author', 'finding', { access: { level: 'restricted', members: [] } });
    await revoke(world.ids.author);
    // The single-Administrator path is forbidden because the Owner is gone; only a Dual_Approval widens (R47.7).
    const id = await proposed('admin', { action: 'access_widen', target: { itemId: item.id, add: [world.ids.colleague] }, reason: 'Open the departed Owner\u2019s item.' });
    expect((await approve('colleague', id)).status).toBe(200);
    expect(await rows('SELECT member_id AS m FROM access_grants WHERE root_id = ?1', item.id)).toEqual([{ m: world.ids.colleague }]);
    // An Access_Change Revision records the widening.
    expect(await rows("SELECT count(*) AS n FROM revisions WHERE target_id = ?1 AND kind = 'access_change'", item.id)).toEqual([{ n: 1 }]);
  });

  it('consent_on_behalf: records a source=dual consent that satisfies the owner_consent gate for a Revoked Owner', async () => {
    const item = await finding('author');
    await revoke(world.ids.author);
    // Before the consent, the Administrator's widening of the Revoked author's finding is refused, naming the author.
    const before = await preview({ units: [{ key: unitKey(item.id), level: 'public' }] });
    expect(before.failures.some((f) => f.reason === 'owner_consent' && f.memberId === world.ids.author)).toBe(true);

    const id = await proposed('admin', { action: 'consent_on_behalf', target: { key: unitKey(item.id), values: { level: 'public' } }, reason: 'Publish the departed Member\u2019s finding.' });
    expect((await approve('colleague', id)).status).toBe(200);
    const consent = await world.core().prepare('SELECT source, member_id AS member, used_at AS used FROM publication_consents WHERE unit_id = ?1').bind(item.id).first<{ source: string; member: string; used: string | null }>();
    expect(consent).toMatchObject({ source: 'dual', member: world.ids.author, used: null });

    // The same widening now previews cleanly and applies, spending the consent.
    const after = await preview({ units: [{ key: unitKey(item.id), level: 'public' }] });
    expect(after.failures).toEqual([]);
    expect(after.token).toBeTruthy();
    expect((await apply(after.token!)).status).toBe(200);
    expect(await rows('SELECT used_at AS used FROM publication_consents WHERE unit_id = ?1', item.id)).toEqual([{ used: expect.any(String) }]);
  });
});

describe('two distinct Administrators are required (dual_distinct)', () => {
  it('refuses an approval by the proposer, and never by the same Administrator twice', async () => {
    const item = await finding();
    const holdId = await placeHold('admin', item.id);
    const id = await proposed('admin', { action: 'hold_override', target: { itemId: item.id, holdId }, reason: 'Override.' });
    // The proposer is a single Administrator; a count of Administrators is not enough, the approver must differ.
    const response = await approve('admin', id);
    expect(response.status).toBe(403);
    expect((await response.json<{ details: { rule: string } }>()).details.rule).toBe('not_approver');
    expect(await approvalRow(id)).toMatchObject({ state: 'open' });
  });
});

describe('a changed or ineligible proposal lapses rather than applies', () => {
  it('lapses when the hold is lifted before approval', async () => {
    const item = await finding();
    const holdId = await placeHold('admin', item.id);
    const id = await proposed('admin', { action: 'hold_override', target: { itemId: item.id, holdId }, reason: 'Override.' });
    // The placer lifts the hold, so the action no longer applies (R49.4).
    await world.request('admin', 'POST', `/items/${item.id}/holds/${holdId}/lift`, {});
    const response = await approve('colleague', id);
    expect(response.status).toBe(200);
    expect((await response.json<{ state: string }>()).state).toBe('lapsed');
    expect(await approvalRow(id)).toMatchObject({ state: 'lapsed', decidedBy: world.ids.colleague });
    // The lifted hold was not overridden by the lapsed proposal.
    expect(await rows('SELECT override_id AS o FROM confidentiality_holds WHERE id = ?1', holdId)).toEqual([{ o: null }]);
  });

  it('lapses when the Owner\u2019s access is restored before approval of an access_widen', async () => {
    const item = await world.created('author', 'finding', { access: { level: 'restricted', members: [] } });
    await revoke(world.ids.author);
    const id = await proposed('admin', { action: 'access_widen', target: { itemId: item.id, add: [world.ids.colleague] }, reason: 'Open it.' });
    // The Owner is restored to Active, so the departed-Owner condition no longer holds (R47.7, R49.4).
    await world.core().prepare("UPDATE members SET status = 'active' WHERE id = ?1").bind(world.ids.author).run();
    const response = await approve('colleague', id);
    expect(response.status).toBe(200);
    expect((await response.json<{ state: string }>()).state).toBe('lapsed');
    expect(await rows('SELECT count(*) AS n FROM access_grants WHERE root_id = ?1', item.id)).toEqual([{ n: 0 }]);
  });

  it('lapses when the proposing Administrator becomes ineligible before approval', async () => {
    const item = await finding();
    const holdId = await placeHold('admin', item.id);
    const id = await proposed('admin', { action: 'hold_override', target: { itemId: item.id, holdId }, reason: 'Override.' });
    // The proposer is revoked, so they are no longer a currently Active Administrator (R49.8).
    await revoke(world.ids.admin);
    const response = await approve('colleague', id);
    expect(response.status).toBe(200);
    expect((await response.json<{ state: string }>()).state).toBe('lapsed');
    expect(await rows('SELECT override_id AS o FROM confidentiality_holds WHERE id = ?1', holdId)).toEqual([{ o: null }]);
  });

  it('lapses a consent_on_behalf when the approved content changes before approval', async () => {
    const item = await finding('author');
    await revoke(world.ids.author);
    const id = await proposed('admin', { action: 'consent_on_behalf', target: { key: unitKey(item.id), values: { level: 'public' } }, reason: 'Publish it.' });
    // An Administrator edits the finding's body, changing a dependency the consent was bound to (R23.24, R49.8).
    await world.core().prepare('UPDATE units SET updated_seq = updated_seq + 1 WHERE id = ?1').bind(item.id).run();
    await world.core().prepare("UPDATE findings SET claim = 'An edited claim.' WHERE unit_id = ?1").bind(item.id).run();
    const response = await approve('colleague', id);
    expect(response.status).toBe(200);
    expect((await response.json<{ state: string }>()).state).toBe('lapsed');
    expect(await rows('SELECT count(*) AS n FROM publication_consents WHERE unit_id = ?1', item.id)).toEqual([{ n: 0 }]);
  });
});

describe('decline and withdraw close an open proposal without effect', () => {
  it('a second Administrator declines; the proposer cannot decline', async () => {
    const item = await finding();
    const holdId = await placeHold('admin', item.id);
    const id = await proposed('admin', { action: 'hold_override', target: { itemId: item.id, holdId }, reason: 'Override.' });
    expect((await decline('admin', id)).status).toBe(403);
    expect((await decline('colleague', id, 'Not now.')).status).toBe(200);
    expect(await approvalRow(id)).toMatchObject({ state: 'declined', decidedBy: world.ids.colleague, decisionReason: 'Not now.' });
    // The hold is untouched.
    expect(await rows('SELECT override_id AS o FROM confidentiality_holds WHERE id = ?1', holdId)).toEqual([{ o: null }]);
  });

  it('the proposer withdraws; a second Administrator cannot withdraw', async () => {
    const item = await finding();
    const holdId = await placeHold('admin', item.id);
    const id = await proposed('admin', { action: 'hold_override', target: { itemId: item.id, holdId }, reason: 'Override.' });
    expect((await withdraw('colleague', id)).status).toBe(403);
    expect((await withdraw('admin', id, 'Never mind.')).status).toBe(200);
    expect(await approvalRow(id)).toMatchObject({ state: 'withdrawn', decidedBy: world.ids.admin, decisionReason: 'Never mind.' });
  });

  it('refuses a second decision on an already closed proposal', async () => {
    const item = await finding();
    const holdId = await placeHold('admin', item.id);
    const id = await proposed('admin', { action: 'hold_override', target: { itemId: item.id, holdId }, reason: 'Override.' });
    expect((await decline('colleague', id)).status).toBe(200);
    expect((await approve('colleague', id)).status).toBe(422);
    expect((await withdraw('admin', id)).status).toBe(422);
  });
});

describe('the fewer-than-two-Administrators disabled case (R49.6)', () => {
  it('disables propose and approve with a disabled explanation while only one Administrator is active', async () => {
    const item = await finding();
    const holdId = await placeHold('admin', item.id);
    const id = await proposed('admin', { action: 'hold_override', target: { itemId: item.id, holdId }, reason: 'Override.' });
    // Demote the second Administrator, leaving only one active Administrator.
    await world.core().prepare('UPDATE members SET role_id = ?1 WHERE id = ?2').bind(ROLE_IDS.contributor, world.ids.colleague).run();

    const proposeAgain = await propose('admin', { action: 'hold_override', target: { itemId: item.id, holdId }, reason: 'Again.' });
    expect(proposeAgain.status).toBe(422);
    expect((await proposeAgain.json<{ details: { rule: string } }>()).details.rule).toBe('need_second_admin');

    // The only other Member is now a Contributor, so no second Administrator can approve the open proposal.
    expect((await approve('colleague', id)).status).toBe(403);
    expect(await approvalRow(id)).toMatchObject({ state: 'open' });
  });
});
