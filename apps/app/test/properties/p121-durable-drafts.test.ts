// Feature: research-collab-cms, Property 121: Durable drafts recover acknowledged input with author isolation
import { describe, expect, it } from 'vitest';
import { contentBytes, DRAFT_LIMITS, draftExpiry } from '@researchforce/domain/drafts';
import { newULID } from '@researchforce/domain/identifiers';
import { asTimestamp } from '@researchforce/domain/types';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { sweepDrafts } from '../../src/records/drafts';
import { itemWorld, rich } from '../items';
import type { Who } from '../items';
import { addProject, resetRecords } from '../units';

/**
 * Validates R57.1, R57.2, R57.3 against an independent model of one author's single durable draft.
 * Each case saves a fresh item draft, then drives a random sequence of steps: updating the content (a
 * save whose acknowledged result is what the server must return), replaying a save under its operation
 * key after a lost response, pinning and unpinning, revoking and restoring the author's read access to
 * the draft's edited target, and running the inactivity sweep at a chosen day offset. After every step
 * the model asserts that the normal API returns exactly the last acknowledged content at the current
 * rev to the author and only the author; that a second Member (Contributor or Administrator through the
 * normal API) cannot read, list, pin, update, or discard it, indistinguishable from a draft that never
 * existed; that a draft whose target the author can no longer read is omitted from reads and lists but
 * is not deleted; and that the warn-then-expire lifecycle fires only on an unpinned working draft, once
 * for the warning, with a pinned draft retained forever. A companion case pins the content byte budget:
 * the largest encoded content is accepted and recovered exactly, and one byte more is refused with
 * nothing stored.
 */

type DraftView = {
  id: string; kind: string; form: string; targetId: string | null; targetRootId: string | null; baseRev: number | null;
  content: unknown; uploadGroup: string | null; pinned: boolean; rev: number; lastSavedAt: string; warnAt: string; expireAt: string;
};

const OTHERS: readonly Who[] = ['colleague', 'admin'];

type Op =
  | { t: 'update'; text: string }
  | { t: 'replay' }
  | { t: 'pin'; pinned: boolean }
  | { t: 'access'; readable: boolean }
  | { t: 'sweep'; day: number };

const op: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ t: fc.constant('update' as const), text: fc.string({ minLength: 1, maxLength: 24 }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('replay' as const) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('pin' as const), pinned: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('access' as const), readable: fc.boolean() }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('sweep' as const), day: fc.constantFrom(10, DRAFT_LIMITS.warningDays - 1, DRAFT_LIMITS.warningDays + 1, DRAFT_LIMITS.expiryDays + 1) }) },
);

const world = itemWorld();
const draftOf = async (response: Response): Promise<DraftView> => {
  if (response.status !== 200 && response.status !== 201) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json<{ draft: DraftView }>()).draft;
};
const count = async (sql: string, ...values: unknown[]) => (await world.core().prepare(sql).bind(...values).first<number>('n'))!;
const eventKinds = async (draftId: string) => (await world.core().prepare('SELECT kind FROM draft_events WHERE draft_id = ?1 ORDER BY at, id').bind(draftId).all<{ kind: string }>()).results.map((row) => row.kind);
const dayOffset = (base: string, days: number) => asTimestamp(new Date(Date.parse(base) + days * 86_400_000).toISOString());

