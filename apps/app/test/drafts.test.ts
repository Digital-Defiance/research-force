import { describe, expect, it } from 'vitest';
import { newULID } from '@researchforce/domain/identifiers';
import { contentBytes, DRAFT_LIMITS, draftExpiry } from '@researchforce/domain/drafts';
import { asTimestamp } from '@researchforce/domain/types';
import { sweepDrafts } from '../src/records/drafts';
import { errorOf, itemWorld, rich } from './items';
import type { Who } from './items';

const world = itemWorld();
type DraftView = {
  id: string; kind: string; form: string; targetId: string | null; targetRootId: string | null; baseRev: number | null;
  content: unknown; uploadGroup: string | null; pinned: boolean; rev: number; lastSavedAt: string; warnAt: string; expireAt: string; authorId?: string;
};
const save = (who: Who, body: Record<string, unknown>) => world.request(who, 'POST', '/drafts', body);
const saved = async (response: Response): Promise<DraftView> => {
  if (response.status !== 201 && response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json<{ draft: DraftView }>()).draft;
};
const count = async (sql: string, ...values: unknown[]) => (await world.core().prepare(sql).bind(...values).first<number>('n'))!;
const eventKinds = async (draftId: string) => (await world.core().prepare('SELECT kind FROM draft_events WHERE draft_id = ?1 ORDER BY at, id').bind(draftId).all<{ kind: string }>()).results.map((row) => row.kind);
const itemDraft = { kind: 'item', form: 'finding', content: { title: 'A finding in progress', claim: rich('Rows of tiles') } };

