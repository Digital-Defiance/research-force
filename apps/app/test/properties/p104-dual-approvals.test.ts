// Feature: research-collab-cms, Property 104: Dual_Approvals need two different active Administrators
import { beforeEach, describe, expect, it } from 'vitest';
import { CONSENT_LIMITS } from '@researchforce/domain/consent';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { cpLength } from '@researchforce/domain/text';
import { unitKey } from '@researchforce/kernel/views';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import type { HoldPreview } from '../../src/disclosure/holds';
import type { PreviewResult } from '../../src/disclosure/preview';
import { itemWorld } from '../items';
import type { ItemView, Who } from '../items';
import { addProject, resetRecords } from '../units';

/**
 * Validates R23.22, R47.7, R48.8, R48.9, R49.1, R49.3, R49.4, R49.5, R49.6, R49.8 against an independent model of the
 * three overriding actions a Dual_Approval carries: a Hold_Override of a Confidentiality_Hold (R48.8, R48.9), a widening
 * of a Revoked Owner's Restricted Research_Item (R47.7), and a Publication_Consent recorded on behalf of a Revoked
 * Consenting_Member (R23.22). Each action is proposed by one active Administrator and applied only when a SECOND,
 * DISTINCT, currently Active Administrator approves it (R49.1, R49.3). The world holds one finding owned by `author` in a
 * Public, Full_Content Project, with `admin` and `colleague` as the two Administrators and `author` the Contributor whose
 * protection the three actions override.
 *
 * A random sequence of operations drives the world and a model built beside it from the acceptance criteria alone:
 * `admin` proposes one of the three actions; a Member approves, declines, or withdraws an open proposal; a precondition is
 * faulted between propose and approve (the hold lifted, the Owner restored to Active, the proposer revoked, the body
 * edited so a consent snapshot goes stale); and the Administrator count is varied by demoting or promoting `colleague`.
 *
 * After every step the model asserts, through the propose/approve/decline/withdraw and preview/apply API, that: the
 * proposer may NOT approve their own proposal, and approval needs two DISTINCT currently Active Administrators by id so a
 * count alone never suffices (R49.3); a proposal LAPSES with nothing applied when a precondition changed before approval —
 * the hold lifted, the Owner no longer Revoked, the Consenting_Member no longer Revoked or the snapshot changed, or the
 * proposer no longer a currently Active Administrator (R49.4, R47.7, R23.22, R49.8); on a clean approval the effect
 * applies exactly once — a hold override stops the hold blocking with no Disclosure_Level change (R48.8, R48.9), an
 * access_widen lifts the restriction with an access_change Revision (R47.7), and a consent_on_behalf writes a source='dual'
 * consent that then satisfies the owner_consent gate (R23.22); decline (a second Administrator) and withdraw (the proposer)
 * close the open proposal with an immutable reason and apply nothing (R49.5); with fewer than two active Administrators the
 * propose and approve paths are disabled with the need_second_admin explanation (R49.6); and a second decision on an
 * already-closed proposal is refused. No action R49.1 lists takes effect by any other path.
 */

const SECRET = 'synthetic-preview-hmac-secret-for-tests';
const LICENCE = 'Synthetic Content Licence 1.0';
const world = itemWorld(undefined, { contentLicence: LICENCE });

/**
 * `colleague` is promoted to a second Administrator so a Dual_Approval has a proposer (`admin`) and a distinct second
 * approver (`colleague`), and every Member holds a Licence_Agreement for the current Content_Licence so the licence gate
 * never stands in for the consent or hold gate the actions clear.
 */
beforeEach(async () => {
  await world.core().batch([
    world.core().prepare('UPDATE members SET role_id = ?1 WHERE id = ?2').bind(ROLE_IDS.administrator, world.ids.colleague),
    world.core().prepare('UPDATE profiles SET licence_name = ?1, licence_given_on = ?2 WHERE member_id IN (?3, ?4, ?5)')
      .bind(LICENCE, '2026-10-27', world.ids.admin, world.ids.colleague, world.ids.author),
  ]);
});

