// Feature: research-collab-cms, Property 54: Recipients follow the event rules
import { describe, expect, it } from 'vitest';
import { GuardedBatch } from '@researchforce/db/batch';
import { sql } from 'drizzle-orm';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { newULID } from '@researchforce/domain/identifiers';
import type { ULID } from '@researchforce/domain/types';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import {
  notifyAdministrators, notifyDissent, notifyItemUpdate, notifyNewSubmission, notifyOwner, notifyReply,
  notifyReviewCompleted, notifyReviewRequested, notifySystemAlert,
} from '../../src/notifications/fanout';
import { itemWorld } from '../items';
import { addMember } from '../api';
import { addElement, addItem, addProject, addSubmissionRow, resetRecords } from '../units';

/**
 * Property 54: Recipients follow the event rules.
 *
 * **Validates: Requirements 17.4, 17.6, 19.1, 19.2, 19.3, 19.4, 19.8, 23.7, 23.13, 32.3, 39.9, 39.10, 42.4, 46.36**
 *
 * For EACH Notification_Event type, the SET of `notification_events.member_id` rows the real `notify*` helper writes
 * equals an independent model of the per-type recipient rule, across randomized member/role/mute/preference/thread and
 * Restricted/Whole_Team access configurations. Each criterion is read character-for-character against requirements.md:
 *
 *  - R19.1  — New_Submission: every OTHER active Member who Can_Read at least one Item of the Submission in a Project
 *             they have NOT muted; a journal_import Submission and a reply-only Submission cause none.
 *  - R19.2  — Item_Update on a Correction/Withdrawal/Status_Change/Disclosure_Change: the Item's Owner and every Member
 *             who posted a Reply in the Thread, minus the actor, minus muters (R39.9), only Can_Read; other kinds none.
 *  - R19.3  — Reply: the root Item's Owner and every Thread poster, minus the actor, minus muters (R39.9), Can_Read.
 *  - R19.4  — System_Alert: every Administrator, INCLUDING the acting Member.
 *  - R19.8  — the stored email_mode equals the recipient's pref (default 'immediate'); a Member with in-app Off AND
 *             email Off gets NO event, while in-app Off + email <> off still gets an event with its correct email_mode.
 *  - R23.7  — notifyOwner: the Item's Owner even when the Owner muted the Project (mutes do NOT apply), minus actor.
 *  - R23.13 — notifyAdministrators: every Administrator who Can_Read, mutes do NOT apply, minus actor.
 *  - R39.9  — a mute removes New_Submission, Reply, and ordinary Item_Updates, but not the Owner/Administrator
 *             (R23.7, R23.13) or Dissent (R42.4) notifications. R39.10 — a Member's own Muted_Projects list drives
 *             exactly which Members a mute removes, applied here by varying each Member's mute of the Project.
 *  - R42.4  — Dissent: the Owner of the Research_Item the note concerns, plus (on a permanent deletion) the note's
 *             author; the acting Member excluded; mutes do NOT apply; Owner == author dedups to one.
 *  - R17.4  — Review_Requested: the Eligible_Reviewers the request names, who Can_Read.
 *  - R17.6  — Review_Completed: the requesting Member.
 *  - R32.3 / R46.36 — Outside_Submission recipients (every Administrator; the Responsible_Person) are driven by the
 *             example suites moderation-queue.test.ts and the Responsible_Person tests rather than duplicated here: the
 *             Outside_Submission events are not fanned out by a single notify* recipient helper this property drives
 *             (the moderation handler composes the Administrator and Responsible_Person audiences), so they are left to
 *             those end-to-end suites. The recipient MACHINERY those paths rely on — the Administrator-only audience,
 *             the active-only and in-app/email inclusion predicate, and dedup — is proven here through the
 *             notifyAdministrators and notifySystemAlert cases, which use the same `insertEvents` recipient pipeline.
 *
 * Cross-cutting rules proven across every case: the ACTING Member is excluded from every event except System_Alert
 * (R19.4); recipients are DEDUPLICATED (a Member who is both Owner and Thread-poster gets ONE event); only ACTIVE
 * Members receive events; a Member is included only when in-app On OR email <> off (R19.8).
 *
 * Chosen layer. This is a D1-backed fanout, so the proof drives the REAL notify* helpers inside a GuardedBatch against
 * rf-core D1 and reads back the stored notification_events rows, the same path production runs.
 *
 * p88 PATTERN: every fast-check run FIRST resets the seeded records (the named D1 is shared across runs in the Workers
 * pool). p78 CAP: numRuns is Math.min(FC_RUNS, 40).
 */

