import { describe, expect, it } from 'vitest';
import { newULID } from '@researchforce/domain/identifiers';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { errorOf, itemBody, itemWorld, rich } from './items';
import type { ItemView, Who } from './items';

const world = itemWorld();
const keyOf = (label: string): string => `${label}-${newULID(world.at)}`.slice(0, 40);
const keyed = (who: Who, key: string, method: string, path: string, body?: unknown) => world.request(who, method, path, body, { 'Idempotency-Key': key });
const total = async (table: string) => (await world.core().prepare(`SELECT count(*) AS n FROM ${table}`).first<number>('n'))!;
const operation = async (who: Who, key: string) => world.request(who, 'GET', `/operations/${key}`);
const state = async (who: Who, key: string) => (await (await operation(who, key)).json<{ operation: { state: string; status?: number; error?: string; resource?: Record<string, string> } }>()).operation;

describe('actor-scoped operation keys', () => {
  it('records a committed write once, in the same transaction, and replays it without a second item', async () => {
    const key = keyOf('create');
    const body = itemBody('journal_entry', world.projectId);
    const before = await total('research_items');
    const first = await keyed('author', key, 'POST', '/items/journal-entry', body);
    expect(first.status).toBe(201);
    const { item } = await first.json<{ item: ItemView }>();
    expect(await total('research_items')).toBe(before + 1);
    expect(await state('author', key)).toMatchObject({ key, state: 'committed', status: 201, resource: { 'item.id': item.id } });

    const replay = await keyed('author', key, 'POST', '/items/journal-entry', body);
    expect(replay.status).toBe(201);
    expect(replay.headers.get('Idempotency-Replayed')).toBe('true');
    expect(await replay.json()).toMatchObject({ replayed: true, operation: { state: 'committed', resource: { 'item.id': item.id } } });
    expect(await total('research_items')).toBe(before + 1);
  });

  it('refuses a changed body or another route under the same key', async () => {
    const key = keyOf('changed');
    const body = itemBody('journal_entry', world.projectId);
    expect((await keyed('author', key, 'POST', '/items/journal-entry', body)).status).toBe(201);
    const before = await total('research_items');
    expect(await errorOf(await keyed('author', key, 'POST', '/items/journal-entry', { ...body, title: 'Another title' }))).toMatchObject({ status: 409, error: 'conflict', details: { rule: 'operation_key_reused' } });
    expect((await errorOf(await keyed('author', key, 'POST', '/items/topic', body))).status).toBe(409);
    expect(await total('research_items')).toBe(before);
  });

  it('keeps one Member’s keys apart from another’s and hides them from status reads', async () => {
    const key = keyOf('shared');
    const body = itemBody('journal_entry', world.projectId);
    expect((await keyed('author', key, 'POST', '/items/journal-entry', body)).status).toBe(201);
    expect((await keyed('colleague', key, 'POST', '/items/journal-entry', body)).status).toBe(201);
    expect(await total('idempotency_results')).toBeGreaterThanOrEqual(2);
    expect((await operation('colleague', keyOf('unused'))).status).toBe(404);
    const mine = await keyed('author', keyOf('hidden'), 'POST', '/items/journal-entry', body);
    expect(mine.status).toBe(201);
    const hidden = (await world.core().prepare('SELECT op_key AS k FROM idempotency_results WHERE actor_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 1').bind(world.ids.author).first<string>('k'))!;
    expect((await operation('admin', hidden)).status).toBe(404);
    expect((await operation('author', hidden)).status).toBe(200);
  });

  it('records a refusal with its status and code, never the request or its fields, and replays that refusal', async () => {
    const key = keyOf('refused');
    const bad = itemBody('journal_entry', world.projectId, { title: ' ' });
    const before = await total('research_items');
    const first = await keyed('author', key, 'POST', '/items/journal-entry', bad);
    expect(first.status).toBe(422);
    expect(await state('author', key)).toEqual(expect.objectContaining({ state: 'refused', status: 422, error: 'validation' }));
    const row = await world.core().prepare('SELECT * FROM idempotency_results WHERE op_key = ?1').bind(key).first<Record<string, unknown>>();
    expect(JSON.stringify(row)).not.toContain('Synthetic');
    const replay = await keyed('author', key, 'POST', '/items/journal-entry', bad);
    expect(replay.status).toBe(422);
    expect(await replay.json()).toMatchObject({ replayed: true, error: 'validation' });
    expect(await total('research_items')).toBe(before);
    const fixed = await keyed('author', keyOf('fixed'), 'POST', '/items/journal-entry', itemBody('journal_entry', world.projectId));
    expect(fixed.status).toBe(201);
  });

  it('reports a request that was cut off as pending and then unknown, and lets the same request take it over', async () => {
    const key = keyOf('stalled');
    const body = itemBody('journal_entry', world.projectId);
    const digest = await (async () => {
      const probe = keyOf('probe');
      await keyed('author', probe, 'POST', '/items/journal-entry', body);
      return (await world.core().prepare('SELECT request_hash AS h FROM idempotency_results WHERE op_key = ?1').bind(probe).first<string>('h'))!;
    })();
    await world.core().prepare("INSERT INTO idempotency_results (actor_id, op_key, request_hash, method, route, state, created_at) VALUES (?1, ?2, ?3, 'POST', '/items/journal-entry', 'pending', ?4)")
      .bind(world.ids.author, key, digest, new Date(Date.parse(world.at) - 600_000).toISOString()).run();
    expect((await state('author', key)).state).toBe('unknown');
    const fresh = new Date(Date.parse(world.at) - 5_000).toISOString();
    await world.core().prepare('UPDATE idempotency_results SET created_at = ?2 WHERE op_key = ?1').bind(key, fresh).run();
    expect((await state('author', key)).state).toBe('pending');
    expect(await errorOf(await keyed('author', key, 'POST', '/items/journal-entry', body))).toMatchObject({ status: 409, details: { rule: 'operation_pending' } });
    await world.core().prepare('UPDATE idempotency_results SET created_at = ?2 WHERE op_key = ?1').bind(key, new Date(Date.parse(world.at) - 600_000).toISOString()).run();
    const before = await total('research_items');
    expect((await keyed('author', key, 'POST', '/items/journal-entry', body)).status).toBe(201);
    expect(await total('research_items')).toBe(before + 1);
    expect((await state('author', key)).state).toBe('committed');
  });

  it('applies to every kind of write, accepts only well-formed keys, and leaves unkeyed writes working', async () => {
    const created = await world.created('author', 'journal_entry');
    const key = keyOf('edit');
    const edit = { rev: 1, mark: { mark: 'minor_edit' }, title: 'Keyed edit' };
    const first = await keyed('author', key, 'PATCH', `/items/${created.id}`, edit);
    expect(first.status).toBe(200);
    expect((await keyed('author', key, 'PATCH', `/items/${created.id}`, edit)).status).toBe(200);
    expect((await world.view('author', created.id)).rev).toBe(2);
    expect(await total('revisions')).toBeGreaterThanOrEqual(1);
    expect((await errorOf(await keyed('author', 'short', 'POST', '/items/topic', itemBody('topic', world.projectId)))).fields).toEqual([{ field: 'Idempotency-Key', rule: expect.any(String) }]);
    expect((await world.create('author', 'topic', itemBody('topic', world.projectId))).status).toBe(201);
    expect((await operation('author', 'bad key!')).status).toBe(404);
    void rich;
  });

  it('invites a Member once when the same invitation is sent again, queuing one email', async () => {
    const key = keyOf('invite');
    const invite = { email: 'keyed.invite@example.test', roleId: ROLE_IDS.contributor };
    const queued = () => total('outgoing_emails');
    const before = await queued();
    const first = await keyed('admin', key, 'POST', '/members/invite', invite);
    expect(first.status).toBe(201);
    const replay = await keyed('admin', key, 'POST', '/members/invite', invite);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toMatchObject({ replayed: true });
    expect(await queued()).toBe(before + 1);
    expect(await world.core().prepare("SELECT count(*) AS n FROM members WHERE email = 'keyed.invite@example.test'").first('n')).toBe(1);
    expect((await keyed('admin', key, 'POST', '/members/invite', { ...invite, email: 'other@example.test' })).status).toBe(409);
  });

  it('commits a staged save once under its key and answers the replay from the record', async () => {
    const token = (await (await world.request('author', 'POST', '/stages', {})).json<{ token: string }>()).token;
    expect((await world.request('author', 'PUT', `/stages/${token}/parts/1`, { sections: [{ content: rich('Staged once.') }] })).status).toBe(200);
    const { sections: _sections, ...rest } = itemBody('journal_entry', world.projectId);
    const key = keyOf('commit');
    const before = await total('research_items');
    const first = await keyed('author', key, 'POST', `/stages/${token}/commit`, rest);
    expect(first.status).toBe(201);
    const { item } = await first.json<{ item: ItemView }>();
    expect(await state('author', key)).toMatchObject({ state: 'committed', resource: { 'item.id': item.id } });
    const replay = await keyed('author', key, 'POST', `/stages/${token}/commit`, rest);
    expect(await replay.json()).toMatchObject({ replayed: true, operation: { resource: { 'item.id': item.id } } });
    expect(await total('research_items')).toBe(before + 1);
  });

  it('keys a stage part write like any other mutating route', async () => {
    const token = (await (await world.request('author', 'POST', '/stages', {})).json<{ token: string }>()).token;
    const key = keyOf('part');
    const part = { sections: [{ content: rich('Part body.') }] };
    expect((await keyed('author', key, 'PUT', `/stages/${token}/parts/1`, part)).status).toBe(200);
    const replay = await keyed('author', key, 'PUT', `/stages/${token}/parts/1`, part);
    expect(replay.headers.get('Idempotency-Replayed')).toBe('true');
    expect(await world.core().prepare('SELECT count(*) AS n FROM staging_rows WHERE token = ?1 AND part = 1').bind(token).first('n')).toBe(1);
  });
});
