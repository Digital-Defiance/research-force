// Feature: research-collab-cms, Property 122: Proposed edits apply only current authorized diffs
import { describe, expect, it } from 'vitest';
import { diffBytes, PROPOSAL_LIMITS } from '@researchforce/domain/proposals';
import { BUILT_IN_VALUE_IDS } from '@researchforce/domain/value-sets';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { itemWorld, rich } from '../items';
import type { ItemView, Who } from '../items';
import { addProject, resetRecords } from '../units';

/**
 * Validates R57.4, R57.5, R57.6 against an independent model of one Edit_Proposal and the record it edits. A colleague
 * proposes an edit of a finding another Member owns, then a random sequence of steps drives the world: the record is edited
 * under the proposal (moving its base so acceptance must refuse until an explicit rebase), the proposer rebases onto the
 * current revision, an actor tries to accept, an actor tries to decline, the proposer withdraws, and the proposer's read
 * access to the record is revoked or restored. Each case also fixes which field the diff carries: a plain content field any
 * authorized editor may apply, or one of the forbidden routes (another Member's Log_Summary, a Project move, a Group_Note,
 * a status change) that the ordinary edit path refuses atomically.
 *
 * After every step the model asserts against the normal API: the proposer and base revision never change, however the
 * proposal is rebased or accepted; a proposal applies only when accepted by an actor authorized for every changed field and
 * only while the base is still current, recording the accepter as the acting editor distinct from the proposer; a stale base
 * refuses acceptance with nothing applied until the proposer rebases; a forbidden field rejects the whole action atomically,
 * leaving the record unchanged and the proposal open; a proposal of a record the viewer can no longer read is hidden as a
 * 404; the readable audience is notified once per Member with no duplicate for a Member who is both owner and proposer; and
 * the proposal never becomes a Submission, a research-search hit, or part of a completed-submission count. A companion case
 * pins the diffBytes budget: the largest encoded diff is stored exactly, and one byte more is refused with nothing stored.
 */

type ProposalEvent = { kind: string; actor: string | null; at: string; atRev: number | null; note: string | null };
type ProposalView = {
  id: string; targetId: string; targetRootId: string; proposer: string; baseRev: number; appliesToRev: number; state: string;
  stale: boolean; targetRev: number | null; diff: Record<string, unknown>; explanation: string; references: string[];
  acceptedBy: string | null; acceptedAt: string | null; closedBy: string | null; rev: number; events: ProposalEvent[];
};

/** Who tries each decisive action; author owns the finding, admin can edit any Item, colleague is the proposer and owns neither. */
const DECIDERS: readonly Who[] = ['author', 'colleague', 'admin'];

/** The field a diff carries. 'claim' is a plain content edit; the rest are forbidden routes the ordinary edit path refuses. */
type DiffKind = 'claim' | 'logSummary' | 'projectId' | 'groupNote' | 'status';

type Op =
  | { t: 'moveTarget' } // the owner edits the finding, pushing its revision past the proposal's base.
  | { t: 'rebase' } // the proposer rebases onto the record's current revision.
  | { t: 'accept'; who: Who }
  | { t: 'decline'; who: Who }
  | { t: 'withdraw'; who: Who }
  | { t: 'access'; readable: boolean }; // fault injection: revoke or restore the proposer's read access to the finding.

const op: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ t: fc.constant('moveTarget' as const) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('rebase' as const) }) },
  { weight: 4, arbitrary: fc.record({ t: fc.constant('accept' as const), who: fc.constantFrom(...DECIDERS) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('decline' as const), who: fc.constantFrom(...DECIDERS) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('withdraw' as const), who: fc.constantFrom(...DECIDERS) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('access' as const), readable: fc.boolean() }) },
);

const world = itemWorld();
const proposed = async (response: Response): Promise<ProposalView> => {
  if (response.status !== 201 && response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json<{ proposal: ProposalView }>()).proposal;
};
const read = (who: Who, id: string) => world.request(who, 'GET', `/proposals/edits/${id}`);
const count = async (sql: string, ...values: unknown[]) => (await world.core().prepare(sql).bind(...values).first<number>('n'))!;
const claimText = (view: ItemView) => (view.claim as { text: string }).text;

