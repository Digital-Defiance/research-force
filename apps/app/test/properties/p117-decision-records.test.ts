// Feature: research-collab-cms, Property 117: Decisions never infer another Member's agreement
import { describe, expect, it } from 'vitest';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { itemWorld, rich } from '../items';
import type { Who } from '../items';

/**
 * Validates R53.1 to R53.5 against an independent model. One Team decision, owned by the author and naming the colleague and the administrator,
 * is driven through random sequences of responses (some to wording that has since changed, some replacing a response the Member never saw, some
 * by a Member who is not named), rewordings, outcome changes, adoption, withdrawal and loss of access. After every step each participant's status
 * is exactly their own latest response judged against the wording as it is now: silence is `no_response`, a response to older wording is
 * `earlier_wording` (and is current again if the wording is put back), and no participant's status ever depends on another Member's action. A refused
 * step changes nothing at all, every response is kept as the next version of its Member's own, and a decision is adopted only with an outcome.
 */
const PARTICIPANTS = ['colleague', 'admin'] as const;
const ACTORS: readonly Who[] = ['author', 'colleague', 'admin'];
const RATIONALES = ['The first half is cheaper.', 'The second half is cheaper.', 'Neither half is cheaper.'] as const;
const OUTCOMES = ['selected0', 'selected1', 'deferred'] as const;
type Outcome = typeof OUTCOMES[number] | null;
const outcomeBody = (outcome: Exclude<Outcome, null>) => (outcome === 'deferred' ? { kind: 'deferred', reason: 'Waiting for the archive.' } : { kind: 'selected', alternative: outcome === 'selected0' ? 0 : 1 });
const ALTERNATIVES = [{ title: 'First half', description: 'Search keys 0 through 49.' }, { title: 'Second half', description: 'Search keys 50 through 99.' }];

type Status = 'acknowledged' | 'disagreed' | 'earlier_wording' | 'no_response';
interface Response { response: 'acknowledged' | 'disagreed'; key: string; wv: number }
interface Model { rationale: number; outcome: Outcome; wv: number; state: 'proposed' | 'adopted' | 'withdrawn'; restricted: boolean; responses: Record<string, Response[]>; digests: Map<string, string>; seen: { key: string; wv: number; digest: string }[] }
type Op =
  | { t: 'ack'; who: Who; response: 'acknowledged' | 'disagreed'; wording: 'fresh' | number; version: 'fresh' | 'stale'; comment: boolean }
  | { t: 'reword'; who: Who; to: number; stale: boolean }
  | { t: 'outcome'; who: Who; to: number }
  | { t: 'detail'; who: Who }
  | { t: 'adopt'; who: Who; stale: boolean }
  | { t: 'withdraw'; who: Who; stale: boolean }
  | { t: 'restrict' };

const who = fc.constantFrom(...ACTORS);
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 8, arbitrary: fc.record({
    t: fc.constant('ack' as const), who, response: fc.constantFrom('acknowledged' as const, 'disagreed' as const),
    wording: fc.oneof({ weight: 3, arbitrary: fc.constant('fresh' as const) }, { weight: 1, arbitrary: fc.nat(10) }), version: fc.constantFrom('fresh' as const, 'fresh' as const, 'stale' as const), comment: fc.boolean(),
  }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('reword' as const), who, to: fc.nat(2), stale: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('outcome' as const), who, to: fc.nat(2) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('detail' as const), who }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('adopt' as const), who, stale: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('withdraw' as const), who, stale: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('restrict' as const) }) },
);

const world = itemWorld();
const keyOf = (model: Pick<Model, 'rationale' | 'outcome'>): string => `${model.rationale}|${model.outcome ?? '-'}`;