describe('durable drafts (R57.1, R57.2)', () => {
  it('saves a draft with content, form, upload group and pin, and reads it back only for its author', async () => {
    const draft = await saved(await save('author', { ...itemDraft, uploadGroup: newULID(world.at), pinned: false }));
    expect(draft).toMatchObject({ kind: 'item', form: 'finding', pinned: false, rev: 1 });
    expect(draft.content).toEqual(itemDraft.content);

    const own = await saved(await world.request('author', 'GET', `/drafts/${draft.id}`));
    expect(own.id).toBe(draft.id);
    // Another Member cannot read, list, pin, update, or discard someone else's draft: it is indistinguishable from a draft that does not exist.
    expect((await world.request('colleague', 'GET', `/drafts/${draft.id}`)).status).toBe(404);
    expect((await world.request('colleague', 'PUT', `/drafts/${draft.id}`, itemDraft)).status).toBe(404);
    expect((await world.request('colleague', 'POST', `/drafts/${draft.id}/pin`, { pinned: true })).status).toBe(404);
    expect((await world.request('colleague', 'DELETE', `/drafts/${draft.id}`)).status).toBe(404);
    const colleagueList = await world.request('colleague', 'GET', '/drafts');
    expect((await colleagueList.json<{ drafts: DraftView[] }>()).drafts).toEqual([]);
  });

  it('records the last acknowledged save and advances rev, distinguishing durable content from a later change', async () => {
    const draft = await saved(await save('author', itemDraft));
    expect(draft.rev).toBe(1);
    expect(draft.lastSavedAt).toBe(world.at);
    const updated = await saved(await world.request('author', 'PUT', `/drafts/${draft.id}`, { ...itemDraft, content: { title: 'A finding in progress', claim: rich('Rows of tiles, revised') } }));
    expect(updated.rev).toBe(2);
    expect(updated.content).toMatchObject({ claim: { text: 'Rows of tiles, revised' } });
    // The server holds only the acknowledged content at this rev; the browser keeps anything typed since and compares against it.
    expect((await saved(await world.request('author', 'GET', `/drafts/${draft.id}`))).rev).toBe(2);
  });

  it('refuses an update whose expected rev is stale rather than overwriting a newer save', async () => {
    const draft = await saved(await save('author', itemDraft));
    // The client holds rev 1, but another save advanced the stored draft to rev 2.
    await world.core().prepare('UPDATE saved_drafts SET rev = rev + 1 WHERE id = ?1').bind(draft.id).run();
    const refused = await errorOf(await world.request('author', 'PUT', `/drafts/${draft.id}`, { ...itemDraft, content: { x: 2 }, expectedRev: 1 }));
    expect(refused.status).toBe(409);
    // Sending the current rev succeeds.
    expect((await world.request('author', 'PUT', `/drafts/${draft.id}`, { ...itemDraft, content: { x: 3 }, expectedRev: 2 })).status).toBe(200);
  });

  it('bounds the stored form content', async () => {
    const big = 'x'.repeat(DRAFT_LIMITS.contentBytes + 10);
    expect(contentBytes({ big })).toBeGreaterThan(DRAFT_LIMITS.contentBytes);
    expect((await errorOf(await save('author', { kind: 'item', form: 'finding', content: { big } }))).status).toBe(422);
  });

  it('only accepts an edit draft while its author can read the target, and omits it if access is later lost', async () => {
    const target = await world.created('author', 'finding');
    const edit = { kind: 'edit', form: 'finding', targetId: target.id, targetRootId: target.id, baseRev: 1, content: { claim: rich('A suggested wording') } };
    // The colleague can read a Whole_Team item, so may draft an edit of it.
    const draft = await saved(await save('colleague', edit));
    expect(draft.targetId).toBe(target.id);
    expect(await count('SELECT count(*) AS n FROM saved_drafts WHERE author_id = ?1', world.ids.colleague)).toBe(1);

    // Once the item is Restricted away from the colleague, their draft's target is unreadable, so the normal API no longer shows it.
    await world.core().prepare("UPDATE research_items SET access_level = 'restricted' WHERE unit_id = ?1").bind(target.id).run();
    expect((await world.request('colleague', 'GET', `/drafts/${draft.id}`)).status).toBe(404);
    expect((await world.request('colleague', 'GET', '/drafts').then((r) => r.json<{ drafts: DraftView[] }>())).drafts).toEqual([]);

    // An edit draft of a record the author cannot read is refused at save time.
    const hidden = await world.created('author', 'finding');
    await world.core().prepare("UPDATE research_items SET access_level = 'restricted' WHERE unit_id = ?1").bind(hidden.id).run();
    const refused = await errorOf(await save('colleague', { ...edit, targetId: hidden.id, targetRootId: hidden.id }));
    expect(refused.fields?.[0]?.field).toBe('targetId');
  });

  it('requires an edit draft to name the record it edits', async () => {
    expect((await errorOf(await save('author', { kind: 'edit', form: 'finding', content: { x: 1 } }))).fields?.some((f) => f.field === 'targetId')).toBe(true);
  });

  it('pins and unpins a draft, recording the lifecycle, and discards it explicitly', async () => {
    const draft = await saved(await save('author', itemDraft));
    expect((await saved(await world.request('author', 'POST', `/drafts/${draft.id}/pin`, { pinned: true }))).pinned).toBe(true);
    expect((await saved(await world.request('author', 'POST', `/drafts/${draft.id}/pin`, { pinned: false }))).pinned).toBe(false);
    expect([...await eventKinds(draft.id)].sort()).toEqual(['created', 'pinned', 'unpinned']);

    expect((await world.request('author', 'DELETE', `/drafts/${draft.id}`)).status).toBe(204);
    expect(await count('SELECT count(*) AS n FROM saved_drafts WHERE id = ?1', draft.id)).toBe(0);
    // The discard is recorded even though the draft row is gone.
    expect(await eventKinds(draft.id)).toContain('discarded');
    expect((await world.request('author', 'GET', `/drafts/${draft.id}`)).status).toBe(404);
  });

  it('replays an idempotent draft save without creating a second draft', async () => {
    const key = `draft-${newULID(world.at)}`.slice(0, 40);
    const firstJson = await saved(await world.request('author', 'POST', '/drafts', itemDraft, { 'Idempotency-Key': key }));
    const before = await count('SELECT count(*) AS n FROM saved_drafts');
    const replay = await world.request('author', 'POST', '/drafts', itemDraft, { 'Idempotency-Key': key });
    expect(replay.headers.get('Idempotency-Replayed')).toBe('true');
    expect(await replay.json()).toMatchObject({ replayed: true, operation: { state: 'committed', resource: { 'draft.id': firstJson.id } } });
    expect(await count('SELECT count(*) AS n FROM saved_drafts')).toBe(before);
  });

  it('keeps drafts out of other counts and exposes the documented expiry window', async () => {
    const draft = await saved(await save('author', itemDraft));
    // A draft is not a Submission, Research_Item, Revision, Activity, or Notification.
    expect(await count('SELECT count(*) AS n FROM submissions WHERE member_id = ?1', world.ids.author)).toBe(0);
    expect(await count('SELECT count(*) AS n FROM activity')).toBe(0);
    expect(await count('SELECT count(*) AS n FROM notifications')).toBe(0);
    const expected = draftExpiry(draft.lastSavedAt);
    expect({ warnAt: draft.warnAt, expireAt: draft.expireAt }).toEqual(expected);
  });
});