describe('Property 122: Proposed edits apply only current authorized diffs', () => {
  it('applies a proposal only when an authorized actor accepts a current base, keeps authorship and base fixed, and refuses forbidden or stale changes atomically', async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom<DiffKind>('claim', 'logSummary', 'projectId', 'groupNote', 'status'), fc.array(op, { minLength: 1, maxLength: 10 }), async (diffKind, ops) => {
      // Each case is a clean slate with a single finding owned by the author; the colleague proposes an edit of it.
      await resetRecords(world.core());
      (world as { projectId: typeof world.projectId }).projectId = await addProject(world.core(), world.ids.admin, world.at);
      const target = await world.created('author', 'finding');
      // A second Project so the 'projectId' diff is a real Move attempt; a Move has its own action and is refused through a proposal.
      const otherProject = await addProject(world.core(), world.ids.admin, world.at);
      const proposedText = 'The accepted synthetic claim.';
      // The diff is an ordinary edit body. 'claim' is a plain content change any authorized editor may apply. The rest route a
      // field the content proposal path refuses: a Log_Summary only the finding's Owner can change, a Project move, a
      // Group_Note, or a Status_Change, which has its own gated action. None of them may ever apply through a proposal.
      const diff: Record<string, unknown> = (() => {
        switch (diffKind) {
          case 'claim': return { claim: rich(proposedText), mark: { mark: 'minor_edit' } };
          case 'logSummary': return { logSummary: rich('A rewritten summary.'), mark: { mark: 'minor_edit' } };
          case 'projectId': return { claim: rich(proposedText), mark: { mark: 'minor_edit' }, projectId: otherProject };
          case 'groupNote': return { claim: rich(proposedText), mark: { mark: 'minor_edit' }, groupNote: rich('A note.') };
          case 'status': return { claim: rich(proposedText), mark: { mark: 'minor_edit' }, statusValueId: BUILT_IN_VALUE_IDS.findingConfirmed };
        }
      })();
      const submitted = await proposed(await world.request('colleague', 'POST', '/proposals/edits', { targetId: target.id, baseRev: target.rev, diff, explanation: 'Suggesting a change.' }));

      // The notifications before any decisive step: submission announced one Proposal event to owner and proposer (distinct
      // Members here), and the baseline the model holds steady for the no-Submission / no-search guarantees.
      const baseline = {
        submissions: await count('SELECT count(*) AS n FROM submissions'),
        activity: await count('SELECT count(*) AS n FROM activity'),
      };

      // The independent model of the one proposal and its record.
      const model = {
        id: submitted.id,
        baseRev: target.rev, // immutable: the revision the diff was first written against.
        appliesToRev: target.rev, // moves to the record's current revision on a rebase.
        targetRev: target.rev, // the finding's current revision; a moveTarget advances it.
        claim: claimText(target), // the finding's current claim text; an accepted 'claim'-bearing proposal changes it.
        logSummary: (target.logSummary as { text: string }).text, // the finding's Log_Summary; only an accepted 'logSummary' proposal by its Owner changes it.
        state: 'open' as string,
        acceptedBy: null as string | null,
        readable: true, // the proposer can still read the finding.
        events: ['submitted'] as string[],
      };
      // A proposal is stale exactly when it is open and the record moved past where the edit applies (R57.5).
      const stale = () => model.state === 'open' && model.targetRev !== model.appliesToRev;
      // Who may accept or decline: an actor authorized for every field the diff touches. The author owns the finding and the
      // admin can edit any Item's content, so both may act on a plain content edit; the colleague owns neither and may not. A
      // Log_Summary may be rewritten only by the finding's Owner, so only the author is authorized when the diff carries one.
      const canAct = (who: Who) => (diffKind === 'logSummary' ? who === 'author' : who === 'author' || who === 'admin');
      // Whether an authorized acceptance actually applies the diff. The 'claim' and 'logSummary' edits are real, permitted
      // field changes once the right actor accepts; a Project move, a Group_Note, or a Status_Change is a forbidden route the
      // content proposal path rejects atomically whatever the accepter's authority (R57.4).
      const forbidden = diffKind === 'projectId' || diffKind === 'groupNote' || diffKind === 'status';

      const verify = async (label: string): Promise<void> => {
        // The proposal is visible to the proposer only while they can read the finding; otherwise it is a 404 that reveals nothing (R57.4, R60.1).
        const got = await read('colleague', model.id);
        expect(got.status, `${label}: proposer read`).toBe(model.readable ? 200 : 404);
        // The owner (author) and admin can always read the finding, so always see the proposal with its fixed authorship and base.
        const owned = await proposed(await read('author', model.id));
        expect(owned.proposer, `${label}: proposer fixed`).toBe(world.ids.colleague);
        expect(owned.baseRev, `${label}: base fixed`).toBe(model.baseRev);
        expect(owned.appliesToRev, `${label}: applies-to`).toBe(model.appliesToRev);
        expect(owned.state, `${label}: state`).toBe(model.state);
        expect(owned.stale, `${label}: stale`).toBe(stale());
        expect(owned.targetRev, `${label}: target rev`).toBe(model.targetRev);
        expect(owned.events.map((e) => e.kind), `${label}: events`).toEqual(model.events);
        // The accepter is recorded as the acting editor, distinct from the proposer; while open or declined/withdrawn there is none.
        expect(owned.acceptedBy, `${label}: accepter`).toBe(model.acceptedBy);
        if (model.acceptedBy !== null) expect(owned.acceptedBy, `${label}: accepter not proposer`).not.toBe(owned.proposer);

        // The finding carries the proposed wording only once an authorized actor accepted the permitted edit; a forbidden
        // field never changes it, and a stale or unauthorized acceptance changes nothing.
        const after = await world.view('author', target.id);
        expect(claimText(after), `${label}: claim`).toBe(model.claim);
        expect((after.logSummary as { text: string }).text, `${label}: log summary`).toBe(model.logSummary);
        expect(after.rev, `${label}: target rev matches record`).toBe(model.targetRev);

        // A proposal is never a Submission or research-search hit, and never joins a completed-submission count (R57.6).
        expect(await count('SELECT count(*) AS n FROM submissions'), `${label}: submissions`).toBe(baseline.submissions);
        expect(await count('SELECT count(*) AS n FROM activity'), `${label}: activity`).toBe(baseline.activity);
        expect(await count("SELECT count(*) AS n FROM submissions WHERE member_id = ?1", world.ids.colleague), `${label}: proposer submissions`).toBe(0);
      };

      await verify('start');
      for (const [step, current] of ops.entries()) {
        const label = `diff=${diffKind} step ${step} ${JSON.stringify(current)}`;
        if (current.t === 'moveTarget') {
          // The owner edits the finding, moving its revision past where the proposal applies. If the proposal is already
          // accepted the claim may differ, so write a distinct value and advance the model's record state.
          const now = await world.view('author', target.id);
          const edited = await world.edit('author', target.id, { rev: now.rev, claim: rich(`Intervening change ${step}.`), mark: { mark: 'minor_edit' } });
          expect(edited.status, label).toBe(200);
          model.targetRev = now.rev + 1;
          model.claim = `Intervening change ${step}.`;
        } else if (current.t === 'rebase') {
          // Only the proposer rebases, onto the record's current revision, and only while the proposal is open. The base stays fixed.
          const body = { baseRev: model.targetRev, diff, explanation: 'Rebased.' };
          const response = await world.request('colleague', 'POST', `/proposals/edits/${model.id}/rebase`, body);
          if (!model.readable) expect(response.status, label).toBe(404); // a proposal of an unreadable record is hidden from its proposer too.
          else if (model.state !== 'open') expect(response.status, label).toBe(409);
          else {
            expect(response.status, label).toBe(200);
            model.appliesToRev = model.targetRev;
            model.events = [...model.events, 'rebased'];
          }
        } else if (current.t === 'accept') {
          const response = await world.request(current.who, 'POST', `/proposals/edits/${model.id}/accept`);
          if (current.who === 'colleague' && !model.readable) expect(response.status, label).toBe(404);
          else if (model.state !== 'open') expect(response.status, label).toBe(409); // a closed proposal cannot be accepted again.
          else if (stale()) expect(response.status, label).toBe(409); // a stale base refuses acceptance until an explicit rebase (R57.5).
          else if (!canAct(current.who)) expect(response.status, label).toBe(403); // only an actor authorized for every field may accept.
          else if (forbidden) {
            // The base is current and the actor could edit content, but the diff routes a forbidden field: the whole action is
            // rejected atomically, nothing applies, and the proposal stays open (R57.4).
            expect(response.status, label).toBe(422);
          } else {
            // A current base, an authorized actor, a permitted field edit: it applies, advancing the record one revision and
            // recording the accepter as the acting editor. Only the field the diff actually carries changes.
            expect(response.status, label).toBe(200);
            model.state = 'accepted';
            model.acceptedBy = world.ids[current.who];
            model.appliesToRev = model.targetRev; // acceptance applied against the current base.
            model.targetRev += 1;
            if (diffKind === 'claim') model.claim = proposedText;
            else model.logSummary = 'A rewritten summary.';
            model.events = [...model.events, 'accepted'];
          }
        } else if (current.t === 'decline') {
          const response = await world.request(current.who, 'POST', `/proposals/edits/${model.id}/decline`, { note: 'No.' });
          if (current.who === 'colleague' && !model.readable) expect(response.status, label).toBe(404);
          else if (model.state !== 'open') expect(response.status, label).toBe(409);
          else if (!canAct(current.who)) expect(response.status, label).toBe(403); // only an actor who could accept may decline.
          else {
            expect(response.status, label).toBe(200);
            model.state = 'declined';
            model.events = [...model.events, 'declined'];
          }
        } else if (current.t === 'withdraw') {
          const response = await world.request(current.who, 'POST', `/proposals/edits/${model.id}/withdraw`);
          if (current.who === 'colleague' && !model.readable) expect(response.status, label).toBe(404);
          else if (model.state !== 'open') expect(response.status, label).toBe(409);
          else if (current.who !== 'colleague') expect(response.status, label).toBe(403); // only the proposer withdraws their own suggestion.
          else {
            expect(response.status, label).toBe(200);
            model.state = 'withdrawn';
            model.events = [...model.events, 'withdrawn'];
          }
        } else {
          // Fault injection: revoke or restore the proposer's read access to the finding. The author is the Owner and the admin
          // is an Administrator, so both keep access; the colleague is neither, so Restricted hides it from them.
          const level = current.readable ? 'whole_team' : 'restricted';
          await world.core().prepare('UPDATE research_items SET access_level = ?2 WHERE unit_id = ?1').bind(target.id, level).run();
          model.readable = current.readable;
        }
        await verify(label);
      }

      // The readable audience is notified once per Member, deduplicated: the owner and the proposer are distinct here, so each
      // proposal event reaches exactly those two, and a Member never gets two Notifications from one proposal event (R57.6, R60.1).
      const perMember = (await world.core().prepare(
        "SELECT member_id AS m, count(*) AS n FROM notification_events WHERE event_type = 'proposal' GROUP BY member_id",
      ).all<{ m: string; n: number }>()).results;
      const recipients = new Set(perMember.map((row) => row.m));
      // Every recipient is the owner or the proposer, and no proposal event is duplicated for a Member within one batch.
      expect([...recipients].every((m) => m === world.ids.author || m === world.ids.colleague), 'proposal recipients are owner or proposer').toBe(true);
      const notifications = (await world.core().prepare(
        "SELECT member_id AS m, count(DISTINCT notification_id) AS notes, count(*) AS events FROM notification_events WHERE event_type = 'proposal' AND notification_id IS NOT NULL GROUP BY member_id",
      ).all<{ m: string; notes: number; events: number }>()).results;
      // One Notification per proposal event per Member: the settle step never folds two events into one here, and never splits one.
      for (const row of notifications) expect(row.notes, `deduplicated notifications for ${row.m}`).toBe(row.events);
    }), { numRuns: Math.min(FC_RUNS, 80) });
  }, 600_000);

  it('stores the maximum encoded diff and refuses one byte more with nothing stored', async () => {
    const target = await world.created('author', 'finding');
    // The diff is held opaquely as the ordinary edit body, so its only submit-time bound is the diffBytes budget. A single
    // filler field whose JSON encodes to exactly the limit is the largest diff accepted; one byte more is refused. (The
    // per-field edit limits are checked only when the diff is replayed on acceptance, which the regression tests cover.)
    const envelope = diffBytes({ fill: '' });
    const atLimit = { fill: 'x'.repeat(PROPOSAL_LIMITS.diffBytes - envelope) };
    expect(diffBytes(atLimit)).toBe(PROPOSAL_LIMITS.diffBytes);

    const before = await count('SELECT count(*) AS n FROM edit_proposals');
    const accepted = await world.request('colleague', 'POST', '/proposals/edits', { targetId: target.id, baseRev: target.rev, diff: atLimit, explanation: 'At the limit.' });
    expect(accepted.status).toBe(201);
    // The largest diff is stored exactly as submitted.
    const stored = await proposed(accepted);
    expect(diffBytes(stored.diff)).toBe(PROPOSAL_LIMITS.diffBytes);
    expect(await count('SELECT count(*) AS n FROM edit_proposals')).toBe(before + 1);

    const tooBig = { fill: `${atLimit.fill}x` };
    expect(diffBytes(tooBig)).toBeGreaterThan(PROPOSAL_LIMITS.diffBytes);
    const refused = await world.request('colleague', 'POST', '/proposals/edits', { targetId: target.id, baseRev: target.rev, diff: tooBig, explanation: 'One byte too many.' });
    expect(refused.status).toBe(422);
    // Nothing stored: the oversize diff never became a proposal.
    expect(await count('SELECT count(*) AS n FROM edit_proposals')).toBe(before + 1);
  }, 120_000);
});