const world = itemWorld();

/** How many Members (beyond the always-present author, owner, admin) the world seeds, 0..N extra contributors. */
const MAX_EXTRA = 3;
type EmailMode = 'immediate' | 'daily_digest' | 'off';
const EMAIL_MODES: readonly EmailMode[] = ['immediate', 'daily_digest', 'off'];

/** A seeded Member: role, mute of the one Project, and in-app/email preference for the event under test. */
interface MemberSpec {
  readonly admin: boolean;
  readonly muted: boolean;
  readonly inApp: boolean;
  readonly email: EmailMode;
  /** Whether this Member is on the Access_List of a Restricted item (the Owner and Administrators read regardless). */
  readonly onList: boolean;
  /** Whether this Member posted a Reply in the Thread. */
  readonly posted: boolean;
}

const memberArb: fc.Arbitrary<MemberSpec> = fc.record({
  admin: fc.boolean(),
  muted: fc.boolean(),
  inApp: fc.boolean(),
  email: fc.constantFrom(...EMAIL_MODES),
  onList: fc.boolean(),
  posted: fc.boolean(),
});

const worldArb = fc.record({
  members: fc.array(memberArb, { minLength: 0, maxLength: MAX_EXTRA }),
  restricted: fc.boolean(),
  ownerMuted: fc.boolean(),
  ownerInApp: fc.boolean(),
  ownerEmail: fc.constantFrom(...EMAIL_MODES),
  /** The acting Member's index among all Members (0 = owner, 1 = fixed observer, 2.. = extras). */
  actorPick: fc.nat({ max: MAX_EXTRA + 1 }),
});

/** Each seeded Member, resolved from the generated specs into a stable list with ids filled at run time. */
interface Person extends MemberSpec { readonly id: ULID; readonly active: boolean }

