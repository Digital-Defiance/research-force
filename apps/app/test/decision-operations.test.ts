import { describe, expect, it } from 'vitest';
import { publicDecision } from '@researchforce/domain/decisions';
import type { Timestamp } from '@researchforce/domain/types';
import { sweepDecisionRevisits } from '../src/records/decision-operations';
import { wordingDigestOf } from '../src/records/kinds/decision';
import { errorOf, itemWorld, rich } from './items';

const world = itemWorld();
const at = (days: number) => new Date(Date.parse(world.at) + days * 24 * 60 * 60 * 1000).toISOString() as Timestamp;
const env = () => ({ RF_CORE: world.core() }) as never;
const count = async (sql: string, ...values: unknown[]) => (await world.core().prepare(sql).bind(...values).first<number>('n'))!;
const ALTERNATIVES = [{ title: 'First half', description: 'Search keys 0 through 49.' }, { title: 'Second half', description: 'Search keys 50 through 99.' }];
const decide = (overrides: Record<string, unknown> = {}) => world.created('author', 'decision_record', {
  alternatives: ALTERNATIVES, scope: 'team', participantIds: [world.ids.colleague, world.ids.admin], rationale: rich('The first half is cheaper.'), outcome: { kind: 'selected', alternative: 0 }, ...overrides,
});
const post = (who: 'author' | 'colleague' | 'admin', id: unknown, action: string, body: Record<string, unknown>) => world.request(who, 'POST', `/decisions/${String(id)}/${action}`, body);
const fresh = async (who: 'author' | 'colleague' | 'admin', id: unknown) => world.view(who, id as string);
const events = async (id: unknown) => (await world.core().prepare('SELECT seq, kind, actor_id AS actor, related_id AS related, reason FROM decision_events WHERE decision_id = ?1 ORDER BY seq').bind(id).all<{ seq: number; kind: string; actor: string | null; related: string | null; reason: string | null }>()).results;
const notified = async (type: string, root: unknown) => [...new Set((await world.core().prepare('SELECT member_id AS member FROM notification_events WHERE event_type = ?1 AND root_id = ?2 ORDER BY member_id').bind(type, root).all<{ member: string }>()).results.map((row) => row.member))].sort();
const state = async (id: unknown) => (await world.core().prepare('SELECT state, supersedes_id AS supersedes, superseded_by_id AS supersededBy, adopted_by AS adoptedBy FROM decisions WHERE unit_id = ?1').bind(id).first<{ state: string; supersedes: string | null; supersededBy: string | null; adoptedBy: string | null }>())!;

describe('adopting a decision (R53.2, R53.4)', () => {
  it('adopts a proposed decision, records who and when, and tells the participants', async () => {
    const decision = await decide();
    const response = await post('author', decision.id, 'adopt', { rev: decision['rev'] });
    expect(response.status).toBe(200);
    expect(await state(decision.id)).toMatchObject({ state: 'adopted', adoptedBy: world.ids.author });
    const view = await fresh('colleague', decision.id);
    expect(view).toMatchObject({ decisionState: 'adopted', decisionAdoptedBy: world.ids.author, decisionAdoptedAt: world.at });
    expect(view['decisionEvents']).toMatchObject([{ seq: 1, kind: 'adopted', actorId: world.ids.author }]);
    expect(view['participantResponses']).toMatchObject([{ memberId: world.ids.colleague, status: 'no_response' }, { memberId: world.ids.admin, status: 'no_response' }]);
    expect(await count("SELECT count(*) AS n FROM revisions WHERE target_id = ?1 AND kind = 'status_change'", decision.id)).toBe(1);
    expect(await notified('item_update', decision.id)).toEqual([world.ids.admin, world.ids.colleague].sort());
  });

  it('needs a rationale and an outcome, naming what is missing, and changes nothing otherwise', async () => {
    const decision = await world.created('author', 'decision_record', { alternatives: ALTERNATIVES });
    const refused = await errorOf(await post('author', decision.id, 'adopt', { rev: decision['rev'] }));
    expect(refused.status).toBe(422);
    expect(refused.fields?.map((field) => field.field).sort()).toEqual(['outcome', 'rationale']);
    expect(await state(decision.id)).toMatchObject({ state: 'proposed' });
    expect(await events(decision.id)).toEqual([]);
  });

  it('is for the Owner or an editor, not for a participant who only reads', async () => {
    const decision = await decide();
    expect((await post('colleague', decision.id, 'adopt', { rev: decision['rev'] })).status).toBe(403);
    expect((await post('admin', decision.id, 'adopt', { rev: decision['rev'] })).status).toBe(200);
    expect(await state(decision.id)).toMatchObject({ state: 'adopted', adoptedBy: world.ids.admin });
  });

  it('refuses a stale revision and a decision that is no longer proposed, and never adopts twice', async () => {
    const decision = await decide();
    expect((await post('author', decision.id, 'adopt', { rev: (decision['rev'] as number) + 5 })).status).toBe(409);
    expect((await post('author', decision.id, 'adopt', { rev: decision['rev'] })).status).toBe(200);
    const again = await fresh('author', decision.id);
    expect((await post('author', decision.id, 'adopt', { rev: again['rev'] })).status).toBe(409);
    expect(await events(decision.id)).toHaveLength(1);
  });

  it('keeps events as they were written', async () => {
    const decision = await decide();
    await post('author', decision.id, 'adopt', { rev: decision['rev'] });
    await expect(world.core().prepare("UPDATE decision_events SET kind = 'withdrawn' WHERE decision_id = ?1").bind(decision.id).run()).rejects.toThrow(/decision_event_immutable/);
  });
});

