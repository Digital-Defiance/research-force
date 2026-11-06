// Feature: research-collab-cms, Property 90: Moderation decisions are final, credited, and append-only
import { describe, expect, it } from 'vitest';
import { newULID } from '@researchforce/domain/identifiers';
import type { OutsideSubmissionType, ULID } from '@researchforce/domain/types';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { itemWorld, rich } from '../items';
import type { Who } from '../items';

/**
 * Property 90: Moderation decisions are final, credited, and append-only
 * (Validates: Requirements 32.4, 32.13, 32.16, 46.23).
 *
 * This property drives the real `POST /moderation/{id}/decide` route (apps/app/src/moderation/decide.ts) against the
 * local Workspace D1 over arbitrary sequences of decisions on one Outside_Submission. Each sequence is any number of
 * More_Information_Requested decisions (not final, each leaves the Outside_Submission open) followed by at most one
 * final Accept or Reject, and then one further decision that must be refused once a final one exists. The property
 * asserts the three halves of the requirement:
 *
 *   • R32.16 (final) — once an Accepted or Rejected (final) decision is recorded, any further decision is refused by
 *     the `decision_open` guard (409) and the refusal shows the recorded decision (its kind, Administrator, and time).
 *     More_Information_Requested is never final and never blocks a later final decision. At most one final decision is
 *     ever recorded.
 *   • R32.13 (append-only) — decision rows are never changed: every earlier row keeps its id, kind, Administrator,
 *     time, text, and created Items byte-for-byte across later attempts, and a refused second decision adds no row.
 *   • R32.4 (credited) — accepting Material creates the selected Items (at least one), each credited to the Submitter's
 *     name and affiliation, Not_Published and Unclassified, as one Submission by the accepting Administrator.
 *   • R46.23 — an accepted Removal_Request records the elements it names as changed and creates no Item.
 *
 * fast-check runs each property many times (FC_RUNS, at least 100) inside one `it`. Following p78/p88/p107, every run
 * first clears the tables it seeds (the Outside_Submission, its decisions, emails, response links, and the units and
 * Submissions an acceptance creates) and re-seeds the Outside_Submission, so no run inherits another run's state in the
 * shared Workers-pool D1. The Members, their sessions, and the Project are seeded once per `it` by `itemWorld`'s
 * `beforeEach`. D1-driven properties cap the run count to Math.min(FC_RUNS, 40), as p78 does.
 */

const world = itemWorld();

const admin = (): Who => 'admin';

/** Clear every per-run row this property seeds, so a fast-check run never inherits another run's state. */
async function resetPerRun(): Promise<void> {
  await world.core().batch([
    world.core().prepare('DELETE FROM outgoing_emails'),
    world.core().prepare('DELETE FROM response_links'),
    world.core().prepare('DELETE FROM moderation_decisions'),
    world.core().prepare('DELETE FROM outside_files'),
    world.core().prepare('DELETE FROM outside_submissions'),
    world.core().prepare('DELETE FROM submissions'),
    world.core().prepare('DELETE FROM research_items'),
    world.core().prepare('DELETE FROM findings'),
    world.core().prepare('DELETE FROM units'),
  ]);
}

/** Insert one Outside_Submission the way the rf-submit Worker stores it. */
let subCounter = 0;
async function outsideSubmission(type: OutsideSubmissionType, name: string, affiliation: string | null): Promise<ULID> {
  const id = newULID(world.at);
  subCounter += 1;
  const licence = type === 'removal_request' ? null : 'Synthetic Licence 1.0';
  await world.core().prepare(
    `INSERT INTO outside_submissions (id, reference, type, project_id, message, name, email, affiliation, page_ref, licence_agreed, received_at, state, rev, updated_seq)
     VALUES (?1, ?2, ?3, ?4, 'A synthetic submission message.', ?5, ?6, ?7, NULL, ?8, ?9, 'queued', 1, 0)`,
  ).bind(id, `RS-P90-${String(subCounter).padStart(5, '0')}`, type, world.projectId, name, `submitter${subCounter}@example.test`, affiliation, licence, world.at).run();
  return id;
}

/** A material Research_Item an acceptance may create, with a Log_Summary so it passes validation. */
const materialItem = () => ({
  unit: 'research_item' as const, kind: 'finding' as const,
  fields: { title: 'A finding from outside', claim: rich('A synthetic outside claim.'), scopeCaveat: rich('Synthetic caveat.'), logSummary: rich('Summary of the outside finding.') },
});

