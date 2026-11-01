// Feature: research-collab-cms, Property 102: Publication follows the Consenting_Member's consent
import { beforeEach, describe, expect, it } from 'vitest';
import { CONSENT_LIMITS } from '@researchforce/domain/consent';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { cpLength } from '@researchforce/domain/text';
import { unitKey } from '@researchforce/kernel/views';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import type { PreviewResult } from '../../src/disclosure/preview';
import { itemWorld, rich } from '../items';
import type { ItemView } from '../items';
import { addProject, resetRecords } from '../units';

/**
 * Validates R23.17, R23.18, R23.19, R23.20, R23.21, R23.22, R23.23, R23.24 against an independent model of one finding
 * owned by `author` in a Public, Full_Content Project, whose Consenting_Member is therefore a Member other than the
 * `admin` who applies disclosure changes. A random sequence of operations drives the world and a model built beside it
 * from the acceptance criteria alone: the `admin` proposes publication and the Owner approves or declines it
 * (R23.18, R23.19); the Owner records their own Publication_Request (R23.21); a second Administrator records a
 * consent_on_behalf for a Revoked Owner through a Dual_Approval (R23.22); the Owner withdraws an unused consent
 * (R23.19); the `admin` edits the finding's body, moving the dependency manifest so an earlier consent goes stale
 * (R23.23, R23.24); the `admin` applies a widening to the consented values or to a strictly narrower output; and the
 * Owner's Member_Status is revoked or restored as fault injection.
 *
 * After every step the model asserts through the normal preview/apply API: a widening of the Owner's own view is
 * refused by the owner_consent gate unless some live (unused, unwithdrawn, not-stale, exact-snapshot) consent covers
 * exactly the applied values; a consent from a proposal approval, from the Owner's own Publication_Request, or from a
 * consent_on_behalf Dual_Approval each lets exactly its consented values apply; an edit to a dependency between consent
 * and apply requires a fresh consent (the stale snapshot no longer covers); withdrawing an unused consent revokes it;
 * applying spends the consent (used_at) so it covers nothing further; a consent covers only the exact resulting
 * snapshot it was signed against (R23.23), so a Summary_Only consent never widens to Full_Content and vice versa, while
 * a narrower output (omission, never substitution) presents nothing new and so the owner_consent gate asks for no
 * consent for it at all; and a Project's own level change never needs a consent, though it still moves a dependency the
 * snapshot binds. The owning property here does not replace the browser or staging checks.
 */

const SECRET = 'synthetic-preview-hmac-secret-for-tests';
const LICENCE = 'Synthetic Content Licence 1.0';
const world = itemWorld(undefined, { contentLicence: LICENCE });

/**
 * The world holds a finding owned by `author` in a Public, Full_Content Project. `colleague` is promoted to a second
 * Administrator so a consent_on_behalf Dual_Approval has a distinct approver, and every Member holds a Licence_Agreement
 * for the current Content_Licence so the licence gate never stands in for the consent gate under test.
 */
beforeEach(async () => {
  await world.core().batch([
    world.core().prepare('UPDATE members SET role_id = ?1 WHERE id = ?2').bind(ROLE_IDS.administrator, world.ids.colleague),
    world.core().prepare('UPDATE profiles SET licence_name = ?1, licence_given_on = ?2 WHERE member_id IN (?3, ?4, ?5)')
      .bind(LICENCE, '2026-10-27', world.ids.admin, world.ids.colleague, world.ids.author),
  ]);
});

/** The applied own values a consent can be given for; we vary the Public_Presentation so a Full_Content consent can cover a Summary_Only output. */
type Presentation = 'summary_only' | 'full_content';

/**
 * An operation the model and the world run in lockstep. The decisive apply operations carry the exact values they apply
 * so the model can decide coverage; the rest drive consent state and inject faults.
 */
