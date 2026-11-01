// Feature: research-collab-cms, Property 103: Confidentiality_Holds block publication until lifted or overridden
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
import { addElement, addProject, addSubmissionRow, resetRecords } from '../units';

/**
 * Validates R48.1, R48.2, R48.3, R48.4, R48.6, R48.7, R48.10 against an independent model of one finding owned by
 * `admin`, with one Entry_Section under it, in a Public Full_Content Project. The finding is owned by the acting
 * Administrator so the owner_consent gate of Requirement 23 never stands in for the hold gate under test — a widening of
 * the Administrator's own work needs no Publication_Consent, leaving the Confidentiality_Hold the only thing that can
 * block it. A random sequence of operations drives the world and a model built beside it from the acceptance criteria
 * alone: `author`, `colleague`, or `admin` places a Confidentiality_Hold on the finding (the subtree's single Item), the
 * placer or the Owner lifts a hold, another Member attempts a lift, two Administrators override a hold through a
 * hold_override Dual_Approval, the Administrator attempts to widen the finding or its Entry_Section back to Public, and a
 * prior save sets the own Disclosure_Level of a covered unit to Public or Withheld as fault injection between holds.
 *
 * After every step the model asserts through the normal preview/apply API: placing a hold resets exactly the covered
 * subtree's own-Public or own-Withheld units to Not_Published and records the hold with its note, leaving any already
 * Not_Published unit untouched (R48.1, R48.3); at most one active hold per Member per Item, while a second Member may hold
 * the same Item (R48.1); while ANY hold that is neither lifted nor overridden covers a unit, a widening of that unit to
 * Public is refused by the hold gate naming each covering hold, so the preview issues no token and the apply changes
 * nothing (R48.2, R48.4); a lift by the placer or the Owner frees that one hold and changes no Disclosure_Level, while any
 * other Member's lift is refused with an authorization error and keeps the hold (R48.6, R48.7, R48.10); a hold_override
 * Dual_Approval frees that one hold with no level change (R48.9, reached here only to clear the gate); and a widening
 * becomes possible again exactly once every hold covering the unit is lifted or overridden (R48.2, R48.4). The companion
 * current-access and maximum-encoded-input cases pin the Owner's own-item lift and the longest allowed hold note.
 */

const SECRET = 'synthetic-preview-hmac-secret-for-tests';
const LICENCE = 'Synthetic Content Licence 1.0';
const world = itemWorld(undefined, { contentLicence: LICENCE });

/**
 * `colleague` is promoted to a second Administrator so a hold_override Dual_Approval has a proposer and a distinct second
 * approver, and every Member holds a Licence_Agreement for the current Content_Licence so the licence gate never stands in
 * for the hold gate under test when an Administrator widens the Owner's finding.
 */
beforeEach(async () => {
  await world.core().batch([
    world.core().prepare('UPDATE members SET role_id = ?1 WHERE id = ?2').bind(ROLE_IDS.administrator, world.ids.colleague),
    world.core().prepare('UPDATE profiles SET licence_name = ?1, licence_given_on = ?2 WHERE member_id IN (?3, ?4, ?5)')
      .bind(LICENCE, '2026-10-27', world.ids.admin, world.ids.colleague, world.ids.author),
  ]);
});

const core = () => world.bindings.RF_CORE;

/** The Members who act in the run: the Owner, a second Administrator, and the acting Administrator who widens. */
const PLACERS: readonly Who[] = ['author', 'colleague', 'admin'];
/** The two covered units a widening targets: the finding itself and its Entry_Section. */
type Covered = 'item' | 'section';
/** The own Disclosure_Level a fault injection sets a covered unit to between holds. */
type OwnLevel = 'public' | 'withheld' | 'not_published';

/**
 * An operation the model and world run in lockstep. Placing, lifting, and overriding drive the active-hold set; a widen
 * probes the hold gate decisively; a setLevel is fault injection that changes a unit's own Disclosure_Level directly, as
 * a prior save would have, so a later hold has own-Public or own-Withheld units to reset.
 */