describe('administrator draft recovery (R57.2)', () => {
  it('lets an Administrator recover another Member\'s draft only with a reason and an audit event', async () => {
    const draft = await saved(await save('author', itemDraft));
    // A Contributor cannot recover another Member's draft.
    expect((await world.request('colleague', 'POST', `/ops/drafts/${draft.id}/recover`, { reason: 'curiosity' })).status).toBe(403);
    // An Administrator must give a reason.
    expect((await errorOf(await world.request('admin', 'POST', `/ops/drafts/${draft.id}/recover`, { reason: '' }))).status).toBe(422);

    const recovered = await world.request('admin', 'POST', `/ops/drafts/${draft.id}/recover`, { reason: 'Recovering lost work after a crash.' });
    expect(recovered.status).toBe(200);
    const body = (await recovered.json<{ draft: DraftView }>()).draft;
    expect(body.content).toEqual(itemDraft.content);
    expect(body.authorId).toBe(world.ids.author);
    // The recovery leaves an audit event naming the Administrator and the reason.
    const audit = await world.core().prepare("SELECT actor_id AS actorId, reason FROM draft_events WHERE draft_id = ?1 AND kind = 'recovered'").bind(draft.id).first<{ actorId: string; reason: string }>();
    expect(audit).toEqual({ actorId: world.ids.admin, reason: 'Recovering lost work after a crash.' });
  });
});

describe('inactive draft expiry (R57.2)', () => {
  const at = (days: number) => asTimestamp(new Date(Date.parse(world.at) + days * 86_400_000).toISOString());

  it('warns a working draft at 83 days and expires it at 90, while a pinned draft is retained', async () => {
    const working = await saved(await save('author', itemDraft));
    const pinned = await saved(await save('author', itemDraft));
    await world.core().prepare('UPDATE saved_drafts SET pinned = 1 WHERE id = ?1').bind(pinned.id).run();

    // Before the warning period nothing happens.
    expect(await sweepDrafts(world.bindings, at(80))).toBe(0);
    expect(await count('SELECT count(*) AS n FROM saved_drafts')).toBe(2);

    // At the warning period the working draft is warned once; the pinned one is untouched.
    expect(await sweepDrafts(world.bindings, at(DRAFT_LIMITS.warningDays + 1))).toBe(1);
    expect(await count('SELECT count(*) AS n FROM saved_drafts WHERE warned_at IS NOT NULL')).toBe(1);
    expect(await eventKinds(working.id)).toEqual(['created', 'warned']);
    // A second sweep in the warning window does not warn again.
    expect(await sweepDrafts(world.bindings, at(DRAFT_LIMITS.warningDays + 2))).toBe(0);

    // At the expiry period the working draft is deleted with an audit event; the pinned one remains.
    expect(await sweepDrafts(world.bindings, at(DRAFT_LIMITS.expiryDays + 1))).toBe(1);
    expect(await count('SELECT count(*) AS n FROM saved_drafts WHERE id = ?1', working.id)).toBe(0);
    expect(await count('SELECT count(*) AS n FROM saved_drafts WHERE id = ?1', pinned.id)).toBe(1);
    expect(await eventKinds(working.id)).toContain('expired');
  });
});
