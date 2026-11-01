// Feature: research-collab-cms, Property 15: Publisher convergence
import { beforeEach, describe, expect, it } from 'vitest';
import { GuardedBatch } from '@researchforce/db/batch';
import { readEpoch } from '@researchforce/db/publication-epoch';
import type { Generation } from '@researchforce/db/publication-epoch';
import { projectDetailed } from '@researchforce/kernel/project';
import { canonicalJson, unitKey } from '@researchforce/kernel/views';
import type { PublicView, UnitKey } from '@researchforce/kernel/views';
import type { ItemKind, ULID } from '@researchforce/domain/types';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { loadProjectionInput } from '../../src/kernel-input';
import { renderSiteBuild } from '../../src/publisher/render';
import { runProjectionSlice } from '../../src/publisher/projection';
import type { ProjectionDeps } from '../../src/publisher/projection';
import { itemWorld } from '../items';
import { addProject, resetRecords } from '../units';

/**
 * Validates R24.1, R24.2, R24.4, R24.11, R24.12, R25.2, R25.3, R29.1, R30.7, R30.8, R36.9, R40.4, R46.7,
 * R46.30: the Publisher CONVERGES the materialized public state to exactly the kernel's projection of the
 * current Workspace state — no more and no less — regardless of how the confidentiality-affecting saves were
 * batched into runs, which runs were urgent, how the epoch preempted an in-flight addition run, where the
 * slice boundaries fell, or whether an already-processed generation was re-run. The independent model is a
 * full `projectDetailed` of the FINAL Workspace state (every Public/Withheld unit and Project with its view
 * hash, and nothing Not_Published); the Publisher reaches it by draining a stream of `publish` rows under a
 * randomised interleaving of runs — some preempted by an advanced epoch, one re-running an old generation.
 * After quiescence the current open `public_views` set (unit_key → effective + view_hash) EQUALS that model:
 * every current Public/Withheld view present with the right hash, no suppressed/removed view resurrected, and
 * no stale version left open. The convergence-under-interruption case interleaves and resumes a run and the
 * stale-generation case asserts a run that observed an earlier epoch cannot re-add a suppressed view, both
 * reaching the same fixed point as an uninterrupted drain. Finally, two drain orderings that reach the same
 * final views render the identical `site_files` manifest, because the rendered file set is a pure function of
 * the current views (R24.4, R29.1, R40.4). The model is authored here from `projectDetailed`, never by reading
 * back the Publisher's own SQL.
 */

const LICENCE = { name: 'Synthetic Licence 1.0', url: 'https://licence.example.test/1.0' } as const;
// A spread of kinds whose synthetic body passes the create API without extra required relations.
const KINDS: readonly ItemKind[] = ['finding', 'journal_entry', 'hypothesis', 'run', 'topic'];
/** The disclosure a unit settles on; `withheld` carries a Disclosure_Line, `restricted` stays off the public site. */
type Level = 'public' | 'withheld' | 'not_published' | 'restricted';
const LEVELS: readonly Level[] = ['public', 'withheld', 'not_published', 'restricted'];
const SYNTHETIC_LINE = JSON.stringify({ kindOfMaterial: 'Synthetic material', date: { value: '2026-10-01', approx: false }, partyIds: [] });

const world = itemWorld();
const core = (): D1Database => world.bindings.RF_CORE;
const pub = (): D1Database => world.bindings.RF_PUBLIC;
const priv = (): R2Bucket => world.bindings.RF_PRIVATE_BUCKET;
const NOW = () => world.at;
const deps = (): ProjectionDeps => ({ core: core(), public: pub() });

beforeEach(async () => {
  await core().batch([core().prepare("DELETE FROM outbox WHERE topic = 'publish'"), core().prepare("DELETE FROM counters WHERE k = 'epoch'")]);
  await pub().batch([pub().prepare('DELETE FROM public_views'), pub().prepare('DELETE FROM publish_runs'), pub().prepare('DELETE FROM site_files')]);
});

/**
 * `beforeEach` fires once per `it`, but fast-check runs each property body many times; clear every store and
 * open a fresh Public Project at the start of each iteration so runs do not accumulate each other's units. The
 * author Member (and its token) persists, so `world.created` keeps working. Returns the fresh Project id.
 */