type Op =
  | { t: 'place'; who: Who } // a Member places a hold on the finding, covering the whole subtree.
  | { t: 'lift'; who: Who; which: number } // a Member lifts the `which`-th placed hold (by placer or Owner; any other is refused).
  | { t: 'override'; which: number } // two Administrators override the `which`-th placed hold through a hold_override Dual_Approval.
  | { t: 'widen'; unit: Covered } // the acting Administrator tries to widen a covered unit back to Public.
  | { t: 'setLevel'; unit: Covered; level: OwnLevel }; // fault injection: set a covered unit's own Disclosure_Level.

const op: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ t: fc.constant('place' as const), who: fc.constantFrom(...PLACERS) }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('lift' as const), who: fc.constantFrom(...PLACERS), which: fc.nat({ max: 3 }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('override' as const), which: fc.nat({ max: 3 }) }) },
  { weight: 5, arbitrary: fc.record({ t: fc.constant('widen' as const), unit: fc.constantFrom<Covered>('item', 'section') }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('setLevel' as const), unit: fc.constantFrom<Covered>('item', 'section'), level: fc.constantFrom<OwnLevel>('public', 'withheld', 'not_published') }) },
);

/** A finding owned by `admin` with one Entry_Section under it, in a Public Full_Content Project, with its creation outbox and events cleared. */
async function subtree(owner: Who = 'admin'): Promise<{ item: ItemView; section: string }> {
  await resetRecords(core());
  (world as { projectId: typeof world.projectId }).projectId = await addProject(core(), world.ids.admin, world.at);
  const item = await world.created(owner, 'finding');
  // A single Entry_Section under the finding, owned by the same Member, so the hold's subtree spans two units at two depths.
  const submissionId = await addSubmissionRow(core(), world.ids[owner], world.at);
  const element = await addElement(core(), { projectId: world.projectId, ownerId: world.ids[owner], submissionId, now: world.at }, 'entry_section', item.id);
  await core().batch([
    core().prepare("UPDATE projects SET disclosure_level = 'public' WHERE id = ?1").bind(world.projectId),
    core().prepare("UPDATE research_items SET public_presentation = 'full_content' WHERE unit_id = ?1").bind(item.id),
    core().prepare('DELETE FROM outbox'),
    core().prepare('DELETE FROM notification_events'),
  ]);
  return { item, section: element.id };
}

/** A minimal valid Disclosure_Line, so a Withheld unit satisfies the `units_withheld_line` check. */
const LINE = { kindOfMaterial: 'Synthetic materials', date: { value: '2026', approx: false }, partyIds: [] };

/**
 * Set a unit's own Disclosure_Level directly, as a prior save would have. A Withheld unit needs a Disclosure_Line;
 * anything else clears it, so the row always satisfies the `units_withheld_line` check.
 */
async function setLevel(unitId: string, level: OwnLevel): Promise<void> {
  await core().prepare('UPDATE units SET disclosure_level = ?2, disclosure_line = ?3 WHERE id = ?1')
    .bind(unitId, level, level === 'withheld' ? JSON.stringify(LINE) : null).run();
}
/** A unit's own Disclosure_Level, read straight from the row. */
async function levelOf(unitId: string): Promise<string> {
  return (await core().prepare('SELECT disclosure_level AS level FROM units WHERE id = ?1').bind(unitId).first<{ level: string }>())!.level;
}

