import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { newULID } from '@researchforce/domain/identifiers';
import { artifactEvidenceDigest } from '@researchforce/domain/releases';
import type { ApiEnv } from '../src/api/app';
import { readJson } from '../src/api/input';
import { JOB_HANDLERS } from '../src/do/jobs';
import type { JsonValue } from '../src/do/jobs';
import '../src/jobs/deletion';
import { approveRelease, createRelease, createSuccessor, manifestMac, readManifest, readRelease, sealRelease, setArtifacts } from '../src/records/releases';
import { errorOf, itemWorld, rich } from './items';
import type { ItemView } from './items';

const KEY = 'synthetic-manifest-key';
/** Test-only routes over the release functions, which the release API of task 66.2 will replace. */
const routes = new Hono<ApiEnv>();
routes.post('/releases', async (c) => c.json({ id: await createRelease(c, await readJson(c)) }, 201));
routes.put('/releases/:id/artifacts', async (c) => { await setArtifacts(c, c.req.param('id'), await readJson(c)); return c.json({ ok: true }); });
routes.post('/releases/:id/approvals', async (c) => { await approveRelease(c, c.req.param('id'), await readJson(c)); return c.json({ ok: true }); });
routes.post('/releases/:id/seal', async (c) => c.json(await sealRelease(c, c.req.param('id'), await readJson(c), KEY)));
routes.post('/releases/:id/successor', async (c) => c.json({ id: await createSuccessor(c, c.req.param('id')) }, 201));
routes.get('/releases/:id', async (c) => c.json({ release: await readRelease(c, c.req.param('id')) }));
routes.get('/releases/:id/manifest', async (c) => c.json(await readManifest(c, c.req.param('id'), KEY)));

const world = itemWorld(undefined, { localRoutes: routes });
type Who = 'author' | 'colleague' | 'admin';
const count = async (sql: string, ...values: unknown[]) => (await world.core().prepare(sql).bind(...values).first<number>('n'))!;
const NEW = { name: 'Spring release', scope: 'The private scope.', rationale: 'The private rationale.', licenceVersion: 'cc-by-4.0' };
const make = async (who: Who = 'admin') => {
  const response = await world.request(who, 'POST', '/dev/releases', NEW);
  if (response.status !== 201) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json<{ id: string }>()).id;
};
const fill = (id: string, rev: number, artifacts: unknown[], who: Who = 'admin') => world.request(who, 'PUT', `/dev/releases/${id}/artifacts`, { rev, artifacts });
const rev = async (id: string) => (await world.core().prepare('SELECT rev FROM research_releases WHERE id = ?1').bind(id).first<number>('rev'))!;
const approve = (id: string, who: Who, body: Record<string, unknown>) => world.request(who, 'POST', `/dev/releases/${id}/approvals`, body);
const seal = (id: string, expected: number, who: Who = 'admin') => world.request(who, 'POST', `/dev/releases/${id}/seal`, { rev: expected });
const view = async (who: Who, id: string) => {
  const response = await world.request(who, 'GET', `/dev/releases/${id}`);
  if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json<{ release: Record<string, unknown> & { artifacts: Record<string, unknown>[] } }>()).release;
};
/** A draft with a public finding approved by its Owner, for its rights, and by an Administrator, ready to seal. */
async function ready(): Promise<{ id: string; finding: ItemView; secret: ItemView }> {
  const finding = await world.created('author', 'finding', { title: 'A public finding' });
  const secret = await world.created('author', 'finding', { title: 'A private finding', access: { level: 'restricted', members: [] } });
  const id = await make();
  expect((await fill(id, 1, [{ kind: 'record', unitId: finding.id, publicApproved: true }, { kind: 'record', unitId: secret.id }])).status).toBe(200);
  expect((await approve(id, 'author', { kind: 'owner', unitId: finding.id })).status).toBe(200);
  expect((await approve(id, 'admin', { kind: 'rights', unitId: finding.id })).status).toBe(200);
  expect((await approve(id, 'admin', { kind: 'administrator' })).status).toBe(200);
  return { id, finding, secret };
}
async function runDeletion(jobId: string): Promise<void> {
  const row = (await world.core().prepare('SELECT params, requested_by AS requestedBy FROM jobs WHERE id = ?1').bind(jobId).first<{ params: string; requestedBy: string }>())!;
  let cursor: JsonValue = null;
  for (;;) {
    const result = await JOB_HANDLERS.deletion!.slice({ env: world.bindings, job: { id: jobId, type: 'deletion', params: JSON.parse(row.params) as JsonValue, requestedBy: row.requestedBy as never }, now: world.at }, cursor);
    if (result.done) return;
    cursor = result.cursor;
  }
}