const decide = (id: string, body: unknown) => world.request(admin(), 'POST', `/moderation/${id}/decide`, body);

/** Every decision row for an Outside_Submission, oldest first, with the columns a decision records (R32.13). */
interface DecisionRow { readonly id: string; readonly kind: string; readonly adminId: string; readonly at: string; readonly text: string; readonly final: number; readonly createdUnitIds: string | null; readonly changedRefs: string | null }
async function decisionRows(id: string): Promise<DecisionRow[]> {
  const rows = await world.core().prepare(
    `SELECT id, kind, admin_id AS adminId, at, text, final, created_unit_ids AS createdUnitIds, changed_refs AS changedRefs
       FROM moderation_decisions WHERE outside_submission_id = ?1 ORDER BY at, id`,
  ).bind(id).all<DecisionRow>();
  return rows.results;
}

/** The body for a final decision, specialised per Submission_Type (an ordinary accept carries Items; a removal carries a statement). */
function finalBody(kind: 'accept' | 'reject', type: OutsideSubmissionType, run: number): unknown {
  if (type === 'removal_request') {
    const changed = [{ kind: 'item' as const, reference: `RI-${String(run).padStart(6, '0')}` }];
    return kind === 'accept'
      ? { decision: 'removal_accepted', confirm: true, statement: `Removed the named record ${run}.`, changed }
      : { decision: 'removal_rejected', confirm: true, statement: `Declined the removal ${run}.`, changed };
  }
  return kind === 'accept'
    ? { decision: 'accepted', confirm: true, text: `Accepted with thanks ${run}.`, items: [materialItem()] }
    : { decision: 'rejected', confirm: true, text: `Out of scope ${run}.` };
}

