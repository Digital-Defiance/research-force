// Feature: research-collab-cms, Property 78: Project choice and preselection
import { describe, expect, it } from 'vitest';
import { newULID } from '@researchforce/domain/identifiers';
import { asULID } from '@researchforce/domain/types';
import type { ULID } from '@researchforce/domain/types';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { GuardedBatch } from '@researchforce/db/batch';
import { projects } from '@researchforce/db/schema/core';
import { itemWorld, rich } from '../items';
import type { Who } from '../items';

/**
 * Property 78: Project choice and preselection — the app, D1-driven part (Validates: Requirements 31.13, 32.18, 39.2, 39.3).
 *
 * The kernel of the offered set (the public form offers the Public Projects and the General_Choice, and a nonexistent
 * or non-Public Project is refused identically) is proven as pure data logic in
 * `packages/domain/test/properties/p78-project-choice.test.ts`. This file proves the half that only the Workspace
 * database can show:
 *
 *   • R39.2 — the Workspace Project choice (`GET /projects/choice`, `projectChoice`) returns every Project in the
 *     Project_Order (by position) with the preselection: the Project of the starting page when that Project exists,
 *     else the only Project when the page concerns none and exactly one exists, else none.
 *   • R39.3 — a submitted Research_Item names a Project that must exist; a missing or nonexistent choice keeps the
 *     Submission unsent, and when no Project exists at all the refusal says an Administrator must first create one.
 *   • R32.18 — accepting an Outside_Submission creates each Research_Item in the Outside_Submission's Project unless
 *     the Administrator chooses another for that Item, and a General_Choice submission (no recorded Project) REQUIRES
 *     a Project choice for every Research_Item before the acceptance applies.
 *
 * The property runs the real routes against the local Workspace D1. fast-check runs each property many times (FC_RUNS,
 * at least 100) inside one `it`, so — following p88/p107 — every run first clears the tables it seeds (projects,
 * outside_submissions, moderation_decisions, and the units an acceptance creates) and re-seeds them, so no run inherits
 * another run's Projects, submissions, or Items. The Members and their sessions are seeded once per `it` by
 * `itemWorld`'s `beforeEach`; only the Project-and-submission state is rebuilt per run.
 */

const world = itemWorld();

const admin = (): Who => 'admin';
const author = (): Who => 'author';

/** Clear every per-run row this property seeds, so a fast-check run never inherits another run's state. */
async function resetPerRun(): Promise<void> {
  await world.core().batch([
    world.core().prepare('DELETE FROM outgoing_emails'),
    world.core().prepare('DELETE FROM response_links'),
    world.core().prepare('DELETE FROM moderation_decisions'),
    world.core().prepare('DELETE FROM outside_submissions'),
    world.core().prepare('DELETE FROM submissions'),
    world.core().prepare('DELETE FROM research_items'),
    world.core().prepare('DELETE FROM findings'),
    world.core().prepare('DELETE FROM units'),
    world.core().prepare('DELETE FROM projects'),
  ]);
}

/** Create `count` Projects in order and return their ids, positioned 0..count-1 (the Project_Order). */
async function seedProjects(count: number): Promise<ULID[]> {
  const ids: ULID[] = [];
  for (let index = 0; index < count; index++) {
    const id = newULID(world.at);
    await new GuardedBatch(world.core(), { id: world.ids.admin, now: world.at }).insert(projects, {
      id, name: `Synthetic project ${index}`, nameKey: `synthetic project ${index}`, shortDescription: 'Synthetic.',
      slug: `synthetic-${index}-${id.toLowerCase().slice(-6)}`, position: index, createdBy: world.ids.admin, createdAt: world.at,
    }).commit();
    ids.push(id);
  }
  return ids;
}