describe('draft releases (R59.1)', () => {
  it('lets only an Administrator create one, and requires each field', async () => {
    expect((await world.request('author', 'POST', '/dev/releases', NEW)).status).toBe(403);
    const bad = await errorOf(await world.request('admin', 'POST', '/dev/releases', { ...NEW, name: ' ', rationale: '' }));
    expect(bad.fields?.map((field) => field.field).sort()).toEqual(['name', 'rationale']);
    const id = await make();
    expect(await world.core().prepare('SELECT state, rev, snapshot_at AS at FROM research_releases WHERE id = ?1').bind(id).first()).toEqual({ state: 'draft', rev: 1, at: world.at });
    expect((await world.request('author', 'GET', `/dev/releases/${id}`)).status).toBe(403);
  });

  it('captures each artifact at its exact revision with a SHA-256 identity, and refuses what cannot be read', async () => {
    const finding = await world.created('author', 'finding');
    const secret = await world.created('author', 'finding', { access: { level: 'restricted', members: [] } });
    const id = await make();
    const saved = await fill(id, 1, [{ kind: 'record', unitId: finding.id }, { kind: 'record', unitId: newULID(world.at) }, { kind: 'package', unitId: finding.id }]);
    expect(saved.status).toBe(422);
    expect((await errorOf(saved)).fields?.map((field) => field.field).sort()).toEqual(['artifacts.1.unitId', 'artifacts.2.kind']);
    expect(await fill(id, 1, [{ kind: 'record', unitId: finding.id }, { kind: 'record', unitId: finding.id }])).toHaveProperty('status', 422);
    expect((await fill(id, 1, [{ kind: 'record', unitId: finding.id }, { kind: 'record', unitId: secret.id }])).status).toBe(200);
    const rows = (await world.core().prepare('SELECT unit_id AS unitId, revision, sha256, identifier FROM release_artifacts WHERE release_id = ?1 ORDER BY position').bind(id).all<{ unitId: string; revision: number; sha256: string; identifier: string }>()).results;
    expect(rows.map((row) => [row.unitId, row.revision, row.identifier])).toEqual([[finding.id, finding['rev'], finding.identifier], [secret.id, secret['rev'], secret.identifier]]);
    expect(rows.every((row) => /^[0-9a-f]{64}$/.test(row.sha256))).toBe(true);
    expect(await rev(id)).toBe(2);
  });

  it('refuses a save from an older revision and keeps the list it had', async () => {
    const finding = await world.created('author', 'finding');
    const id = await make();
    expect((await fill(id, 1, [{ kind: 'record', unitId: finding.id }])).status).toBe(200);
    const stale = await fill(id, 1, []);
    expect(stale.status).toBe(409);
    expect(await count('SELECT count(*) AS n FROM release_artifacts WHERE release_id = ?1', id)).toBe(1);
  });

  it('captures an Attachment by its bytes and a citation by what it cites', async () => {
    const source = await world.created('author', 'source');
    const finding = await world.created('author', 'finding');
    const cited = await world.request('author', 'POST', '/citations', { citingUnitId: finding.id, citingField: 'claim', target: { type: 'source', unitId: source.id }, role: 'supports', locator: { type: 'page', from: 2 } });
    const citation = (await cited.json<{ citation: { id: string } }>()).citation.id;
    const file = newULID(world.at);
    await world.core().prepare("INSERT INTO units (id, unit_type, project_id, root_id, owner_id, credit, submission_id, created_at, updated_seq) SELECT ?2, 'attachment', project_id, id, owner_id, credit, submission_id, created_at, 0 FROM units WHERE id = ?1").bind(finding.id, file).run();
    await world.core().prepare("INSERT INTO attachments (unit_id, item_identifier, title, file_kind, original_name, size_bytes, sha256, r2_key, origin, uploaded_at, rights_status_id, chain_id) VALUES (?1, 'RF-ATT', 'A scan', 'pdf', 'scan.pdf', 10, ?2, 'k', 'upload', ?3, ?4, ?1)")
      .bind(file, 'c'.repeat(64), world.at, '0000000000000000000000P002').run();
    const id = await make();
    expect((await fill(id, 1, [{ kind: 'attachment', unitId: file }, { kind: 'citation', unitId: citation }])).status).toBe(200);
    const rows = (await world.core().prepare('SELECT kind, revision, sha256, identifier FROM release_artifacts WHERE release_id = ?1 ORDER BY position').bind(id).all<{ kind: string; revision: number | null; sha256: string; identifier: string }>()).results;
    expect(rows[0]).toEqual({ kind: 'attachment', revision: null, sha256: 'c'.repeat(64), identifier: 'RF-ATT' });
    expect(rows[1]).toMatchObject({ kind: 'citation', revision: 1, identifier: citation });
    expect(rows[1]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await count('SELECT rights_permits_publication AS n FROM release_artifacts WHERE release_id = ?1 AND kind = ?2', id, 'attachment')).toBe(1);
  });
});

