// Feature: research-collab-cms, Property 29: Concurrent saves from one base are serialized
import { describe, expect, it } from 'vitest';
import { SEED_POLICY_SECTIONS } from '@researchforce/db/seed/policy-sections';
import { POLICY_PAGE_KEYS } from '@researchforce/db/schema/core';
import type { PolicyPageKey } from '@researchforce/db/seed/policy-sections';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { itemWorld, rich, errorOf } from '../items';
import { addProject, resetRecords } from '../units';

/**
 * **Validates: Requirements 4.9, 22.10, 32.16, 42.16, 46.28**
 *
 * Property 29 — concurrent saves from one base are serialized. For any set of saves issued from the SAME base revision
 * against ONE target, the optimistic-concurrency guard that every save path shares (`commitSave`'s `GuardedBatch
 * .guard('rev', …)` with `conflictSince`, apps/app/src/records/pipeline.ts) serializes them: EXACTLY ONE commits and
 * the rest are each refused with a 409 conflict that reports the target's current revision and the Revisions made
 * since the stale base; the committed state is ONE submitted save applied atomically (never a mixed/interleaved merge
 * of two); the revision advances by exactly the number of committed saves; and a save re-issued from the now-fresh
 * base then commits. This is the one guard behind a Research_Item edit (R4.9, R22.10), a moderation acceptance /
 * decision (R32.16), an AI-assisted save (R42.16), and a Policy_Page edit (R46.28).
 *
 * WHAT IS EXERCISED — THE REAL PRODUCTION CODE, NEVER A RE-IMPLEMENTATION.
 * The property drives the real HTTP save handlers end to end and lets the production guard do the serializing:
 *   • Leg A/B — a Research_Item edit through `PATCH /items/:id` (the real `editItem` → `commitSave`), both a content
 *     edit and a status-only edit, whose guard reads `units.rev` (REV_ROWS.unit). This covers R4.9/R22.10 and is the
 *     same `commitSave` guard a moderation acceptance (R32.16) and an AI-assisted save (R42.16) commit through — they
 *     differ only in which fields change and which Revision_Kind results, not in the revision guard being proven here.
 *   • Leg C — a Policy_Page edit through `PUT /policy/:page` (the real `editPolicyPage` → `commitSave`), whose guard
 *     reads a DIFFERENT row, `policy_pages.rev` keyed by `page_key` (REV_ROWS.policy_page), so the proof spans two
 *     target kinds whose guards resolve against different tables/keys (R46.28).
 * The test never re-creates the `rev` guard, the conflict builder, or the batch; it only reads back D1 and the HTTP
 * responses the real handlers produced.
 *
 * HOW THE INVARIANTS ARE GENERATED AND ASSERTED. Each run generates a SET of saves (2…N) that all declare the SAME
 * base `rev` against one freshly-seeded target, plus a generated interleaving ORDER in which the saves are submitted
 * (adversarial: the order in which the real handlers run decides which save wins, and the property holds for every
 * order). Each save carries a distinct, identifiable payload (a unique title / section text), so the committed value
 * pins down WHICH save won and proves atomicity — the stored state equals exactly one submitted save, with no field
 * taken from another. Submitting all of them from the same base, the property asserts:
 *   • SERIALIZED — exactly one response is a success and every other is a 409 `conflict`;
 *   • CONFLICT REPORT — each refusal's body carries the target's current `rev` and the Revisions since the stale base
 *     (the save that did win), newest first (R4.9/R22.10/R46.28);
 *   • ATOMICITY — the stored target equals exactly one submitted save's payload, never a mixed merge of two;
 *   • REVISION ADVANCE — the target's `rev` advanced by exactly one (exactly one save committed);
 *   • RE-ISSUE — a save re-submitted from the now-fresh `rev` then commits, and the target advances by one again.
 *
 * CHOSEN POOL: WORKERS (`apps/app/test/properties/`). The save path IS a stateful rf-core D1 write: `commitSave`
 * issues a real `GuardedBatch` whose `guard('rev', …)` is a D1 statement over `units`/`policy_pages`, and
 * `conflictSince` reads `revisions`/`policy_*` back from D1 to build the 409. Only the Workers (workerd) pool gives the
 * real D1 binding the HTTP handlers and the guard require; the node pool is scoped to `packages/<name>/test` and could
 * not run the app's `PATCH /items/:id` / `PUT /policy/:page` routes against a live D1. So the faithful proof lives here
 * in the Workers pool, like p41/p78/p28.
 *
 * p88 PER-RUN RESET + p78 RUN CAP (as p41/p78). The named D1 is SHARED across fast-check runs in the Workers pool, so
 * every run FIRST reseeds its target to a known base revision (`resetRecords` + a fresh Item for Leg A/B; a policy
 * reseed that restores `policy_pages.rev = 1` and the seeded sections for Leg C), so no run inherits another's rows or
 * advanced revision. The run count is capped at `Math.min(FC_RUNS, 25)` because each run drives several real HTTP
 * saves and D1 batches through workerd, and the full `FC_RUNS` would exceed the per-test budget — the cap p74/p111 use.
 */