/** Insert one Outside_Submission the way the rf-submit Worker stores it, with the chosen Project (or null for the General_Choice). */
let subCounter = 0;
async function outsideSubmission(projectId: ULID | null): Promise<ULID> {
  const id = newULID(world.at);
  subCounter += 1;
  await world.core().prepare(
    `INSERT INTO outside_submissions (id, reference, type, project_id, message, name, email, affiliation, page_ref, licence_agreed, received_at, state, rev, updated_seq)
     VALUES (?1, ?2, 'material', ?3, 'A synthetic submission message.', 'Ada Lovelace', ?4, NULL, NULL, 'Synthetic Licence 1.0', ?5, 'queued', 1, 0)`,
  ).bind(id, `RS-P78-${String(subCounter).padStart(5, '0')}`, projectId, `submitter${subCounter}@example.test`, world.at).run();
  return id;
}

/** A material Research_Item an acceptance may create; `projectId` overrides the Outside_Submission's Project when given. */
const materialItem = (projectId?: ULID) => ({
  unit: 'research_item' as const, kind: 'finding' as const,
  ...(projectId === undefined ? {} : { projectId }),
  fields: { title: 'A finding from outside', claim: rich('A synthetic outside claim.'), scopeCaveat: rich('Synthetic caveat.'), logSummary: rich('Summary of the outside finding.') },
});

const decide = (id: string, body: unknown) => world.request(admin(), 'POST', `/moderation/${id}/decide`, body);
const projectOf = async (unitId: string): Promise<string> => ((await world.view(admin(), unitId)).project as { id: string }).id;

describe('Property 78 (R39.2): the Workspace Project choice lists every Project in the Project_Order with the right preselection', () => {
  it('returns the Projects by position and preselects the starting page’s Project, the only Project, or none', async () => {
    let run = 0;
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 0, max: 6 }),
      fc.oneof(
        fc.constant<{ kind: 'none' }>({ kind: 'none' }),
        fc.record({ kind: fc.constant('page' as const), index: fc.nat() }),
        fc.record({ kind: fc.constant('missing' as const) }),
      ),
      async (count, page) => {
        run += 1;
        await resetPerRun();
        const ids = await seedProjects(count);

        // The starting page determines the preselection (R39.2).
        let query = '';
        let expectedPreselected: string | null;
        if (page.kind === 'page' && count > 0) {
          const chosen = ids[page.index % count]!;
          query = `?project=${chosen}`;
          expectedPreselected = chosen; // the page concerns one existing Project
        } else if (page.kind === 'missing') {
          query = `?project=${asULID('0000000000000000000000ZZZZ')}`; // a page whose Project no longer exists
          expectedPreselected = count === 1 ? ids[0]! : null; // falls back to the only Project, else none
        } else {
          expectedPreselected = count === 1 ? ids[0]! : null; // no page: only Project, else none
        }

        const response = await world.request(author(), 'GET', `/projects/choice${query}`);
        expect(response.status).toBe(200);
        const body = await response.json<{ projects: { id: string }[]; preselected: string | null }>();
        // Every Project, in the Project_Order (by position).
        expect(body.projects.map((project) => project.id)).toEqual(ids);
        expect(body.preselected).toBe(expectedPreselected);
      },
    ), { numRuns: Math.min(FC_RUNS, 40) });
  }, 200_000);
});

