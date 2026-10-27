import { describe, expect, it } from 'vitest';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { ApiFailure, CSRF_HEADER, failureMessage, STAGED_SAVE_THRESHOLD_BYTES, stagedParts } from '../src/api';
import { failure, fakeApi, json } from './helpers';

describe('the API client', () => {
  it('sends the CSRF header and JSON on writes only, from the same origin', async () => {
    const api = fakeApi({ 'GET /me': { ok: true }, 'POST /links': { link: {} } });
    await api.client.get('/me');
    await api.client.post('/links', { originId: 'a' });
    const [read, write] = api.calls;
    expect(read!.headers.has(CSRF_HEADER)).toBe(false);
    expect(read!.raw).toBeUndefined();
    expect(write!.headers.get(CSRF_HEADER)).toBe('1');
    expect(write!.headers.get('Content-Type')).toBe('application/json');
    expect(write!.body).toEqual({ originId: 'a' });
  });

  it('turns the error shape into a failure with its fields and details', async () => {
    const api = fakeApi({ 'POST /projects': failure(422, 'validation', { fields: [{ field: 'slug', rule: 'Reserved.' }, { field: 'slug.0', rule: 'Nested.' }], details: { hint: 1 } }) });
    const error = await api.client.post('/projects', {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiFailure);
    expect(error).toMatchObject({ status: 422, code: 'validation', details: { hint: 1 } });
    expect((error as ApiFailure).issuesFor('slug').map((issue) => issue.rule)).toEqual(['Reserved.', 'Nested.']);
    expect((error as ApiFailure).issuesFor('sl')).toEqual([]);
  });

  it('reloads through Access when the session has ended', async () => {
    const api = fakeApi({ 'GET /me': failure(401, 'unauthenticated') });
    await expect(api.client.get('/me')).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(api.reloads).toHaveLength(1);
  });

  it('records a daily limit from the Worker or from the platform for every page to show', async () => {
    const worker = fakeApi({ 'POST /items/topic': failure(503, 'daily_limit') });
    await expect(worker.client.post('/items/topic', {})).rejects.toMatchObject({ code: 'daily_limit' });
    expect(worker.client.status.get().dailyLimit).toBe(true);
    const platform = fakeApi({ 'GET /me': new Response('<html>Error 1027</html>', { status: 429, headers: { 'Content-Type': 'text/html' } }) });
    await expect(platform.client.get('/me')).rejects.toMatchObject({ code: 'platform_limit', status: 429 });
    expect(platform.client.status.get().dailyLimit).toBe(true);
    const limited = fakeApi({ 'GET /me': failure(429, 'rate_limited') });
    await expect(limited.client.get('/me')).rejects.toMatchObject({ code: 'rate_limited' });
    expect(limited.client.status.get().dailyLimit).toBe(false);
    const other = fakeApi({ 'GET /me': new Response('oops', { status: 502 }) });
    await expect(other.client.get('/me')).rejects.toMatchObject({ code: 'internal', status: 502 });
    expect(other.client.status.get().dailyLimit).toBe(false);
  });

  it('shows the backup pause until a write succeeds again', async () => {
    let frozen = true;
    const api = fakeApi({ 'PUT /me/mutes': () => (frozen ? failure(503, 'frozen') : { mutedProjectIds: [] }), 'GET /me': {} });
    await expect(api.client.put('/me/mutes', { projectIds: [] })).rejects.toMatchObject({ code: 'frozen' });
    expect(api.client.status.get().frozen).toBe(true);
    await api.client.get('/me');
    expect(api.client.status.get().frozen).toBe(true);
    frozen = false;
    await api.client.put('/me/mutes', { projectIds: [] });
    expect(api.client.status.get().frozen).toBe(false);
  });

  it('records the missing Profile fields so that the Profile form replaces every page', async () => {
    const api = fakeApi({ 'GET /projects': failure(428, 'profile_incomplete', { details: { missing: ['displayName', 'timeZone'] } }) });
    await expect(api.client.get('/projects')).rejects.toMatchObject({ code: 'profile_incomplete' });
    expect(api.client.status.get().profileMissing).toEqual(['displayName', 'timeZone']);
  });

  it('reports a request that got no response as a network failure', async () => {
    const api = fakeApi({ 'GET /me': () => { throw new TypeError('offline'); } });
    await expect(api.client.get('/me')).rejects.toMatchObject({ code: 'network', status: 0 });
  });

  it('notifies status subscribers only when the status changes', async () => {
    const api = fakeApi({ 'POST /x': failure(503, 'daily_limit') });
    let notified = 0;
    const unsubscribe = api.client.status.subscribe(() => { notified += 1; });
    await api.client.post('/x').catch(() => undefined);
    await api.client.post('/x').catch(() => undefined);
    unsubscribe();
    api.client.status.update({ dailyLimit: false });
    expect(notified).toBe(1);
    api.client.status.update({ dailyLimit: false, frozen: true });
    expect(api.client.status.get()).toEqual({ dailyLimit: false, frozen: true, profileMissing: null });
  });

  it('says that the input was not saved for every failure', () => {
    for (const code of ['daily_limit', 'platform_limit', 'frozen', 'network', 'validation', 'conflict', 'forbidden', 'too_large', 'internal'] as const) {
      expect(failureMessage(new ApiFailure(500, code))).toMatch(/not saved/u);
    }
    expect(failureMessage(new ApiFailure(503, 'daily_limit'))).toContain('until 00:00 UTC');
    expect(failureMessage(new ApiFailure(503, 'frozen'))).toContain('paused for a backup');
    expect(failureMessage(new Error('boom'))).toMatch(/not saved/u);
  });
});

describe('saving Research_Items', () => {
  const section = (characters: number) => ({ content: { text: 'x'.repeat(characters), spans: [] } });

  it('posts a new item and patches an edit when the JSON is within 512 KB', async () => {
    const api = fakeApi({ 'POST /items/archival-request': { item: { id: 'n' } }, 'PATCH /items/i1': { item: { id: 'i1' } } });
    await api.client.saveItem({ kindPath: 'archival-request' }, { title: 'T' });
    await api.client.saveItem({ id: 'i1' }, { rev: 2, sections: [section(10)] });
    expect(api.calls.map((call) => `${call.method} ${call.path}`)).toEqual(['POST /items/archival-request', 'PATCH /items/i1']);
    expect(api.calls[1]!.body).toEqual({ rev: 2, sections: [section(10)] });
  });

  it('sends larger Journal_Entries as a staged save: sections in parts, the rest in the commit', async () => {
    const partBytes = 200_000;
    const api = fakeApi({
      'POST /stages': { token: 'tok', partBytes, maxParts: 256 },
      'PUT /stages/tok/parts/1': { ok: true }, 'PUT /stages/tok/parts/2': { ok: true }, 'PUT /stages/tok/parts/3': { ok: true }, 'PUT /stages/tok/parts/4': { ok: true },
      'POST /stages/tok/commit': json({ item: { id: 'new' } }, 201),
    });
    const sections = Array.from({ length: 6 }, () => section(90_000));
    const result = await api.client.saveItem<{ item: { id: string } }>({ kindPath: 'journal-entry' }, { projectId: 'p', title: 'Big', sections });
    expect(result.item.id).toBe('new');
    const writes = api.writes();
    expect(writes[0]).toMatchObject({ method: 'POST', path: '/stages', body: {} });
    const parts = writes.filter((call) => call.method === 'PUT');
    expect(parts.map((call) => call.path)).toEqual(['/stages/tok/parts/1', '/stages/tok/parts/2', '/stages/tok/parts/3']);
    for (const part of parts) expect(new TextEncoder().encode(part.raw).length).toBeLessThanOrEqual(partBytes);
    expect(parts.flatMap((call) => (call.body as { sections: unknown[] }).sections)).toEqual(sections);
    expect(writes.at(-1)).toMatchObject({ path: '/stages/tok/commit', body: { projectId: 'p', title: 'Big' } });
    expect(writes.at(-1)!.body).not.toHaveProperty('sections');
  });

  it('opens an edit stage for the item and refuses a save that needs more parts than the stage allows', async () => {
    const api = fakeApi({ 'POST /stages': { token: 't', partBytes: 300_000, maxParts: 1 } });
    const error = await api.client.saveItem({ id: 'i9' }, { rev: 1, sections: [section(290_000), section(290_000)] }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'too_large', status: 413 });
    expect(api.writes()).toHaveLength(1);
    expect(api.writes()[0]!.body).toEqual({ itemId: 'i9' });
    expect(STAGED_SAVE_THRESHOLD_BYTES).toBe(512_000);
  });

  it('splits sections into parts that keep their order and fit the part size', () => {
    fc.assert(fc.property(fc.array(fc.string({ maxLength: 60, unit: 'grapheme' }), { maxLength: 40 }), fc.integer({ min: 80, max: 400 }), (texts, partBytes) => {
      const sections = texts.map((text) => ({ content: { text, spans: [] } }));
      const parts = stagedParts(sections, partBytes);
      expect(parts.flatMap((part) => (JSON.parse(part) as { sections: unknown[] }).sections)).toEqual(sections);
      for (const part of parts) {
        const parsed = JSON.parse(part) as { sections: unknown[] };
        if (parsed.sections.length > 1) expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(partBytes);
        expect(parsed.sections.length).toBeGreaterThan(0);
      }
    }), { numRuns: FC_RUNS });
  });
});