async function freshRecords(): Promise<ULID> {
  await resetRecords(core());
  await core().batch([core().prepare("DELETE FROM outbox WHERE topic = 'publish'"), core().prepare("DELETE FROM counters WHERE k = 'epoch'")]);
  await pub().batch([pub().prepare('DELETE FROM public_views'), pub().prepare('DELETE FROM publish_runs'), pub().prepare('DELETE FROM site_files')]);
  const projectId = await addProject(core(), world.ids.admin, NOW());
  await core().prepare("UPDATE projects SET disclosure_level = 'public' WHERE id = ?1").bind(projectId).run();
  (world as { projectId: ULID }).projectId = projectId;
  return projectId;
}

/** Append one `publish` row at `changeSeq`; an urgent save bumps the epoch in the same batch, as a real save does. */
async function publish(scope: string, changeSeq: number, urgent: boolean): Promise<void> {
  const batch = new GuardedBatch(core(), { id: null, now: NOW() }, { ignoreFreeze: true });
  if (urgent) batch.bumpEpoch();
  await batch.commit();
  await core().prepare("INSERT INTO outbox (topic, scope, change_seq, created_at) VALUES ('publish', ?1, ?2, ?3)").bind(scope, changeSeq, NOW()).run();
}

/** Set a unit's stored disclosure the way a save does: Not_Published/public clears the line, Withheld writes one. */
async function setLevel(id: ULID, level: Level): Promise<void> {
  const stored = level === 'restricted' ? 'not_published' : level;
  const line = level === 'withheld' ? SYNTHETIC_LINE : null;
  await core().prepare('UPDATE units SET disclosure_level = ?2, disclosure_line = ?3 WHERE id = ?1').bind(id, stored, line).run();
  if (level === 'restricted') await core().prepare("UPDATE research_items SET access_level = 'restricted' WHERE unit_id = ?1").bind(id).run();
  else await core().prepare("UPDATE research_items SET access_level = 'whole_team' WHERE unit_id = ?1").bind(id).run();
}

/** The current open Public_Views as the convergence invariant compares them: unit key → effective + view hash. */
async function materializedViews(): Promise<Map<string, { effective: string; hash: string }>> {
  const rows = (await pub().prepare('SELECT unit_key AS key, effective, view_hash AS hash FROM public_views WHERE valid_to_at IS NULL')
    .all<{ key: string; effective: string; hash: string }>()).results;
  return new Map(rows.map((row) => [row.key, { effective: row.effective, hash: row.hash }]));
}

/** SHA-256 of the canonical Public_View, exactly as the projection step hashes a stored view. */
async function viewHash(view: PublicView): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(view))));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The independent model: a full projection of the FINAL Workspace state. Every Public or Withheld unit and
 * Project is expected with its effective level and view hash; Not_Published (and Restricted-not-public) units
 * are absent. Authored from `projectDetailed`, never from the Publisher's materialized rows.
 */
async function expectedViews(rootIds: readonly ULID[], projectId: ULID): Promise<Map<string, { effective: string; hash: string }>> {
  const { input } = await loadProjectionInput(core(), rootIds, NOW(), { projectIds: [projectId] });
  const projection = projectDetailed(input);
  const expected = new Map<string, { effective: string; hash: string }>();
  for (const [key, level] of projection.levels) {
    if (level !== 'public' && level !== 'withheld') continue;
    expected.set(key, { effective: level, hash: await viewHash(projection.views.get(key as UnitKey)!) });
  }
  return expected;
}

/** No stale version is left open: each unit key has at most one current (`valid_to_at IS NULL`) row. */
async function noDoubleOpen(): Promise<boolean> {
  const row = await pub().prepare('SELECT count(*) AS n FROM (SELECT unit_key FROM public_views WHERE valid_to_at IS NULL GROUP BY unit_key HAVING count(*) > 1)')
    .first<{ n: number }>();
  return (row?.n ?? 0) === 0;
}

/** Drain the publish outbox to quiescence under the given run plan, then guarantee a final current-epoch drain. */
async function drain(plan: readonly { run: string; epochDelta: number }[]): Promise<void> {
  // The randomised plan models arbitrary batching, preemption (a run that observed an earlier epoch), and a
  // re-run of an already-processed generation. A preempted or stale run does no addition work; it never
  // resurrects a suppressed view. `epochDelta` below 0 makes a run stale on purpose.
  for (const step of plan) {
    const epoch = Math.max(0, (await readEpoch(core())) + step.epochDelta);
    // Bounded: a few slices per planned run, mirroring the DO's slice loop.
    for (let slice = 0; slice < 4; slice += 1) {
      const result = await runProjectionSlice(deps(), { run: step.run, epoch }, NOW());
      if (!result.more) break;
    }
  }
  // Whatever the plan did, a current generation finally drains every remaining pending row to the fixed point.
  for (let slice = 0; slice < 64; slice += 1) {
    const gen: Generation = { run: `final-${slice}`, epoch: await readEpoch(core()) };
    const result = await runProjectionSlice(deps(), gen, NOW());
    if (!result.more && result.processed === 0) break;
  }
}