describe('Property 78 (R39.3): a submitted Research_Item needs a Project that exists', () => {
  it('refuses a missing or nonexistent Project, says so, and accepts an existing one', async () => {
    let run = 0;
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 0, max: 4 }),
      fc.oneof(
        fc.constant<{ kind: 'omit' }>({ kind: 'omit' }),
        fc.constant<{ kind: 'nonexistent' }>({ kind: 'nonexistent' }),
        fc.record({ kind: fc.constant('existing' as const), index: fc.nat() }),
      ),
      async (count, choice) => {
        run += 1;
        await resetPerRun();
        const ids = await seedProjects(count);

        const body = (projectId: ULID | undefined) => ({
          title: `A synthetic finding ${run}`, claim: rich('A synthetic claim.'), scopeCaveat: rich('Synthetic caveat.'),
          logSummary: rich('Synthetic summary.'), ...(projectId === undefined ? {} : { projectId }),
        });

        if (choice.kind === 'existing' && count > 0) {
          const chosen = ids[choice.index % count]!;
          const response = await world.create(author(), 'finding', body(chosen));
          expect(response.status).toBe(201);
          const item = (await response.json<{ item: { project: { id: string } } }>()).item;
          expect(item.project.id).toBe(chosen); // the Research_Item belongs to the chosen Project
          return;
        }

        // Omitted or nonexistent: the Submission is kept unsent, and a projectId issue names the requirement.
        const projectId = choice.kind === 'nonexistent' ? asULID('0000000000000000000000ZZZZ') : undefined;
        const response = await world.create(author(), 'finding', body(projectId));
        expect(response.status).toBe(422);
        const refusal = await response.json<{ error: string; fields?: { field: string; rule: string }[] }>();
        const projectIssue = (refusal.fields ?? []).find((issue) => issue.field === 'projectId');
        expect(projectIssue, 'a projectId issue is reported').toBeDefined();
        // With no Project at all, the message tells the Visitor an Administrator must first create one.
        if (count === 0) expect(projectIssue!.rule).toContain('Administrator');
        // Nothing was created.
        expect(await world.core().prepare("SELECT count(*) AS n FROM units WHERE unit_type = 'research_item'").first<number>('n')).toBe(0);
      },
    ), { numRuns: Math.min(FC_RUNS, 40) });
  }, 200_000);
});

describe('Property 78 (R32.18): acceptance places each Item in the submission’s Project unless another is chosen; the General_Choice requires a choice', () => {
  it('uses the Outside_Submission’s Project by default, honours a per-Item override, and demands a Project for a General_Choice submission', async () => {
    let run = 0;
    await fc.assert(fc.asyncProperty(
      fc.record({
        general: fc.boolean(), // whether the submission recorded the General_Choice (no Project) or a Project
        override: fc.boolean(), // whether the Administrator chooses a different Project for the Item
        submissionProject: fc.nat(),
        overrideProject: fc.nat(),
      }),
      async (scenario) => {
        run += 1;
        await resetPerRun();
        // At least two Projects so an override is distinguishable from the default.
        const ids = await seedProjects(2);
        const submissionProject = ids[scenario.submissionProject % ids.length]!;
        const overrideProject = ids[scenario.overrideProject % ids.length]!;

        const submissionId = await outsideSubmission(scenario.general ? null : submissionProject);
        const chosenItemProject = scenario.override ? overrideProject : undefined;

        const body = { decision: 'accepted', confirm: true, text: 'Accepted with thanks.', items: [materialItem(chosenItemProject)] };
        const response = await decide(submissionId, body);

        if (scenario.general && !scenario.override) {
          // A General_Choice submission with no per-Item Project is refused: a Project choice is required (R32.18).
          expect(response.status).toBe(422);
          const refusal = await response.json<{ fields?: { field: string }[] }>();
          expect((refusal.fields ?? []).some((issue) => issue.field.endsWith('projectId'))).toBe(true);
          // All-or-nothing: nothing was created (R32.15).
          expect(await world.core().prepare("SELECT count(*) AS n FROM units WHERE unit_type = 'research_item'").first<number>('n')).toBe(0);
          return;
        }

        expect(response.status).toBe(200);
        const result = await response.json<{ applied?: { createdUnitIds: string[] } }>();
        expect(result.applied?.createdUnitIds).toHaveLength(1);
        const itemId = result.applied!.createdUnitIds[0]!;

        // The created Research_Item's Project: the per-Item override when chosen, else the Outside_Submission's Project.
        const expectedProject = scenario.override ? overrideProject : submissionProject;
        expect(await projectOf(itemId)).toBe(expectedProject);
      },
    ), { numRuns: Math.min(FC_RUNS, 40) });
  }, 220_000);
});
