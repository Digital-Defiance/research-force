import { beforeEach, describe, expect, it } from 'vitest';
import { newULID } from '@researchforce/domain/identifiers';
import { errorOf, itemWorld } from './items';
import type { ItemView } from './items';

// Integration tests for the Research_Release API of task 66.2: the real /releases routes mounted in the versioned app,
// under the global operation keys, with the publish/withdraw transitions that route public output through the Publisher's
// normal gates (no release-only publish bypass). The publisher-level removal of a suppressed release artifact is proved in
// releases-publisher.test.ts; here we prove the route surface, the operation keys, the rev/dependency guards, and that
// publication/withdrawal only hand scopes to the Publisher rather than writing the public site directly.

const MANIFEST_KEY = 'synthetic-release-manifest-key';
const world = itemWorld();
type Who = 'author' | 'colleague' | 'admin';
const NEW = { name: 'Spring release', scope: 'The private scope.', rationale: 'The private rationale.', licenceVersion: 'cc-by-4.0' };
let serial = 0;
const keyOf = (label: string) => `${label}-${(serial++).toString().padStart(4, '0')}-${newULID(world.at)}`.slice(0, 50);

beforeEach(() => { world.bindings.RELEASE_MANIFEST_KEY = MANIFEST_KEY; serial = 0; });

const keyed = (who: Who, key: string, method: string, path: string, body?: unknown) => world.request(who, method, path, body, { 'Idempotency-Key': key });
const rev = async (id: string) => (await world.core().prepare('SELECT rev FROM research_releases WHERE id = ?1').bind(id).first<number>('rev'))!;
const stateOf = async (id: string) => world.core().prepare('SELECT state FROM research_releases WHERE id = ?1').bind(id).first<string>('state');
const publishRows = async (): Promise<string[]> =>
  (await world.core().prepare("SELECT scope FROM outbox WHERE topic = 'publish' ORDER BY seq").all<{ scope: string }>()).results.map((row) => row.scope);
const clearPublish = () => world.core().prepare("DELETE FROM outbox WHERE topic = 'publish'").run();

const make = async (who: Who = 'admin') => {
  const response = await keyed(who, keyOf('create'), 'POST', '/releases', NEW);
  if (response.status !== 201) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json<{ id: string }>()).id;
};
const fill = (id: string, revStart: number, artifacts: unknown[], who: Who = 'admin') =>
  keyed(who, keyOf('fill'), 'PATCH', `/releases/${id}/artifacts`, { rev: revStart, artifacts });
const approve = (id: string, who: Who, body: Record<string, unknown>) => keyed(who, keyOf('approve'), 'POST', `/releases/${id}/approvals`, body);
const seal = (id: string, expected: number, who: Who = 'admin') => keyed(who, keyOf('seal'), 'POST', `/releases/${id}/seal`, { rev: expected });

/** A sealed release with one public finding (Owner-, rights- and Administrator-approved) and one restricted finding kept internal. */
async function sealed(): Promise<{ id: string; finding: ItemView; secret: ItemView }> {
  const finding = await world.created('author', 'finding', { title: 'A public finding' });
  const secret = await world.created('author', 'finding', { title: 'A private finding', access: { level: 'restricted', members: [] } });
  const id = await make();
  expect((await fill(id, 1, [{ kind: 'record', unitId: finding.id, publicApproved: true }, { kind: 'record', unitId: secret.id }])).status).toBe(200);
  expect((await approve(id, 'author', { kind: 'owner', unitId: finding.id })).status).toBe(200);
  expect((await approve(id, 'admin', { kind: 'rights', unitId: finding.id })).status).toBe(200);
  expect((await approve(id, 'admin', { kind: 'administrator' })).status).toBe(200);
  expect((await seal(id, await rev(id))).status).toBe(200);
  await clearPublish();
  return { id, finding, secret };
}

describe('the /releases API under operation keys (R59.1, R60.2)', () => {
  it('runs create → artifacts → approve → seal through the mounted routes, Administrator-only', async () => {
    expect((await keyed('author', keyOf('c'), 'POST', '/releases', NEW)).status).toBe(403);
    const { id, finding } = await sealed();
    expect(await stateOf(id)).toBe('sealed');
    const view = await (await world.request('admin', 'GET', `/releases/${id}`)).json<{ release: { artifacts: { unitId: string }[] } }>();
    expect(view.release.artifacts.map((a) => a.unitId)).toContain(finding.id);
    const manifest = await (await world.request('admin', 'GET', `/releases/${id}/manifest`)).json<{ authentic: boolean }>();
    expect(manifest.authentic).toBe(true);
  });

  it('lists releases for an Administrator and refuses a Contributor', async () => {
    const { id } = await sealed();
    const list = await world.request('admin', 'GET', '/releases');
    expect(list.status).toBe(200);
    expect((await list.json<{ releases: { id: string }[] }>()).releases.map((r) => r.id)).toContain(id);
    expect((await world.request('author', 'GET', '/releases')).status).toBe(403);
  });

  it('errors clearly when the manifest signing key is not configured', async () => {
    delete world.bindings.RELEASE_MANIFEST_KEY;
    const finding = await world.created('author', 'finding');
    const id = await make();
    await fill(id, 1, [{ kind: 'record', unitId: finding.id, publicApproved: true }]);
    await approve(id, 'author', { kind: 'owner', unitId: finding.id });
    await approve(id, 'admin', { kind: 'rights', unitId: finding.id });
    await approve(id, 'admin', { kind: 'administrator' });
    expect((await seal(id, await rev(id))).status).toBe(500);
    expect(await stateOf(id)).toBe('draft');
  });

  it('replays a publish under the same operation key and body without publishing twice', async () => {
    const { id } = await sealed();
    const key = keyOf('publish');
    const body = { rev: await rev(id) };
    const first = await keyed('admin', key, 'POST', `/releases/${id}/publish`, body);
    expect(first.status).toBe(200);
    expect(await stateOf(id)).toBe('published');
    const scopesAfterFirst = await publishRows();
    // The same key with the same body replays the recorded result rather than running the publish again.
    const replay = await keyed('admin', key, 'POST', `/releases/${id}/publish`, body);
    expect(replay.status).toBe(200);
    expect(replay.headers.get('Idempotency-Replayed')).toBe('true');
    expect(await stateOf(id)).toBe('published');
    expect(await publishRows()).toEqual(scopesAfterFirst);
  });
});