describe('Property 117: Decisions never infer another Member’s agreement', () => {
  it('matches an independent model after every step, changes nothing on a refusal, and never fills in a silent participant', async () => {
    let run = 0;
    await fc.assert(fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 12 }), async (ops) => {
      run += 1;
      const created = await world.created('author', 'decision_record', {
        title: `Decision ${run}`, alternatives: ALTERNATIVES, scope: 'team', participantIds: PARTICIPANTS.map((name) => world.ids[name]), rationale: rich(RATIONALES[0]),
      });
      const id = created.id as string;
      const model: Model = { rationale: 0, outcome: null, wv: 1, state: 'proposed', restricted: false, responses: { colleague: [], admin: [] }, digests: new Map(), seen: [] };
      const send = (actor: Who, method: string, path: string, body?: unknown) => world.request(actor, method, path, body);
      const counts = async (): Promise<string> => JSON.stringify([
        (await world.core().prepare('SELECT member_id AS m, version, response, digest FROM decision_acknowledgements WHERE decision_id = ?1 ORDER BY member_id, version').bind(id).all()).results,
        await world.core().prepare('SELECT state, wording_version AS wv, wording_digest AS d, outcome_kind AS k, outcome_alternative AS a FROM decisions WHERE unit_id = ?1').bind(id).first(),
        (await world.view('admin', id))['rev'],
        await world.core().prepare('SELECT count(*) AS n FROM decision_events WHERE decision_id = ?1').bind(id).first<number>('n'),
      ]);
      const expected = (name: string): Status => {
        const last = model.responses[name]!.at(-1);
        if (last === undefined) return 'no_response';
        return last.key === keyOf(model) && last.wv >= 1 && model.digests.get(last.key) === model.digests.get(keyOf(model)) ? last.response : 'earlier_wording';
      };

      const verify = async (label: string): Promise<void> => {
        const item = await world.view('author', id);
        const digest = item['wordingDigest'] as string;
        // The same wording always has the same digest, and different wordings never share one.
        const known = model.digests.get(keyOf(model));
        if (known === undefined) {
          expect([...model.digests.values()], `${label} digest reused by another wording`).not.toContain(digest);
          model.digests.set(keyOf(model), digest);
        } else expect(digest, `${label} digest of the same wording`).toBe(known);
        if (!model.seen.some((entry) => entry.key === keyOf(model) && entry.wv === model.wv)) model.seen.push({ key: keyOf(model), wv: model.wv, digest });
        expect(item, `${label} item`).toMatchObject({ decisionState: model.state, wordingVersion: model.wv });
        const statuses = Object.fromEntries((item['participantResponses'] as { memberId: string; status: Status }[]).map((entry) => [entry.memberId, entry.status]));
        expect(statuses, `${label} statuses`).toEqual(Object.fromEntries(PARTICIPANTS.map((name) => [world.ids[name], expected(name)])));
        // Every response is kept, as the next version of its Member's own, and nobody else's.
        const rows = (await world.core().prepare('SELECT member_id AS m, version FROM decision_acknowledgements WHERE decision_id = ?1 ORDER BY member_id, version').bind(id).all<{ m: string; version: number }>()).results;
        expect(rows, `${label} history`).toEqual(PARTICIPANTS.flatMap((name) => model.responses[name]!.map((_response, index) => ({ m: world.ids[name], version: index + 1 }))).sort((a, b) => (a.m < b.m ? -1 : a.m > b.m ? 1 : a.version - b.version)));
        const theirs = await send('colleague', 'GET', `/items/${id}`);
        expect(theirs.status, `${label} colleague read`).toBe(model.restricted ? 404 : 200);
      };
      await verify('start');

      for (const [step, op] of ops.entries()) {
        const label = `step ${step} ${JSON.stringify(op)}`;
        if (op.t === 'restrict') {
          await world.core().prepare("UPDATE research_items SET access_level = 'restricted' WHERE unit_id = ?1").bind(id).run();
          model.restricted = true;
          await verify(label);
          continue;
        }
        const before = await counts();
        const item = await world.view('author', id);
        const rev = item['rev'] as number;
        const mayEdit = op.who === 'author' || op.who === 'admin';
        let allowed: boolean;
        let apply = (): void => undefined;
        let response: Response2;
        if (op.t === 'ack') {
          const mine = op.who === 'author' ? [] : model.responses[op.who]!;
          const target = op.wording === 'fresh' ? undefined : model.seen[op.wording % model.seen.length]!;
          const digest = target?.digest ?? (item['wordingDigest'] as string);
          const wv = target?.wv ?? model.wv;
          const expectedVersion = op.version === 'fresh' ? mine.length : mine.length + 1;
          response = await send(op.who, 'POST', `/decisions/${id}/acknowledge`, {
            response: op.response, digest, wordingVersion: wv, expectedVersion, ...(op.comment ? { comment: 'My reasons.' } : {}),
          });
          const named = op.who !== 'author';
          const current = model.digests.get(keyOf(model)) === digest && wv === model.wv;
          const hidden = model.restricted && op.who === 'colleague';
          allowed = named && !hidden && model.state !== 'withdrawn' && current && op.version === 'fresh';
          apply = () => { model.responses[op.who]!.push({ response: op.response, key: keyOf(model), wv: model.wv }); };
        } else if (op.t === 'reword' || op.t === 'outcome') {
          const wording = op.t === 'reword'
            ? { rationale: (model.rationale + 1 + op.to % 2) % RATIONALES.length }
            : { outcome: OUTCOMES[(Math.max(0, OUTCOMES.indexOf(model.outcome ?? 'deferred')) + (model.outcome === null ? 0 : 1 + op.to % 2)) % OUTCOMES.length]! };
          const body = op.t === 'reword' ? { rationale: rich(RATIONALES[wording.rationale!]!) } : { outcome: outcomeBody(wording.outcome!) };
          const stale = op.t === 'reword' && op.stale;
          response = await send(op.who, 'PATCH', `/items/${id}`, { rev: stale ? rev + 3 : rev, mark: { mark: 'correction', reason: 'Synthetic.' }, ...body });
          allowed = mayEdit && !stale && model.state !== 'withdrawn';
          apply = () => { if (wording.rationale !== undefined) model.rationale = wording.rationale; if (wording.outcome !== undefined) model.outcome = wording.outcome; model.wv += 1; };
        } else if (op.t === 'detail') {
          response = await send(op.who, 'PATCH', `/items/${id}`, { rev, mark: { mark: 'minor_edit', reason: 'Synthetic.' }, revisitCondition: `Condition ${step}` });
          allowed = mayEdit && model.state !== 'withdrawn';
        } else if (op.t === 'adopt') {
          response = await send(op.who, 'POST', `/decisions/${id}/adopt`, { rev: op.stale ? rev + 3 : rev });
          allowed = mayEdit && !op.stale && model.state === 'proposed' && model.outcome !== null;
          apply = () => { model.state = 'adopted'; };
        } else {
          response = await send(op.who, 'POST', `/decisions/${id}/withdraw`, { rev: op.stale ? rev + 3 : rev });
          allowed = mayEdit && !op.stale && model.state !== 'withdrawn';
          apply = () => { model.state = 'withdrawn'; };
        }
        expect(response.status >= 200 && response.status < 300, `${label} -> ${response.status}`).toBe(allowed);
        if (allowed) apply();
        else expect(await counts(), `${label} refused but changed something`).toBe(before);
        await verify(label);
      }
    }), { numRuns: Math.min(FC_RUNS, 25) });
  }, 280_000);
});