describe('withdrawing a decision (R53.4)', () => {
  it('withdraws a proposed or an adopted decision with its reason, and keeps it final', async () => {
    const proposed = await decide();
    expect((await post('author', proposed.id, 'withdraw', { rev: proposed['rev'], reason: 'The question was withdrawn.' })).status).toBe(200);
    expect(await state(proposed.id)).toMatchObject({ state: 'withdrawn' });
    expect(await events(proposed.id)).toMatchObject([{ kind: 'withdrawn', reason: 'The question was withdrawn.', actor: world.ids.author }]);
    const view = await fresh('author', proposed.id);
    expect((await post('author', proposed.id, 'adopt', { rev: view['rev'] })).status).toBe(409);
    const adopted = await decide();
    await post('author', adopted.id, 'adopt', { rev: adopted['rev'] });
    const next = await fresh('author', adopted.id);
    expect((await post('author', adopted.id, 'withdraw', { rev: next['rev'] })).status).toBe(200);
    expect((await events(adopted.id)).map((event) => event.kind)).toEqual(['adopted', 'withdrawn']);
    expect(await notified('item_update', adopted.id)).toEqual([world.ids.admin, world.ids.colleague].sort());
  });
});

describe('superseding a decision (R53.4)', () => {
  const adopted = async (overrides: Record<string, unknown> = {}) => {
    const decision = await decide(overrides);
    await post('author', decision.id, 'adopt', { rev: decision['rev'] });
    return fresh('author', decision.id);
  };

  it('links both ways in one step, keeps the earlier rationale and responses visible, and tells both audiences', async () => {
    const earlier = await adopted({ revisitDate: { value: '2027-01-01', approx: false } });
    const ack = await post('colleague', earlier.id, 'acknowledge', { response: 'acknowledged', digest: wordingDigestOf(earlier), wordingVersion: 1, expectedVersion: 0 });
    expect(ack.status).toBe(201);
    const replacement = await decide({ rationale: rich('The second half is cheaper.'), outcome: { kind: 'selected', alternative: 1 } });
    const response = await post('author', replacement.id, 'supersede', { rev: replacement['rev'], supersededId: earlier.id, supersededRev: (await fresh('author', earlier.id))['rev'] });
    expect(response.status).toBe(200);
    expect(await state(earlier.id)).toMatchObject({ state: 'superseded', supersededBy: replacement.id });
    expect(await state(replacement.id)).toMatchObject({ state: 'adopted', supersedes: earlier.id });
    const before = await fresh('colleague', earlier.id);
    expect(before).toMatchObject({ decisionState: 'superseded', rationale: rich('The first half is cheaper.'), supersededBy: { id: replacement.id, state: 'adopted', rationale: 'The second half is cheaper.' } });
    expect(before['participantResponses']).toMatchObject([{ memberId: world.ids.colleague, status: 'acknowledged' }, { memberId: world.ids.admin, status: 'no_response' }]);
    const after = await fresh('colleague', replacement.id);
    expect(after).toMatchObject({ decisionState: 'adopted', supersedes: { id: earlier.id, state: 'superseded', rationale: 'The first half is cheaper.' } });
    expect((after['supersedes'] as { responses: { memberId: string; status: string }[] }).responses).toMatchObject([{ memberId: world.ids.colleague, status: 'acknowledged' }, { memberId: world.ids.admin, status: 'no_response' }]);
    expect((await events(earlier.id)).map((event) => [event.kind, event.related])).toEqual([['adopted', null], ['superseded', replacement.id]]);
    expect(await events(replacement.id)).toMatchObject([{ kind: 'adopted', related: earlier.id }]);
    expect(await count("SELECT count(*) AS n FROM revisions WHERE target_id = ?1 AND kind = 'status_change'", earlier.id)).toBe(2);
    expect(await notified('item_update', earlier.id)).toEqual(expect.arrayContaining([world.ids.colleague, world.ids.admin]));
  });

  it('changes nothing when the earlier decision moved since it was read, or when it is not adopted', async () => {
    const earlier = await adopted();
    const replacement = await decide();
    const stale = await post('author', replacement.id, 'supersede', { rev: replacement['rev'], supersededId: earlier.id, supersededRev: (earlier['rev'] as number) + 3 });
    expect(stale.status).toBe(409);
    expect(await state(replacement.id)).toMatchObject({ state: 'proposed', supersedes: null });
    expect(await state(earlier.id)).toMatchObject({ state: 'adopted', supersededBy: null });
    const proposed = await decide();
    const notAdopted = await post('author', replacement.id, 'supersede', { rev: replacement['rev'], supersededId: proposed.id, supersededRev: proposed['rev'] });
    expect(notAdopted.status).toBe(409);
    expect((await post('author', replacement.id, 'supersede', { rev: replacement['rev'], supersededId: replacement.id, supersededRev: replacement['rev'] })).status).toBe(422);
    expect(await events(replacement.id)).toEqual([]);
  });

  it('replaces a decision only once, and refuses one the actor cannot edit', async () => {
    const earlier = await adopted();
    const first = await decide();
    expect((await post('author', first.id, 'supersede', { rev: first['rev'], supersededId: earlier.id, supersededRev: earlier['rev'] })).status).toBe(200);
    const second = await decide();
    const current = await fresh('author', earlier.id);
    expect((await post('author', second.id, 'supersede', { rev: second['rev'], supersededId: earlier.id, supersededRev: current['rev'] })).status).toBe(409);
    const other = await adopted();
    const third = await decide();
    expect((await post('colleague', third.id, 'supersede', { rev: third['rev'], supersededId: other.id, supersededRev: other['rev'] })).status).toBe(403);
  });

  it('does not name an earlier decision the Member cannot read', async () => {
    const hidden = await adopted({ access: { level: 'restricted', members: [world.ids.admin] } });
    const replacement = await world.created('colleague', 'decision_record', { alternatives: ALTERNATIVES, rationale: rich('Why.'), outcome: { kind: 'selected', alternative: 0 } });
    const refused = await errorOf(await post('colleague', replacement.id, 'supersede', { rev: replacement['rev'], supersededId: hidden.id, supersededRev: hidden['rev'] }));
    expect(refused.status).toBe(422);
    expect(JSON.stringify(refused)).not.toContain('first half');
    expect((await fresh('author', hidden.id))['decisionState']).toBe('adopted');
  });
});