describe('sealing (R59.1, R59.2, R59.5)', () => {
  it('seals a complete draft, authenticating the internal manifest and recording the public subset apart from it', async () => {
    const { id, finding } = await ready();
    const sealed = await seal(id, await rev(id));
    expect(sealed.status).toBe(200);
    const body = await sealed.json<{ manifestHash: string; publicManifestHash: string }>();
    expect(body.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.publicManifestHash).not.toBe(body.manifestHash);
    expect(await world.core().prepare('SELECT state, manifest_hash AS h, manifest_mac AS m, sealed_by AS by FROM research_releases WHERE id = ?1').bind(id).first())
      .toEqual({ state: 'sealed', h: body.manifestHash, m: await manifestMac(KEY, body.manifestHash), by: world.ids.admin });
    const manifest = await (await world.request('admin', 'GET', `/dev/releases/${id}/manifest`)).json<{ authentic: boolean; manifest: { artifacts: { unitId: string; publicApproved: boolean }[] } }>();
    expect(manifest.authentic).toBe(true);
    expect(manifest.manifest.artifacts.map((artifact) => [artifact.unitId, artifact.publicApproved])).toEqual([[finding.id, true], [expect.any(String), false]]);
    expect((await world.request('author', 'GET', `/dev/releases/${id}/manifest`)).status).toBe(403);
  });

  it('names every missing approval and seals nothing', async () => {
    const finding = await world.created('author', 'finding');
    const id = await make();
    await fill(id, 1, [{ kind: 'record', unitId: finding.id, publicApproved: true }]);
    const refused = await errorOf(await seal(id, await rev(id)));
    expect(refused.status).toBe(422);
    expect(refused.fields?.map((field) => field.field).sort()).toEqual(['approvals', 'artifacts.0.owner', 'artifacts.0.rights']);
    expect(await world.core().prepare('SELECT state FROM research_releases WHERE id = ?1').bind(id).first('state')).toBe('draft');
    expect((await errorOf(await seal(await make(), 1))).fields?.map((field) => field.field).sort()).toEqual(['approvals', 'artifacts']);
  });

  it('lets only the Owner approve for the Owner, and only an Administrator approve rights and the release', async () => {
    const finding = await world.created('author', 'finding');
    const id = await make();
    await fill(id, 1, [{ kind: 'record', unitId: finding.id, publicApproved: true }]);
    expect((await approve(id, 'colleague', { kind: 'owner', unitId: finding.id })).status).toBe(403);
    expect((await approve(id, 'admin', { kind: 'owner', unitId: finding.id })).status).toBe(403); // no one approves for the Owner
    expect((await approve(id, 'author', { kind: 'rights', unitId: finding.id })).status).toBe(403);
    expect((await approve(id, 'author', { kind: 'administrator' })).status).toBe(403);
    expect((await approve(id, 'author', { kind: 'owner', unitId: newULID(world.at) })).status).toBe(422);
    expect((await approve(id, 'author', { kind: 'owner', unitId: finding.id })).status).toBe(200);
    expect((await approve(id, 'author', { kind: 'owner', unitId: finding.id })).status).toBe(200); // repeating changes nothing
    expect(await count('SELECT count(*) AS n FROM release_approvals WHERE release_id = ?1', id)).toBe(1);
  });

  it('lapses an approval when the artifact changes, and refuses to seal what changed after it was captured', async () => {
    const { id, finding } = await ready();
    const edited = await world.edit('author', finding.id as string, { rev: finding['rev'], mark: { mark: 'correction', reason: 'Synthetic.' }, claim: rich('A corrected claim.') });
    expect(edited.status).toBe(200);
    const refused = await errorOf(await seal(id, await rev(id)));
    expect(refused.fields?.map((field) => field.field)).toEqual(['artifacts.0']);
    expect(refused.fields?.[0]?.rule).toContain('changed after it was captured');
    // Capturing again moves the snapshot, and the earlier approvals no longer count.
    await fill(id, await rev(id), [{ kind: 'record', unitId: finding.id, publicApproved: true }]);
    expect((await errorOf(await seal(id, await rev(id)))).fields?.map((field) => field.field).sort()).toEqual(['approvals', 'artifacts.0.owner', 'artifacts.0.rights']);
  });

  it('refuses a seal from an older revision of the draft', async () => {
    const { id } = await ready();
    expect((await seal(id, 1)).status).toBe(409);
  });

  it('never changes a sealed release, whatever writes to it', async () => {
    const { id, finding } = await ready();
    await seal(id, await rev(id));
    const touch = async (statement: string, ...values: unknown[]) => world.core().prepare(statement).bind(...values).run().then(() => false, () => true);
    expect(await touch("UPDATE research_releases SET name = 'Another' WHERE id = ?1", id)).toBe(true);
    expect(await touch("UPDATE research_releases SET manifest_hash = ?2 WHERE id = ?1", id, 'f'.repeat(64))).toBe(true);
    expect(await touch("UPDATE research_releases SET state = 'draft' WHERE id = ?1", id)).toBe(true);
    expect(await touch("UPDATE research_releases SET state = 'withdrawn' WHERE id = ?1", id)).toBe(true); // a release is published before it is withdrawn
    expect(await touch('DELETE FROM research_releases WHERE id = ?1', id)).toBe(true);
    expect(await touch("UPDATE release_artifacts SET sha256 = ?2 WHERE release_id = ?1", id, 'f'.repeat(64))).toBe(true);
    expect(await touch("UPDATE release_artifacts SET public_approved = 0 WHERE release_id = ?1", id)).toBe(true);
    expect(await touch('DELETE FROM release_artifacts WHERE release_id = ?1', id)).toBe(true);
    expect(await touch("INSERT INTO release_artifacts (release_id, position, kind, unit_id, root_id, owner_id, revision, sha256) VALUES (?1, 9, 'record', 'U', 'U', 'O', 1, ?2)", id, 'a'.repeat(64))).toBe(true);
    expect(await touch("INSERT INTO release_approvals VALUES (?1, 'owner', 'U', ?2, 'M', ?3)", id, 'a'.repeat(64), world.at)).toBe(true);
    expect(await touch('DELETE FROM release_approvals WHERE release_id = ?1', id)).toBe(true);
    expect((await fill(id, await rev(id), [])).status).toBe(409);
    expect((await approve(id, 'admin', { kind: 'administrator' })).status).toBe(409);
    expect((await seal(id, await rev(id))).status).toBe(422);
    expect(await count('SELECT count(*) AS n FROM release_artifacts WHERE release_id = ?1', id)).toBe(2);
    expect(await world.core().prepare('SELECT name FROM research_releases WHERE id = ?1').bind(id).first('name')).toBe('Spring release');
    expect(finding.id).toBeTruthy();
  });

  it('detects a manifest or authentication that no longer matches its rows', async () => {
    const { id } = await ready();
    await seal(id, await rev(id));
    await world.core().prepare("DROP TRIGGER release_artifacts_change").run();
    await world.core().prepare("UPDATE release_artifacts SET title = 'Altered' WHERE release_id = ?1 AND position = 0").bind(id).run();
    const checked = await (await world.request('admin', 'GET', `/dev/releases/${id}/manifest`)).json<{ authentic: boolean }>();
    expect(checked.authentic).toBe(false);
  });
});

