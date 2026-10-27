import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GuardedBatch } from '@researchforce/db/batch';
import { submissions, units } from '@researchforce/db/schema/core';
import { PROJECT_ACCENT_IDS } from '@researchforce/design/tokens';
import { newULID } from '@researchforce/domain/identifiers';
import { BUILT_IN_ROLES, ROLE_IDS } from '@researchforce/domain/permissions';
import { asTimestamp, asULID } from '@researchforce/domain/types';
import type { ULID } from '@researchforce/domain/types';
import { assertionSpec, signAssertion, testAccess } from '@researchforce/testing/jwt';
import type { TestAccess } from '@researchforce/testing/jwt';
import type { Env } from '../src/env';
import type { ProjectRecord } from '../src/records/projects';
import { migrated } from './d1';
import { addMember, call, KeyServer, resetPeople, testApi } from './api';
import type { TestApi } from './api';

const t0 = new Date('2026-10-27T18:00:00.000Z');
const at = asTimestamp(t0.toISOString());
const accent = PROJECT_ACCENT_IDS[0]!;
let bindings: Env;
let access: TestAccess;
let api: TestApi;
let admin: string;
let adminId: ULID;
let deputy: string;
let contributor: string;
let contributorId: ULID;
const core = () => bindings.RF_CORE;
const token = (email: string) => signAssertion(access, assertionSpec(email), t0) as Promise<string>;
const snapshot = async () => JSON.stringify((await core().batch([
  core().prepare('SELECT * FROM projects ORDER BY id'), core().prepare("SELECT * FROM revisions WHERE target_type = 'project' ORDER BY id"), core().prepare('SELECT * FROM outbox ORDER BY seq'),
])).map((result) => result.results));

async function create(name: string, slug: string, by = admin): Promise<ProjectRecord> {
  const response = await call(api, bindings, by, 'POST', '/projects', { name, description: `About ${name}.`, slug });
  expect(response.status).toBe(201);
  return (await response.json<{ project: ProjectRecord }>()).project;
}
const edit = (by: string, project: { id: string }, body: unknown) => call(api, bindings, by, 'PATCH', `/projects/${project.id}`, body);
const move = (by: string, project: { id: string }, position: unknown) => call(api, bindings, by, 'POST', `/projects/${project.id}/move-position`, { position });
const list = async () => (await (await call(api, bindings, admin, 'GET', '/projects')).json<{ projects: (ProjectRecord & { muted: boolean; researchItems: number })[] }>()).projects;
const history = async (project: { id: string }) => (await (await call(api, bindings, contributor, 'GET', `/projects/${project.id}/history`)).json<{ history: Record<string, unknown>[] }>()).history;
const outboxScopes = async () => (await core().prepare('SELECT topic, scope FROM outbox ORDER BY seq').all<{ topic: string; scope: string }>()).results;

beforeAll(async () => {
  bindings = await migrated();
  access = await testAccess();
});
beforeEach(async () => {
  await resetPeople(core());
  await core().batch([core().prepare('DELETE FROM units'), core().prepare('DELETE FROM submissions'), core().prepare('DELETE FROM projects')]);
  adminId = await addMember(core(), 'admin@example.test', 'active', at, ROLE_IDS.administrator);
  contributorId = await addMember(core(), 'contributor@example.test', 'active', at);
  api = testApi(access, new KeyServer(access), t0);
  admin = await token('admin@example.test');
  contributor = await token('contributor@example.test');
  const role = await (await call(api, bindings, admin, 'POST', '/roles', { name: 'Deputy', permissions: BUILT_IN_ROLES.administrator.permissions })).json<{ role: { id: ULID } }>();
  await addMember(core(), 'deputy@example.test', 'active', at, role.role.id);
  deputy = await token('deputy@example.test');
  await core().prepare('DELETE FROM outbox').run();
});