describe('Property 90 (R32.16, R32.13, R32.4, R46.23): moderation decisions are final, credited, and append-only', () => {
  it('records at most one final decision, refuses later ones showing the recorded decision, and never changes an earlier row', async () => {
    let run = 0;
    await fc.assert(fc.asyncProperty(
      fc.record({
        type: fc.constantFrom<OutsideSubmissionType>('material', 'removal_request'),
        name: fc.constantFrom('Grace Hopper', 'Ada Lovelace', 'Alan Turing'),
        affiliation: fc.option(fc.constantFrom('Navy', 'Analytical Society', 'Bletchley'), { nil: null }),
        // Any number of non-final More_Information_Requested decisions before the final one.
        infoRequests: fc.nat({ max: 3 }),
        finalKind: fc.constantFrom<'accept' | 'reject'>('accept', 'reject'),
        // A further decision attempted after the final one, which must be refused.
        extraKind: fc.constantFrom<'accept' | 'reject'>('accept', 'reject'),
      }),
      async (scenario) => {
        run += 1;
        await resetPerRun();
        const id = await outsideSubmission(scenario.type, scenario.name, scenario.affiliation);

        // Any number of More_Information_Requested decisions: none is final, each leaves the Outside_Submission open
        // to a later final decision (R32.16), and each appends exactly one row (R32.13).
        for (let i = 0; i < scenario.infoRequests; i++) {
          const response = await decide(id, { decision: 'more_information_requested', confirm: true, text: `Could you send more ${run}.${i}?` });
          expect(response.status).toBe(200);
          const body = await response.json<{ applied?: { kind: string } }>();
          expect(body.applied?.kind).toBe('more_information_requested');
        }
        const afterInfo = await decisionRows(id);
        expect(afterInfo).toHaveLength(scenario.infoRequests);
        expect(afterInfo.every((row) => row.final === 0)).toBe(true);
        // No final decision exists yet, so none is recorded (R32.16).
        expect(afterInfo.some((row) => row.final === 1)).toBe(false);

        // The single final decision applies (R32.16).
        const finalResponse = await decide(id, finalBody(scenario.finalKind, scenario.type, run));
        expect(finalResponse.status).toBe(200);
        const finalResult = await finalResponse.json<{ applied?: { decisionId: string; kind: string; createdUnitIds: string[] } }>();
        const expectedFinalKind = scenario.finalKind === 'accept' ? 'accepted' : 'rejected';
        expect(finalResult.applied?.kind).toBe(expectedFinalKind);
        const finalDecisionId = finalResult.applied!.decisionId;

        const afterFinal = await decisionRows(id);
        expect(afterFinal).toHaveLength(scenario.infoRequests + 1);
        // Exactly one final decision is ever recorded (R32.16).
        expect(afterFinal.filter((row) => row.final === 1)).toHaveLength(1);
        const finalRow = afterFinal.find((row) => row.final === 1)!;
        expect(finalRow.id).toBe(finalDecisionId);
        expect(finalRow.kind).toBe(expectedFinalKind);
        expect(finalRow.adminId).toBe(world.ids.admin);

        // Append-only: every row that existed before the final decision is still present, matched by id, and
        // byte-for-byte unchanged (R32.13). Rows are matched by id, not position, because decisions recorded at the
        // same instant sort by ULID rather than by insertion order.
        const afterFinalById = new Map(afterFinal.map((row) => [row.id, row]));
        for (const before of afterInfo) {
          expect(afterFinalById.get(before.id)).toEqual(before);
        }

        // R32.4 — an acceptance of Material creates the Item credited to the Submitter, Not_Published, Unclassified,
        // as one Submission by the accepting Administrator; R46.23 — an accepted Removal_Request creates no Item.
        if (scenario.finalKind === 'accept' && scenario.type === 'material') {
          expect(finalResult.applied!.createdUnitIds).toHaveLength(1);
          expect(JSON.parse(finalRow.createdUnitIds!)).toEqual(finalResult.applied!.createdUnitIds);
          const itemId = finalResult.applied!.createdUnitIds[0]!;
          const item = await world.view(admin(), itemId);
          const expectedCredit = scenario.affiliation === null
            ? [{ outside: { name: scenario.name } }]
            : [{ outside: { name: scenario.name, affiliation: scenario.affiliation } }];
          expect(item.credit).toEqual(expectedCredit);
          expect((item.disclosure as { level: string }).level).toBe('not_published');
          const row = await world.core().prepare(
            `SELECT u.classification_state AS classification, s.member_id AS memberId, s.completed_at AS completedAt
               FROM units u JOIN submissions s ON s.id = u.submission_id WHERE u.id = ?1`,
          ).bind(itemId).first<{ classification: string; memberId: string; completedAt: string | null }>();
          expect(row?.classification).toBe('unclassified');
          expect(row?.memberId).toBe(world.ids.admin); // one Submission by the accepting Administrator
          expect(row?.completedAt).not.toBeNull();
          // Exactly one Submission backs the acceptance's Items.
          const subs = await world.core().prepare(
            'SELECT DISTINCT submission_id AS id FROM units WHERE id IN (SELECT value FROM json_each(?1))',
          ).bind(JSON.stringify(finalResult.applied!.createdUnitIds)).all<{ id: string }>();
          expect(subs.results).toHaveLength(1);
        } else if (scenario.finalKind === 'accept' && scenario.type === 'removal_request') {
          // R46.23 — the accepted Removal_Request records what it named as changed and creates no Item.
          expect(finalResult.applied!.createdUnitIds).toHaveLength(0);
          expect(finalRow.createdUnitIds).toBeNull();
          expect(JSON.parse(finalRow.changedRefs!)).toEqual([{ kind: 'item', reference: `RI-${String(run).padStart(6, '0')}` }]);
          expect(await world.core().prepare("SELECT count(*) AS n FROM units WHERE unit_type = 'research_item'").first<number>('n')).toBe(0);
        } else {
          // A rejection creates no Item at all.
          expect(finalResult.applied!.createdUnitIds).toHaveLength(0);
          expect(await world.core().prepare("SELECT count(*) AS n FROM units WHERE unit_type = 'research_item'").first<number>('n')).toBe(0);
        }

        // A decision after the final one is refused with the recorded decision shown, and adds no row (R32.16, R32.13).
        const extraResponse = await decide(id, finalBody(scenario.extraKind, scenario.type, run));
        expect(extraResponse.status).toBe(409);
        const refusal = await extraResponse.json<{ error: string; details?: { rule?: string; decision?: { kind: string; admin: { id: string }; at: string } } }>();
        expect(refusal.details?.rule).toBe('decision_open');
        expect(refusal.details?.decision?.kind).toBe(expectedFinalKind);
        expect(refusal.details?.decision?.admin.id).toBe(world.ids.admin);
        expect(refusal.details?.decision?.at).toBe(finalRow.at);

        // No row was added, and every recorded row is still byte-for-byte unchanged (R32.13).
        const afterExtra = await decisionRows(id);
        expect(afterExtra).toEqual(afterFinal);
      },
    ), { numRuns: Math.min(FC_RUNS, 40) });
  }, 240_000);
});
