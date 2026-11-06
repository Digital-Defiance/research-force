// Feature: research-collab-cms, Property 48: Review_Requests follow their state machine
import { describe, expect, it } from 'vitest';
import { newULID } from '@researchforce/domain/identifiers';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { asULID } from '@researchforce/domain/types';
import type { ULID } from '@researchforce/domain/types';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { SPECIALTY } from '../api';
import { itemWorld } from '../items';
import type { ItemView, Who } from '../items';
import { addProject, resetRecords } from '../units';

/**
 * Property 48: Review_Requests follow their state machine.
 *
 * **Validates: Requirements 17.3, 17.4, 17.5, 17.8, 17.9, 17.10**
 *
 * The Review_Service creates every Review_Request in the Needs_Review state, holds it in exactly one of
 * {Needs_Review, Reviewed}, and never changes a Reviewed request back (R17.3). An Eligible_Reviewer — an active
 * Member other than the requester who can read the Research_Item and is named, holds a named Specialty, or is in a
 * named Role (R17.4) — marks a Needs_Review request Reviewed, which records the reviewing Member, the review time,
 * and an optional note (R17.5). The review queue shows a Member exactly the Needs_Review requests for which it is
 * currently an Eligible_Reviewer, oldest first (R17.8). A request is created only when it would have an
 * Eligible_Reviewer, else refused with "no active Member other than you" (R17.9). An attempt to mark a request
 * Reviewed by a non-Eligible_Reviewer, or when it is already Reviewed, is refused naming which condition applies and
 * leaves the state, reviewing Member, review time, and review note unchanged; a Publication_Request is completed only
 * by applying or declining it, not through the ordinary complete path, each refusal naming its reason (R17.10).
 *
 * This is a D1-backed state machine (the `review_requests` table in rf-core), so this property drives the REAL
 * createReview / completeReview / reviewQueue handlers through the Worker API against the real D1 database across
 * randomized sequences of create/complete actions and randomized actor/addressee/eligibility configurations, and
 * checks the model-vs-database agreement after every action.
 *
 * Following the p88 pattern, every fast-check run FIRST resets the seeded records (the named D1 is shared across runs
 * in the Workers pool, so a run that did not reset would inherit the prior run's review_requests rows). Following the
 * p78 convention, the D1-driven property is capped at Math.min(FC_RUNS, 40).
 */

const world = itemWorld();
const UNKNOWN = asULID('01J00000000000000000000000');

/** The three signed-in Members the world seeds; `admin` holds the Administrator Role, the others Contributor. */
const PEOPLE = ['author', 'colleague', 'admin'] as const;

/**
 * How a Review_Request is addressed. Every seeded Member holds the one seeded SPECIALTY and a Profile, so:
 *   - `member` names a specific Member, so only that Member (if otherwise eligible) can review;
 *   - `specialty` names the seeded Specialty, so every active Member other than the requester who can read is eligible;
 *   - `role` names the Administrator or Contributor Role, so every active reader in that Role (not the requester) is.
 */
type Addressing =
  | { readonly kind: 'member'; readonly who: Who }
  | { readonly kind: 'specialty' }
  | { readonly kind: 'role'; readonly role: 'administrator' | 'contributor' };

interface CreateAction {
  readonly t: 'create';
  readonly requester: Who;
  readonly addressing: Addressing;
  /** Whether the target Item is Restricted; when so, only its Owner, Administrators, and its Access_List can read it. */
  readonly restricted: boolean;
  /** Members placed on a Restricted Item's Access_List (the requester is always an implicit reader as Owner). */
  readonly list: readonly Who[];
  readonly note: boolean;
}
interface CompleteAction {
  readonly t: 'complete';
  readonly actor: Who;
  /** Index into the created requests, taken modulo the count so it always names an existing request when any exist. */
  readonly which: number;
  readonly note: boolean;
}
type Action = CreateAction | CompleteAction;

const who = fc.constantFrom<Who>(...PEOPLE);
const addressingArb: fc.Arbitrary<Addressing> = fc.oneof(
  fc.record({ kind: fc.constant('member' as const), who }),
  fc.record({ kind: fc.constant('specialty' as const) }),
  fc.record({ kind: fc.constant('role' as const), role: fc.constantFrom('administrator' as const, 'contributor' as const) }),
);
const actionArb: fc.Arbitrary<Action> = fc.oneof(
  { weight: 2, arbitrary: fc.record({ t: fc.constant('create' as const), requester: who, addressing: addressingArb, restricted: fc.boolean(), list: fc.subarray([...PEOPLE]), note: fc.boolean() }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('complete' as const), actor: who, which: fc.nat({ max: 20 }), note: fc.boolean() }) },
);