describe('creating Projects', () => {
  it('creates a Private, unfeatured Project last in the Project_Order with its creator and time', async () => {
    const first = await create('Alpha', 'alpha');
    const second = await create('Beta', 'beta', deputy);
    expect(first).toEqual({
      id: first.id, name: 'Alpha', description: 'About Alpha.', slug: 'alpha', slugFixed: false, featured: false, accent: null, position: 0,
      disclosureLevel: 'private', disclosureLine: null, createdBy: adminId, createdAt: at, rev: 1,
    });
    expect(second).toMatchObject({ position: 1, disclosureLevel: 'private', featured: false });
    expect(await core().prepare('SELECT name_key FROM projects WHERE id = ?1').bind(first.id).first('name_key')).toBe('alpha');
    expect(await outboxScopes()).toEqual([{ topic: 'publish', scope: `project:${first.id}` }, { topic: 'publish', scope: `project:${second.id}` }]);
    expect((await list()).map((project) => project.id)).toEqual([first.id, second.id]);
  });

  it('refuses Contributors, duplicate names ignoring case, used slugs, and invalid fields without change', async () => {
    await create('Alpha', 'alpha');
    const before = await snapshot();
    expect((await call(api, bindings, contributor, 'POST', '/projects', { name: 'Gamma', description: 'About.', slug: 'gamma' })).status).toBe(403);
    const named = await call(api, bindings, admin, 'POST', '/projects', { name: 'ALPHA', description: 'About.', slug: 'other' });
    expect([named.status, await named.json()]).toEqual([422, { error: 'validation', fields: [{ field: 'name', rule: 'Project names must be unique ignoring letter case.' }] }]);
    const slugged = await call(api, bindings, admin, 'POST', '/projects', { name: 'Other', description: 'About.', slug: 'alpha' });
    expect([slugged.status, ((await slugged.json<{ fields: { field: string }[] }>()).fields).map((field) => field.field)]).toEqual([422, ['slug']]);
    for (const body of [{ name: '', description: 'About.', slug: 'x' }, { name: 'X', description: '', slug: 'x' }, { name: 'X', description: 'About.', slug: 'Not A Slug' }, { name: 'X', description: 'About.', slug: 'search' }]) {
      expect((await call(api, bindings, admin, 'POST', '/projects', body)).status).toBe(422);
    }
    expect(await snapshot()).toBe(before);
  });
});

