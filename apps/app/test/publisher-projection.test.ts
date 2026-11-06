import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GuardedBatch } from '@researchforce/db/batch';
import { projectKey, unitKey } from '@researchforce/kernel/views';
import type { Generation } from '@researchforce/db/publication-epoch';
import type { ULID } from '@researchforce/domain/types';
import { createLogger } from '../src/log';
import { kick } from '../src/outbox';
import { expandScopesToRoots, runProjectionSlice } from '../src/publisher/projection';
import type { ProjectionDeps } from '../src/publisher/projection';
import { itemWorld } from './items';

const world = itemWorld();
const core = () => world.core();
const pub = () => world.bindings.RF_PUBLIC;
const NOW = () => world.at;
const deps = (): ProjectionDeps => ({ core: core(), public: pub() });
const gen = (run: string, epoch: number): Generation => ({ run, epoch });

/** Make a Research_Item (and its Project) Public, so the kernel projects it. */
const makePublic = async (id: ULID): Promise<void> => {
  await core().prepare("UPDATE units SET disclosure_level = 'public' WHERE id = ?1").bind(id).run();
  await core().prepare("UPDATE projects SET disclosure_level = 'public'").run();
};
/** Clear the `publish` rows item setup wrote, so each test drives projection from its own rows only. */
const clearPublish = () => core().prepare("DELETE FROM outbox WHERE topic = 'publish'").run();
const publishRow = async (scope: string, changeSeq = 1) => {
  await clearPublish();
  await core().prepare("INSERT INTO outbox (topic, scope, change_seq, created_at) VALUES ('publish', ?1, ?2, ?3)").bind(scope, changeSeq, world.at).run();
};

/** The current (open) Public_View rows, by unit key. */
const currentViews = async () =>
  (await pub().prepare('SELECT unit_key AS key, effective, view_hash AS hash, valid_from AS validFrom FROM public_views WHERE valid_to_at IS NULL ORDER BY unit_key')
    .all<{ key: string; effective: string; hash: string; validFrom: number }>()).results;
const versionsOf = async (key: string) =>
  (await pub().prepare('SELECT effective, valid_from AS validFrom, valid_to_at AS validTo, view_hash AS hash FROM public_views WHERE unit_key = ?1 ORDER BY valid_from')
    .bind(key).all<{ effective: string; validFrom: number; validTo: string | null; hash: string }>()).results;

beforeEach(async () => {
  await core().batch([
    core().prepare("DELETE FROM outbox WHERE topic = 'publish'"),
    core().prepare("DELETE FROM counters WHERE k = 'epoch'"),
  ]);
  await pub().batch([pub().prepare('DELETE FROM public_views'), pub().prepare('DELETE FROM publish_runs')]);
});

describe('dirty-scope expansion to Root_Items', () => {
  it('resolves unit, root, and project scopes to the Root_Items they touch', async () => {
    const finding = await world.created('author', 'finding');
    const section = await world.created('author', 'journal_entry');
    const sectionUnit = await core().prepare("SELECT id FROM units WHERE root_id = ?1 AND unit_type = 'entry_section' LIMIT 1").bind(section.id).first<{ id: ULID }>();
    const rows = [
      { seq: 1, scope: `root:${finding.id}`, changeSeq: 1, createdAt: world.at },
      { seq: 2, scope: `unit:${sectionUnit!.id}`, changeSeq: 1, createdAt: world.at },
      { seq: 3, scope: `project:${world.projectId}`, changeSeq: 1, createdAt: world.at },
    ];
    const { roots, projects } = await expandScopesToRoots(core(), rows);
    expect([...roots].sort()).toEqual([finding.id, section.id].sort());
    expect([...projects]).toEqual([world.projectId]);
  });

  it('follows a Cross_Link to the neighbour Root_Item, so a Research_Question re-renders when an entry’s target changes (R50.5)', async () => {
    const finding = await world.created('author', 'finding');
    // A Research_Question whose Question_Group entry Addresses the Finding (an Addresses Cross_Link, R50.2).
    const question = await world.created('author', 'research_question', { groups: [{ heading: 'G', entries: [{ targetId: finding.id }] }] });
    // A change under the target's Root_Item expands to the question's Root_Item through the Cross_Link.
    const { roots } = await expandScopesToRoots(core(), [{ seq: 1, scope: `unit:${finding.id}`, changeSeq: 1, createdAt: world.at }]);
    expect([...roots].sort()).toEqual([finding.id, question.id].sort());
    // And the reverse: a change under the question's Root_Item expands to the target.
    const back = await expandScopesToRoots(core(), [{ seq: 1, scope: `root:${question.id}`, changeSeq: 1, createdAt: world.at }]);
    expect([...back.roots].sort()).toEqual([finding.id, question.id].sort());
  });
});