const core = () => world.bindings.RF_CORE;

/** The three overriding actions a Dual_Approval carries (R49.1). */
type Action = 'hold_override' | 'access_widen' | 'consent_on_behalf';
/** Who may act as an approver, decliner, or withdrawer in a step. */
const ACTORS: readonly Who[] = ['author', 'colleague', 'admin'];

/**
 * An operation the model and the world run in lockstep. `propose` opens a proposal for one action (when its precondition
 * holds); `approve`/`decline`/`withdraw` close the open proposal by a chosen Member; the fault operations change a live
 * precondition between propose and approve; and `adminCount` varies the number of active Administrators.
 */
type Op =
  | { t: 'propose'; action: Action } // `admin` proposes one of the three actions on the finding.
  | { t: 'approve'; who: Who } // `who` tries to approve the open proposal; only a second, distinct active Administrator succeeds.
  | { t: 'decline'; who: Who } // `who` tries to decline the open proposal; only an active Administrator other than the proposer succeeds.
  | { t: 'withdraw'; who: Who } // `who` tries to withdraw the open proposal; only the proposer succeeds.
  | { t: 'liftHold' } // the placer lifts the hold the open hold_override targets, faulting its precondition.
  | { t: 'revokeOwner'; revoked: boolean } // fault injection: the finding Owner becomes Revoked or Active.
  | { t: 'revokeProposer'; revoked: boolean } // fault injection: the proposer (`admin`) becomes Revoked or Active.
  | { t: 'editBody' } // `admin` edits the finding body, moving a dependency so a consent_on_behalf snapshot goes stale.
  | { t: 'adminCount'; two: boolean }; // promote `colleague` back to Administrator (two) or demote to Contributor (one).

const op: fc.Arbitrary<Op> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ t: fc.constant('propose' as const), action: fc.constantFrom<Action>('hold_override', 'access_widen', 'consent_on_behalf') }) },
  { weight: 5, arbitrary: fc.record({ t: fc.constant('approve' as const), who: fc.constantFrom(...ACTORS) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('decline' as const), who: fc.constantFrom(...ACTORS) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('withdraw' as const), who: fc.constantFrom(...ACTORS) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('liftHold' as const) }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('revokeOwner' as const), revoked: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('revokeProposer' as const), revoked: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('editBody' as const) }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('adminCount' as const), two: fc.boolean() }) },
);

/**
 * A fresh clean slate for one property iteration: no leftover records, the two Administrators and the Owner restored to
 * Active with the Content_Licence, and a Restricted finding owned by `author` in a Public Full_Content Project with its
 * creation outbox and events cleared. Restricted so an access_widen has room to widen; Public Full_Content so a
 * consent_on_behalf then clears the owner_consent gate.
 */
async function finding(): Promise<ItemView> {
  await resetRecords(core());
  await core().batch([
    core().prepare("UPDATE members SET status = 'active', role_id = ?1 WHERE id = ?2").bind(ROLE_IDS.administrator, world.ids.admin),
    core().prepare("UPDATE members SET status = 'active', role_id = ?1 WHERE id = ?2").bind(ROLE_IDS.administrator, world.ids.colleague),
    core().prepare("UPDATE members SET status = 'active' WHERE id = ?1").bind(world.ids.author),
    core().prepare('UPDATE profiles SET licence_name = ?1, licence_given_on = ?2 WHERE member_id IN (?3, ?4, ?5)')
      .bind(LICENCE, '2026-10-27', world.ids.admin, world.ids.colleague, world.ids.author),
  ]);
  (world as { projectId: typeof world.projectId }).projectId = await addProject(core(), world.ids.admin, world.at);
  const item = await world.created('author', 'finding', { access: { level: 'restricted', members: [] } });
  await core().batch([
    core().prepare("UPDATE projects SET disclosure_level = 'public' WHERE id = ?1").bind(world.projectId),
    core().prepare("UPDATE research_items SET public_presentation = 'full_content' WHERE unit_id = ?1").bind(item.id),
    core().prepare('DELETE FROM outbox'),
    core().prepare('DELETE FROM notification_events'),
  ]);
  return item;
}