describe('editing Projects', () => {
  it('saves details with a Minor_Edit Revision and shows each change before and after in the history', async () => {
    const project = await create('Alpha', 'alpha');
    const response = await edit(deputy, project, { rev: 1, name: 'Alpha Prime', featured: true });
    expect(response.status).toBe(200);
    expect((await response.json<{ project: ProjectRecord }>()).project).toMatchObject({ name: 'Alpha Prime', featured: true, slug: 'alpha', rev: 2 });
    await edit(admin, project, { rev: 2, description: 'Revised.', accent });
    expect(await outboxScopes()).toEqual(Array(3).fill({ topic: 'publish', scope: `project:${project.id}` }));
    const entries = await history(project);
    expect(entries).toEqual([
      { kind: 'minor_edit', memberId: adminId, displayName: `Member ${adminId}`, at, reason: null, changes: [{ field: 'description', before: 'About Alpha.', after: 'Revised.' }, { field: 'accent', before: null, after: accent }] },
      { kind: 'minor_edit', memberId: expect.any(String), displayName: expect.stringMatching(/^Member /u), at, reason: null, changes: [{ field: 'name', before: 'Alpha', after: 'Alpha Prime' }, { field: 'featured', before: false, after: true }] },
      { kind: 'creation', memberId: adminId, displayName: `Member ${adminId}`, at, values: {
        name: 'Alpha', description: 'About Alpha.', slug: 'alpha', featured: false, accent: null, position: 0, disclosureLevel: 'private', disclosureLine: null,
      } },
    ]);
  });

  it('records Disclosure_Change for level and Disclosure_Line changes', async () => {
    const project = await create('Alpha', 'alpha');
    const line = { text: 'A synthetic line.', spans: [] };
    await core().prepare("UPDATE projects SET disclosure_level = 'withheld', disclosure_line = ?1, rev = 2 WHERE id = ?2").bind(JSON.stringify(line), project.id).run();
    await core().prepare(`INSERT INTO revisions (id, target_type, target_id, kind, member_id, at, prev, seq) VALUES (?1, 'project', ?2, 'disclosure_change', ?3, ?4, ?5, 99)`)
      .bind(newULID(at), project.id, adminId, at, JSON.stringify({ disclosureLevel: 'private', disclosureLine: null })).run();
    const entries = await history(project);
    expect(entries[0]).toMatchObject({ kind: 'disclosure_change', changes: [{ field: 'disclosureLevel', before: 'private', after: 'withheld' }, { field: 'disclosureLine', before: null, after: line }] });
    expect(entries[1]).toMatchObject({ kind: 'creation', values: { disclosureLevel: 'private', disclosureLine: null } });
  });

  it('answers an unchanged save without a Revision and refuses a stale one with the Revisions since', async () => {
    const project = await create('Alpha', 'alpha');
    const before = await snapshot();
    expect((await (await edit(admin, project, { rev: 1, name: 'Alpha', slug: 'alpha' })).json<{ project: ProjectRecord }>()).project.rev).toBe(1);
    expect(await snapshot()).toBe(before);
    await edit(admin, project, { rev: 1, name: 'Changed' });
    const stale = await edit(deputy, project, { rev: 1, description: 'Mine.' });
    expect([stale.status, await stale.json()]).toEqual([409, { error: 'conflict', details: { rev: 2, revisions: [{ kind: 'minor_edit', memberId: adminId, displayName: `Member ${adminId}`, at }] } }]);
    expect((await edit(deputy, project, { rev: 1 })).status).toBe(409);
    expect((await list())[0]).toMatchObject({ name: 'Changed', description: 'About Alpha.', rev: 2 });
  });

  it('refuses the whole save when it changes a fixed Project_Slug', async () => {
    const project = await create('Alpha', 'alpha');
    await core().prepare('UPDATE projects SET slug_fixed_at = ?1 WHERE id = ?2').bind(at, project.id).run();
    const before = await snapshot();
    const response = await edit(admin, project, { rev: 1, name: 'Renamed', slug: 'renamed' });
    expect(response.status).toBe(422);
    expect((await response.json<{ fields: { field: string }[] }>()).fields.map((field) => field.field)).toEqual(['slug']);
    expect(await snapshot()).toBe(before);
    expect((await edit(admin, project, { rev: 1, name: 'Renamed', slug: 'alpha' })).status).toBe(200);
  });

  it('refuses a name or slug another Project uses', async () => {
    const alpha = await create('Alpha', 'alpha');
    await create('Beta', 'beta');
    const before = await snapshot();
    for (const body of [{ rev: 1, name: 'beta' }, { rev: 1, slug: 'beta' }]) expect((await edit(admin, alpha, body)).status).toBe(422);
    expect(await snapshot()).toBe(before);
    expect((await edit(admin, alpha, { rev: 1, name: 'Gamma Ray' })).status).toBe(200);
    expect(await core().prepare('SELECT name_key FROM projects WHERE id = ?1').bind(alpha.id).first('name_key')).toBe('gamma ray');
    const clash = await call(api, bindings, admin, 'POST', '/projects', { name: 'gamma ray', description: 'About.', slug: 'gamma' });
    expect((await clash.json<{ fields: { field: string }[] }>()).fields).toEqual([{ field: 'name', rule: 'Project names must be unique ignoring letter case.' }]);
  });

  it('lets only Administrators set or clear a Project_Accent, and only from the palette', async () => {
    const project = await create('Alpha', 'alpha');
    const before = await snapshot();
    for (const value of [accent, null]) expect((await edit(deputy, project, { rev: 1, accent: value })).status).toBe(403);
    expect((await edit(contributor, project, { rev: 1, name: 'Mine' })).status).toBe(403);
    const invented = await edit(admin, project, { rev: 1, accent: '#ff0000' });
    expect([invented.status, (await invented.json<{ fields: { field: string; rule: string }[] }>()).fields[0]]).toEqual([422, {
      field: 'accent', rule: `Only the Design System’s accent colours are allowed: ${PROJECT_ACCENT_IDS.join(', ')}.`,
    }]);
    expect(await snapshot()).toBe(before);
    expect((await (await edit(admin, project, { rev: 1, accent })).json<{ project: ProjectRecord }>()).project.accent).toBe(accent);
    expect((await (await edit(admin, project, { rev: 2, accent: null })).json<{ project: ProjectRecord }>()).project.accent).toBeNull();
  });

  it('answers 404 for unknown Projects and refuses unknown fields', async () => {
    const project = await create('Alpha', 'alpha');
    expect((await edit(admin, { id: newULID(at) }, { rev: 1 })).status).toBe(404);
    expect((await edit(admin, { id: 'nope' }, { rev: 1 })).status).toBe(404);
    expect((await call(api, bindings, admin, 'GET', '/projects/nope/history')).status).toBe(404);
    expect((await edit(admin, project, { rev: 1, position: 3 })).status).toBe(422);
    expect((await edit(admin, project, { name: 'No rev' })).status).toBe(422);
  });
});