describe('versioned Public_Views', () => {
  it('writes a new version for a Public unit and its Project', async () => {
    const finding = await world.created('author', 'finding');
    await makePublic(finding.id);
    await publishRow(`root:${finding.id}`);
    const result = await runProjectionSlice(deps(), gen('r1', 0), NOW());
    expect(result.processed).toBe(1);
    const views = await currentViews();
    // A `root:` scope reprojects the Root_Item's units, not the Project view (the Project itself is unchanged).
    expect(views.map((v) => v.key)).toEqual([unitKey(finding.id)]);
    expect(views.every((v) => v.effective === 'public')).toBe(true);
  });

  it('writes the Project view when a project scope fires', async () => {
    const finding = await world.created('author', 'finding');
    await makePublic(finding.id);
    await publishRow(`project:${world.projectId}`);
    await runProjectionSlice(deps(), gen('r1', 0), NOW());
    const views = await currentViews();
    expect(views.map((v) => v.key).sort()).toEqual([projectKey(world.projectId), unitKey(finding.id)].sort());
  });

  it('closes the old version and opens a new one when a view changes', async () => {
    const finding = await world.created('author', 'finding');
    await makePublic(finding.id);
    await publishRow(`root:${finding.id}`, 1);
    await runProjectionSlice(deps(), gen('r1', 0), NOW());
    const before = await versionsOf(unitKey(finding.id));
    expect(before).toHaveLength(1);

    // Edit the title so the projected view differs, then reproject at a later sequence.
    await core().prepare("UPDATE research_items SET title = 'A changed synthetic title' WHERE unit_id = ?1").bind(finding.id).run();
    await publishRow(`root:${finding.id}`, 2);
    const result = await runProjectionSlice(deps(), gen('r2', 0), NOW());
    expect(result.urgent).toBe(true); // an existing public view changed
    const versions = await versionsOf(unitKey(finding.id));
    expect(versions).toHaveLength(2);
    expect(versions[0]!.validTo).not.toBeNull(); // prior version closed
    expect(versions[1]!.validTo).toBeNull(); // new version current
    expect(versions[1]!.validFrom).toBe(2);
    expect(versions[1]!.hash).not.toBe(versions[0]!.hash);
  });

  it('closes the current version with no new row when a unit becomes Not_Published', async () => {
    const finding = await world.created('author', 'finding');
    await makePublic(finding.id);
    await publishRow(`root:${finding.id}`, 1);
    await runProjectionSlice(deps(), gen('r1', 0), NOW());
    expect(await versionsOf(unitKey(finding.id))).toHaveLength(1);

    await core().prepare("UPDATE units SET disclosure_level = 'not_published' WHERE id = ?1").bind(finding.id).run();
    await publishRow(`root:${finding.id}`, 2);
    const result = await runProjectionSlice(deps(), gen('r2', 0), NOW());
    expect(result.urgent).toBe(true);
    const versions = await versionsOf(unitKey(finding.id));
    expect(versions).toHaveLength(1); // no new row
    expect(versions[0]!.validTo).not.toBeNull(); // the current version was closed
    expect((await currentViews()).some((v) => v.key === unitKey(finding.id))).toBe(false);
  });

  it('re-renders a Research_Question page when one of its entries’ targets changes (R50.5)', async () => {
    const finding = await world.created('author', 'finding');
    const question = await world.created('author', 'research_question', { groups: [{ heading: 'G', entries: [{ targetId: finding.id }] }] });
    await makePublic(finding.id);
    await makePublic(question.id);
    // First projection: both pages exist, the question's view names the Finding's title.
    await publishRow(`project:${world.projectId}`, 1);
    await runProjectionSlice(deps(), gen('r1', 0), NOW());
    expect(await versionsOf(unitKey(question.id))).toHaveLength(1);

    // The Finding's title changes; only the Finding's own scope is published.
    await core().prepare("UPDATE research_items SET title = 'A renamed finding' WHERE unit_id = ?1").bind(finding.id).run();
    await publishRow(`unit:${finding.id}`, 2);
    const result = await runProjectionSlice(deps(), gen('r2', 0), NOW());
    expect(result.urgent).toBe(true);
    // The question page re-rendered through Cross_Link neighbour expansion, picking up the new title.
    expect(await versionsOf(unitKey(question.id))).toHaveLength(2);
    const current = await pub().prepare('SELECT view_json AS viewJson FROM public_views WHERE unit_key = ?1 AND valid_to_at IS NULL').bind(unitKey(question.id)).first<{ viewJson: string }>();
    expect(current!.viewJson).toContain('A renamed finding');
  });

  it('writes nothing when the view hash is unchanged', async () => {
    const finding = await world.created('author', 'finding');
    await makePublic(finding.id);
    await publishRow(`root:${finding.id}`, 1);
    await runProjectionSlice(deps(), gen('r1', 0), NOW());
    const first = await versionsOf(unitKey(finding.id));

    await publishRow(`root:${finding.id}`, 2); // reproject with no underlying change
    const result = await runProjectionSlice(deps(), gen('r2', 0), NOW());
    expect(result.urgent).toBe(false);
    expect(await versionsOf(unitKey(finding.id))).toEqual(first); // untouched
  });
});