type Response2 = Awaited<ReturnType<typeof world.request>>;

describe('concrete scenarios (R53.2, R53.3)', () => {
  const statuses = async (id: string) => Object.fromEntries(((await world.view('author', id))['participantResponses'] as { memberId: string; status: string }[]).map((entry) => [entry.memberId, entry.status]));
  const decide = (overrides: Record<string, unknown> = {}) => world.created('author', 'decision_record', {
    alternatives: ALTERNATIVES, scope: 'team', participantIds: [world.ids.colleague, world.ids.admin], rationale: rich(RATIONALES[0]), outcome: outcomeBody('selected0'), ...overrides,
  });
  const respond = async (actor: Who, id: string, input: Record<string, unknown> = {}) => {
    const item = await world.view('author', id);
    return world.request(actor, 'POST', `/decisions/${id}/acknowledge`, { response: 'acknowledged', digest: item['wordingDigest'], wordingVersion: item['wordingVersion'], expectedVersion: 0, ...input });
  };

  it('does not read one participant’s agreement, the Owner’s adoption, or an Administrator’s role as anyone else’s', async () => {
    const decision = await decide();
    const id = decision.id as string;
    expect((await respond('colleague', id)).status).toBe(201);
    expect((await world.request('author', 'POST', `/decisions/${id}/adopt`, { rev: (await world.view('author', id))['rev'] })).status).toBe(200);
    expect(await statuses(id)).toEqual({ [world.ids.colleague]: 'acknowledged', [world.ids.admin]: 'no_response' });
    expect((await respond('author', id)).status).toBe(422);
    expect(await statuses(id)).toEqual({ [world.ids.colleague]: 'acknowledged', [world.ids.admin]: 'no_response' });
  });

  it('counts a response to older wording for nothing, until the wording is put back', async () => {
    const decision = await decide();
    const id = decision.id as string;
    await respond('colleague', id, { response: 'disagreed' });
    const edit = async (text: string) => world.request('author', 'PATCH', `/items/${id}`, { rev: (await world.view('author', id))['rev'], mark: { mark: 'correction', reason: 'Synthetic.' }, rationale: rich(text) });
    expect((await edit(RATIONALES[1])).status).toBe(200);
    expect((await statuses(id))[world.ids.colleague]).toBe('earlier_wording');
    expect((await edit(RATIONALES[0])).status).toBe(200);
    expect((await statuses(id))[world.ids.colleague]).toBe('disagreed');
  });

  it('shows an individual decision with no participants and takes no response to it', async () => {
    const decision = await decide({ scope: 'individual', participantIds: undefined });
    expect((await world.view('author', decision.id as string))['participantResponses']).toEqual([]);
    expect((await respond('colleague', decision.id as string)).status).toBe(422);
  });

  it('refuses a response from a Member who can no longer read the decision', async () => {
    const decision = await decide();
    await world.core().prepare("UPDATE research_items SET access_level = 'restricted' WHERE unit_id = ?1").bind(decision.id).run();
    expect((await respond('colleague', decision.id as string)).status).toBe(404);
    expect(await statuses(decision.id as string)).toEqual({ [world.ids.colleague]: 'no_response', [world.ids.admin]: 'no_response' });
  });
});

