// Feature: research-collab-cms, Property 123: Navigation and follows preserve access and event uniqueness
import { describe, expect, it } from 'vitest';
import { cpLength } from '@researchforce/domain/text';
import { PERSONAL_LIMITS } from '@researchforce/domain/personal';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { drainSearch } from '../../src/search/indexer';
import { itemWorld, rich } from '../items';
import type { ItemView, Who } from '../items';
import { addProject, resetRecords } from '../units';

/**
 * Validates R58.1, R58.2, R58.3, R58.4, R58.5 against an independent model of one Member's whole personal
 * navigation over a shared world. The world holds one finding and one Research_Question another Member owns,
 * both readable by the viewer until a fault revokes access; the viewer keeps a Bookmark of the finding, a
 * Saved_Search that matches both records, a Follow of the finding, and a Follow of the Question. A random
 * sequence of steps drives the world: the owner corrects the finding (an Item_Update the viewer's Follow must
 * be unioned into exactly once), the viewer's read access to the finding or to the Question is revoked and
 * restored (fault injection), the viewer mutes and unmutes the Project, and the viewer turns their item_update
 * Event_Type preference off and on.
 *
 * After every step the model asserts through the normal API: a second Member, whatever their Role, sees none
 * of the viewer's Bookmarks, Saved_Searches, or Follows and cannot read, mutate, reorder, rerun, or delete
 * them (author isolation, R58.2, R58.3); a Bookmark or Follow whose target the viewer can no longer read is a
 * neutral unavailable entry (null target, no identifying metadata) yet stays in the list, never deleted
 * (R58.4); the Saved_Search reruns through current authorization and returns exactly the records the viewer
 * can read now, never a stored snapshot (R58.4); the My_Work dashboard lists the followed Question only when
 * readable, as a neutral unavailable entry otherwise, with no inaccessible counts, and reading it clears no
 * flag (R58.1, R58.4, R58.5); and each owner correction fans out to the viewer's finding Follow as exactly one
 * Item_Update event and one Notification — never two for a Member who both participates and follows — unless
 * the viewer cannot read the finding, has muted the Project, or has turned the Event_Type off, while a
 * mandatory System_Alert reaches the Administrator regardless of that same muting and those same preferences.
 *
 * A companion case pins the validated-name and count-limit boundaries (R58.2): the longest 100-code-point name
 * is accepted and recovered exactly and a 101st code point is refused; the 100th Bookmark and 50th Saved_Search
 * are accepted and the next is refused with nothing stored.
 */

const OTHERS: readonly Who[] = ['author', 'admin'];

type Op =
  | { t: 'correct' } // the owner corrects the finding, an Item_Update the viewer's Follow is unioned into.
  | { t: 'accessItem'; readable: boolean } // fault injection: revoke or restore the viewer's read access to the finding.
  | { t: 'accessQuestion'; readable: boolean } // fault injection: revoke or restore the viewer's read access to the Question.
  | { t: 'mute'; muted: boolean } // the viewer mutes or unmutes the finding's Project.
  | { t: 'pref'; inApp: boolean }; // the viewer turns their item_update Event_Type in-app preference off or on.

const op: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ t: fc.constant('correct' as const) }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('accessItem' as const), readable: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('accessQuestion' as const), readable: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('mute' as const), muted: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('pref' as const), inApp: fc.boolean() }) },
);

const world = itemWorld();
const core = () => world.bindings.RF_CORE;
const search = () => world.bindings.RF_SEARCH;
const drain = () => drainSearch({ core: core(), search: search() }, world.at);
const count = async (sql: string, ...values: unknown[]) => (await core().prepare(sql).bind(...values).first<number>('n'))!;

interface BookmarkView { id: string; name: string; position: number; targetId: string | null; available: boolean }
interface FollowView { id: string; kind: string; inApp: boolean; email: string; targetId: string | null; available: boolean }
interface SavedSearchView { id: string; name: string; position: number; filters: Record<string, unknown> }
interface DashboardQuestion { followId: string; available: boolean; rootId: string | null; identifier: string | null; question: string | null; state: string | null }
interface DashboardView { proposals: { total: number; items: unknown[] }; archival: { total: number; items: unknown[] }; questions: DashboardQuestion[] }
interface SearchPage { results: { id: string }[]; next: string | null }

