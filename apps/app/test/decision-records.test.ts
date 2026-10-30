import { describe, expect, it } from 'vitest';
import { GuardedBatch } from '@researchforce/db/batch';
import type { AcknowledgementInput } from '@researchforce/domain/decisions';
import { newULID } from '@researchforce/domain/identifiers';
import type { ULID } from '@researchforce/domain/types';
import { JOB_HANDLERS } from '../src/do/jobs';
import type { JsonValue } from '../src/do/jobs';
import '../src/jobs/deletion';
import { readParticipantResponses, readResponseHistory, recordAcknowledgement } from '../src/records/decisions';
import { wordingDigestOf } from '../src/records/kinds/decision';
import { drainSearch } from '../src/search/indexer';
import { errorOf, itemWorld, rich } from './items';
import type { ItemView } from './items';

const world = itemWorld();
const count = async (sql: string, ...values: unknown[]) => (await world.core().prepare(sql).bind(...values).first<number>('n'))!;
const ALTERNATIVES = [{ title: 'First half', description: 'Search keys 0 through 49.' }, { title: 'Second half', description: 'Search keys 50 through 99.' }];
const stored = (id: unknown) => world.core().prepare('SELECT state, scope, wording_digest AS digest, wording_version AS version, outcome_kind AS kind, outcome_alternative AS alternative FROM decisions WHERE unit_id = ?1')
  .bind(id).first<{ state: string; scope: string; digest: string; version: number; kind: string | null; alternative: number | null }>();
async function runDeletion(jobId: string): Promise<void> {
  const row = (await world.core().prepare('SELECT params, requested_by AS requestedBy FROM jobs WHERE id = ?1').bind(jobId).first<{ params: string; requestedBy: ULID }>())!;
  let cursor: JsonValue = null;
  for (;;) {
    const result = await JOB_HANDLERS.deletion!.slice({ env: world.bindings, job: { id: jobId, type: 'deletion', params: JSON.parse(row.params) as JsonValue, requestedBy: row.requestedBy }, now: world.at }, cursor);
    if (result.done) return;
    cursor = result.cursor;
  }
}
const refusal = (work: Promise<unknown>) => work.then(() => undefined, (error: unknown) => error);
const edit = async (who: 'author' | 'colleague' | 'admin', item: ItemView, changes: Record<string, unknown>, mark = 'correction') => {
  const response = await world.edit(who, item.id as string, { rev: item['rev'], mark: { mark, reason: 'Synthetic.' }, ...changes });
  if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json<{ item: ItemView }>()).item;
};
const team = (overrides: Record<string, unknown> = {}) => ({
  scope: 'team', participantIds: [world.ids.colleague, world.ids.admin], rationale: rich('The first half is cheaper.'), outcome: { kind: 'selected', alternative: 0 }, ...overrides,
});