describe('maximum encoded input (R53.1, R53.3)', () => {
  const astral = (length: number) => '𝒜'.repeat(length);
  const base = { alternatives: ALTERNATIVES, rationale: rich('Because.'), outcome: outcomeBody('selected0') };
  const create = (body: Record<string, unknown>) => world.create('author', 'decision_record', { projectId: world.projectId, title: 'Maximum', logSummary: rich('S'), question: 'Which?', ...base, ...body });

  it('accepts a question of 2,000 code points, a context and a rationale of 20,000, and refuses one more of each', async () => {
    for (const [field, limit] of [['question', 2000], ['context', 20_000], ['rationale', 20_000]] as const) {
      const value = (length: number) => (field === 'question' ? astral(length) : rich(astral(length)));
      expect((await create({ [field]: value(limit + 1) })).status, `${field} over`).toBe(422);
      const accepted = await create({ [field]: value(limit) });
      expect(accepted.status, field).toBe(201);
      const read = (await accepted.json<{ item: Record<string, unknown> }>()).item[field];
      expect(field === 'question' ? read : (read as { text: string }).text, `${field} read back`).toBe(astral(limit));
    }
  }, 120_000);

  it('accepts 20 alternatives of the longest title and description, and refuses a 21st or a longer one', async () => {
    const alternative = (title: number, description: number) => ({ title: astral(title), description: astral(description) });
    const many = (count: number) => Array.from({ length: count }, () => alternative(200, 5000));
    expect((await create({ alternatives: many(21) })).status).toBe(422);
    expect((await create({ alternatives: [alternative(201, 1)] })).status).toBe(422);
    expect((await create({ alternatives: [alternative(1, 5001)] })).status).toBe(422);
    const accepted = await create({ alternatives: many(20), outcome: { kind: 'selected', alternative: 19 } });
    expect(accepted.status).toBe(201);
    expect((await accepted.json<{ item: { alternatives: unknown[] } }>()).item.alternatives).toEqual(many(20));
  }, 120_000);

  it('accepts a revisit condition and a deferral reason of 1,000 code points and a comment of 2,000, and refuses one more of each', async () => {
    expect((await create({ revisitCondition: astral(1001) })).status).toBe(422);
    expect((await create({ revisitCondition: astral(1000) })).status).toBe(201);
    expect((await create({ outcome: { kind: 'deferred', reason: astral(1001) } })).status).toBe(422);
    const decision = await create({ scope: 'team', participantIds: [world.ids.colleague], outcome: { kind: 'deferred', reason: astral(1000) } });
    expect(decision.status).toBe(201);
    const item = (await decision.json<{ item: Record<string, unknown> }>()).item;
    const fresh = await world.view('colleague', item['id'] as string);
    const body = (comment: string) => ({ response: 'disagreed', comment, digest: fresh['wordingDigest'], wordingVersion: fresh['wordingVersion'], expectedVersion: 0 });
    expect((await world.request('colleague', 'POST', `/decisions/${String(item['id'])}/acknowledge`, body(astral(2001)))).status).toBe(422);
    expect((await world.request('colleague', 'POST', `/decisions/${String(item['id'])}/acknowledge`, body(astral(2000)))).status).toBe(201);
    const stored = (await world.view('author', item['id'] as string))['participantResponses'] as { latest?: { comment: string } }[];
    expect(stored[0]!.latest!.comment).toBe(astral(2000));
  }, 120_000);
});