describe('Property 54 (R17.4, R17.6, R19.1-19.4, R19.8, R23.7, R23.13, R39.9, R39.10, R42.4): recipients follow the event rules', () => {
  it('writes exactly the modelled recipient set for each event type, deduplicated, active-only, actor-excluded', async () => {
    const core = () => world.bindings.RF_CORE;

    await fc.assert(fc.asyncProperty(worldArb, async (config) => {
      // p88: reset the shared records at the START so no prior run's rows leak in. The named D1 is shared across
      // runs in the Workers pool, so a run that did not reset would inherit the prior run's units AND Members. The
      // three seeded Members (author, colleague, admin) are the only ones kept; every Member added by a prior run,
      // and every preference and mute, is cleared.
      await resetRecords(core());
      await core().prepare('DELETE FROM notification_prefs').run();
      await core().prepare('DELETE FROM muted_projects').run();
      await core().prepare('DELETE FROM members WHERE id NOT IN (?1, ?2, ?3)').bind(world.ids.author, world.ids.colleague, world.ids.admin).run();
      const projectId = await addProject(core(), world.ids.admin, world.at);

      // The three seeded people are the owner (author), a fixed active observer (colleague), and an Administrator
      // (admin). The owner's spec is taken from the top-level config; the observer is a plain active contributor.
      const owner: Person = { id: world.ids.author, admin: false, active: true, muted: config.ownerMuted, inApp: config.ownerInApp, email: config.ownerEmail, onList: true, posted: false };
      const observer: Person = { id: world.ids.colleague, admin: false, active: true, muted: false, inApp: true, email: 'immediate', onList: false, posted: true };
      const adminPerson: Person = { id: world.ids.admin, admin: true, active: true, muted: false, inApp: true, email: 'immediate', onList: false, posted: false };

      // Extra contributors seeded fresh for this run, each with a random role, mute, preference, access, and whether
      // they posted a Reply. A subset is made inactive (status 'revoked') so the active-only rule is exercised.
      const extras: Person[] = [];
      for (const [index, spec] of config.members.entries()) {
        const active = !(index % 3 === 0 && config.members.length > 1); // make roughly a third inactive
        const id = await addMember(core(), `extra${index}@example.test`, active ? 'active' : 'revoked', world.at, spec.admin ? ROLE_IDS.administrator : ROLE_IDS.contributor);
        extras.push({ ...spec, id, active });
      }

      const everyone: Person[] = [owner, observer, adminPerson, ...extras];
      // The acting Member for the actor-exclusion rule; wraps around the seeded list.
      const actor = everyone[config.actorPick % everyone.length]!;

      // Preferences and mutes: write a notification_prefs row for every Event_Type this property drives only when it
      // differs from the default (in-app On, email immediate), so the default-row absence is exercised too. The fanout
      // LEFT JOINs notification_prefs on the event's type, so each Member's preference must be seeded for each type the
      // Member's event rows should carry. A muted_projects row for each Member that muted the one Project.
      for (const person of everyone) {
        if (!(person.inApp && person.email === 'immediate')) {
          for (const type of PREF_TYPES) {
            await core().prepare('INSERT INTO notification_prefs (member_id, event_type, in_app, email) VALUES (?1, ?2, ?3, ?4)')
              .bind(person.id, type, person.inApp ? 1 : 0, person.email).run();
          }
        }
        if (person.muted) await core().prepare('INSERT INTO muted_projects (member_id, project_id, muted_at) VALUES (?1, ?2, ?3)').bind(person.id, projectId, world.at).run();
      }

      // One Research_Item owned by `owner`, Restricted or Whole_Team, with the Access_List drawn from `onList`. The
      // Thread holds a Reply from each poster. Access and preferences are seeded for the single `EVENT_FOR_PREFS`
      // event type, which the preference-sensitive cases (New_Submission, Reply, Item_Update) each use.
      const submissionId = await addSubmissionRow(core(), owner.id, world.at);
      const place = { projectId, ownerId: owner.id, submissionId, now: world.at };
      const item = await addItem(core(), place);
      const rootId = item.id;
      if (config.restricted) {
        await core().prepare("UPDATE research_items SET access_level = 'restricted' WHERE unit_id = ?1").bind(rootId).run();
        for (const person of everyone) {
          if (person.onList && person.id !== owner.id) {
            await core().prepare('INSERT INTO access_grants (root_id, member_id, granted_by, granted_at) VALUES (?1, ?2, ?3, ?4)').bind(rootId, person.id, owner.id, world.at).run();
          }
        }
      }
      // Each poster adds one Reply (its own completed Submission), so the Thread's posters are exactly those Members.
      for (const person of everyone) {
        if (person.posted) {
          const replySub = await addSubmissionRow(core(), person.id, world.at);
          await addElement(core(), { projectId, ownerId: person.id, submissionId: replySub, now: world.at }, 'reply', rootId);
        }
      }

      /** Whether `person` Can_Read the item: Whole_Team, or Administrator, or the Owner, or on the Access_List. */
      const canRead = (person: Person): boolean => !config.restricted || person.admin || person.id === owner.id || person.onList;
      /** The inclusion predicate every event shares: active, delivered (in-app On OR email <> off). */
      const delivered = (person: Person): boolean => person.active && (person.inApp || person.email !== 'off');
      /** The thread audience: the Owner of the root plus every Member who posted a Reply. */
      const threadAudience = (): Person[] => everyone.filter((person) => person.id === owner.id || person.posted);

      // Run one notify* helper as the acting Member and read back the member ids it wrote for the event type.
      const run = async (fn: (batch: GuardedBatch) => GuardedBatch, type: string, actorId: ULID | null): Promise<string[]> => {
        await core().prepare('DELETE FROM notification_events').run();
        const batch = new GuardedBatch(core(), { id: actorId, now: world.at });
        fn(batch);
        await batch.commit();
        const rows = (await core().prepare('SELECT member_id AS member, email_mode AS mode FROM notification_events WHERE event_type = ?1').bind(type).all<{ member: string; mode: string }>()).results;
        // One event per recipient (dedup): no member id appears twice.
        const members = rows.map((row) => row.member);
        expect(new Set(members).size, `${type} duplicates`).toBe(members.length);
        // R19.8: the stored email_mode equals the recipient's preference (default 'immediate').
        for (const row of rows) {
          const person = everyone.find((candidate) => candidate.id === row.member)!;
          expect(row.mode, `${type} email_mode for ${row.member}`).toBe(person.email);
        }
        return members.sort();
      };
      const expected = (people: Person[]): string[] => [...new Set(people.map((person) => person.id))].sort();

      // ---- R19.1 New_Submission: every OTHER active deliverable reader in an unmuted Project. ----
      {
        const got = await run((batch) => notifyNewSubmission(batch, submissionId), 'new_submission', owner.id);
        const model = everyone.filter((person) => person.id !== owner.id && delivered(person) && canRead(person) && !person.muted);
        expect(got, 'new_submission (R19.1, R19.8, R39.9, R47.5)').toEqual(expected(model));
      }

      // ---- R19.1 New_Submission of a journal_import Submission: none. ----
      {
        const importSub = await addSubmissionRow(core(), owner.id, world.at);
        await core().prepare("UPDATE submissions SET kind = 'journal_import' WHERE id = ?1").bind(importSub).run();
        const importItem = await addItem(core(), { projectId, ownerId: owner.id, submissionId: importSub, now: world.at });
        void importItem;
        const got = await run((batch) => notifyNewSubmission(batch, importSub), 'new_submission', owner.id);
        expect(got, 'new_submission journal_import causes none (R19.1)').toEqual([]);
      }

      // ---- R19.1 New_Submission of a reply-only Submission: none (a Reply tells the Thread through a Reply event). ----
      {
        const replyOnlySub = await addSubmissionRow(core(), owner.id, world.at);
        await addElement(core(), { projectId, ownerId: owner.id, submissionId: replyOnlySub, now: world.at }, 'reply', rootId);
        const got = await run((batch) => notifyNewSubmission(batch, replyOnlySub), 'new_submission', owner.id);
        expect(got, 'new_submission reply-only causes none (R19.1)').toEqual([]);
      }

      // ---- R19.3 Reply: root Owner + Thread posters, minus actor, minus muters, Can_Read, deliverable. ----
      {
        // A fresh Reply by the actor (its unit is the event's subject); the actor is excluded from its own event.
        const replySub = await addSubmissionRow(core(), actor.id, world.at);
        const reply = await addElement(core(), { projectId, ownerId: actor.id, submissionId: replySub, now: world.at }, 'reply', rootId);
        const got = await run((batch) => notifyReply(batch, reply.id, replySub), 'reply', actor.id);
        const model = threadAudience().filter((person) => person.id !== actor.id && delivered(person) && canRead(person) && !person.muted);
        expect(got, 'reply (R19.3, R19.4, R39.9)').toEqual(expected(model));
      }

      // ---- R19.2 Item_Update (ordinary kinds): Owner + Thread posters, minus actor, minus muters, Can_Read. ----
      {
        const got = await run((batch) => notifyItemUpdate(batch, rootId, ['correction']), 'item_update', actor.id);
        const model = threadAudience().filter((person) => person.id !== actor.id && delivered(person) && canRead(person) && !person.muted);
        expect(got, 'item_update correction (R19.2, R39.9)').toEqual(expected(model));
      }

      // ---- R19.2 Item_Update with NO ITEM_UPDATE_KIND (minor_edit): no event. ----
      {
        const got = await run((batch) => notifyItemUpdate(batch, rootId, ['minor_edit']), 'item_update', actor.id);
        expect(got, 'item_update minor_edit causes none (R19.2)').toEqual([]);
      }

      // ---- R23.7 notifyOwner: the Owner, mutes do NOT apply, minus actor, Can_Read (Owner always reads own item). ----
      {
        const got = await run((batch) => notifyOwner(batch, rootId, { change: 'disclosure' }), 'item_update', adminPerson.id);
        // The Owner is told even when the Owner muted the Project (R23.7); excluded only if the Owner is the actor.
        const model = owner.id === adminPerson.id ? [] : (delivered(owner) ? [owner] : []);
        expect(got, 'notifyOwner (R23.7, mutes N/A)').toEqual(expected(model));
      }

      // ---- R23.13 notifyAdministrators: every Administrator who Can_Read, mutes do NOT apply, minus actor. ----
      {
        const got = await run((batch) => notifyAdministrators(batch, [rootId], { change: 'downgrade' }), 'item_update', actor.id);
        const model = everyone.filter((person) => person.admin && person.id !== actor.id && delivered(person) && canRead(person));
        expect(got, 'notifyAdministrators (R23.13, R9.6, mutes N/A)').toEqual(expected(model));
      }

      // ---- R42.4 Dissent (create/edit/withdraw): the root Owner, minus actor, mutes do NOT apply, Can_Read. ----
      {
        const got = await run((batch) => notifyDissent(batch, rootId), 'dissent', actor.id);
        const model = owner.id === actor.id ? [] : (delivered(owner) && canRead(owner) ? [owner] : []);
        expect(got, 'notifyDissent create (R42.4, mutes N/A)').toEqual(expected(model));
      }

      // ---- R42.4 Dissent on permanent deletion: the Owner AND the note's author, deduped, minus actor. ----
      {
        // The author is a non-owner active Member; pick the observer (always active) as the author.
        const author = observer;
        const got = await run((batch) => notifyDissent(batch, rootId, { authorId: author.id }), 'dissent', actor.id);
        const model = [owner, author].filter((person) => person.id !== actor.id && delivered(person) && canRead(person));
        expect(got, 'notifyDissent delete adds author, deduped (R42.4)').toEqual(expected(model));
      }

      // ---- R19.4 System_Alert: every Administrator, INCLUDING the acting Member. ----
      {
        const got = await run((batch) => notifySystemAlert(batch, 'usage:d1', { allowance: 'D1 rows read', percent: 80 }), 'system_alert', actor.id);
        // includeActor: an Administrator acting is kept; mutes and Can_Read do not apply to System_Alert.
        const model = everyone.filter((person) => person.admin && delivered(person));
        expect(got, 'system_alert reaches every Administrator incl. actor (R19.4)').toEqual(expected(model));
      }

      // ---- R17.4 Review_Requested: the Eligible_Reviewers the request names, who Can_Read. ----
      {
        // Name every Member as a reviewer; only those who Can_Read and are deliverable receive. The requester is a
        // review addressee pipeline detail (not actor-excluded here): notifyReviewRequested has no actor exclusion,
        // so pass a null actor to keep the whole eligible set.
        const reviewers = sql`SELECT value FROM json_each(${JSON.stringify(everyone.map((person) => person.id))})`;
        const got = await run((batch) => notifyReviewRequested(batch, reviewers, rootId, 'req-synthetic'), 'review_requested', null);
        const model = everyone.filter((person) => delivered(person) && canRead(person));
        expect(got, 'review_requested reaches Eligible_Reviewers who Can_Read (R17.4)').toEqual(expected(model));
      }

      // ---- R17.6 Review_Completed: the requesting Member. ----
      {
        // Seed a review_requests row whose requester is the owner; the completion event goes to that requester.
        const requestId = newULID(world.at);
        await core().prepare('INSERT INTO review_requests (id, target_id, root_id, requester_id, request_type, state, created_at, reviewer_id, reviewed_at, is_publication_request, rev, updated_seq) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, 1, 0)')
          .bind(requestId, rootId, rootId, owner.id, 'review', 'reviewed', world.at, observer.id, world.at).run();
        const got = await run((batch) => notifyReviewCompleted(batch, requestId), 'review_completed', observer.id);
        const model = delivered(owner) ? [owner] : [];
        expect(got, 'review_completed reaches the requester (R17.6)').toEqual(expected(model));
      }
    }), { numRuns: Math.min(FC_RUNS, 40) });
  }, 600_000);
});

/** The Event_Types the property drives; each Member's preference is seeded for every one so email_mode matches. */
const PREF_TYPES = ['new_submission', 'reply', 'item_update', 'dissent', 'system_alert', 'review_requested', 'review_completed'] as const;