describe('Property 15: Publisher convergence', () => {
  it('converges the materialized Public_Views to the kernel projection of the final state under any batching', async () => {
    const itemArb = fc.record({
      kind: fc.constantFrom(...KINDS),
      initial: fc.constantFrom(...LEVELS),
      // A sequence of later changes to this unit: re-level, or edit the title (a content change).
      changes: fc.array(fc.oneof(
        fc.record({ op: fc.constant('level' as const), level: fc.constantFrom(...LEVELS) }),
        fc.record({ op: fc.constant('edit' as const) }),
      ), { maxLength: 3 }),
    });
    // The run plan: a mix of current drains, a stale run (negative delta), and an urgent-preempted run.
    const planArb = fc.array(fc.record({
      run: fc.constantFrom('a', 'b', 'c', 'repeat'),
      epochDelta: fc.constantFrom(0, 0, 0, -1, -2),
    }), { minLength: 1, maxLength: 6 });
    // Whether a Project-level change fires, moving every unit under it.
    const projectArb = fc.option(fc.constantFrom('public', 'not_published') as fc.Arbitrary<'public' | 'not_published'>, { nil: undefined });

    await fc.assert(fc.asyncProperty(fc.array(itemArb, { minLength: 1, maxLength: 6 }), planArb, projectArb, async (items, plan, projectLevel) => {
      const projectId = await freshRecords();
      let seq = 0;
      const rootIds: ULID[] = [];
      // The Project's own publication is a confidentiality-affecting save with its own `project:` publish row;
      // without it the Publisher never materializes the Project view (a `root:` scope reprojects only its units).
      seq += 1;
      await publish(`project:${projectId}`, seq, false);

      for (const spec of items) {
        const item = await world.created('author', spec.kind as ItemKind);
        rootIds.push(item.id);
        // The publish of the unit at its initial level: an addition (not urgent) from Not_Published.
        await setLevel(item.id, spec.initial);
        seq += 1;
        await publish(`root:${item.id}`, seq, false);

        // Each later change: re-levelling off a public/withheld state, or editing public content, is urgent.
        let current: Level = spec.initial;
        for (const change of spec.changes) {
          const wasVisible = current === 'public' || current === 'withheld';
          if (change.op === 'level') {
            await setLevel(item.id, change.level);
            current = change.level;
          } else {
            await core().prepare('UPDATE research_items SET title = ?2 WHERE unit_id = ?1').bind(item.id, `Edited ${item.id} ${seq}`).run();
          }
          seq += 1;
          await publish(`root:${item.id}`, seq, wasVisible);
        }
      }

      // An optional Project-level change moves every unit under the Project (R24.11, R24.12).
      if (projectLevel !== undefined) {
        await core().prepare('UPDATE projects SET disclosure_level = ?1, disclosure_line = ?2 WHERE id = ?3')
          .bind(projectLevel, projectLevel === 'not_published' ? null : SYNTHETIC_LINE, projectId).run();
        seq += 1;
        await publish(`project:${projectId}`, seq, true);
      }

      await drain(plan);

      const expected = await expectedViews(rootIds, projectId);
      const got = await materializedViews();
      // No more, no less: the materialized current set equals the projection of the final state, key for key.
      expect([...got.keys()].sort()).toEqual([...expected.keys()].sort());
      for (const [key, want] of expected) expect(got.get(key)).toEqual(want);
      // No suppressed view resurrected: nothing current that the projection does not keep.
      for (const key of got.keys()) expect(expected.has(key)).toBe(true);
      // No stale version left open.
      expect(await noDoubleOpen()).toBe(true);
    }), { numRuns: FC_RUNS });
  }, 4000 * FC_RUNS);

  it('reaches the same fixed point whether a run is interrupted and resumed or drained in one pass, and a stale run cannot resurrect a suppressed view', async () => {
    // A focused interruption/stale scenario shaped like publisher-projection.test.ts: publish a unit, suppress
    // it under an advanced epoch, and show a stale generation (observed an earlier epoch) cannot re-add it.
    await fc.assert(fc.asyncProperty(fc.constantFrom('finding', 'hypothesis', 'journal_entry') as fc.Arbitrary<ItemKind>, async (kind) => {
      const projectId = await freshRecords();
      const item = await world.created('author', kind);
      // The create save writes its own Not_Published publish rows; clear them so this scenario's sequence is exact.
      await core().prepare("DELETE FROM outbox WHERE topic = 'publish'").run();
      await setLevel(item.id, 'public');
      await publish(`project:${projectId}`, 1, false); // the Project's own publication row
      await publish(`root:${item.id}`, 2, false);
      // Interrupt: one bounded slice under the current epoch brings the views current.
      const first = await runProjectionSlice(deps(), { run: 'r1', epoch: await readEpoch(core()) }, NOW());
      expect(first.processed).toBe(2);
      expect((await materializedViews()).has(unitKey(item.id))).toBe(true);

      // The unit is suppressed and an urgent save advances the epoch.
      await setLevel(item.id, 'not_published');
      const staleEpoch = await readEpoch(core());
      await publish(`unit:${item.id}`, 3, true);

      // A stale generation (observed the earlier epoch) is preempted and cannot resurrect the suppressed view.
      const stale = await runProjectionSlice(deps(), { run: 'stale', epoch: staleEpoch }, NOW());
      expect(stale.preempted).toBe(true);
      expect((await materializedViews()).has(unitKey(item.id))).toBe(true); // still the old view; not resurrected

      // Resume under the current generation: it suppresses the view, reaching the fixed point.
      await drain([]);
      const expected = await expectedViews([item.id], projectId);
      const got = await materializedViews();
      expect(got.has(unitKey(item.id))).toBe(false);
      expect([...got.keys()].sort()).toEqual([...expected.keys()].sort());
      for (const [key, want] of expected) expect(got.get(key)).toEqual(want);
      expect(await noDoubleOpen()).toBe(true);
    }), { numRuns: Math.min(FC_RUNS, 20) });
  }, 4000 * FC_RUNS);

  it('renders the identical site_files manifest for two drain orderings that reach the same final views', async () => {
    // The rendered file set and manifest are a pure function of the current views, so two paths to the same
    // final views produce byte-identical manifests (R24.4, R29.1, R40.4).
    await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom(...KINDS), { minLength: 1, maxLength: 4 }), async (kinds) => {
      const renderDeps = () => ({ core: core(), public: pub(), privateBucket: priv(), licence: LICENCE, shellAssets: [] });
      const manifestSnapshot = async (): Promise<[string, string, number][]> =>
        (await pub().prepare('SELECT path, hash, size FROM site_files ORDER BY path').all<{ path: string; hash: string; size: number }>())
          .results.map((row) => [row.path, row.hash, row.size]);

      // Ordering A: publish the Project then each unit public one at a time, draining per step, then render.
      const projectId = await freshRecords();
      let seq = 0;
      seq += 1;
      await publish(`project:${projectId}`, seq, false);
      await drain([{ run: 'a0', epochDelta: 0 }]);
      for (const kind of kinds) {
        const item = await world.created('author', kind);
        await setLevel(item.id, 'public');
        seq += 1;
        await publish(`root:${item.id}`, seq, false);
        await drain([{ run: `a${seq}`, epochDelta: 0 }]); // drain each unit in its own run
      }
      await renderSiteBuild(renderDeps(), NOW());
      const manifestA = await manifestSnapshot();

      // Ordering B: reset the public store and reproject the SAME final state in one combined Project run, then render.
      await pub().batch([pub().prepare('DELETE FROM public_views'), pub().prepare('DELETE FROM site_files')]);
      await core().prepare("DELETE FROM outbox WHERE topic = 'publish'").run();
      seq += 1;
      await publish(`project:${projectId}`, seq, false);
      await drain([{ run: 'b', epochDelta: 0 }]);
      await renderSiteBuild(renderDeps(), NOW());
      const manifestB = await manifestSnapshot();

      // Same final views ⇒ byte-identical manifest (path, Direct Upload hash, size).
      expect(manifestB).toEqual(manifestA);
    }), { numRuns: Math.min(FC_RUNS, 15) });
  }, 6000 * FC_RUNS);
});