describe('Decision_Record rows (R53.1)', () => {
  it('stores every field exactly and reads it back in order, starting as a proposed decision', async () => {
    const created = await world.created('author', 'decision_record', {
      context: rich('Synthetic context 😀.'), alternatives: ALTERNATIVES, revisitDate: { value: '2027-03-01', approx: false }, revisitCondition: 'When the archive replies.', ...team(),
    });
    expect(created).toMatchObject({
      kind: 'decision_record', question: 'Which synthetic key range is searched next?', context: rich('Synthetic context 😀.'), rationale: rich('The first half is cheaper.'), alternatives: ALTERNATIVES,
      outcome: { kind: 'selected', alternative: 0 }, scope: 'team', participantIds: [world.ids.colleague, world.ids.admin],
      revisitDate: { value: '2027-03-01', approx: false }, revisitCondition: 'When the archive replies.',
    });
    expect(await world.view('colleague', created.id as string)).toMatchObject({ alternatives: ALTERNATIVES, participantIds: [world.ids.colleague, world.ids.admin] });
    expect(await stored(created.id)).toMatchObject({ state: 'proposed', scope: 'team', version: 1, kind: 'selected', alternative: 0, digest: wordingDigestOf(created) });
  });

  it('keeps an individual decision without participants or outcome, and refuses invalid values naming each one', async () => {
    const created = await world.created('author', 'decision_record', { alternatives: [ALTERNATIVES[0]] });
    expect(created['outcome']).toBeUndefined();
    expect(created).toMatchObject({ scope: 'individual' });
    expect(created['participantIds']).toBeUndefined();
    expect(created['evidenceCitationIds']).toBeUndefined();
    const before = await count('SELECT count(*) AS n FROM research_items');
    const bad = await errorOf(await world.create('author', 'decision_record', {
      projectId: world.projectId, title: 'T', logSummary: rich('S'), question: ' ', alternatives: [], scope: 'team', participantIds: [], outcome: { kind: 'selected', alternative: 3 },
    }));
    expect(bad.status).toBe(422);
    expect(bad.fields?.map((field) => field.field).sort()).toEqual(['alternatives', 'outcome.alternative', 'participantIds', 'question']);
    expect(await count('SELECT count(*) AS n FROM research_items')).toBe(before);
  });

  it('starts a new wording version only when what a response answers changes', async () => {
    const created = await world.created('author', 'decision_record', { alternatives: ALTERNATIVES, ...team() });
    const first = await stored(created.id);
    const details = await edit('author', created, { revisitCondition: 'Next quarter.', participantIds: [world.ids.colleague] }, 'minor_edit');
    expect(await stored(created.id)).toMatchObject({ version: 1, digest: first!.digest });
    expect(details).toMatchObject({ revisitCondition: 'Next quarter.', participantIds: [world.ids.colleague] });
    const reworded = await edit('author', details, { rationale: rich('The second half is cheaper.') });
    const second = await stored(created.id);
    expect(second).toMatchObject({ version: 2 });
    expect(second!.digest).not.toBe(first!.digest);
    expect(second!.digest).toBe(wordingDigestOf(reworded));
    const reordered = await edit('author', reworded, { alternatives: [ALTERNATIVES[1], ALTERNATIVES[0]], outcome: { kind: 'selected', alternative: 1 } });
    expect(await stored(created.id)).toMatchObject({ version: 3, alternative: 1 });
    await edit('author', reordered, { outcome: { kind: 'deferred', reason: 'Waiting for the archive.' } });
    expect(await stored(created.id)).toMatchObject({ version: 4, kind: 'deferred', alternative: null });
    expect(await count('SELECT count(*) AS n FROM decision_alternatives WHERE decision_id = ?1', created.id)).toBe(2);
    expect(await count("SELECT count(*) AS n FROM revisions WHERE target_id = ?1 AND kind = 'correction'", created.id)).toBe(3);
  });

  it('is found by search on its question, rationale and alternatives', async () => {
    await world.created('author', 'decision_record', {
      question: 'Which zebra range?', rationale: rich('Quokka reasoning.'), alternatives: [{ title: 'Narwhal option', description: 'Pangolin details.' }],
      outcome: { kind: 'deferred', reason: 'Wombat delay.' }, revisitCondition: 'After the okapi report.',
    });
    await drainSearch({ core: world.core(), search: world.bindings.RF_SEARCH }, world.at);
    for (const word of ['zebra', 'quokka', 'narwhal', 'pangolin', 'wombat', 'okapi']) expect(await (await world.request('colleague', 'GET', `/search?q=${word}`)).text(), word).toContain('"kind":"decision_record"');
  });
});