describe('urgent classification', () => {
  it('is not urgent when a never-public unit first appears', async () => {
    const finding = await world.created('author', 'finding');
    await makePublic(finding.id);
    await publishRow(`root:${finding.id}`);
    const result = await runProjectionSlice(deps(), gen('r1', 0), NOW());
    expect(result.urgent).toBe(false); // pure addition
  });
});

describe('epoch fencing and preemption', () => {
  it('preempts an older addition generation once the epoch advances', async () => {
    const finding = await world.created('author', 'finding');
    await makePublic(finding.id);
    await publishRow(`root:${finding.id}`);
    // Advance the authoritative epoch to 2 (one bump per commit); the run observed epoch 1, so it is stale.
    await new GuardedBatch(core(), { id: null, now: NOW() }).bumpEpoch().commit();
    await new GuardedBatch(core(), { id: null, now: NOW() }).bumpEpoch().commit();
    const result = await runProjectionSlice(deps(), gen('stale', 1), NOW());
    expect(result.preempted).toBe(true);
    expect(result.processed).toBe(0); // the stale addition run did nothing
    expect(await currentViews()).toEqual([]); // and wrote no view
  });

  it('a stale generation cannot resurrect a suppressed (removed) view', async () => {
    const finding = await world.created('author', 'finding');
    await makePublic(finding.id);
    await publishRow(`root:${finding.id}`, 1);
    await runProjectionSlice(deps(), gen('r1', 0), NOW());
    expect((await currentViews()).some((v) => v.key === unitKey(finding.id))).toBe(true);

    // The unit is removed (Not_Published) and an urgent save advances the epoch.
    await core().prepare("UPDATE units SET disclosure_level = 'not_published' WHERE id = ?1").bind(finding.id).run();
    await new GuardedBatch(core(), { id: null, now: NOW() }).bumpEpoch().commit();
    await publishRow(`unit:${finding.id}`, 2);
    // A stale generation (observed epoch 0) is preempted and cannot re-add the suppressed view.
    const stale = await runProjectionSlice(deps(), gen('stale', 0), NOW());
    expect(stale.preempted).toBe(true);
    expect((await currentViews()).some((v) => v.key === unitKey(finding.id))).toBe(true); // still the old view; not resurrected by the stale run

    // The current generation (observed epoch 1) suppresses the view.
    const current = await runProjectionSlice(deps(), gen('current', 1), NOW());
    expect(current.urgent).toBe(true);
    expect((await currentViews()).some((v) => v.key === unitKey(finding.id))).toBe(false);
  });
});

describe('restore quarantine', () => {
  it('processes nothing while rf-core is frozen for a restore', async () => {
    const finding = await world.created('author', 'finding');
    await makePublic(finding.id);
    await publishRow(`root:${finding.id}`);
    // A LIVE Internal_Backup write-freeze lease (covering NOW()) holds rf-core frozen; the Publisher processes nothing.
    const expiry = new Date(Date.parse(NOW()) + 30_000).toISOString();
    const deadline = new Date(Date.parse(NOW()) + 120_000).toISOString();
    await core().prepare(`INSERT INTO write_freeze_leases (only, job_id, generation, acquired_at, expires_at, deadline_at, heartbeat_at, snapshot_seq, state)
      VALUES (1, 'restore-job', 1, ?1, ?2, ?3, ?1, 1, 'held')
      ON CONFLICT (only) DO UPDATE SET state = 'held', acquired_at = ?1, expires_at = ?2, deadline_at = ?3, heartbeat_at = ?1`)
      .bind(NOW(), expiry, deadline).run();
    try {
      const result = await runProjectionSlice(deps(), gen('r1', 0), NOW());
      expect(result).toMatchObject({ processed: 0, more: false });
      expect(await currentViews()).toEqual([]);
      // The publish rows stay pending until the restore clears.
      expect(await core().prepare("SELECT count(*) AS n FROM outbox WHERE topic = 'publish' AND done_at IS NULL").first('n')).toBe(1);
    } finally {
      await core().prepare("UPDATE write_freeze_leases SET state = 'incomplete' WHERE only = 1").run();
    }
  });
});

describe('the Publisher Durable Object', () => {
  it('drains the publish topic when kicked and records the run', async () => {
    const finding = await world.created('author', 'finding');
    await makePublic(finding.id);
    await publishRow(`root:${finding.id}`);
    await kick(world.bindings, ['publish'], createLogger());
    await vi.waitFor(async () => expect((await currentViews()).some((v) => v.key === unitKey(finding.id))).toBe(true), { timeout: 5000, interval: 50 });
    await vi.waitFor(async () => expect(await core().prepare("SELECT count(*) AS n FROM outbox WHERE topic = 'publish' AND done_at IS NULL").first('n')).toBe(0), { timeout: 5000, interval: 50 });
    // Projection drained the outbox and recorded its run. The run then moves on to the deploy phase (task 32.5);
    // completion depends on a real rf-ops deploy, so this projection-scoped test asserts only that the run started.
    await vi.waitFor(async () => expect(await pub().prepare('SELECT count(*) AS n FROM publish_runs WHERE started_at IS NOT NULL').first('n')).toBe(1), { timeout: 5000, interval: 50 });
  });
});