describe('successor releases (R59.2)', () => {
  it('makes a new draft that names the sealed release, which stays exactly as it was', async () => {
    const { id, finding } = await ready();
    await seal(id, await rev(id));
    const edited = await world.edit('author', finding.id as string, { rev: finding['rev'], mark: { mark: 'correction', reason: 'Synthetic.' }, claim: rich('A corrected claim.') });
    expect(edited.status).toBe(200);
    const before = await world.core().prepare('SELECT manifest_hash AS h FROM research_releases WHERE id = ?1').bind(id).first<string>('h');
    const made = await world.request('admin', 'POST', `/dev/releases/${id}/successor`);
    expect(made.status).toBe(201);
    const next = (await made.json<{ id: string }>()).id;
    expect(next).not.toBe(id);
    expect(await world.core().prepare('SELECT state, predecessor_id AS p FROM research_releases WHERE id = ?1').bind(next).first()).toEqual({ state: 'draft', p: id });
    expect(await world.core().prepare('SELECT manifest_hash AS h FROM research_releases WHERE id = ?1').bind(id).first('h')).toBe(before);
    const old = await world.core().prepare('SELECT sha256 FROM release_artifacts WHERE release_id = ?1 AND position = 0').bind(id).first<string>('sha256');
    const fresh = await world.core().prepare('SELECT sha256 FROM release_artifacts WHERE release_id = ?1 AND position = 0').bind(next).first<string>('sha256');
    expect(fresh).not.toBe(old);
    expect((await world.request('admin', 'POST', `/dev/releases/${id}/successor`)).status).toBe(409);
    expect((await world.request('admin', 'POST', `/dev/releases/${next}/successor`)).status).toBe(409); // a draft is changed directly
    expect((await world.request('author', 'POST', `/dev/releases/${id}/successor`)).status).toBe(403);
  });

  it('gives a successor with different contents a different manifest', async () => {
    const { id, finding } = await ready();
    const first = (await (await seal(id, await rev(id))).json<{ manifestHash: string }>()).manifestHash;
    await world.edit('author', finding.id as string, { rev: finding['rev'], mark: { mark: 'correction', reason: 'Synthetic.' }, claim: rich('A corrected claim.') });
    const next = (await (await world.request('admin', 'POST', `/dev/releases/${id}/successor`)).json<{ id: string }>()).id;
    await approve(next, 'author', { kind: 'owner', unitId: finding.id });
    await approve(next, 'admin', { kind: 'rights', unitId: finding.id });
    await approve(next, 'admin', { kind: 'administrator' });
    const second = (await (await seal(next, await rev(next))).json<{ manifestHash: string }>()).manifestHash;
    expect(second).not.toBe(first);
  });
});