/** The Role each seeded Member holds; the world gives `admin` the Administrator Role and the rest Contributor. */
const ROLE_OF: Record<Who, 'administrator' | 'contributor'> = { author: 'contributor', colleague: 'contributor', admin: 'administrator' };

interface Model {
  readonly id: ULID;
  readonly requester: Who;
  readonly addressing: Addressing;
  readonly rootId: ULID;
  readonly readers: ReadonlySet<Who>;
  readonly createdAt: string;
  state: 'needs_review' | 'reviewed';
  reviewer?: Who;
  reviewedAt?: string;
  reviewNote?: string | null;
}

describe('Property 48 (R17.3, R17.4, R17.5, R17.8, R17.9, R17.10): Review_Requests follow their state machine', () => {
  it('creates only with an Eligible_Reviewer, completes once by an Eligible_Reviewer, and queues exactly the open requests each Member may review', async () => {
    const core = () => world.bindings.RF_CORE;
    const ids = () => world.ids;

    await fc.assert(
      fc.asyncProperty(fc.array(actionArb, { minLength: 1, maxLength: 12 }), async (actions) => {
        // p88: reset the shared D1 records at the START of the run so no prior run's review_requests leak in. The
        // reset also clears the Project the world seeded in beforeEach, so create a fresh one for this run's Items.
        await resetRecords(core());
        const projectId = await addProject(core(), ids().admin, world.at);

        const requests: Model[] = [];

        /**
         * Whether `member` is an addressee of this request who is active and not the requester, by name, held Specialty,
         * or Role — the permission-level predicate the complete handler checks first with `can('review.complete')`,
         * which does NOT consider readability (R17.4).
         */
        const addressed = (model: Model, member: Who): boolean => {
          if (member === model.requester) return false; // not the requester (R17.4)
          switch (model.addressing.kind) {
            case 'member': return member === model.addressing.who; // named Member (R17.4)
            case 'specialty': return true; // every seeded Member holds the one seeded Specialty (R17.4)
            case 'role': return ROLE_OF[member] === model.addressing.role; // in the named Role (R17.4)
          }
        };
        /** A full Eligible_Reviewer: addressed AND able to read the Research_Item (R17.4, R47.5). */
        const eligible = (model: Model, member: Who): boolean => addressed(model, member) && model.readers.has(member);
        const anyEligible = (model: Model): boolean => PEOPLE.some((member) => eligible(model, member));

        /** The addressee payload the create handler expects for this addressing. */
        const addresseeBody = (addressing: Addressing): Record<string, unknown> => {
          switch (addressing.kind) {
            case 'member': return { memberIds: [ids()[addressing.who]] };
            case 'specialty': return { specialtyIds: [SPECIALTY] };
            case 'role': return { roleIds: [ROLE_IDS[addressing.role]] };
          }
        };

        const expectQueues = async () => {
          for (const member of PEOPLE) {
            // R17.8: the queue is exactly the Needs_Review requests this Member is currently eligible for, oldest first.
            const expected = requests
              .filter((model) => model.state === 'needs_review' && eligible(model, member))
              .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1))
              .map((model) => model.id);
            const response = await world.request(member, 'GET', '/reviews/queue');
            expect(response.status).toBe(200);
            const queue = (await response.json<{ reviews: { id: ULID; state: string }[] }>()).reviews;
            expect(queue.map((review) => review.id), `${member} queue`).toEqual(expected);
            // No Reviewed request ever appears in any queue (R17.3 terminal, R17.8).
            expect(queue.every((review) => review.state === 'needs_review')).toBe(true);
          }
        };

        /** Confirm the stored row matches the model's terminal fields exactly (R17.3, R17.5, R17.10). */
        const expectStored = async (model: Model) => {
          const row = await core().prepare(
            'SELECT state, requester_id AS requester, reviewer_id AS reviewer, reviewed_at AS reviewedAt, review_note AS reviewNote FROM review_requests WHERE id = ?1',
          ).bind(model.id).first<{ state: string; requester: ULID; reviewer: ULID | null; reviewedAt: string | null; reviewNote: string | null }>();
          expect(row, model.id).not.toBeNull();
          expect(row!.state).toBe(model.state);
          expect(row!.requester).toBe(ids()[model.requester]);
          if (model.state === 'reviewed') {
            expect(row!.reviewer).toBe(ids()[model.reviewer!]);
            expect(row!.reviewedAt).toBe(model.reviewedAt);
            expect(row!.reviewNote).toBe(model.reviewNote ?? null);
          } else {
            expect(row!.reviewer).toBeNull();
            expect(row!.reviewedAt).toBeNull();
            expect(row!.reviewNote).toBeNull();
          }
        };

        for (const action of actions) {
          if (action.t === 'create') {
            // A fresh Whole_Team or Restricted Research_Item owned by the requester to hang the request on.
            const list = action.restricted ? action.list.filter((member) => member !== action.requester) : [];
            const item: ItemView = await world.created(action.requester, 'finding', {
              projectId,
              access: action.restricted ? { level: 'restricted', members: list.map((member) => ids()[member]) } : { level: 'whole_team', members: [] },
            });
            // Who can read the Item (R47.3): everyone for Whole_Team; else the Owner, Administrators, and the Access_List.
            const readers = new Set<Who>(action.restricted
              ? [action.requester, ...PEOPLE.filter((member) => ROLE_OF[member] === 'administrator'), ...list]
              : PEOPLE);
            // The optional request note (R17.1); it is distinct from the review note set at completion (R17.5).
            const requestNote = action.note ? `Please check request ${requests.length}.` : undefined;
            const body = { targetId: item.id, ...addresseeBody(action.addressing), ...(requestNote === undefined ? {} : { note: requestNote }) };

            const candidate: Model = {
              id: UNKNOWN, requester: action.requester, addressing: action.addressing, rootId: item.id as ULID, readers,
              createdAt: world.at, state: 'needs_review',
            };
            const response = await world.request(action.requester, 'POST', '/reviews', body);

            // A named Member who cannot read a Restricted Item is refused first as an unreadable addressee (R47.10),
            // before the Eligible_Reviewer existence check; a Specialty/Role addressing names no Member to check.
            const unreadableNamed = action.addressing.kind === 'member' && !readers.has(action.addressing.who);

            if (unreadableNamed) {
              // R47.10: the named Member cannot read the Item — refused, naming them, and no row is written (R17.9).
              expect(response.status).toBe(422);
              const error = await response.json<{ error: string; details?: { rule?: string } }>();
              expect(error.error).toBe('rule');
              expect(error.details?.rule).toBe('access_addressee');
            } else if (anyEligible(candidate)) {
              // R17.3/R17.9: created in Needs_Review because an Eligible_Reviewer exists.
              expect(response.status, await response.clone().text()).toBe(201);
              const id = (await response.json<{ review: { id: ULID } }>()).review.id;
              const model: Model = { ...candidate, id };
              requests.push(model);
              await expectStored(model);
            } else {
              // R17.9: no Eligible_Reviewer, so no row is written and the refusal names the reason.
              expect(response.status).toBe(422);
              const error = await response.json<{ error: string; details?: { rule?: string; message?: string } }>();
              expect(error.error).toBe('rule');
              expect(error.details?.rule).toBe('no_eligible_reviewer');
              expect(error.details?.message).toBe('The addressees include no active Member other than you.');
            }
            // No request the model did not record exists in the table.
            const count = await core().prepare('SELECT count(*) AS n FROM review_requests').first<number>('n');
            expect(count).toBe(requests.length);
          } else {
            // Completing names an existing request (modulo), or none when none exist yet.
            if (requests.length === 0) continue;
            const model = requests[action.which % requests.length]!;
            const before = { state: model.state, reviewer: model.reviewer, reviewedAt: model.reviewedAt, reviewNote: model.reviewNote };
            const note = action.note ? `Reviewed with note ${action.which}.` : undefined;
            const response = await world.request(action.actor, 'POST', `/reviews/${model.id}/complete`, note === undefined ? {} : { note });

            const open = model.state === 'needs_review';
            const actorAddressed = addressed(model, action.actor);
            const actorReads = model.readers.has(action.actor);
            const actorEligible = actorAddressed && actorReads;
            if (open && actorEligible) {
              // R17.5: an Eligible_Reviewer marks a Needs_Review request Reviewed, recording reviewer/time/note.
              expect(response.status, await response.clone().text()).toBe(200);
              model.state = 'reviewed';
              model.reviewer = action.actor;
              model.reviewedAt = world.at;
              model.reviewNote = note ?? null;
            } else if (!open) {
              // R17.10: already Reviewed — refused naming the `reviewed` condition, state and fields unchanged.
              expect(response.status).toBe(422);
              const error = await response.json<{ error: string; details?: { rule?: string } }>();
              expect(error.error).toBe('rule');
              expect(error.details?.rule).toBe('reviewed');
            } else if (!actorAddressed) {
              // R17.10: the actor is not addressed (or is the requester) — refused `not_eligible` (403), unchanged.
              expect(response.status).toBe(403);
              const error = await response.json<{ error: string; details?: { rule?: string } }>();
              expect(error.error).toBe('forbidden');
              expect(error.details?.rule).toBe('not_eligible');
            } else {
              // R17.10: the actor is addressed but cannot read the Restricted Item, so is not an Eligible_Reviewer —
              // the save guard refuses it (422), naming the rule, and state and fields are unchanged.
              expect(response.status).toBe(422);
              const error = await response.json<{ error: string; details?: { rule?: string } }>();
              expect(error.error).toBe('rule');
              expect(error.details?.rule).toBe('reviewer_eligible');
            }
            // Terminal invariant: a refused complete leaves every field exactly as before.
            if (!(open && actorEligible)) {
              expect({ state: model.state, reviewer: model.reviewer, reviewedAt: model.reviewedAt, reviewNote: model.reviewNote }).toEqual(before);
            }
            await expectStored(model);
          }

          // After every action the model and the database agree on every request and every Member's queue.
          for (const model of requests) await expectStored(model);
          await expectQueues();
        }

        // R17.3 terminal invariant over the whole sequence: no request is Needs_Review once the model marked it Reviewed.
        for (const model of requests) {
          const state = await core().prepare('SELECT state FROM review_requests WHERE id = ?1').bind(model.id).first<string>('state');
          expect(state).toBe(model.state);
        }
      }),
      { numRuns: Math.min(FC_RUNS, 40) },
    );
  }, 600_000);
});