describe('publication and withdrawal transitions (R59.2, R59.3)', () => {
  it('moves sealed → published → withdrawn only in order, under the current revision', async () => {
    const { id } = await sealed();
    // A draft/sealed release cannot be withdrawn, and a stale revision is refused.
    expect((await keyed('admin', keyOf('w'), 'POST', `/releases/${id}/withdraw`, { rev: await rev(id) })).status).toBe(409);
    expect((await keyed('admin', keyOf('p'), 'POST', `/releases/${id}/publish`, { rev: 999 })).status).toBe(409);

    expect((await keyed('admin', keyOf('p'), 'POST', `/releases/${id}/publish`, { rev: await rev(id) })).status).toBe(200);
    expect(await stateOf(id)).toBe('published');
    // Publishing an already-published release is refused.
    expect((await keyed('admin', keyOf('p2'), 'POST', `/releases/${id}/publish`, { rev: await rev(id) })).status).toBe(409);

    expect((await keyed('admin', keyOf('w'), 'POST', `/releases/${id}/withdraw`, { rev: await rev(id) })).status).toBe(200);
    expect(await stateOf(id)).toBe('withdrawn');
    expect((await keyed('author', keyOf('w'), 'POST', `/releases/${id}/withdraw`, { rev: await rev(id) })).status).toBe(403);
  });

  it('hands only the approved-public artifacts\u2019 roots to the Publisher, never the internal ones', async () => {
    const { id, finding, secret } = await sealed();
    expect((await keyed('admin', keyOf('p'), 'POST', `/releases/${id}/publish`, { rev: await rev(id) })).status).toBe(200);
    const scopes = await publishRows();
    // The public finding's root is handed to the Publisher; the restricted (internal-only) artifact's root is not.
    expect(scopes).toContain(`root:${finding.id}`);
    expect(scopes).not.toContain(`root:${secret.id}`);
    // Publication wrote no public_views/site_files itself: it only enqueued Publisher work.
    expect((await world.bindings.RF_PUBLIC.prepare('SELECT count(*) AS n FROM public_views').first<{ n: number }>())?.n ?? 0).toBe(0);
    expect((await world.bindings.RF_PUBLIC.prepare('SELECT count(*) AS n FROM site_files').first<{ n: number }>())?.n ?? 0).toBe(0);
  });

  it('advances the publication epoch on withdrawal so the removal is urgent and fenced', async () => {
    const { id } = await sealed();
    await keyed('admin', keyOf('p'), 'POST', `/releases/${id}/publish`, { rev: await rev(id) });
    const before = (await world.core().prepare("SELECT coalesce((SELECT v FROM counters WHERE k = 'epoch'), 0) AS v").first<{ v: number }>())!.v;
    await clearPublish();
    expect((await keyed('admin', keyOf('w'), 'POST', `/releases/${id}/withdraw`, { rev: await rev(id) })).status).toBe(200);
    const after = (await world.core().prepare("SELECT coalesce((SELECT v FROM counters WHERE k = 'epoch'), 0) AS v").first<{ v: number }>())!.v;
    expect(after).toBe(before + 1); // an urgent removal bumps the epoch exactly once
    expect(await publishRows()).toContain(`root:${await world.core().prepare('SELECT root_id AS r FROM release_artifacts WHERE release_id = ?1 AND public_approved = 1').bind(id).first<string>('r')}`);
  });
});

describe('publication rechecks the exact dependencies (R59.3, R59.5)', () => {
  it('refuses to publish a public artifact that drifted after sealing, naming no hidden detail', async () => {
    const { id, finding } = await sealed();
    const edited = await world.edit('author', finding.id as string, { rev: finding['rev'], mark: { mark: 'correction', reason: 'Synthetic.' }, claim: { text: 'A corrected claim.', spans: [] } });
    expect(edited.status).toBe(200);
    const refused = await errorOf(await keyed('admin', keyOf('p'), 'POST', `/releases/${id}/publish`, { rev: await rev(id) }));
    expect(refused.status).toBe(422);
    expect(refused.fields?.map((f) => f.field)).toContain('artifacts.0');
    expect(JSON.stringify(refused)).not.toContain('A corrected claim.');
    expect(await stateOf(id)).toBe('sealed');
  });
});