describe('Property 121: Durable drafts recover acknowledged input with author isolation', () => {
  it('returns the last acknowledged content only to its author, omits an unreadable target, and warns then expires only eligible working drafts', async () => {
    let cases = 0;
    await fc.assert(fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 10 }), async (ops) => {
      cases += 1;
      // Each case starts from a clean slate so the one author draft under test is the only one the API should expose.
      await resetRecords(world.core());
      (world as { projectId: typeof world.projectId }).projectId = await addProject(world.core(), world.ids.admin, world.at);
      // A Whole_Team target owned by another Member, so the author may draft an edit of it now but can lose read access when it is
      // Restricted (the author is not its Owner, so unlike their own item the author then cannot read it).
      const target = await world.created('colleague', 'finding');
      const key = `draft-${newULID(world.at)}`.slice(0, 40);
      const firstBody = { kind: 'edit', form: 'finding', targetId: target.id, targetRootId: target.id, baseRev: 1, content: { claim: rich('Acknowledged save 0') } };
      const created = await draftOf(await world.request('author', 'POST', '/drafts', firstBody, { 'Idempotency-Key': key }));
      const id = created.id;
      // Creating the target announced one Submission; the draft itself must never add to activity, notifications, or submissions.
      const baseline = {
        activity: await count('SELECT count(*) AS n FROM activity'),
        notifications: await count('SELECT count(*) AS n FROM notifications'),
        submissions: await count('SELECT count(*) AS n FROM submissions'),
      };

      // The independent model of the one draft the API should expose, plus how the world was perturbed.
      const model = {
        content: firstBody.content as unknown,
        body: firstBody as Record<string, unknown>,
        rev: created.rev,
        pinned: false,
        lastSavedAt: created.lastSavedAt,
        warned: false, // currently in the warned window (a save clears this so it can warn again)
        everWarned: false, // a 'warned' event was recorded at some point; the append-only trail keeps it
        gone: false, // swept away by expiry
        readable: true, // the author can still read the edited target
      };

      const verify = async (label: string): Promise<void> => {
        const rows = await count('SELECT count(*) AS n FROM saved_drafts WHERE id = ?1', id);
        expect(rows, `${label}: stored rows`).toBe(model.gone ? 0 : 1);
        // The normal API shows the draft only while it exists and its target is readable; otherwise it is a 404 that reveals nothing.
        const visible = !model.gone && model.readable;
        const own = await world.request('author', 'GET', `/drafts/${id}`);
        expect(own.status, `${label}: author read`).toBe(visible ? 200 : 404);
        if (visible) {
          const view = await draftOf(own);
          expect(view.content, `${label}: acknowledged content`).toEqual(model.content);
          expect(view.rev, `${label}: rev`).toBe(model.rev);
          expect(view.pinned, `${label}: pinned`).toBe(model.pinned);
          expect(view.lastSavedAt, `${label}: last saved`).toBe(model.lastSavedAt);
          expect({ warnAt: view.warnAt, expireAt: view.expireAt }, `${label}: expiry window`).toEqual(draftExpiry(model.lastSavedAt));
        }
        const list = (await (await world.request('author', 'GET', '/drafts')).json<{ drafts: DraftView[] }>()).drafts;
        expect(list.map((draft) => draft.id), `${label}: author list`).toEqual(visible ? [id] : []);

        // Author isolation: another Member, whatever their Role, cannot read, list, pin, update, or discard the draft.
        for (const other of OTHERS) {
          expect((await world.request(other, 'GET', `/drafts/${id}`)).status, `${label}: ${other} read`).toBe(404);
          expect((await world.request(other, 'PUT', `/drafts/${id}`, firstBody)).status, `${label}: ${other} update`).toBe(404);
          expect((await world.request(other, 'POST', `/drafts/${id}/pin`, { pinned: true })).status, `${label}: ${other} pin`).toBe(404);
          expect((await world.request(other, 'DELETE', `/drafts/${id}`)).status, `${label}: ${other} discard`).toBe(404);
          const theirs = (await (await world.request(other, 'GET', '/drafts')).json<{ drafts: DraftView[] }>()).drafts;
          expect(theirs.map((draft) => draft.id), `${label}: ${other} list`).toEqual([]);
        }

        // A draft is never a Submission, Activity, or Notification: these stay at the baseline set before any draft step.
        expect(await count('SELECT count(*) AS n FROM activity'), `${label}: activity unchanged`).toBe(baseline.activity);
        expect(await count('SELECT count(*) AS n FROM notifications'), `${label}: notifications unchanged`).toBe(baseline.notifications);
        expect(await count('SELECT count(*) AS n FROM submissions'), `${label}: submissions unchanged`).toBe(baseline.submissions);
      };

      await verify('start');
      for (const [step, current] of ops.entries()) {
        const label = `step ${step} ${JSON.stringify(current)}`;
        if (model.gone) break; // once expired there is nothing left to drive; the draft stays gone.
        if (current.t === 'update') {
          const content = { claim: rich(`Acknowledged save ${step}: ${current.text}`) };
          const body = { ...model.body, content, expectedRev: model.rev };
          const response = await world.request('author', 'PUT', `/drafts/${id}`, body);
          if (!model.readable) {
            // An edit draft may be re-saved only while its author can still read the edited target; otherwise the save is refused
            // and the acknowledged content is left untouched (R57.2).
            expect(response.status, label).toBe(422);
          } else {
            const updated = await draftOf(response);
            expect(updated.rev, label).toBe(model.rev + 1);
            model.content = content;
            model.body = { ...model.body, content };
            model.rev += 1;
            model.lastSavedAt = world.at;
            model.warned = false; // a save resets the inactivity clock and any pending warning.
          }
        } else if (current.t === 'replay') {
          // A lost response is retried under the same operation key; the stored draft is unchanged and no new draft appears.
          const before = await count('SELECT count(*) AS n FROM saved_drafts');
          const replay = await world.request('author', 'POST', '/drafts', firstBody, { 'Idempotency-Key': key });
          expect(replay.headers.get('Idempotency-Replayed'), label).toBe('true');
          expect(await replay.json<{ operation: { resource: Record<string, string> } }>().then((b) => b.operation.resource['draft.id']), label).toBe(id);
          expect(await count('SELECT count(*) AS n FROM saved_drafts'), label).toBe(before);
        } else if (current.t === 'pin') {
          // Pinning touches only the draft's own expiry state, so it is allowed even when the edited target is no longer readable:
          // an author may still protect their own unsaved work from expiry. It is a write, so it advances rev.
          const pinnedView = await draftOf(await world.request('author', 'POST', `/drafts/${id}/pin`, { pinned: current.pinned }));
          expect(pinnedView.pinned, label).toBe(current.pinned);
          expect(pinnedView.rev, label).toBe(model.rev + 1);
          model.pinned = current.pinned;
          model.rev += 1;
        } else if (current.t === 'access') {
          // Fault injection: revoke or restore the author's read access to the edited target. This does not touch the draft row.
          const level = current.readable ? 'whole_team' : 'restricted';
          await world.core().prepare('UPDATE research_items SET access_level = ?2 WHERE unit_id = ?1').bind(target.id, level).run();
          model.readable = current.readable;
        } else {
          // The inactivity sweep at a day offset from the draft's last save.
          const when = dayOffset(model.lastSavedAt, current.day);
          const eligibleToWarn = !model.pinned && !model.warned && current.day >= DRAFT_LIMITS.warningDays && current.day < DRAFT_LIMITS.expiryDays;
          const eligibleToExpire = !model.pinned && current.day >= DRAFT_LIMITS.expiryDays;
          const swept = await sweepDrafts(world.bindings, when);
          expect(swept, label).toBe((eligibleToExpire ? 1 : 0) + (eligibleToWarn ? 1 : 0));
          if (eligibleToExpire) model.gone = true;
          else if (eligibleToWarn) { model.warned = true; model.everWarned = true; }
        }
        await verify(label);
      }

      // The append-only lifecycle trail matches what happened: exactly one created event, a warned event iff the draft was
      // ever warned (a save between warnings can let it warn again, so there may be more than one), and an expired event iff swept.
      const kinds = await eventKinds(id);
      expect(kinds.filter((kind) => kind === 'created'), 'created once').toEqual(['created']);
      expect(kinds.includes('warned'), 'warned trail matches model').toBe(model.everWarned);
      expect(kinds.includes('expired'), 'expired trail matches model').toBe(model.gone);
    }), { numRuns: Math.min(FC_RUNS, 80) });
  }, 600_000);

  it('accepts the maximum encoded content and recovers it exactly, and refuses one byte more with nothing stored', async () => {
    // JSON.stringify of { claim: { text, spans: [] } } wraps the filler text in a fixed envelope; size the filler so the whole encodes to exactly the limit.
    const envelope = contentBytes({ claim: rich('') });
    const fill = 'x'.repeat(DRAFT_LIMITS.contentBytes - envelope);
    const atLimit = { claim: rich(fill) };
    expect(contentBytes(atLimit)).toBe(DRAFT_LIMITS.contentBytes);

    const saved = await draftOf(await world.request('author', 'POST', '/drafts', { kind: 'item', form: 'finding', content: atLimit }));
    expect((await draftOf(await world.request('author', 'GET', `/drafts/${saved.id}`))).content).toEqual(atLimit);

    const before = await count('SELECT count(*) AS n FROM saved_drafts');
    const tooBig = { claim: rich(`${fill}x`) };
    expect(contentBytes(tooBig)).toBeGreaterThan(DRAFT_LIMITS.contentBytes);
    const refusedSave = await world.request('author', 'POST', '/drafts', { kind: 'item', form: 'finding', content: tooBig });
    expect(refusedSave.status).toBe(422);
    // An update that would exceed the limit is refused too, leaving the acknowledged content intact.
    const refusedUpdate = await world.request('author', 'PUT', `/drafts/${saved.id}`, { kind: 'item', form: 'finding', content: tooBig, expectedRev: saved.rev });
    expect(refusedUpdate.status).toBe(422);
    expect((await draftOf(await world.request('author', 'GET', `/drafts/${saved.id}`))).content).toEqual(atLimit);
    expect(await count('SELECT count(*) AS n FROM saved_drafts')).toBe(before);
  }, 120_000);
});