const rows = async <T>(query: string, ...binds: unknown[]): Promise<T[]> => (await core().prepare(query).bind(...binds).all<T>()).results;

async function placeHold(itemId: string, note = 'Held pending review.'): Promise<string> {
  const previewResp = await world.request('admin', 'POST', `/items/${itemId}/holds/preview`, {});
  const { confirmation } = await previewResp.json<HoldPreview>();
  const response = await world.request('admin', 'POST', `/items/${itemId}/holds`, { note, ...(confirmation === null ? {} : { confirmation }) });
  if (response.status !== 201) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json<{ hold: string }>()).hold;
}

function propose(action: Action, item: ItemView, holdId: string | null): Promise<Response> {
  const bodies: Record<Action, Record<string, unknown>> = {
    hold_override: { action: 'hold_override', target: { itemId: item.id, holdId }, reason: 'Override the hold.' },
    access_widen: { action: 'access_widen', target: { itemId: item.id, add: [world.ids.colleague] }, reason: 'Open the departed Owner\u2019s item.' },
    consent_on_behalf: { action: 'consent_on_behalf', target: { key: unitKey(item.id), values: { level: 'public' } }, reason: 'Publish the departed Member\u2019s finding.' },
  };
  return world.request('admin', 'POST', '/dual-approvals', bodies[action]);
}

async function preview(body: unknown): Promise<PreviewResult> {
  world.bindings.DOWNLOAD_HMAC_KEY = SECRET;
  const response = await world.request('admin', 'POST', '/disclosure/preview', body);
  if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return response.json<PreviewResult>();
}
function applyToken(token: string): Promise<Response> {
  world.bindings.DOWNLOAD_HMAC_KEY = SECRET;
  return world.request('admin', 'POST', '/disclosure/apply', { token });
}

const stateOf = (id: string) => core().prepare('SELECT state, decided_by AS decidedBy, decision_reason AS reason FROM dual_approvals WHERE id = ?1')
  .bind(id).first<{ state: string; decidedBy: string | null; reason: string | null }>();

/** The model's record of the single open proposal, enough to decide every guard the server runs at approval. */
interface Open {
  readonly id: string;
  readonly action: Action;
  readonly holdId: string | null; // the hold a hold_override targets, so a lift can fault it.
  readonly epoch: number; // the dependency epoch a consent_on_behalf snapshot was bound to; a later editBody makes it stale.
}