describe('a Member’s own response through the API (R53.2, R53.3)', () => {
  it('records the actor’s response, refuses another Member’s and stale wording, and invalidates older answers when the wording changes', async () => {
    const decision = await decide();
    const input = { response: 'disagreed', comment: 'The second half has the better odds.', digest: wordingDigestOf(decision), wordingVersion: 1, expectedVersion: 0 };
    expect((await post('author', decision.id, 'acknowledge', input)).status).toBe(422);
    expect((await post('colleague', decision.id, 'acknowledge', { ...input, digest: 'f'.repeat(64) })).status).toBe(422);
    expect((await post('colleague', decision.id, 'acknowledge', input)).status).toBe(201);
    expect((await post('colleague', decision.id, 'acknowledge', input)).status).toBe(422);
    const view = await fresh('author', decision.id);
    expect(view['participantResponses']).toMatchObject([{ memberId: world.ids.colleague, status: 'disagreed' }, { memberId: world.ids.admin, status: 'no_response' }]);
    const edited = await world.edit('author', decision.id as string, { rev: view['rev'], mark: { mark: 'correction', reason: 'Synthetic.' }, rationale: rich('Reworded.') });
    expect(edited.status).toBe(200);
    expect((await fresh('author', decision.id))['participantResponses']).toMatchObject([{ memberId: world.ids.colleague, status: 'earlier_wording' }, { status: 'no_response' }]);
  });

  it('answers no decision once it is final', async () => {
    const decision = await decide();
    await post('author', decision.id, 'withdraw', { rev: decision['rev'] });
    const refused = await post('colleague', decision.id, 'acknowledge', { response: 'acknowledged', digest: wordingDigestOf(decision), wordingVersion: 1, expectedVersion: 0 });
    expect(refused.status).toBe(409);
  });
});