describe('Decision_Record evidence and finality (R53.1, R53.4)', () => {
  const cite = (who: 'author' | 'colleague' | 'admin', decisionId: unknown, sourceId: unknown) => world.request(who, 'POST', '/citations', {
    citingUnitId: decisionId, citingField: 'evidence', target: { type: 'source', unitId: sourceId }, role: 'supports', locator: { type: 'page', from: 3 },
  });
  const citation = async (response: Response) => (await response.json<{ citation: { id: string } }>()).citation.id;

  it('takes evidence only from citations recorded for the decision, after it is saved', async () => {
    const source = await world.created('author', 'source');
    const refusedAtCreation = await errorOf(await world.create('author', 'decision_record', {
      projectId: world.projectId, title: 'T', logSummary: rich('S'), question: 'Q?', alternatives: ALTERNATIVES, evidenceCitationIds: [newULID(world.at)],
    }));
    expect(refusedAtCreation.fields?.map((field) => field.field)).toEqual(['evidenceCitationIds']);
    const created = await world.created('author', 'decision_record', { alternatives: ALTERNATIVES });
    const other = await world.created('author', 'finding');
    const foreign = await citation(await world.request('author', 'POST', '/citations', { citingUnitId: other.id, citingField: 'claim', target: { type: 'source', unitId: source.id }, role: 'supports', locator: { type: 'page', from: 1 } }));
    const own = await citation(await cite('author', created.id, source.id));
    const bad = await world.edit('author', created.id as string, { rev: created['rev'], mark: { mark: 'minor_edit' }, evidenceCitationIds: [foreign, newULID(world.at)] });
    expect(bad.status).toBe(422);
    expect((await bad.json<{ fields: { field: string }[] }>()).fields.map((field) => field.field)).toEqual(['evidenceCitationIds.0', 'evidenceCitationIds.1']);
    const saved = await edit('author', created, { evidenceCitationIds: [own] }, 'minor_edit');
    expect(saved['evidenceCitationIds']).toEqual([own]);
    expect(saved['evidenceDetails']).toMatchObject({ [own]: { locatorLabel: 'p. 3', state: 'current' } });
    expect(await stored(created.id)).toMatchObject({ version: 1 });
  });

  it('shows each Member only the evidence whose Source they can read, and does not let them rearrange the rest', async () => {
    const open = await world.created('author', 'source');
    const secret = await world.created('author', 'source', { access: { level: 'restricted', members: [] } });
    const created = await world.created('author', 'decision_record', { alternatives: ALTERNATIVES });
    const [a, b] = [await citation(await cite('author', created.id, open.id)), await citation(await cite('author', created.id, secret.id))];
    const saved = await edit('author', created, { evidenceCitationIds: [a, b] }, 'minor_edit');
    const seen = await world.view('colleague', created.id as string);
    expect(seen['evidenceCitationIds']).toEqual([a]);
    expect(JSON.stringify(seen['evidenceDetails'])).not.toContain(b);
    expect((await world.view('author', created.id as string))['evidenceCitationIds']).toEqual([a, b]);
    // A Member who edits the decision without seeing all of its evidence cannot change that list.
    const attempt = await world.edit('author', created.id as string, { rev: saved['rev'], mark: { mark: 'minor_edit' }, evidenceCitationIds: [a] });
    expect(attempt.status).toBe(200);
    expect(await count('SELECT count(*) AS n FROM decision_evidence WHERE decision_id = ?1', created.id)).toBe(1);
  });

  it('keeps a superseded or withdrawn decision as it was', async () => {
    const created = await world.created('author', 'decision_record', { alternatives: ALTERNATIVES });
    for (const state of ['superseded', 'withdrawn']) {
      await world.core().prepare('UPDATE decisions SET state = ?1 WHERE unit_id = ?2').bind(state, created.id).run();
      const response = await world.edit('author', created.id as string, { rev: created['rev'], mark: { mark: 'correction', reason: 'Synthetic.' }, rationale: rich('A new reason.') });
      expect(response.status).toBe(422);
      expect((await errorOf(response)).fields?.[0]?.rule).toContain(state);
    }
    await world.core().prepare("UPDATE decisions SET state = 'adopted', adopted_at = ?1, adopted_by = ?2 WHERE unit_id = ?3").bind(world.at, world.ids.author, created.id).run();
    expect((await world.edit('author', created.id as string, { rev: created['rev'], mark: { mark: 'correction', reason: 'Synthetic.' }, rationale: rich('A new reason.') })).status).toBe(200);
  });

  it('removes every row of a permanently deleted decision, and only the pointers that named it', async () => {
    const created = await world.created('author', 'decision_record', { alternatives: ALTERNATIVES, ...team() });
    const successor = await world.created('author', 'decision_record', { alternatives: ALTERNATIVES });
    await world.core().prepare('UPDATE decisions SET superseded_by_id = ?1 WHERE unit_id = ?2').bind(created.id, successor.id).run();
    await world.core().prepare("INSERT INTO decision_acknowledgements (decision_id, member_id, version, response, digest, wording_version, at) VALUES (?1, ?2, 1, 'acknowledged', ?3, 1, ?4)")
      .bind(created.id, world.ids.colleague, 'a'.repeat(64), world.at).run();
    const deleted = await world.request('admin', 'DELETE', `/items/${created.id}`, { identifier: created.identifier, reason: 'Synthetic deletion.' });
    expect(deleted.status).toBe(202);
    await runDeletion((await deleted.json<{ deletion: { jobId: string } }>()).deletion.jobId);
    for (const [table, column] of [['decisions', 'unit_id'], ['decision_alternatives', 'decision_id'], ['decision_participants', 'decision_id'], ['decision_acknowledgements', 'decision_id']]) {
      expect(await count(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?1`, created.id), table).toBe(0);
    }
    expect(await stored(successor.id)).toMatchObject({ state: 'proposed' });
    expect(await world.core().prepare('SELECT superseded_by_id AS s FROM decisions WHERE unit_id = ?1').bind(successor.id).first('s')).toBeNull();
  });
});

describe('personal acknowledgements (R53.2, R53.3)', () => {
  const respond = (who: ULID, decision: ItemView, input: Partial<AcknowledgementInput> = {}) => {
    const batch = new GuardedBatch(world.core(), { id: who, now: world.at });
    return recordAcknowledgement(batch, decision.id as ULID, {
      response: 'acknowledged', digest: wordingDigestOf(decision), wordingVersion: 1, expectedVersion: 0, ...input,
    }).commit();
  };
  const decide = (overrides: Record<string, unknown> = {}) => world.created('author', 'decision_record', { alternatives: ALTERNATIVES, ...team(), ...overrides });
  const statuses = async (decision: ItemView) => Object.fromEntries((await readParticipantResponses(world.core(), decision.id as string)).map((entry) => [entry.memberId, entry.status]));

  it('lists each named participant as no response until they answer, and never fills one in for them', async () => {
    const decision = await decide();
    expect(await statuses(decision)).toEqual({ [world.ids.colleague]: 'no_response', [world.ids.admin]: 'no_response' });
    await respond(world.ids.colleague, decision);
    expect(await statuses(decision)).toEqual({ [world.ids.colleague]: 'acknowledged', [world.ids.admin]: 'no_response' });
    // The Owner's own decision, an Administrator's role, and a completed review do not answer for anyone.
    expect((await readParticipantResponses(world.core(), decision.id as string)).find((entry) => entry.memberId === world.ids.admin)).not.toHaveProperty('latest');
  });

  it('records only the acting Member’s own response, and only a named participant’s', async () => {
    const decision = await decide();
    for (const who of [world.ids.author, newULID(world.at)]) {
      expect(await refusal(respond(who, decision))).toMatchObject({ code: 'decision_participant', status: 422 });
    }
    expect(await count('SELECT count(*) AS n FROM decision_acknowledgements')).toBe(0);
    const batch = new GuardedBatch(world.core(), { id: null, now: world.at });
    expect(() => recordAcknowledgement(batch, decision.id as ULID, { response: 'acknowledged', digest: wordingDigestOf(decision), wordingVersion: 1, expectedVersion: 0 })).toThrow(/Member/);
  });

  it('answers only a Team decision that is still open and whose participant is still active', async () => {
    const individual = await decide({ scope: 'individual' });
    expect(await refusal(respond(world.ids.colleague, individual))).toMatchObject({ code: 'decision_participant' });
    const decision = await decide();
    for (const state of ['superseded', 'withdrawn']) {
      await world.core().prepare('UPDATE decisions SET state = ?1 WHERE unit_id = ?2').bind(state, decision.id).run();
      expect(await refusal(respond(world.ids.colleague, decision)), state).toMatchObject({ code: 'decision_participant' });
    }
    await world.core().prepare("UPDATE decisions SET state = 'adopted', adopted_at = ?1, adopted_by = ?2 WHERE unit_id = ?3").bind(world.at, world.ids.author, decision.id).run();
    await respond(world.ids.colleague, decision);
    await world.core().prepare("UPDATE members SET status = 'revoked' WHERE id = ?1").bind(world.ids.admin).run();
    expect(await refusal(respond(world.ids.admin, decision))).toMatchObject({ code: 'decision_participant' });
    await world.core().prepare("UPDATE members SET status = 'active' WHERE id = ?1").bind(world.ids.admin).run();
    await world.core().prepare('UPDATE units SET withdrawn_at = ?1 WHERE id = ?2').bind(world.at, decision.id).run();
    expect(await refusal(respond(world.ids.admin, decision))).toMatchObject({ code: 'decision_participant' });
  });

  it('refuses a response to wording that has changed since it was read', async () => {
    const decision = await decide();
    const stale = wordingDigestOf(decision);
    await edit('author', decision, { rationale: rich('A different reason.') });
    expect(await refusal(respond(world.ids.colleague, decision, { digest: stale }))).toMatchObject({ code: 'decision_wording', status: 409 });
    expect(await refusal(respond(world.ids.colleague, decision, { digest: stale, wordingVersion: 2 }))).toMatchObject({ code: 'decision_wording' });
    expect(await count('SELECT count(*) AS n FROM decision_acknowledgements')).toBe(0);
    const fresh = await world.view('colleague', decision.id as string);
    await respond(world.ids.colleague, fresh, { wordingVersion: 2 });
    expect(await statuses(fresh)).toMatchObject({ [world.ids.colleague]: 'acknowledged' });
  });

  it('adds each change of mind as the next version, and refuses one that replaces a response the Member did not see', async () => {
    const decision = await decide();
    await respond(world.ids.colleague, decision);
    expect(await refusal(respond(world.ids.colleague, decision))).toMatchObject({ code: 'acknowledgement_version', status: 409 });
    expect(await refusal(respond(world.ids.colleague, decision, { expectedVersion: 5 }))).toMatchObject({ code: 'acknowledgement_version' });
    await respond(world.ids.colleague, decision, { response: 'disagreed', comment: 'Not for the second half.', expectedVersion: 1 });
    expect(await statuses(decision)).toMatchObject({ [world.ids.colleague]: 'disagreed' });
    expect(await readResponseHistory(world.core(), decision.id as string, world.ids.colleague)).toEqual([
      { version: 1, response: 'acknowledged', wordingVersion: 1, comment: null, at: world.at },
      { version: 2, response: 'disagreed', wordingVersion: 1, comment: 'Not for the second half.', at: world.at },
    ]);
    expect(await readResponseHistory(world.core(), decision.id as string, world.ids.admin)).toEqual([]);
  });

  it('lets two responses race and keeps exactly one', async () => {
    const decision = await decide();
    const results = await Promise.all([respond(world.ids.colleague, decision), respond(world.ids.colleague, decision, { response: 'disagreed' })].map(refusal));
    expect(results.filter((result) => result === undefined)).toHaveLength(1);
    expect(await count('SELECT count(*) AS n FROM decision_acknowledgements WHERE member_id = ?1', world.ids.colleague)).toBe(1);
  });

  it('reads a response to older wording as earlier wording, not as agreement, until it is renewed', async () => {
    const decision = await decide();
    await respond(world.ids.colleague, decision);
    await respond(world.ids.admin, decision, { response: 'disagreed' });
    const reworded = await edit('author', decision, { outcome: { kind: 'selected', alternative: 1 } });
    expect(await statuses(reworded)).toEqual({ [world.ids.colleague]: 'earlier_wording', [world.ids.admin]: 'earlier_wording' });
    expect((await readParticipantResponses(world.core(), decision.id as string))[0]).toMatchObject({ status: 'earlier_wording', latest: { response: 'acknowledged', version: 1, wordingVersion: 1 } });
    await respond(world.ids.colleague, reworded, { wordingVersion: 2, expectedVersion: 1 });
    expect(await statuses(reworded)).toEqual({ [world.ids.colleague]: 'acknowledged', [world.ids.admin]: 'earlier_wording' });
    // Changing only details leaves current responses current.
    await edit('author', reworded, { revisitCondition: 'Next year.' }, 'minor_edit');
    expect(await statuses(reworded)).toEqual({ [world.ids.colleague]: 'acknowledged', [world.ids.admin]: 'earlier_wording' });
  });

  it('leaves another Member’s Log Summary and Dissent_Note alone', async () => {
    const decision = await decide({ logSummary: rich('The Owner’s summary.') });
    await respond(world.ids.colleague, decision, { response: 'disagreed' });
    const after = await world.view('author', decision.id as string);
    expect(after['logSummary']).toEqual(rich('The Owner’s summary.'));
    expect(await count('SELECT count(*) AS n FROM dissent_notes')).toBe(0);
  });
});