describe('Property 104: Dual_Approvals need two different active Administrators', () => {
  it('applies each action exactly once only on approval by a second distinct active Administrator, lapses a changed precondition, and never applies by another path', async () => {
    await fc.assert(fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 16 }), async (ops) => {
      const item = await finding();
      const key = unitKey(item.id);
      const proposer: Who = 'admin';

      // The independent model, built from the acceptance criteria alone.
      const model = {
        open: undefined as Open | undefined, // the single open proposal, or none.
        ownerRevoked: false, // the finding Owner (`author`) Member_Status.
        proposerRevoked: false, // the proposer (`admin`) Member_Status; a Revoked proposer is no longer a currently Active Administrator.
        twoAdmins: true, // whether `colleague` is a second active Administrator, so two distinct Administrators exist.
        epoch: 0, // the finding body's dependency epoch; an editBody advances it, moving a consent snapshot stale.
        holdId: null as string | null, // the active hold on the finding, if any (for hold_override).
        holdOverridden: false, // whether the live hold has been overridden by an approved hold_override.
        consentWritten: false, // whether an approved consent_on_behalf wrote a source='dual' consent.
        widened: false, // whether an approved access_widen added `colleague` to the Access_List.
      };

      /** The proposer is a currently Active Administrator exactly when `admin` is not Revoked (R49.3, R49.8). */
      const proposerEligible = (): boolean => !model.proposerRevoked;
      /** Whether an action's precondition still holds now, so an approval would apply rather than lapse (R49.4, R49.8). */
      const preconditionHolds = (open: Open): boolean => {
        if (!proposerEligible()) return false;
        if (open.action === 'hold_override') return model.holdId !== null && !model.holdOverridden;
        if (open.action === 'access_widen') return model.ownerRevoked;
        return model.ownerRevoked && open.epoch === model.epoch; // consent_on_behalf: Owner still Revoked and snapshot unchanged.
      };

      for (const [step, current] of ops.entries()) {
        const label = `step ${step} ${JSON.stringify(current)}`;
        if (current.t === 'propose') {
          if (model.open !== undefined) continue; // keep one open proposal at a time, so the model tracks a single target.
          // Each action's propose-time precondition, mirrored so the model proposes only when the server will accept it. The
          // hold is placed by `admin`, so it is placed only while `admin` is still an active Administrator who can place it.
          if (current.action === 'hold_override' && model.holdId === null && proposerEligible()) {
            model.holdId = await placeHold(item.id);
            model.holdOverridden = false;
          }
          const canPropose = model.twoAdmins && proposerEligible()
            && (current.action === 'hold_override' ? model.holdId !== null && !model.holdOverridden
              : model.ownerRevoked); // access_widen and consent_on_behalf need a Revoked Owner (R47.7, R23.22).
          const response = await propose(current.action, item, current.action === 'hold_override' ? model.holdId : null);
          if (!canPropose) {
            // The propose path is disabled while fewer than two Administrators are active (R49.6); otherwise a precondition
            // fails (a revoked proposer cannot hold dual.propose, an active Owner has no Dual_Approval path).
            expect(response.status, `${label}: propose refused`).not.toBe(201);
            if (!model.twoAdmins && proposerEligible()) {
              expect((await response.json<{ details: { rule: string } }>()).details.rule, `${label}: need_second_admin`).toBe('need_second_admin');
            }
            continue;
          }
          expect(response.status, `${label}: propose accepted`).toBe(201);
          const id = (await response.json<{ dualApproval: string }>()).dualApproval;
          model.open = { id, action: current.action, holdId: current.action === 'hold_override' ? model.holdId : null, epoch: model.epoch };
        } else if (current.t === 'approve') {
          const open = model.open;
          if (open === undefined) continue; // nothing open to approve.
          const response = await world.request(current.who, 'POST', `/dual-approvals/${open.id}/approve`, { reason: 'Approved by a second Administrator.' });
          // Only a second, different active Administrator may approve. The proposer is `admin`, so only `colleague` can,
          // and only while a second Administrator; the proposer and a Contributor cannot (R49.3).
          const isSecondAdmin = current.who === 'colleague' && model.twoAdmins;
          if (!isSecondAdmin) {
            expect(response.status, `${label}: non-approver refused`).toBe(403);
            expect((await response.json<{ details: { rule: string } }>()).details.rule, `${label}: not_approver`).toBe('not_approver');
            expect((await stateOf(open.id))?.state, `${label}: proposal stays open`).toBe('open');
            continue;
          }
          const result = await response.json<{ state: string }>();
          if (preconditionHolds(open)) {
            // A clean approval applies the effect exactly once and records the approver (R49.3).
            expect(response.status, `${label}: approve accepted`).toBe(200);
            expect(result.state, `${label}: approved`).toBe('approved');
            expect(await stateOf(open.id), `${label}: approved by the second Administrator`).toMatchObject({ state: 'approved', decidedBy: world.ids.colleague });
            if (open.action === 'hold_override') model.holdOverridden = true;
            else if (open.action === 'access_widen') model.widened = true;
            else model.consentWritten = true;
          } else {
            // A changed or ineligible proposal lapses with nothing applied (R49.4, R49.8). An ineligible proposer still
            // lapses rather than merely blocks, whatever the Administrator count.
            expect(response.status, `${label}: lapse accepted`).toBe(200);
            expect(result.state, `${label}: lapsed`).toBe('lapsed');
            expect((await stateOf(open.id))?.state, `${label}: lapsed in the row`).toBe('lapsed');
          }
          model.open = undefined;
        } else if (current.t === 'decline') {
          const open = model.open;
          if (open === undefined) continue;
          const response = await world.request(current.who, 'POST', `/dual-approvals/${open.id}/decline`, { reason: 'Declined by a second Administrator.' });
          // Any active Administrator other than the proposer (`admin`) may decline (R49.5); only `colleague` qualifies here,
          // and only while a second Administrator; the proposer and a Contributor cannot.
          const canDecline = current.who === 'colleague' && model.twoAdmins;
          if (!canDecline) {
            expect(response.status, `${label}: non-decliner refused`).toBe(403);
            expect((await stateOf(open.id))?.state, `${label}: proposal stays open`).toBe('open');
            continue;
          }
          expect(response.status, `${label}: decline accepted`).toBe(200);
          expect(await stateOf(open.id), `${label}: declined with an immutable reason`).toMatchObject({ state: 'declined', decidedBy: world.ids.colleague, reason: 'Declined by a second Administrator.' });
          model.open = undefined;
        } else if (current.t === 'withdraw') {
          const open = model.open;
          if (open === undefined) continue;
          const response = await world.request(current.who, 'POST', `/dual-approvals/${open.id}/withdraw`, { reason: 'Withdrawn by the proposer.' });
          // Only the proposing Administrator may withdraw their own open proposal (R49.5).
          if (current.who !== proposer) {
            expect(response.status, `${label}: non-proposer withdraw refused`).toBe(403);
            expect((await stateOf(open.id))?.state, `${label}: proposal stays open`).toBe('open');
            continue;
          }
          expect(response.status, `${label}: withdraw accepted`).toBe(200);
          expect(await stateOf(open.id), `${label}: withdrawn with an immutable reason`).toMatchObject({ state: 'withdrawn', decidedBy: world.ids.admin, reason: 'Withdrawn by the proposer.' });
          model.open = undefined;
        } else if (current.t === 'liftHold') {
          if (model.holdId === null || model.holdOverridden || !proposerEligible()) continue; // no active hold, or the placer `admin` is Revoked and cannot lift.
          const response = await world.request('admin', 'POST', `/items/${item.id}/holds/${model.holdId}/lift`, {});
          expect(response.status, `${label}: placer lifts the hold`).toBe(200);
          model.holdId = null; // the lifted hold no longer covers the finding, faulting any open hold_override.
        } else if (current.t === 'revokeOwner') {
          await core().prepare('UPDATE members SET status = ?2 WHERE id = ?1').bind(world.ids.author, current.revoked ? 'revoked' : 'active').run();
          model.ownerRevoked = current.revoked;
        } else if (current.t === 'revokeProposer') {
          await core().prepare('UPDATE members SET status = ?2 WHERE id = ?1').bind(world.ids.admin, current.revoked ? 'revoked' : 'active').run();
          model.proposerRevoked = current.revoked;
        } else if (current.t === 'editBody') {
          // An Administrator edits the finding body, moving the unit's updated_seq, a dependency a consent_on_behalf
          // snapshot binds, so an earlier snapshot goes stale (R23.23, R23.24, R49.8). The proposer must be eligible to edit.
          if (model.proposerRevoked) continue;
          const view = await world.view('admin', item.id);
          const edited = await world.edit('admin', item.id, { rev: view.rev, claim: { text: `An edited claim ${step}.`, spans: [] }, mark: { mark: 'minor_edit' } });
          expect(edited.status, `${label}: edit body`).toBe(200);
          model.epoch += 1;
        } else {
          // adminCount: promote `colleague` back to Administrator or demote to Contributor, varying the count of active Administrators.
          await core().prepare('UPDATE members SET role_id = ?2 WHERE id = ?1').bind(world.ids.colleague, current.two ? ROLE_IDS.administrator : ROLE_IDS.contributor).run();
          model.twoAdmins = current.two;
        }

        // The open proposal the model tracks is exactly the one open row in the database (at most one open at a time).
        const openRows = await rows<{ id: string }>("SELECT id FROM dual_approvals WHERE state = 'open'");
        expect(new Set(openRows.map((row) => row.id)), `${label}: open proposal set matches the model`).toEqual(new Set(model.open === undefined ? [] : [model.open.id]));
      }

      // After the whole run the applied effects match the model exactly: an action takes effect only through an approval.
      // The hold is overridden exactly when an approval overrode it; no other path sets override_id.
      if (model.holdId !== null || model.holdOverridden) {
        const held = await rows<{ override: string | null }>('SELECT override_id AS override FROM confidentiality_holds WHERE unit_id = ?1 AND lifted_at IS NULL', item.id);
        expect(held.some((row) => row.override !== null), 'hold overridden iff an approval overrode it').toBe(model.holdOverridden);
      }
      // The Access_List holds `colleague` exactly when an approval widened it (R47.7).
      const grants = await rows<{ member: string }>('SELECT member_id AS member FROM access_grants WHERE root_id = ?1', item.id);
      expect(grants.some((row) => row.member === world.ids.colleague), 'access widened iff an approval widened it').toBe(model.widened);
      // A source='dual' consent exists exactly when an approval wrote one (R23.22).
      const consents = await rows<{ source: string }>("SELECT source FROM publication_consents WHERE unit_id = ?1 AND source = 'dual'", item.id);
      expect(consents.length > 0, 'dual consent exists iff an approval wrote it').toBe(model.consentWritten);

      // A written consent_on_behalf satisfies the owner_consent gate for the Revoked Owner's widening (R23.22).
      if (model.consentWritten && model.ownerRevoked && !model.widened) {
        const result = await preview({ units: [{ key, level: 'public' }] });
        expect(result.failures.some((f) => f.reason === 'owner_consent'), 'dual consent clears the owner_consent gate').toBe(false);
        expect(result.token, 'the Revoked Owner\u2019s widening now issues a token').toBeTruthy();
      }
    }), { numRuns: Math.min(FC_RUNS, 40) });
  }, 1000 * Math.min(FC_RUNS, 40));

  // The current-access case the design calls for: a hold_override stops the hold blocking a widening and changes no
  // Disclosure_Level, so a previously-held widening of the Administrator's own finding goes through after the override (R48.8, R48.9).
  it('a hold_override clears the hold gate for a widening without changing any Disclosure_Level', async () => {
    await resetRecords(core());
    (world as { projectId: typeof world.projectId }).projectId = await addProject(core(), world.ids.admin, world.at);
    await core().prepare('UPDATE members SET role_id = ?1 WHERE id = ?2').bind(ROLE_IDS.administrator, world.ids.colleague).run();
    // A finding owned by `admin`, so no Publication_Consent is needed and the hold is the only thing that can block the widening.
    const item = await world.created('admin', 'finding');
    await core().batch([
      core().prepare("UPDATE projects SET disclosure_level = 'public' WHERE id = ?1").bind(world.projectId),
      core().prepare("UPDATE research_items SET public_presentation = 'full_content' WHERE unit_id = ?1").bind(item.id),
      core().prepare("UPDATE units SET classification_state = 'unclassified' WHERE id = ?1").bind(item.id),
    ]);
    const holdId = await placeHold(item.id);
    // Before the override, the hold blocks a widening to Public (R48.4).
    const held = await preview({ units: [{ key: unitKey(item.id), level: 'public' }] });
    expect(held.failures.some((f) => f.reason === 'hold')).toBe(true);
    expect(held.token).toBeNull();

    const proposeResp = await propose('hold_override', item, holdId);
    expect(proposeResp.status).toBe(201);
    const dualId = (await proposeResp.json<{ dualApproval: string }>()).dualApproval;
    // The proposer cannot approve their own proposal (R49.3).
    expect((await world.request('admin', 'POST', `/dual-approvals/${dualId}/approve`, { reason: 'Mine.' })).status).toBe(403);
    expect((await world.request('colleague', 'POST', `/dual-approvals/${dualId}/approve`, { reason: 'Approved.' })).status).toBe(200);

    // The hold is overridden by this approval, with its Disclosure_Level unchanged (R48.8, R48.9); the finding stays Not_Published.
    expect(await rows('SELECT override_id AS o, lifted_at AS l FROM confidentiality_holds WHERE id = ?1', holdId)).toEqual([{ o: dualId, l: null }]);
    expect(await core().prepare('SELECT disclosure_level AS level FROM units WHERE id = ?1').bind(item.id).first<{ level: string }>()).toEqual({ level: 'not_published' });
    // The previously-held widening now goes through (R48.9).
    const free = await preview({ units: [{ key: unitKey(item.id), level: 'public' }] });
    expect(free.failures.some((f) => f.reason === 'hold')).toBe(false);
    expect(free.token).toBeTruthy();
    expect((await applyToken(free.token!)).status).toBe(200);
  }, 120_000);

  // A second decision on an already-closed proposal is refused: once declined, neither an approval nor a withdraw reopens it.
  it('refuses a second decision on an already-closed Dual_Approval', async () => {
    const item = await finding();
    const holdId = await placeHold(item.id);
    const proposeResp = await propose('hold_override', item, holdId);
    expect(proposeResp.status).toBe(201);
    const dualId = (await proposeResp.json<{ dualApproval: string }>()).dualApproval;
    // `colleague`, a second Administrator, declines, closing the proposal.
    expect((await world.request('colleague', 'POST', `/dual-approvals/${dualId}/decline`, { reason: 'Not now.' })).status).toBe(200);
    expect((await stateOf(dualId))?.state).toBe('declined');
    // A later approve or withdraw on the closed proposal is refused and changes nothing.
    expect((await world.request('colleague', 'POST', `/dual-approvals/${dualId}/approve`, { reason: 'Too late.' })).status).toBe(422);
    expect((await world.request('admin', 'POST', `/dual-approvals/${dualId}/withdraw`, { reason: 'Too late.' })).status).toBe(422);
    expect((await stateOf(dualId))?.state).toBe('declined');
  }, 120_000);

  // The maximum-encoded-input case the design calls for: a Dual_Approval reason is a bounded field, so the longest
  // allowed reason is accepted and recovered exactly, and one code point more is refused with nothing stored.
  it('accepts the longest Dual_Approval reason and refuses one code point more, storing nothing', async () => {
    const item = await finding();
    const holdId = await placeHold(item.id);
    const limit = CONSENT_LIMITS.dualReasonCodePoints;
    const atLimit = 'n'.repeat(limit);
    expect(cpLength(atLimit)).toBe(limit);

    const before = (await core().prepare('SELECT count(*) AS n FROM dual_approvals').first<number>('n')) ?? 0;
    const accepted = await world.request('admin', 'POST', '/dual-approvals', { action: 'hold_override', target: { itemId: item.id, holdId }, reason: atLimit });
    expect(accepted.status).toBe(201);
    const id = (await accepted.json<{ dualApproval: string }>()).dualApproval;
    // The reason is stored exactly as submitted.
    expect(await core().prepare('SELECT proposal_reason AS reason FROM dual_approvals WHERE id = ?1').bind(id).first<{ reason: string }>()).toEqual({ reason: atLimit });
    expect((await core().prepare('SELECT count(*) AS n FROM dual_approvals').first<number>('n')) ?? 0).toBe(before + 1);

    const tooLong = `${atLimit}n`;
    expect(cpLength(tooLong)).toBe(limit + 1);
    const refused = await world.request('admin', 'POST', '/dual-approvals', { action: 'hold_override', target: { itemId: item.id, holdId }, reason: tooLong });
    expect(refused.status).toBe(422);
    // Nothing stored: the over-long reason never became a proposal.
    expect((await core().prepare('SELECT count(*) AS n FROM dual_approvals').first<number>('n')) ?? 0).toBe(before + 1);
  }, 120_000);
});