type Op =
  | { t: 'proposeApprove'; presentation: Presentation } // admin proposes public at a presentation; the Owner approves, recording a source=proposal consent.
  | { t: 'proposeDecline' } // admin proposes; the Owner declines, recording no consent.
  | { t: 'request'; presentation: Presentation } // the Owner records their own Publication_Request, a source=request consent.
  | { t: 'onBehalf'; presentation: Presentation } // a consent_on_behalf Dual_Approval records a source=dual consent for a Revoked Owner.
  | { t: 'withdraw' } // the Owner withdraws their oldest live unused consent.
  | { t: 'editBody' } // admin edits the finding body, moving the dependency manifest so earlier consents go stale (R23.24).
  | { t: 'applyWiden'; presentation: Presentation } // admin applies a widening to Public at a presentation.
  | { t: 'applyProject' } // admin flips the Project's own level; a Project change never needs consent (R23.17).
  | { t: 'revoke'; revoked: boolean }; // fault injection: the Owner's Member_Status becomes Revoked or Active.

const op: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ t: fc.constant('proposeApprove' as const), presentation: fc.constantFrom<Presentation>('summary_only', 'full_content') }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('proposeDecline' as const) }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('request' as const), presentation: fc.constantFrom<Presentation>('summary_only', 'full_content') }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('onBehalf' as const), presentation: fc.constantFrom<Presentation>('summary_only', 'full_content') }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('withdraw' as const) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('editBody' as const) }) },
  { weight: 5, arbitrary: fc.record({ t: fc.constant('applyWiden' as const), presentation: fc.constantFrom<Presentation>('summary_only', 'full_content') }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('applyProject' as const) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('revoke' as const), revoked: fc.boolean() }) },
);

const core = () => world.bindings.RF_CORE;

/**
 * A fresh clean slate for one property iteration: no leftover records or consents, the Owner restored to Active after any
 * revocation in a prior iteration, and a finding owned by `author` in a Public Full_Content Project with its creation
 * outbox and events cleared.
 */