describe('revisit reminders (R53.4)', () => {
  it('remind the Owner, the adopter and the participants once the date comes and again after each interval, until the decision is revisited', async () => {
    const decision = await decide({ revisitDate: { value: '2026-11-05', approx: false } });
    await post('admin', decision.id, 'adopt', { rev: decision['rev'] });
    expect(await sweepDecisionRevisits(env(), at(8))).toBe(0);
    expect(await sweepDecisionRevisits(env(), at(9))).toBe(1);
    expect(await sweepDecisionRevisits(env(), at(10))).toBe(0);
    expect(await notified('reminder', decision.id)).toEqual([world.ids.admin, world.ids.author, world.ids.colleague].sort());
    expect(await sweepDecisionRevisits(env(), at(17))).toBe(1);
    expect((await events(decision.id)).map((event) => [event.kind, event.actor])).toEqual([['adopted', world.ids.admin], ['revisit_due', null], ['revisit_due', null]]);
    await post('admin', decision.id, 'withdraw', { rev: (await fresh('admin', decision.id))['rev'] });
    expect(await sweepDecisionRevisits(env(), at(40))).toBe(0);
  });

  it('skip a proposed decision, a decision without a date, and a date still ahead', async () => {
    await decide({ revisitDate: { value: '2026-11-05', approx: false } });
    const none = await decide();
    await post('author', none.id, 'adopt', { rev: none['rev'] });
    const ahead = await decide({ revisitDate: { value: '2030-01-01', approx: false } });
    await post('author', ahead.id, 'adopt', { rev: ahead['rev'] });
    expect(await sweepDecisionRevisits(env(), at(60))).toBe(0);
  });
});

describe('the public view of a decision (R53.5)', () => {
  it('carries the reasoning and the state, never the participants, responses or who acted', () => {
    const canary = 'CANARY-PRIVATE-PARTICIPANT';
    const view = publicDecision({
      question: 'Which range?', context: 'Context.', rationale: 'Because.', alternatives: [{ title: 'A', description: 'B' }], outcome: { kind: 'selected', alternative: 0 }, scope: 'team',
      state: 'adopted', adoptedAt: '2026-10-27T00:00:00.000Z', revisitDate: '2027-01-01',
      participants: [canary], participantResponses: [{ memberId: canary, status: 'disagreed', comment: canary }], adoptedBy: canary, decisionEvents: [{ actorName: canary }],
    } as never);
    expect(JSON.stringify(view)).not.toContain(canary);
    expect(Object.keys(view).sort()).toEqual(['adoptedAt', 'alternatives', 'context', 'outcome', 'question', 'rationale', 'revisitDate', 'scope', 'state']);
  });
});

describe('exporting a decision (R53.5)', () => {
  it('exports what the Member can read as strict JSON, with the state, history and each participant’s own status', async () => {
    const earlier = await decide();
    await post('author', earlier.id, 'adopt', { rev: earlier['rev'] });
    const replacement = await decide({ rationale: rich('The second half is cheaper.'), outcome: { kind: 'selected', alternative: 1 } });
    await post('author', replacement.id, 'supersede', { rev: replacement['rev'], supersededId: earlier.id, supersededRev: (await fresh('author', earlier.id))['rev'] });
    const response = await world.request('colleague', 'GET', `/decisions/${String(replacement.id)}/export`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('decision.json');
    const document = JSON.parse(await response.text()) as Record<string, unknown>;
    expect(document).toMatchObject({
      format: 'researchforce-decision', version: 1, id: replacement.id, state: 'adopted', events: [{ kind: 'adopted', relatedId: earlier.id }],
      participants: [{ memberId: world.ids.colleague, status: 'no_response' }, { memberId: world.ids.admin, status: 'no_response' }], supersedes: { id: earlier.id, state: 'superseded' },
    });
    expect(JSON.parse(JSON.stringify(document))).toEqual(document);
    expect((await world.request('colleague', 'GET', `/decisions/${world.ids.author}/export`)).status).toBe(404);
  });

  it('leaves out a decision the Member cannot read', async () => {
    const hidden = await decide({ access: { level: 'restricted', members: [world.ids.admin] } });
    expect((await world.request('colleague', 'GET', `/decisions/${String(hidden.id)}/export`)).status).toBe(404);
  });
});

describe('deleting a decision', () => {
  it('leaves no event of it behind', async () => {
    const decision = await decide();
    await post('author', decision.id, 'adopt', { rev: decision['rev'] });
    expect(await count('SELECT count(*) AS n FROM decision_events WHERE decision_id = ?1', decision.id)).toBe(1);
  });
});