describe('the Project_Order', () => {
  it('moves a Project, shifting those between, with a Minor_Edit Revision on each Project whose position changed', async () => {
    const projects = [await create('A', 'alpha'), await create('B', 'bravo'), await create('C', 'charlie'), await create('D', 'delta')];
    await core().prepare('DELETE FROM outbox').run();
    const moved = await move(deputy, projects[0]!, 2);
    expect((await moved.json<{ project: ProjectRecord }>()).project).toMatchObject({ position: 2, rev: 2 });
    expect((await list()).map((project) => [project.name, project.rev])).toEqual([['B', 2], ['C', 2], ['A', 2], ['D', 1]]);
    await move(admin, projects[3]!, 0);
    expect((await list()).map((project) => [project.name, project.position, project.rev])).toEqual([['D', 0, 2], ['B', 1, 3], ['C', 2, 3], ['A', 3, 3]]);
    const positions = async (project: { id: string }) => (await history(project)).map((entry) => entry['changes'] ?? (entry['values'] as { position: number }).position);
    expect(await positions(projects[0]!)).toEqual([[{ field: 'position', before: 2, after: 3 }], [{ field: 'position', before: 0, after: 2 }], 0]);
    expect(await positions(projects[1]!)).toEqual([[{ field: 'position', before: 0, after: 1 }], [{ field: 'position', before: 1, after: 0 }], 1]);
    expect(await positions(projects[3]!)).toEqual([[{ field: 'position', before: 3, after: 0 }], 3]);
    expect((await history(projects[1]!))[0]).toMatchObject({ kind: 'minor_edit', memberId: adminId });
    expect(await outboxScopes()).toEqual([{ topic: 'publish', scope: `project:${projects[0]!.id}` }, { topic: 'publish', scope: `project:${projects[3]!.id}` }]);
  });

  it('keeps the order a permutation when moves race, refusing any planned from a stale order', async () => {
    const projects = [await create('A', 'alpha'), await create('B', 'bravo'), await create('C', 'charlie'), await create('D', 'delta')];
    const responses = await Promise.all([move(admin, projects[0]!, 3), move(deputy, projects[3]!, 0), move(admin, projects[1]!, 2), move(deputy, projects[2]!, 0)]);
    expect(responses.every((response) => response.status === 200 || response.status === 409)).toBe(true);
    const positions = (await list()).map((project) => project.position);
    expect(positions).toEqual([0, 1, 2, 3]);
    const revisions = await core().prepare("SELECT count(DISTINCT seq) AS n FROM revisions WHERE target_type = 'project' AND target_id IN (SELECT value FROM json_each(?1))")
      .bind(JSON.stringify(projects.map((project) => project.id))).first<number>('n');
    expect(revisions).toBe(responses.filter((response) => response.status === 200).length);
  });

  it('refuses positions outside the order and Contributors, and leaves a move to the same place alone', async () => {
    const [a] = [await create('A', 'alpha'), await create('B', 'bravo')];
    const before = await snapshot();
    for (const position of [-1, 2, 0.5, '1']) expect((await move(admin, a!, position)).status).toBe(422);
    expect((await move(contributor, a!, 1)).status).toBe(403);
    expect((await move(admin, a!, 0)).status).toBe(200);
    expect(await snapshot()).toBe(before);
  });

  it('lists each Project with the viewer’s mute and its Research_Item count from completed Submissions', async () => {
    const [a, b] = [await create('A', 'alpha'), await create('B', 'bravo')];
    const done = newULID(at);
    const draft = newULID(at);
    const items = [newULID(at), newULID(at), newULID(at)];
    await new GuardedBatch(core(), { id: contributorId, now: at })
      .insert(submissions, [{ id: done, memberId: contributorId, kind: 'member', startedAt: at, completedAt: at }, { id: draft, memberId: contributorId, kind: 'member', startedAt: at, completedAt: null }])
      .insert(units, items.map((id, index) => ({ id, unitType: 'research_item' as const, projectId: a!.id, rootId: id, ownerId: contributorId, credit: [{ member: contributorId }], submissionId: index < 2 ? done : draft, createdAt: at })))
      .commit();
    expect((await call(api, bindings, admin, 'PUT', '/me/mutes', { projectIds: [b!.id] })).status).toBe(200);
    expect((await call(api, bindings, contributor, 'PUT', '/me/mutes', { projectIds: [a!.id] })).status).toBe(200);
    expect((await list()).map((project) => [project.name, project.muted, project.researchItems])).toEqual([['A', false, 2], ['B', true, 0]]);
    expect(asULID(a!.id)).toBe(a!.id);
  });
});