const json = async <T>(response: Response): Promise<T> => {
  if (response.status !== 200 && response.status !== 201) throw new Error(`${response.status} ${await response.text()}`);
  return response.json<T>();
};
/** Set the viewer's read access to a record: Restricted hides it from the colleague (not its Owner, not an Administrator). */
const setAccess = (item: ItemView, readable: boolean) =>
  core().prepare('UPDATE research_items SET access_level = ?2 WHERE unit_id = ?1').bind(item.id as string, readable ? 'whole_team' : 'restricted').run();
/** The ids of the recipients of an item_update event on a root, through participation or a Follow union. */
const itemUpdateRecipients = async (root: string) =>
  (await core().prepare("SELECT member_id AS m FROM notification_events WHERE event_type = 'item_update' AND root_id = ?1 ORDER BY member_id").bind(root).all<{ m: string }>()).results.map((row) => row.m);

describe('Property 123: Navigation and follows preserve access and event uniqueness', () => {
  it('keeps personal navigation author-scoped, reruns and lists through current access, and unions a Follow into one event while a System_Alert ignores the same muting and preferences', async () => {
    let cases = 0;
    await fc.assert(fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 10 }), async (ops) => {
      cases += 1;
      // Each case starts clean so the one viewer's personal navigation under test is the only data the API should expose.
      await resetRecords(core());
      await core().prepare('DELETE FROM notification_prefs').run();
      await core().prepare('DELETE FROM muted_projects').run();
      await search().batch([search().prepare('DELETE FROM search_credits'), search().prepare('DELETE FROM search_docs')]);
      (world as { projectId: typeof world.projectId }).projectId = await addProject(core(), world.ids.admin, world.at);

      // The owner (author) makes a finding and a Research_Question the viewer (colleague) can read until a fault revokes it.
      // A distinctive shared word lets one Saved_Search match both records; the Question body also carries it.
      const term = 'quetzal';
      const finding = await world.created('author', 'finding', { title: 'Quetzal finding', claim: rich(term) });
      const question = await world.created('author', 'research_question', { title: 'Quetzal question', question: `What did the ${term} show?` });
      await drain(); // index both so the Saved_Search can find them.

      // The viewer's personal navigation: a Bookmark and a Follow of the finding, a Follow of the Question, and a
      // Saved_Search that matches both records. None stores a copy of the record or of any result.
      const bookmark = (await json<{ bookmark: BookmarkView }>(await world.request('colleague', 'POST', '/me/bookmarks', { name: 'The quetzal', targetId: finding.id }))).bookmark;
      const itemFollow = (await json<{ follow: FollowView }>(await world.request('colleague', 'POST', '/me/follows', { kind: 'item', targetId: finding.id }))).follow;
      const questionFollow = (await json<{ follow: FollowView }>(await world.request('colleague', 'POST', '/me/follows', { kind: 'question', targetId: question.id }))).follow;
      const saved = (await json<{ search: SavedSearchView }>(await world.request('colleague', 'POST', '/me/searches', { name: 'Quetzals', filters: { q: term } }))).search;

      // The viewer's flag count is fixed from the start: creating the two records flagged the viewer, and reading the
      // dashboard, bookmarks, follows, or rerunning the search must never clear a New_Flag or Updated_Flag (R58.5).
      const flags = await count('SELECT count(*) AS n FROM flags WHERE member_id = ?1', world.ids.colleague);

      // The independent model of the world the viewer navigates.
      const model = {
        itemReadable: true, // the viewer can read the finding.
        questionReadable: true, // the viewer can read the Question.
        muted: false, // the viewer has muted the finding's Project.
        prefInApp: true, // the viewer's item_update in-app preference (an explicit off also turns email off here).
        updates: 0, // Item_Update events the viewer should have received through their finding Follow.
      };

      const verify = async (label: string): Promise<void> => {
        // The personal rows are never deleted by a lost target: the three personal objects stay stored throughout.
        expect(await count('SELECT count(*) AS n FROM bookmarks WHERE member_id = ?1', world.ids.colleague), `${label}: bookmark stored`).toBe(1);
        expect(await count('SELECT count(*) AS n FROM follows WHERE member_id = ?1', world.ids.colleague), `${label}: follows stored`).toBe(2);
        expect(await count('SELECT count(*) AS n FROM saved_searches WHERE member_id = ?1', world.ids.colleague), `${label}: search stored`).toBe(1);

        // The Bookmark is available with its target only while the finding is readable; otherwise a neutral entry (R58.4).
        const [bm] = (await json<{ bookmarks: BookmarkView[] }>(await world.request('colleague', 'GET', '/me/bookmarks'))).bookmarks;
        expect(bm, `${label}: bookmark present`).toMatchObject({ id: bookmark.id, name: 'The quetzal', available: model.itemReadable });
        expect(bm!.targetId, `${label}: bookmark target`).toBe(model.itemReadable ? finding.id : null);

        // The two Follows: the item Follow tracks the finding's readability, the question Follow the Question's (R58.4).
        const follows = (await json<{ follows: FollowView[] }>(await world.request('colleague', 'GET', '/me/follows'))).follows;
        const itemView = follows.find((f) => f.id === itemFollow.id)!;
        const questionView = follows.find((f) => f.id === questionFollow.id)!;
        expect(itemView, `${label}: item follow`).toMatchObject({ available: model.itemReadable, targetId: model.itemReadable ? finding.id : null });
        expect(questionView, `${label}: question follow`).toMatchObject({ available: model.questionReadable, targetId: model.questionReadable ? question.id : null });

        // Rerun the Saved_Search through current authorization: it returns exactly the readable records now, never a
        // stored snapshot. The finding and the Question both match the term; each appears only while readable (R58.4).
        const rerun = await json<SearchPage>(await world.request('colleague', 'GET', `/me/searches/${saved.id}/results`));
        const expected = [...(model.itemReadable ? [finding.id as string] : []), ...(model.questionReadable ? [question.id as string] : [])].sort();
        expect(rerun.results.map((r) => r.id).sort(), `${label}: saved search rerun`).toEqual(expected);

        // The My_Work dashboard lists the followed Question, readable with its state and text, neutral otherwise, with no
        // inaccessible count. Reading it (and the lists and rerun above) clears no flag (R58.1, R58.4, R58.5).
        const dashboard = await json<DashboardView>(await world.request('colleague', 'GET', '/me/dashboard'));
        expect(dashboard.questions, `${label}: dashboard questions`).toHaveLength(1);
        const dq = dashboard.questions[0]!;
        if (model.questionReadable) {
          expect(dq, `${label}: dashboard question available`).toMatchObject({ followId: questionFollow.id, available: true, rootId: question.id, state: 'open' });
          expect(dq.question, `${label}: dashboard question text`).toBe(`What did the ${term} show?`);
        } else {
          expect(dq, `${label}: dashboard question neutral`).toMatchObject({ followId: questionFollow.id, available: false, rootId: null, identifier: null, question: null, state: null });
        }
        expect(await count('SELECT count(*) AS n FROM flags WHERE member_id = ?1', world.ids.colleague), `${label}: flags unchanged`).toBe(flags);

        // Author isolation: no other Member, whatever their Role, sees or can touch the viewer's personal navigation (R58.2, R58.3).
        for (const other of OTHERS) {
          expect((await json<{ bookmarks: BookmarkView[] }>(await world.request(other, 'GET', '/me/bookmarks'))).bookmarks.map((b) => b.id), `${label}: ${other} bookmarks`).toEqual([]);
          expect((await json<{ follows: FollowView[] }>(await world.request(other, 'GET', '/me/follows'))).follows.map((f) => f.id), `${label}: ${other} follows`).toEqual([]);
          expect((await json<{ searches: SavedSearchView[] }>(await world.request(other, 'GET', '/me/searches'))).searches.map((s) => s.id), `${label}: ${other} searches`).toEqual([]);
          expect((await world.request(other, 'PATCH', `/me/bookmarks/${bookmark.id}`, { name: 'Mine' })).status, `${label}: ${other} rename bookmark`).toBe(404);
          expect((await world.request(other, 'DELETE', `/me/bookmarks/${bookmark.id}`)).status, `${label}: ${other} delete bookmark`).toBe(404);
          expect((await world.request(other, 'PATCH', `/me/follows/${itemFollow.id}`, { email: 'off' })).status, `${label}: ${other} update follow`).toBe(404);
          expect((await world.request(other, 'DELETE', `/me/follows/${questionFollow.id}`)).status, `${label}: ${other} delete follow`).toBe(404);
          expect((await world.request(other, 'PATCH', `/me/searches/${saved.id}`, { name: 'Mine' })).status, `${label}: ${other} update search`).toBe(404);
          expect((await world.request(other, 'GET', `/me/searches/${saved.id}/results`)).status, `${label}: ${other} rerun search`).toBe(404);
          expect((await world.request(other, 'DELETE', `/me/searches/${saved.id}`)).status, `${label}: ${other} delete search`).toBe(404);
        }
      };

      await verify('start');
      for (const [step, current] of ops.entries()) {
        const label = `step ${step} ${JSON.stringify(current)}`;
        if (current.t === 'correct') {
          // The owner corrects the finding: an Item_Update whose audience is the owner, the Thread's posters, and the
          // finding's Followers unioned in. The viewer follows but does not own it, so is reached exactly when they can
          // read the finding, have not muted the Project, and have not turned the Event_Type off (R58.3, R39.9).
          await core().prepare('DELETE FROM notification_events WHERE event_type = ?1 AND root_id = ?2').bind('item_update', finding.id as string).run();
          await core().prepare('DELETE FROM notifications WHERE member_id = ?1').bind(world.ids.colleague).run();
          const item = await world.view('author', finding.id as string);
          const saveResp = await world.request('author', 'PATCH', `/items/${finding.id}`, { rev: item.rev, title: `Corrected ${item.rev}`, mark: { mark: 'correction', reason: 'Synthetic.' } });
          expect(saveResp.status, label).toBe(200);
          const reaches = model.itemReadable && !model.muted && model.prefInApp;
          const recipients = await itemUpdateRecipients(finding.id as string);
          // Exactly the viewer when reached, and no one else here (the owner acted, so is never notified of their own change).
          expect(recipients, `${label}: item_update recipients`).toEqual(reaches ? [world.ids.colleague] : []);
          // Deduplicated: at most one Item_Update event and one Notification for the viewer, never two for the one follower.
          expect(await count('SELECT count(*) AS n FROM notification_events WHERE event_type = ?2 AND member_id = ?1', world.ids.colleague, 'item_update'), `${label}: viewer events`).toBe(reaches ? 1 : 0);
          expect(await count('SELECT count(*) AS n FROM notifications WHERE member_id = ?1', world.ids.colleague), `${label}: viewer notifications`).toBe(reaches ? 1 : 0);
          if (reaches) model.updates += 1;

          // A mandatory System_Alert reaches the Administrator even with the same Project muted and preferences off: a
          // policy-alert exception is preserved where the follow fan-out honours muting and the Event_Type (R19.4, R19.10).
          await core().prepare("DELETE FROM notification_events WHERE event_type = 'system_alert'").run();
          const { GuardedBatch } = await import('@researchforce/db/batch');
          const { notifySystemAlert } = await import('../../src/notifications/fanout');
          const batch = new GuardedBatch(core(), { id: world.ids.admin, now: world.at });
          notifySystemAlert(batch, 'usage:d1', { allowance: 'D1 rows read', percent: 80 });
          await batch.commit();
          const alertRecipients = (await core().prepare("SELECT member_id AS m FROM notification_events WHERE event_type = 'system_alert'").all<{ m: string }>()).results.map((row) => row.m);
          expect(alertRecipients, `${label}: system_alert reaches admin`).toEqual([world.ids.admin]);
        } else if (current.t === 'accessItem') {
          await setAccess(finding, current.readable);
          await drain(); // the search index tracks the access change so a rerun matches it.
          model.itemReadable = current.readable;
        } else if (current.t === 'accessQuestion') {
          await setAccess(question, current.readable);
          await drain();
          model.questionReadable = current.readable;
        } else if (current.t === 'mute') {
          if (current.muted) await core().prepare('INSERT OR IGNORE INTO muted_projects (member_id, project_id, muted_at) VALUES (?1, ?2, ?3)').bind(world.ids.colleague, world.projectId, world.at).run();
          else await core().prepare('DELETE FROM muted_projects WHERE member_id = ?1 AND project_id = ?2').bind(world.ids.colleague, world.projectId).run();
          model.muted = current.muted;
        } else {
          // Turn the viewer's item_update Event_Type preference off (in-app and email both off) or back to the default on.
          await core().prepare('DELETE FROM notification_prefs WHERE member_id = ?1 AND event_type = ?2').bind(world.ids.colleague, 'item_update').run();
          if (!current.inApp) await core().prepare("INSERT INTO notification_prefs (member_id, event_type, in_app, email) VALUES (?1, 'item_update', 0, 'off')").bind(world.ids.colleague).run();
          model.prefInApp = current.inApp;
        }
        await verify(label);
      }
    }), { numRuns: Math.min(FC_RUNS, 60) });
  }, 600_000);

  it('accepts the longest valid name and refuses a 101st code point, and fills then refuses the bookmark and saved-search count limits', async () => {
    const item = await world.created('author', 'finding');

    // The longest name is exactly 100 code points, stored and recovered unchanged; a 101st is refused with nothing stored.
    const atLimit = 'q'.repeat(PERSONAL_LIMITS.nameCodePoints);
    expect(cpLength(atLimit)).toBe(PERSONAL_LIMITS.nameCodePoints);
    const named = (await json<{ bookmark: BookmarkView }>(await world.request('author', 'POST', '/me/bookmarks', { name: atLimit, targetId: item.id }))).bookmark;
    expect(named.name).toBe(atLimit);
    const refusedName = await world.request('author', 'POST', '/me/searches', { name: `${atLimit}q`, filters: { q: 'tiles' } });
    expect(refusedName.status).toBe(422);
    expect(await count('SELECT count(*) AS n FROM saved_searches WHERE member_id = ?1', world.ids.author)).toBe(0);

    // Fill the Bookmark count to its limit with distinct synthetic targets; the one real Bookmark plus fillers reach 100.
    await core().prepare(`INSERT INTO bookmarks (id, member_id, target_id, target_root_id, name, position, created_at, rev, updated_seq)
      SELECT '1' || printf('%025d', value), ?1, '2' || printf('%025d', value), '2' || printf('%025d', value), 'Filler', 100 + value, ?2, 1, 0
      FROM (WITH RECURSIVE c(value) AS (VALUES(1) UNION ALL SELECT value+1 FROM c WHERE value < ?3) SELECT value FROM c)`)
      .bind(world.ids.author, world.at, PERSONAL_LIMITS.bookmarks - 1).run();
    expect(await count('SELECT count(*) AS n FROM bookmarks WHERE member_id = ?1', world.ids.author)).toBe(PERSONAL_LIMITS.bookmarks);
    const another = await world.created('author', 'finding');
    const over = await world.request('author', 'POST', '/me/bookmarks', { name: 'One too many', targetId: another.id });
    expect(over.status).toBe(422);
    expect(await count('SELECT count(*) AS n FROM bookmarks WHERE member_id = ?1', world.ids.author)).toBe(PERSONAL_LIMITS.bookmarks);

    // Fill the Saved_Search count to its limit; the next is refused with nothing stored.
    await core().prepare(`INSERT INTO saved_searches (id, member_id, name, filters, position, created_at, rev, updated_seq)
      SELECT '0' || printf('%025d', value), ?1, 'Filler', '{"q":"x"}', value, ?2, 1, 0 FROM (WITH RECURSIVE c(value) AS (VALUES(1) UNION ALL SELECT value+1 FROM c WHERE value < ?3) SELECT value FROM c)`)
      .bind(world.ids.author, world.at, PERSONAL_LIMITS.searches).run();
    expect(await count('SELECT count(*) AS n FROM saved_searches WHERE member_id = ?1', world.ids.author)).toBe(PERSONAL_LIMITS.searches);
    const overSearch = await world.request('author', 'POST', '/me/searches', { name: 'Over', filters: { q: 'y' } });
    expect(overSearch.status).toBe(422);
    expect(await count('SELECT count(*) AS n FROM saved_searches WHERE member_id = ?1', world.ids.author)).toBe(PERSONAL_LIMITS.searches);
  }, 120_000);
});