describe('what a Member sees of a release (R59.2, R59.4)', () => {
  it('shows a sealed release to every Member, with version-specific citations, and only the artifacts they can read', async () => {
    const { id, finding, secret } = await ready();
    await seal(id, await rev(id));
    const seen = await view('colleague', id);
    expect(seen).toMatchObject({ state: 'sealed', name: 'Spring release', hiddenArtifacts: 1 });
    expect(seen.artifacts).toHaveLength(1);
    expect(seen.artifacts[0]).toMatchObject({ unitId: finding.id, revision: finding['rev'], drift: 'unchanged', publicApproved: true });
    expect((seen.artifacts[0]!['citation'] as { line: string }).line).toContain(`release ${id}`);
    expect((seen.artifacts[0]!['citation'] as { line: string }).line).toMatch(/SHA-256 [0-9a-f]{64}/);
    const text = JSON.stringify(seen);
    for (const hidden of [secret.id as string, secret.identifier as string, 'A private finding', 'The private scope.', 'The private rationale.']) expect(text, hidden).not.toContain(hidden);
    expect(seen).not.toHaveProperty('scope');
    const admin = await view('admin', id);
    expect(admin).toMatchObject({ hiddenArtifacts: 0, scope: 'The private scope.', rationale: 'The private rationale.' });
    expect(admin.artifacts).toHaveLength(2);
  });

  it('shows that an artifact changed since sealing without saying how', async () => {
    const { id, finding } = await ready();
    await seal(id, await rev(id));
    await world.edit('author', finding.id as string, { rev: finding['rev'], mark: { mark: 'correction', reason: 'Synthetic.' }, claim: rich('A corrected claim.') });
    const seen = await view('colleague', id);
    expect(seen.artifacts[0]!['drift']).toBe('changed');
    expect(seen.artifacts[0]!['revision']).toBe(finding['rev']);
    expect(JSON.stringify(seen)).not.toContain('A corrected claim.');
  });

  it('keeps the identity of a permanently deleted artifact as an unavailable tombstone', async () => {
    const { id, finding } = await ready();
    await seal(id, await rev(id));
    const deleted = await world.request('admin', 'DELETE', `/items/${finding.id}`, { identifier: finding.identifier, reason: 'Synthetic deletion.' });
    expect(deleted.status).toBe(202);
    await runDeletion((await deleted.json<{ deletion: { jobId: string } }>()).deletion.jobId);
    expect(await world.core().prepare('SELECT unavailable_at AS at FROM release_artifacts WHERE release_id = ?1 AND unit_id = ?2').bind(id, finding.id).first('at')).toBe(world.at);
    expect(await count('SELECT count(*) AS n FROM release_artifacts WHERE release_id = ?1', id)).toBe(2);
    const seen = await view('admin', id);
    // The deleted artifact is no longer shown at all, only counted as one the viewer cannot see.
    expect(seen.artifacts.map((artifact) => artifact['unitId'])).not.toContain(finding.id);
    expect(seen['hiddenArtifacts']).toBe(1);
    expect(await world.core().prepare('SELECT state FROM research_releases WHERE id = ?1').bind(id).first('state')).toBe('sealed');
  });

  it('is not readable as a draft by a Member', async () => {
    const { id } = await ready();
    expect((await world.request('colleague', 'GET', `/dev/releases/${id}`)).status).toBe(403);
    expect(artifactEvidenceDigest).toBeTypeOf('function');
  });
});