async function holdPreview(who: Who, id: string): Promise<HoldPreview> {
  const response = await world.request(who, 'POST', `/items/${id}/holds/preview`, {});
  if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return response.json<HoldPreview>();
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

const rows = async <T>(query: string, ...binds: unknown[]): Promise<T[]> => (await core().prepare(query).bind(...binds).all<T>()).results;

/** The active holds (neither lifted nor overridden) on the Item, oldest first, with their placers and notes. */
async function activeHolds(itemId: string): Promise<{ id: string; member: string; note: string }[]> {
  return rows<{ id: string; member: string; note: string }>(
    'SELECT id, member_id AS member, note FROM confidentiality_holds WHERE unit_id = ?1 AND lifted_at IS NULL AND override_id IS NULL ORDER BY id',
    itemId,
  );
}

/** The model's record of one active hold: its database id and the Member who placed it, which decides who may lift it. */
interface ModelHold {
  readonly id: string;
  readonly placedBy: Who;
}

describe('Property 103: Confidentiality_Holds block publication until lifted or overridden', () => {
  it('resets exactly the covered subtree on placement, blocks a widening while any hold covers the unit, frees it only by the placer, Owner, or an override, and keeps every level fixed', async () => {
    await fc.assert(fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 16 }), async (ops) => {
      // The finding is owned by `admin`, the acting Administrator, so widening its subtree needs no Publication_Consent.
      const owner: Who = 'admin';
      const { item, section } = await subtree(owner);
      const keyFor: Record<Covered, string> = { item: unitKey(item.id), section: unitKey(section) };
      const idFor: Record<Covered, string> = { item: item.id, section };

      // The independent model, built from the acceptance criteria alone.
      const model = {
        // Each covered unit's own Disclosure_Level, as the rows hold it. Both start Not_Published (a fresh item).
        own: { item: 'not_published' as OwnLevel, section: 'not_published' as OwnLevel },
        // The active holds (neither lifted nor overridden) on the Item, in placement order, each tagged with its placer.
        holds: [] as ModelHold[],
      };

      /** A covered unit is held exactly when at least one active hold is on the Item: one hold covers the whole subtree (R48.2). */
      const held = (): boolean => model.holds.length > 0;

      /** Whether widening `unit` to Public would add material to its Public_View (R48.4): only a unit not already own-Public widens. */
      const widens = (unit: Covered): boolean => model.own[unit] !== 'public';

      const verifyGate = async (label: string): Promise<void> => {
        // Probe the gate for each covered unit without committing: a widening is refused with the hold reason exactly while a
        // hold covers the subtree, and otherwise issues a token (or needs no change when the unit is already Public).
        for (const unit of ['item', 'section'] as Covered[]) {
          const result = await preview({ units: [{ key: keyFor[unit], level: 'public' }] });
          if (!widens(unit)) {
            // The unit is already own-Public, so a request to set it Public widens nothing and the hold gate does not fire.
            expect(result.failures.some((f) => f.reason === 'hold'), `${label}: non-widening has no hold failure (${unit})`).toBe(false);
            continue;
          }
          if (held()) {
            expect(result.token, `${label}: held widening refused (${unit})`).toBeNull();
            const holdFailure = result.failures.find((f) => f.reason === 'hold');
            expect(holdFailure, `${label}: hold failure present (${unit})`).toBeTruthy();
            // R48.4/R48.5: the refusal lists every covering hold's note, one line per active hold on the subtree.
            expect(holdFailure!.details?.length, `${label}: one detail per covering hold (${unit})`).toBe(model.holds.length);
            expect(
              result.holds.map((hold) => hold.id).sort(),
              `${label}: preview lists each covering hold (${unit})`,
            ).toEqual(model.holds.map((hold) => hold.id).sort());
          } else {
            expect(result.failures.some((f) => f.reason === 'hold'), `${label}: free widening has no hold failure (${unit})`).toBe(false);
            expect(result.token, `${label}: free widening issues a token (${unit})`).toBeTruthy();
          }
        }
      };

      await verifyGate('start');
      for (const [step, current] of ops.entries()) {
        const label = `step ${step} ${JSON.stringify(current)}`;
        if (current.t === 'place') {
          // The preview lists exactly the covered subtree units whose own level is Public or Withheld; the place resets each.
          const shown = await holdPreview(current.who, item.id);
          const expectedResets = (['item', 'section'] as Covered[]).filter((unit) => model.own[unit] !== 'not_published');
          expect(
            new Set(shown.resets.map((reset) => reset.unitId)),
            `${label}: preview resets exactly the own-Public/Withheld subtree units`,
          ).toEqual(new Set(expectedResets.map((unit) => idFor[unit])));

          const body = { note: `Held at step ${step}.`, ...(shown.confirmation === null ? {} : { confirmation: shown.confirmation }) };
          const response = await world.request(current.who, 'POST', `/items/${item.id}/holds`, body);
          if (model.holds.some((hold) => hold.placedBy === current.who)) {
            // R48.1: at most one active hold per Member per Item; a second active hold by the same Member is refused.
            expect(response.status, `${label}: second active hold by the same Member refused`).toBe(422);
          } else {
            expect(response.status, `${label}: place accepted`).toBe(201);
            const holdId = (await response.json<{ hold: string }>()).hold;
            model.holds.push({ id: holdId, placedBy: current.who });
            // R48.3: placing resets each own-Public/Withheld covered unit to Not_Published; an already Not_Published unit is untouched.
            for (const unit of expectedResets) model.own[unit] = 'not_published';
          }
        } else if (current.t === 'setLevel') {
          // Fault injection: a prior save set a covered unit's own Disclosure_Level. A hold reset would have left it
          // Not_Published, so this only takes effect between holds; the model mirrors the row either way.
          await setLevel(idFor[current.unit], current.level);
          model.own[current.unit] = current.level;
        } else if (current.t === 'lift') {
          const target = model.holds[current.which];
          if (target === undefined) continue; // no such active hold to lift.
          const response = await world.request(current.who, 'POST', `/items/${item.id}/holds/${target.id}/lift`, { note: 'Lifted.' });
          // R48.6/R48.10: only the Member who placed the hold or the Item's Owner may lift it.
          if (current.who === target.placedBy || current.who === owner) {
            expect(response.status, `${label}: placer or Owner lift accepted`).toBe(200);
            model.holds = model.holds.filter((hold) => hold.id !== target.id);
          } else {
            expect(response.status, `${label}: other Member's lift refused`).toBe(403);
            expect((await response.json<{ details: { rule: string } }>()).details.rule, `${label}: authorization rule`).toBe('not_placer_or_owner');
          }
        } else if (current.t === 'override') {
          const target = model.holds[current.which];
          if (target === undefined) continue; // no such active hold to override.
          // A hold_override Dual_Approval: `admin` proposes, the distinct second Administrator `colleague` approves. When the
          // proposer placed the hold we still have two distinct Administrators here, so the override always applies.
          const proposer: Who = 'admin';
          const approver: Who = 'colleague';
          const proposeResp = await world.request(proposer, 'POST', '/dual-approvals', {
            action: 'hold_override', target: { itemId: item.id, holdId: target.id }, reason: `Override at step ${step}.`,
          });
          expect(proposeResp.status, `${label}: propose hold_override`).toBe(201);
          const dualId = (await proposeResp.json<{ dualApproval: string }>()).dualApproval;
          const approveResp = await world.request(approver, 'POST', `/dual-approvals/${dualId}/approve`, { reason: 'Approved by a second Administrator.' });
          expect(approveResp.status, `${label}: approve hold_override`).toBe(200);
          expect((await approveResp.json<{ state: string }>()).state, `${label}: override applied`).toBe('approved');
          model.holds = model.holds.filter((hold) => hold.id !== target.id);
        } else {
          // widen: try to set the covered unit Public. Held, the gate refuses and the apply changes nothing; free, it applies.
          const result = await preview({ units: [{ key: keyFor[current.unit], level: 'public' }] });
          if (!widens(current.unit)) {
            // Already own-Public: the change widens nothing. The gate does not fire, and if a token issues the apply is a no-op on the level.
            expect(result.failures.some((f) => f.reason === 'hold'), `${label}: non-widening has no hold failure`).toBe(false);
          } else if (held()) {
            expect(result.token, `${label}: held widening refused`).toBeNull();
            expect(result.failures.some((f) => f.reason === 'hold'), `${label}: hold failure present`).toBe(true);
            // R48.7: nothing the hold reset is published; the unit's own level is unchanged by the refused widening.
            expect(await levelOf(idFor[current.unit]), `${label}: refused widening changed no level`).toBe(model.own[current.unit]);
          } else {
            expect(result.token, `${label}: free widening issues a token`).toBeTruthy();
            expect((await applyToken(result.token!)).status, `${label}: free widening applies`).toBe(200);
            model.own[current.unit] = 'public';
          }
        }

        // The active holds the model tracks are exactly those the database holds active, in the same set.
        const live = await activeHolds(item.id);
        expect(new Set(live.map((row) => row.id)), `${label}: active hold set matches the model`).toEqual(new Set(model.holds.map((hold) => hold.id)));
        // Each covered unit's own Disclosure_Level matches the model: holds reset it, lifts and overrides never change it (R48.7).
        for (const unit of ['item', 'section'] as Covered[]) {
          expect(await levelOf(idFor[unit]), `${label}: ${unit} own level matches the model`).toBe(model.own[unit]);
        }
        await verifyGate(label);
      }
    }), { numRuns: Math.min(FC_RUNS, 50) });
  }, 1000 * Math.min(FC_RUNS, 50));

  // The current-access case the design calls for: the Owner is always allowed to lift a hold on their own Item, whoever
  // placed it, so the Owner's own-item lift always frees the hold with no Disclosure_Level change (R48.6, R48.7).
  it('lets the Item Owner lift a hold another Member placed on their own Item, changing no level', async () => {
    // The finding is owned by `admin`; `author` is another Member who can read it.
    const { item } = await subtree('admin');
    await setLevel(item.id, 'public');
    // `author` (another Member) places the hold, resetting the finding to Not_Published.
    const shown = await holdPreview('author', item.id);
    const place = await world.request('author', 'POST', `/items/${item.id}/holds`, { note: 'A note.', ...(shown.confirmation === null ? {} : { confirmation: shown.confirmation }) });
    expect(place.status).toBe(201);
    const holdId = (await place.json<{ hold: string }>()).hold;
    // The hold reset the finding to Not_Published; the Owner's lift must not publish it again (R48.7).
    expect(await levelOf(item.id)).toBe('not_published');
    // The Item's Owner (`admin`), though not the placer, may lift it (R48.6).
    const lift = await world.request('admin', 'POST', `/items/${item.id}/holds/${holdId}/lift`, {});
    expect(lift.status).toBe(200);
    expect(await activeHolds(item.id)).toEqual([]);
    expect(await levelOf(item.id)).toBe('not_published');
  }, 120_000);

  // The maximum-encoded-input case the design calls for: a hold note is a bounded field, so the longest allowed note is
  // accepted and recovered exactly, and one code point more is refused with no hold stored.
  it('accepts the longest Confidentiality_Hold note and refuses one code point more, storing nothing', async () => {
    const { item } = await subtree();
    const limit = CONSENT_LIMITS.holdNoteCodePoints;
    const atLimit = 'n'.repeat(limit);
    expect(cpLength(atLimit)).toBe(limit);

    const shown = await holdPreview('author', item.id);
    const confirm = shown.confirmation === null ? {} : { confirmation: shown.confirmation };
    const accepted = await world.request('author', 'POST', `/items/${item.id}/holds`, { note: atLimit, ...confirm });
    expect(accepted.status).toBe(201);
    const holdId = (await accepted.json<{ hold: string }>()).hold;
    // The note is stored exactly as submitted.
    expect(await activeHolds(item.id)).toEqual([{ id: holdId, member: world.ids.author, note: atLimit }]);

    // One code point more is refused, and no second hold is stored. The author already holds this Item, so a fresh Member places it.
    const tooLong = `${atLimit}n`;
    expect(cpLength(tooLong)).toBe(limit + 1);
    const refused = await world.request('admin', 'POST', `/items/${item.id}/holds`, { note: tooLong, ...confirm });
    expect(refused.status).toBe(422);
    expect((await activeHolds(item.id)).map((hold) => hold.id)).toEqual([holdId]);
  }, 120_000);
});