async function finding(): Promise<ItemView> {
  await resetRecords(core());
  await core().prepare("UPDATE members SET status = 'active' WHERE id = ?1").bind(world.ids.author).run();
  (world as { projectId: typeof world.projectId }).projectId = await addProject(core(), world.ids.admin, world.at);
  const item = await world.created('author', 'finding');
  await core().batch([
    core().prepare("UPDATE projects SET disclosure_level = 'public' WHERE id = ?1").bind(world.projectId),
    core().prepare("UPDATE research_items SET public_presentation = 'full_content' WHERE unit_id = ?1").bind(item.id),
    core().prepare('DELETE FROM outbox'),
    core().prepare('DELETE FROM notification_events'),
  ]);
  return item;
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

/** The live (unused, unwithdrawn) consent rows for a unit, oldest first. */
async function liveConsents(unitId: string): Promise<{ id: string; source: string; used: string | null; withdrawn: string | null }[]> {
  const rows = await core().prepare(
    'SELECT id, source, used_at AS used, withdrawn_at AS withdrawn FROM publication_consents WHERE unit_id = ?1 ORDER BY id',
  ).bind(unitId).all<{ id: string; source: string; used: string | null; withdrawn: string | null }>();
  return rows.results;
}

function proposalBody(key: string, presentation: Presentation): unknown {
  return { units: [{ key, level: 'public', presentation }], note: 'Please consent to publish this finding.' };
}
function widenBody(key: string, presentation: Presentation): unknown {
  return { units: [{ key, level: 'public', presentation }] };
}

/** The independent model's record of one live consent: the values it was given for and the dependency epoch it is bound to. */
interface ModelConsent {
  readonly id: string;
  readonly source: 'proposal' | 'request' | 'dual';
  readonly presentation: Presentation; // the consented Public_Presentation; level is always 'public' here.
  readonly epoch: number; // the dependency epoch the consent's snapshot was bound to; a later editBody makes it stale.
}

describe('Property 102: Publication follows the Consenting_Member\u2019s consent', () => {
  it('widens a non-owner Administrator\u2019s finding exactly when a live consent covers the applied values, spends it once, and refuses stale or substituted material', async () => {
    await fc.assert(fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 14 }), async (ops) => {
      const item = await finding();
      const key = unitKey(item.id);

      // The independent model, built from the acceptance criteria alone.
      const model = {
        // The finding's own applied state. It starts Not_Published; a widening to Public needs a consent. Once applied at
        // a presentation, re-applying the same or a narrower output presents nothing new, so the gate asks for no consent.
        applied: { level: 'not_published' as 'not_published' | 'public', presentation: 'summary_only' as Presentation },
        // The dependency epoch the current body sits at; an editBody or a Project change increments it, moving every earlier snapshot stale.
        epoch: 0,
        // The live, unused, unwithdrawn consents on the unit, each bound to the epoch it was recorded at.
        consents: [] as ModelConsent[],
        // The Owner's Member_Status; a Revoked Owner can give no proposal/request consent, only a consent_on_behalf.
        revoked: false,
      };

      /** Whether applying Public at `presentation` would present material the finding's own view does not already present (R23.17). */
      const widensNow = (presentation: Presentation): boolean => {
        if (model.applied.level !== 'public') return true; // Not_Published to Public always widens.
        // Already Public: Full_Content presents the claim beyond a Summary_Only view; anything else presents nothing new.
        return presentation === 'full_content' && model.applied.presentation === 'summary_only';
      };

      /**
       * A live consent covers an apply of Public at `presentation` only when it is not stale and was signed against the
       * exact resulting snapshot. The consent is bound to the canonical Public_View's SHA-256 (R23.23); a different
       * presentation produces a different view and a different hash, so coverage is an exact match on the consented
       * values here. A strictly narrower output never reaches this check at all: narrowing does not widen the view, so
       * the owner_consent gate asks for no consent for it (R23.17, R23.20), which `widensNow` captures.
       */
      const covering = (presentation: Presentation): ModelConsent | undefined => model.consents.find(
        (consent) => consent.epoch === model.epoch && consent.presentation === presentation,
      );

      const verifyGate = async (label: string): Promise<void> => {
        // Probe the gate at both presentations without committing: the preview issues a token exactly when a live
        // consent covers that widening, and refuses with the owner_consent reason naming the Owner otherwise.
        for (const presentation of ['full_content', 'summary_only'] as Presentation[]) {
          const result = await preview(widenBody(key, presentation));
          const cover = covering(presentation);
          if (!widensNow(presentation)) {
            // The finding's own view already presents at least this much, so the change widens nothing and needs no consent.
            expect(result.token, `${label}: non-widening preview token (${presentation})`).toBeTruthy();
            continue;
          }
          if (cover) {
            expect(result.failures, `${label}: covered preview has no failure (${presentation})`).toEqual([]);
            expect(result.token, `${label}: covered preview token (${presentation})`).toBeTruthy();
          } else {
            expect(result.token, `${label}: uncovered preview refused (${presentation})`).toBeNull();
            expect(
              result.failures.some((f) => f.reason === 'owner_consent' && f.memberId === world.ids.author),
              `${label}: owner_consent failure names the Owner (${presentation})`,
            ).toBe(true);
          }
        }
      };

      await verifyGate('start');
      for (const [step, current] of ops.entries()) {
        const label = `step ${step} ${JSON.stringify(current)}`;
        if (current.t === 'proposeApprove') {
          const response = await world.request('admin', 'POST', '/reviews/proposals', proposalBody(key, current.presentation));
          if (model.revoked) {
            // A Revoked Owner cannot authorize the proposal (consent.give is denied a Revoked Member), so the approval is refused;
            // the proposal itself is still created, but no consent is recorded.
            expect(response.status, `${label}: propose for revoked Owner`).toBe(201);
            const [id] = (await response.json<{ proposals: string[] }>()).proposals;
            const decided = await world.request('author', 'POST', `/reviews/proposals/${id}/decide`, { outcome: 'approved' });
            expect(decided.status, `${label}: revoked Owner approval refused`).toBe(403);
          } else {
            expect(response.status, `${label}: propose`).toBe(201);
            const [id] = (await response.json<{ proposals: string[] }>()).proposals;
            const before = await consentIds(item.id);
            const decided = await world.request('author', 'POST', `/reviews/proposals/${id}/decide`, { outcome: 'approved', note: 'Approved.' });
            expect(decided.status, `${label}: approve`).toBe(200);
            // The approval recorded exactly one new source=proposal consent, bound to the current dependency epoch.
            const added = [...await consentIds(item.id)].filter((cid) => !before.has(cid));
            expect(added.length, `${label}: proposal approval wrote one consent`).toBe(1);
            model.consents.push({ id: added[0]!, source: 'proposal', presentation: current.presentation, epoch: model.epoch });
          }
        } else if (current.t === 'proposeDecline') {
          if (model.revoked) continue; // a Revoked Owner cannot decide; skip to keep the step meaningful.
          const response = await world.request('admin', 'POST', '/reviews/proposals', proposalBody(key, 'full_content'));
          expect(response.status, `${label}: propose`).toBe(201);
          const [id] = (await response.json<{ proposals: string[] }>()).proposals;
          const declined = await world.request('author', 'POST', `/reviews/proposals/${id}/decide`, { outcome: 'declined', note: 'No.' });
          expect(declined.status, `${label}: decline`).toBe(200);
          // A decline records no consent.
        } else if (current.t === 'request') {
          const response = await world.request('author', 'POST', '/reviews/publication-requests', { unit: { key, level: 'public', presentation: current.presentation }, note: 'I consent.' });
          if (model.revoked) {
            // A Revoked Member cannot make a Publication_Request (review.request is denied), so none is recorded.
            expect(response.status, `${label}: request for revoked Owner`).toBe(403);
          } else {
            expect(response.status, `${label}: request`).toBe(201);
            const consentId = (await response.json<{ consent: string }>()).consent;
            model.consents.push({ id: consentId, source: 'request', presentation: current.presentation, epoch: model.epoch });
          }
        } else if (current.t === 'onBehalf') {
          if (!model.revoked) continue; // a consent on behalf is recorded only for a Revoked Consenting_Member (R23.22).
          const proposed = await world.request('admin', 'POST', '/dual-approvals', {
            action: 'consent_on_behalf', target: { key, values: { level: 'public', presentation: current.presentation } }, reason: 'Publish the departed Member\u2019s finding.',
          });
          expect(proposed.status, `${label}: propose consent_on_behalf`).toBe(201);
          const dualId = (await proposed.json<{ dualApproval: string }>()).dualApproval;
          const before = await consentIds(item.id);
          const approved = await world.request('colleague', 'POST', `/dual-approvals/${dualId}/approve`, { reason: 'Approved by a second Administrator.' });
          expect(approved.status, `${label}: approve consent_on_behalf`).toBe(200);
          expect((await approved.json<{ state: string }>()).state, `${label}: consent_on_behalf applied`).toBe('approved');
          const added = [...await consentIds(item.id)].filter((cid) => !before.has(cid));
          expect(added.length, `${label}: consent_on_behalf wrote one consent`).toBe(1);
          model.consents.push({ id: added[0]!, source: 'dual', presentation: current.presentation, epoch: model.epoch });
        } else if (current.t === 'withdraw') {
          const target = model.consents[0];
          if (target === undefined) continue; // nothing live to withdraw.
          const response = await world.request('author', 'POST', `/reviews/consents/${target.id}/withdraw`, {});
          if (model.revoked) {
            // A Revoked Member is refused at the session layer, so the Owner cannot withdraw while Revoked; the consent stays live.
            expect(response.status, `${label}: revoked Owner withdraw refused`).toBe(403);
          } else {
            expect(response.status, `${label}: withdraw`).toBe(200);
            model.consents = model.consents.filter((consent) => consent.id !== target.id);
          }
        } else if (current.t === 'editBody') {
          // An Administrator edits the finding's body. This moves the unit's updated_seq, a dependency the snapshot binds,
          // so every consent recorded at an earlier epoch is now stale and covers nothing (R23.24).
          const view = await world.view('admin', item.id);
          const edited = await world.edit('admin', item.id, { rev: view.rev, claim: rich(`An edited claim ${step}.`), mark: { mark: 'minor_edit' } });
          expect(edited.status, `${label}: edit body`).toBe(200);
          model.epoch += 1;
        } else if (current.t === 'applyProject') {
          // A Project's own level change never needs a Publication_Consent, so both applies go through with no consent
          // spent (R23.17). The change does touch the Project row, which the finding's consent snapshot binds as a
          // dependency, so moving it still invalidates every earlier consent (R23.23, R23.24): the epoch advances. Flip
          // the Project to Withheld and back to Public so the finding stays under a Public Project for the rest of the run.
          const token = (await preview({ units: [{ key: `p:${world.projectId}`, level: 'withheld', disclosureLine: LINE }] })).token;
          expect(token, `${label}: project withheld preview token`).toBeTruthy();
          expect((await applyToken(token!)).status, `${label}: project withheld apply`).toBe(200);
          const back = (await preview({ units: [{ key: `p:${world.projectId}`, level: 'public' }] })).token;
          expect(back, `${label}: project public preview token`).toBeTruthy();
          expect((await applyToken(back!)).status, `${label}: project public apply`).toBe(200);
          model.epoch += 1;
        } else {
          if (current.t === 'revoke') {
            await core().prepare('UPDATE members SET status = ?2 WHERE id = ?1').bind(world.ids.author, current.revoked ? 'revoked' : 'active').run();
            model.revoked = current.revoked;
          } else {
            // applyWiden: apply a widening to Public at the chosen presentation.
            const result = await preview(widenBody(key, current.presentation));
            const cover = covering(current.presentation);
            if (!widensNow(current.presentation)) {
              // The finding's own view already presents at least this much; the change widens nothing and applies with no consent spent.
              expect(result.token, `${label}: non-widening apply token`).toBeTruthy();
              expect((await applyToken(result.token!)).status, `${label}: non-widening apply`).toBe(200);
              // The apply writes exactly the applied values: a Summary_Only output over a Full_Content view narrows the presentation.
              model.applied = { level: 'public', presentation: current.presentation };
              // The apply touched the unit row, bumping its updated_seq, a dependency every other consent's snapshot binds (R23.24).
              model.epoch += 1;
            } else if (cover) {
              expect(result.token, `${label}: covered apply token`).toBeTruthy();
              const applied = await applyToken(result.token!);
              expect(applied.status, `${label}: covered apply`).toBe(200);
              // The apply spent exactly the covering consent (used_at), so it covers nothing further (R23.20).
              const used = await core().prepare('SELECT used_at AS used FROM publication_consents WHERE id = ?1').bind(cover.id).first<{ used: string | null }>();
              expect(used?.used, `${label}: consent spent`).not.toBeNull();
              model.consents = model.consents.filter((consent) => consent.id !== cover.id);
              model.applied = { level: 'public', presentation: current.presentation };
              // The widening wrote the unit row, bumping its updated_seq, so every other live consent's snapshot goes stale (R23.24).
              model.epoch += 1;
            } else {
              // No live consent covers this widening: the gate refuses it, naming the Owner, and nothing is applied.
              expect(result.token, `${label}: uncovered apply refused`).toBeNull();
              expect(result.failures.some((f) => f.reason === 'owner_consent' && f.memberId === world.ids.author), `${label}: owner_consent failure`).toBe(true);
            }
          }
        }

        // The live consents the model tracks are exactly those in the database, still unused and unwithdrawn.
        const live = (await liveConsents(item.id)).filter((row) => row.used === null && row.withdrawn === null);
        expect(new Set(live.map((row) => row.id)), `${label}: live consent set matches the model`).toEqual(new Set(model.consents.map((consent) => consent.id)));
        await verifyGate(label);
      }
    }), { numRuns: Math.min(FC_RUNS, 60) });
  }, 1000 * Math.min(FC_RUNS, 60));

  // The current-access case the design calls for: when the acting Administrator is the unit's own Consenting_Member, the
  // widening is their own, so R23.17 asks for no Publication_Consent and R23.13's own-work policy holds (R23.24).
  it('needs no Publication_Consent when the acting Administrator is the unit\u2019s own Consenting_Member', async () => {
    await resetRecords(core());
    (world as { projectId: typeof world.projectId }).projectId = await addProject(core(), world.ids.admin, world.at);
    // A finding owned by `admin`, so the Administrator applying the change is its Consenting_Member.
    const own = await world.created('admin', 'finding');
    await core().batch([
      core().prepare("UPDATE projects SET disclosure_level = 'public' WHERE id = ?1").bind(world.projectId),
      core().prepare("UPDATE research_items SET public_presentation = 'full_content' WHERE unit_id = ?1").bind(own.id),
    ]);
    // No consent exists, yet the widening previews cleanly and applies: the owner_consent gate never fires for the Owner's own work.
    const result = await preview(widenBody(unitKey(own.id), 'full_content'));
    expect(result.failures.some((f) => f.reason === 'owner_consent')).toBe(false);
    expect(result.token).toBeTruthy();
    expect((await applyToken(result.token!)).status).toBe(200);
    expect(await core().prepare('SELECT disclosure_level AS level FROM units WHERE id = ?1').bind(own.id).first<{ level: string }>()).toEqual({ level: 'public' });
    // No consent row was created or needed.
    expect(await core().prepare('SELECT count(*) AS n FROM publication_consents WHERE unit_id = ?1').bind(own.id).first<number>('n')).toBe(0);
  }, 120_000);

  // The maximum-encoded-input case the design calls for: a Publication_Proposal note is a bounded field, so the longest
  // allowed note is accepted and recovered exactly, and one code point more is refused with nothing stored.
  it('accepts the longest Publication_Proposal note and refuses one code point more, storing nothing', async () => {
    await resetRecords(core());
    (world as { projectId: typeof world.projectId }).projectId = await addProject(core(), world.ids.admin, world.at);
    const item = await world.created('author', 'finding');
    await core().batch([
      core().prepare("UPDATE projects SET disclosure_level = 'public' WHERE id = ?1").bind(world.projectId),
      core().prepare("UPDATE research_items SET public_presentation = 'full_content' WHERE unit_id = ?1").bind(item.id),
    ]);
    const key = unitKey(item.id);
    const limit = CONSENT_LIMITS.proposalNoteCodePoints;
    const atLimit = 'n'.repeat(limit);
    expect(cpLength(atLimit)).toBe(limit);

    const before = await core().prepare('SELECT count(*) AS n FROM review_requests').first<number>('n');
    const accepted = await world.request('admin', 'POST', '/reviews/proposals', { units: [{ key, level: 'public', presentation: 'full_content' }], note: atLimit });
    expect(accepted.status).toBe(201);
    const [id] = (await accepted.json<{ proposals: string[] }>()).proposals;
    // The note is stored exactly as submitted.
    const stored = await core().prepare('SELECT note FROM review_requests WHERE id = ?1').bind(id).first<{ note: string }>();
    expect(stored?.note).toBe(atLimit);
    expect((await core().prepare('SELECT count(*) AS n FROM review_requests').first<number>('n'))).toBe((before ?? 0) + 1);

    const tooLong = `${atLimit}n`;
    expect(cpLength(tooLong)).toBe(limit + 1);
    const refused = await world.request('admin', 'POST', '/reviews/proposals', { units: [{ key, level: 'public', presentation: 'full_content' }], note: tooLong });
    expect(refused.status).toBe(422);
    // Nothing stored: the over-long note never became a proposal.
    expect((await core().prepare('SELECT count(*) AS n FROM review_requests').first<number>('n'))).toBe((before ?? 0) + 1);
  }, 120_000);
});

/** A minimal valid Disclosure_Line for a Withheld unit, so a Project withheld change passes the disclosure_line gate. */
const LINE = { kindOfMaterial: 'Synthetic materials', date: { value: '2026', approx: false }, partyIds: [] };

/** Every consent id on a unit; the caller diffs this before and after an action to find the row it wrote (ULIDs share one test timestamp, so id order is not creation order). */
async function consentIds(unitId: string): Promise<Set<string>> {
  const rows = await core().prepare('SELECT id FROM publication_consents WHERE unit_id = ?1').bind(unitId).all<{ id: string }>();
  return new Set(rows.results.map((row) => row.id));
}