describe('Property 48 (R17.10): a Publication_Request is completed only by applying or declining it', () => {
  it('refuses the ordinary complete path for a Publication_Request, naming the reason and leaving it Needs_Review', async () => {
    const core = () => world.bindings.RF_CORE;
    const ids = () => world.ids;

    await fc.assert(
      fc.asyncProperty(
        // The actor who attempts the ordinary complete, and whether a note is sent — neither should matter: always refused.
        fc.constantFrom<Who>(...PEOPLE),
        fc.boolean(),
        async (actor, withNote) => {
          // p88: reset shared records so this run's single Publication_Request is the only review_requests row; the
          // reset also clears the beforeEach Project, so create a fresh one for this run's Item.
          await resetRecords(core());
          const projectId = await addProject(core(), ids().admin, world.at);
          const item = await world.created('author', 'finding', { projectId });
          const id = newULID(world.at);
          // A Publication_Request carries is_publication_request = 1 and is addressed to the Administrator Role (R23.10, R17.10).
          await core().prepare(
            `INSERT INTO review_requests (id, target_id, root_id, requester_id, created_at, request_type, is_publication_request, proposal, updated_seq)
             VALUES (?1, ?2, ?2, ?3, ?4, 'publication_request', 1, '{}', 0)`,
          ).bind(id, item.id, ids().author, world.at).run();
          await core().prepare("INSERT INTO review_addressees (request_id, addressee_type, addressee_id) VALUES (?1, 'role', ?2)").bind(id, ROLE_IDS.administrator).run();

          const response = await world.request(actor, 'POST', `/reviews/${id}/complete`, withNote ? { note: 'Attempted ordinary completion.' } : {});
          // R17.10: the ordinary complete path is refused for a Publication_Request, naming the reason.
          expect(response.status).toBe(422);
          const error = await response.json<{ error: string; details?: { rule?: string; message?: string } }>();
          expect(error.error).toBe('rule');
          expect(error.details?.rule).toBe('publication_request');
          expect(error.details?.message).toBe('A Publication Request is completed by applying or declining it.');

          // The request stays Needs_Review with no reviewer, time, or note recorded.
          const row = await core().prepare('SELECT state, reviewer_id AS reviewer, reviewed_at AS reviewedAt FROM review_requests WHERE id = ?1').bind(id)
            .first<{ state: string; reviewer: ULID | null; reviewedAt: string | null }>();
          expect(row).toMatchObject({ state: 'needs_review', reviewer: null, reviewedAt: null });
        },
      ),
      { numRuns: Math.min(FC_RUNS, 40) },
    );
  }, 300_000);
});