const HEAVY_RUNS = Math.min(FC_RUNS, 25);

const world = itemWorld(new Date('2026-10-27T18:00:00.000Z'), { contentLicence: 'Synthetic Licence 1.0' });
const core = () => world.core();

/**
 * p88 per-run reset. The Workers-pool D1 is shared across fast-check runs, so every run first clears the units and
 * records it seeds and installs a fresh Project (the Members and their sessions are seeded once per `it` by
 * `itemWorld`'s `beforeEach`), so no run inherits another run's rows or an advanced target revision. Returns the
 * fresh Project the run's Research_Items are created in.
 */
async function resetPerRun(): Promise<string> {
  await resetRecords(core());
  return addProject(core(), world.ids.admin, world.at);
}

/** The conflict details the real `conflictSince` builds: the target's current revision and the Revisions since the base. */
interface ConflictDetails { readonly rev: number; readonly revisions: readonly { readonly kind: string; readonly memberId: string }[] }
const conflictDetails = (body: { details?: unknown } | null): ConflictDetails => (body as { details: ConflictDetails }).details;

/** Apply a generated permutation to an array (Fisher–Yates driven by the generated swap indices). */
function permute<T>(items: readonly T[], swaps: readonly number[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = swaps[out.length - 1 - i]! % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** The arbitrary for a set of concurrent saves: how many, and a swap vector that gives their submission order. */
const concurrentArb = fc.record({
  // 2…5 saves issued from the SAME base revision; each is distinguishable by its index-tagged payload.
  count: fc.integer({ min: 2, max: 5 }),
  // A swap vector long enough to permute the saves into any adversarial submission order.
  order: fc.array(fc.integer({ min: 0, max: 16 }), { minLength: 5, maxLength: 5 }),
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Leg A — Research_Item content edits (unit target, REV_ROWS.unit; R4.9, R22.10). The same `commitSave` guard serves a
// moderation acceptance (R32.16) and an AI-assisted save (R42.16); only the changed fields differ, not the guard.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('Property 29 (R4.9, R22.10): concurrent Research_Item edits from one base are serialized', () => {
  it('commits exactly one, refuses the rest with a revision-reporting conflict, stays atomic, and advances rev by one; a re-issue then commits', async () => {
    await fc.assert(fc.asyncProperty(concurrentArb, async ({ count, order }) => {
      const projectId = await resetPerRun();
      const item = await world.created('author', 'finding', { projectId });
      const base = item.rev; // every save declares THIS base revision — they race from the same point.
      expect(base).toBe(1);

      // `count` distinct saves, each a content edit that renames the title to an index-tagged value. The title pins
      // down which save won (atomicity), and every save declares the SAME base `rev`.
      const saves = Array.from({ length: count }, (_v, index) => ({
        index, title: `Concurrent edit #${index}`, body: { rev: base, mark: { mark: 'minor_edit' as const }, title: `Concurrent edit #${index}`, claim: rich(`Claim from save #${index}.`) },
      }));

      // Submit them in the generated adversarial order through the REAL edit handler; the production guard decides.
      const submitted = permute(saves, order);
      const results = [] as { index: number; status: number; body: Awaited<ReturnType<typeof errorOf>> | null }[];
      for (const save of submitted) {
        const response = await world.edit('author', item.id, save.body);
        results.push({ index: save.index, status: response.status, body: response.status === 200 ? null : await errorOf(response) });
      }

      // SERIALIZED — exactly one success, every other a 409 conflict.
      const winners = results.filter((result) => result.status === 200);
      const losers = results.filter((result) => result.status !== 200);
      expect(winners, 'exactly one concurrent save commits').toHaveLength(1);
      expect(losers, 'every other save is refused').toHaveLength(count - 1);
      for (const loser of losers) {
        expect(loser.status, `save #${loser.index} is a conflict`).toBe(409);
        expect(loser.body!.error).toBe('conflict');
      }

      // CONFLICT REPORT — each refusal reports the now-current rev (2) and the Revision of the save that won, newest
      // first (R4.9, R22.10). The winner made a `minor_edit` Revision by the author.
      for (const loser of losers) {
        const details = conflictDetails(loser.body);
        expect(details.rev, 'the conflict reports the advanced revision').toBe(base + 1);
        expect(details.revisions.length, 'the conflict lists the Revision(s) since the stale base').toBe(1);
        expect(details.revisions[0], 'the listed Revision is the winning save').toMatchObject({ kind: 'minor_edit', memberId: world.ids.author });
      }

      // ATOMICITY + REVISION ADVANCE — the stored Item equals EXACTLY ONE submitted save (the winner's title and its
      // own claim, never a field from another save), and the revision advanced by exactly one.
      const winnerIndex = winners[0]!.index;
      const stored = await world.view('author', item.id);
      expect(stored.rev, 'the revision advanced by exactly the one committed save').toBe(base + 1);
      expect(stored['title'], 'the committed title is the winner, applied atomically').toBe(`Concurrent edit #${winnerIndex}`);
      expect(stored['claim'], 'the committed claim is the same winner, never a merge of two saves').toEqual(rich(`Claim from save #${winnerIndex}.`));
      // Exactly one Revision row was written for this target — the save path committed one save, not several.
      const revisionCount = (await core().prepare("SELECT count(*) AS n FROM revisions WHERE target_id = ?1").bind(item.id).first<number>('n'))!;
      expect(revisionCount, 'exactly one Revision was recorded').toBe(1);

      // RE-ISSUE — a save re-submitted from the now-fresh base commits, and the target advances by one again.
      const reissue = await world.edit('author', item.id, { rev: stored.rev, mark: { mark: 'minor_edit' as const }, title: 'After the fresh base' });
      expect(reissue.status, 'a save from the fresh base commits').toBe(200);
      const afterReissue = await world.view('author', item.id);
      expect(afterReissue.rev, 'the re-issued save advances the revision by one more').toBe(base + 2);
      expect(afterReissue['title']).toBe('After the fresh base');
    }), { numRuns: HEAVY_RUNS });
  }, 60 * FC_RUNS);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Leg B — Status-only Research_Item saves (the status_change Revision_Kind, where the changed field is the status
// rather than content). Same `unit` guard; proves serialization holds for a save that writes a different kind.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

// Four distinct seeded Campaign_Status value ids (value-set `campaign_status`, seeded C001…C007), so each status-only
// save sets a different status and the committed value pins down which save won.
const STATUS_VALUES = ['0000000000000000000000C005', '0000000000000000000000C001', '0000000000000000000000C002', '0000000000000000000000C003'] as const;

describe('Property 29 (R4.9, R22.10): concurrent status-only saves from one base are serialized', () => {
  it('commits one status change, refuses the rest with the status_change Revision in the conflict, and advances rev by one', async () => {
    await fc.assert(fc.asyncProperty(fc.record({ count: fc.integer({ min: 2, max: 4 }), order: fc.array(fc.integer({ min: 0, max: 16 }), { minLength: 4, maxLength: 4 }) }), async ({ count, order }) => {
      const projectId = await resetPerRun();
      // A Journal_Entry carries a Campaign_Status value; a status-only edit needs no Minor_Edit/Correction mark, so the
      // save writes a status_change Revision — a different Revision_Kind than Leg A, through the SAME `unit` rev guard.
      const item = await world.created('author', 'journal_entry', { projectId });
      const base = item.rev;

      // `count` saves each setting a DIFFERENT status value from the same base; the committed status pins the winner.
      const saves = Array.from({ length: count }, (_v, index) => ({ index, status: STATUS_VALUES[index]!, body: { rev: base, statusValueId: STATUS_VALUES[index]! } }));
      const submitted = permute(saves, order);
      const results = [] as { index: number; status: number; body: Awaited<ReturnType<typeof errorOf>> | null }[];
      for (const save of submitted) {
        const response = await world.edit('author', item.id, save.body);
        results.push({ index: save.index, status: response.status, body: response.status === 200 ? null : await errorOf(response) });
      }

      const winners = results.filter((result) => result.status === 200);
      expect(winners, 'exactly one status save commits').toHaveLength(1);
      for (const loser of results.filter((result) => result.status !== 200)) {
        expect(loser.status).toBe(409);
        const details = conflictDetails(loser.body);
        expect(details.rev).toBe(base + 1);
        // The winning save changed a status, so the conflict lists a status_change Revision (a different kind than Leg A).
        expect(details.revisions[0]).toMatchObject({ kind: 'status_change' });
      }

      const winnerIndex = winners[0]!.index;
      const stored = await world.view('author', item.id);
      expect(stored.rev).toBe(base + 1);
      expect(stored['statusValueId'], 'the committed status is exactly the winner').toBe(STATUS_VALUES[winnerIndex]);
    }), { numRuns: HEAVY_RUNS });
  }, 60 * FC_RUNS);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Leg C — Policy_Page edits (policy_page target, REV_ROWS.policy_page keyed by page_key; R46.28). The guard resolves
// against a DIFFERENT row than Leg A/B, so the serialization proof spans two target kinds.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface PolicyPageView { readonly page: string; readonly rev: number; readonly sections: { key: string; required: boolean; text: { text: string; spans: unknown[] } }[] }

/** Restore a Policy_Page and its sections to the seeded base state (rev = 1), so each run races from a known base. */
async function reseedPolicy(pageKey: PolicyPageKey): Promise<void> {
  const sections = SEED_POLICY_SECTIONS.filter((section) => section.pageKey === pageKey);
  const statements = [
    core().prepare('DELETE FROM revisions'),
    core().prepare('DELETE FROM activity'),
    core().prepare('DELETE FROM outbox'),
    core().prepare('DELETE FROM policy_sections WHERE page_key = ?1').bind(pageKey),
    core().prepare('UPDATE policy_pages SET rev = 1, sections_changed_at = ?1, actor_id = NULL, updated_seq = 0 WHERE page_key = ?2').bind(world.at, pageKey),
    ...sections.map((section, position) => core().prepare(
      'INSERT INTO policy_sections (page_key, section_key, position, title, required, text, text_spans, changed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)',
    ).bind(section.pageKey, section.sectionKey, position, section.title, section.required ? 1 : 0, section.text, '[]', world.at)),
  ];
  await core().batch(statements);
}

const policyPage = (key: PolicyPageKey) => world.request('admin', 'GET', `/policy/${key}`).then((response) => response.json<PolicyPageView>());

/** A full Policy_Page edit body: every section keeps its stored text, with `edits` overlaid onto the keyed sections. */
function policyEditBody(page: PolicyPageView, base: number, edits: Record<string, string>): Record<string, unknown> {
  return {
    rev: base, mark: { mark: 'minor_edit' as const },
    sections: page.sections.map((section) => ({ key: section.key, text: { text: edits[section.key] ?? section.text.text, spans: [] } })),
  };
}

describe('Property 29 (R46.28): concurrent Policy_Page edits from one base are serialized', () => {
  it('commits exactly one, refuses the rest with the revision-since in the conflict, stays atomic, and advances rev by one; a re-issue then commits', async () => {
    const PAGE: PolicyPageKey = 'corrections';
    await fc.assert(fc.asyncProperty(concurrentArb, async ({ count, order }) => {
      await resetPerRun();
      await reseedPolicy(PAGE);
      const page = await policyPage(PAGE);
      const base = page.rev;
      expect(base).toBe(1);
      const section = page.sections[0]!.key; // the first (required) section carries each save's distinguishing text.

      const saves = Array.from({ length: count }, (_v, index) => ({ index, text: `Policy text from save #${index}.`, body: policyEditBody(page, base, { [section]: `Policy text from save #${index}.` }) }));
      const submitted = permute(saves, order);
      const results = [] as { index: number; status: number; body: Awaited<ReturnType<typeof errorOf>> | null }[];
      for (const save of submitted) {
        const response = await world.request('admin', 'PUT', `/policy/${PAGE}`, save.body);
        results.push({ index: save.index, status: response.status, body: response.status === 200 ? null : await errorOf(response) });
      }

      // SERIALIZED — exactly one success, the rest 409 conflicts.
      const winners = results.filter((result) => result.status === 200);
      const losers = results.filter((result) => result.status !== 200);
      expect(winners, 'exactly one Policy_Page edit commits').toHaveLength(1);
      expect(losers, 'every other edit is refused').toHaveLength(count - 1);

      // CONFLICT REPORT — the current rev (2) and the Revision of the winning save since the stale base (R46.28).
      for (const loser of losers) {
        expect(loser.status).toBe(409);
        const details = conflictDetails(loser.body);
        expect(details.rev, 'the conflict reports the advanced policy revision').toBe(base + 1);
        expect(details.revisions.length, 'the conflict lists the Revision since the stale base').toBe(1);
        expect(details.revisions[0]).toMatchObject({ kind: 'minor_edit', memberId: world.ids.admin });
      }

      // ATOMICITY + REVISION ADVANCE — the stored section text equals exactly one submitted save and rev advanced by one.
      const winnerIndex = winners[0]!.index;
      const stored = await policyPage(PAGE);
      expect(stored.rev, 'the policy revision advanced by exactly one').toBe(base + 1);
      expect(stored.sections.find((s) => s.key === section)!.text.text, 'the committed text is the winner, applied atomically').toBe(`Policy text from save #${winnerIndex}.`);
      const revisionCount = (await core().prepare("SELECT count(*) AS n FROM revisions WHERE target_type = 'policy_page' AND target_id = ?1").bind(PAGE).first<number>('n'))!;
      expect(revisionCount, 'exactly one policy Revision was recorded').toBe(1);

      // RE-ISSUE — a save from the now-fresh base commits, advancing the revision by one more.
      const reissue = await world.request('admin', 'PUT', `/policy/${PAGE}`, policyEditBody(stored, stored.rev, { [section]: 'After the fresh policy base.' }));
      expect(reissue.status, 'a policy save from the fresh base commits').toBe(200);
      const afterReissue = await policyPage(PAGE);
      expect(afterReissue.rev, 'the re-issued policy save advances the revision by one more').toBe(base + 2);
      expect(afterReissue.sections.find((s) => s.key === section)!.text.text).toBe('After the fresh policy base.');
    }), { numRuns: HEAVY_RUNS });
  }, 60 * FC_RUNS);
});

// A compile-time anchor that the policy page key the Leg C property uses is a real, seeded page key.
void (POLICY_PAGE_KEYS as readonly string[]);
