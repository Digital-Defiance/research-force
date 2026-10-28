import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newULID } from '@researchforce/domain/identifiers';
import { SINGLE_UPLOAD_BYTES, UPLOAD_PART_BYTES } from '@researchforce/domain/files';
import { asTimestamp } from '@researchforce/domain/types';
import { BUILT_IN_VALUE_IDS } from '@researchforce/domain/value-sets';
import { sweepUploads } from '../src/files/uploads';
import { checksum64, compositeChecksum } from '../src/files/s3';
import { itemBody, itemWorld } from './items';
import { attachedFile, completedUpload, configureFiles, fileInput } from './files';

const world = itemWorld();
beforeEach(async () => { configureFiles(world); await world.core().batch(['uploads', 'upload_parts'].map((t) => world.core().prepare(`DELETE FROM ${t}`))); });
const sha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
async function start(sizeBytes = 0, groupId = newULID(world.at)) {
  return world.request('author', 'POST', '/uploads', { groupId, fileName: 'Synthetic empty.txt', sizeBytes, sha256: sha });
}
describe('file upload and atomic Attachments', () => {
  it('signs exact length, checksum, and write-once conditions without file bytes', async () => {
    const response = await start(); expect(response.status).toBe(201);
    const body = await response.json<{ id: string; url: string; headers: Record<string, string> }>();
    const url = new URL(body.url); expect(url.hostname).toBe('synthetic-account.r2.cloudflarestorage.com');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;host;if-none-match;x-amz-checksum-sha256');
    expect(body.headers).toEqual({ 'content-length': '0', 'x-amz-checksum-sha256': checksum64(sha), 'if-none-match': '*' });
    const key = `files/${body.id}`;
    await world.bindings.RF_PRIVATE_BUCKET.put(key, '', { sha256: sha });
    const complete = await world.request('author', 'POST', `/uploads/${body.id}/complete`, {}); expect(complete.status).toBe(200);
    expect((await world.request('author', 'POST', `/uploads/${body.id}/complete`, {})).status).toBe(200);
    expect((await world.request('colleague', 'GET', `/uploads/${body.id}`)).status).toBe(404);
  });
  it('refuses the 101st file and over-limit files before requesting a transfer', async () => {
    const oversize = await start(1_000_000_001); expect(oversize.status).toBe(422); expect(await oversize.text()).toContain('Synthetic empty.txt');
    const groupId = newULID(world.at);
    await world.core().prepare(`INSERT INTO uploads (id, group_id, owner_type, owner_id, r2_key, file_name, size_bytes, sha256, mode, created_at)
      SELECT value, ?1, 'member', ?2, 'files/' || value, 'Synthetic', 0, ?3, 'single', ?4 FROM json_each(?5)`)
      .bind(groupId, world.ids.author, sha, world.at, JSON.stringify(Array.from({ length: 100 }, () => newULID(world.at)))).run();
    expect((await start(0, groupId)).status).toBe(422);
    expect(await world.core().prepare('SELECT count(*) AS n FROM uploads WHERE group_id = ?1').bind(groupId).first('n')).toBe(100);
  });
  it('local R2 refuses incorrect SHA-256 and completion refuses a stored size mismatch', async () => {
    await expect(world.bindings.RF_PRIVATE_BUCKET.put('files/wrong-checksum', 'Synthetic wrong bytes', { sha256: sha })).rejects.toThrow();
    const response = await start(); const { id } = await response.json<{ id: string }>();
    await world.bindings.RF_PRIVATE_BUCKET.put(`files/${id}`, 'Synthetic bytes', { sha256: await crypto.subtle.digest('SHA-256', new TextEncoder().encode('Synthetic bytes')) });
    const complete = await world.request('author', 'POST', `/uploads/${id}/complete`, {}); expect(complete.status).toBe(422);
    expect(await world.core().prepare('SELECT completed_at AS at FROM uploads WHERE id = ?1').bind(id).first('at')).toBeNull();
  });
  it('signs exact 16 MiB multipart boundaries and a short last part', async () => {
    const mocked = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<InitiateMultipartUploadResult><UploadId>synthetic-multipart-id</UploadId></InitiateMultipartUploadResult>'));
    try {
      const response = await start(SINGLE_UPLOAD_BYTES + 3); expect(response.status).toBe(201);
      const row = await response.json<{ id: string; mode: string }>(); expect(row.mode).toBe('multipart');
      for (const partNumber of [1, 5]) {
        const part = await world.request('author', 'POST', `/uploads/${row.id}/parts`, { partNumber, sha256: sha }); expect(part.status).toBe(200);
        const body = await part.json<{ url: string; headers: Record<string, string> }>();
        expect(body.headers['content-length']).toBe(String(partNumber === 1 ? UPLOAD_PART_BYTES : 3));
        expect(new URL(body.url).searchParams.get('partNumber')).toBe(String(partNumber));
      }
      expect((await world.request('author', 'POST', `/uploads/${row.id}/complete`, { parts: [] })).status).toBe(422);
      expect(mocked).toHaveBeenCalledTimes(1);
    } finally { mocked.mockRestore(); }
  });
  it('computes the S3 composite from binary digests in part order', async () => {
    const expected = await crypto.subtle.digest('SHA-256', Uint8Array.from((sha + sha).match(/../g)!.map((p) => parseInt(p, 16))));
    expect(await compositeChecksum([sha, sha])).toBe(`${btoa(String.fromCharCode(...new Uint8Array(expected)))}-2`);
  });
  it('checks the multipart composite returned by S3 HEAD and safely retries finalization', async () => {
    const id = await completedUpload(world); const key = `files/${id}`; const bytes = new TextEncoder().encode('Synthetic parts');
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
    await world.core().prepare("UPDATE uploads SET state = 'uploading', completed_at = NULL, mode = 'multipart', multipart_id = 'synthetic-multipart', size_bytes = ?1, sha256 = ?2 WHERE id = ?3").bind(bytes.length, hash, id).run();
    await world.core().prepare('INSERT INTO upload_parts(upload_id,part_number,sha256,size_bytes) VALUES(?1,1,?2,?3)').bind(id, hash, bytes.length).run();
    const composite = await compositeChecksum([hash]); let correct = false; let posts = 0;
    const mocked = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      if (init?.method === 'POST') {
        posts++; expect(String(init.body)).toContain(`<ChecksumSHA256>${checksum64(hash)}</ChecksumSHA256>`);
        await world.bindings.RF_PRIVATE_BUCKET.put(key, bytes, { sha256: hash });
        return new Response('<CompleteMultipartUploadResult/>');
      }
      expect(init?.method).toBe('HEAD');
      return new Response(null, { headers: { 'x-amz-checksum-sha256': correct ? composite : 'wrong-1' } });
    });
    try {
      const body = { parts: [{ partNumber: 1, etag: 'abcdef' }] };
      expect((await world.request('author', 'POST', `/uploads/${id}/complete`, body)).status).toBe(422);
      expect(await world.core().prepare('SELECT state FROM uploads WHERE id = ?1').bind(id).first('state')).toBe('uploading');
      correct = true;
      expect((await world.request('author', 'POST', `/uploads/${id}/complete`, body)).status).toBe(200);
      expect(posts).toBe(1);
    } finally { mocked.mockRestore(); }
  });
  it('creates all 100 files in one Submission with exact names and Source rights', async () => {
    const source = await world.created('author', 'source', { rightsStatusId: '0000000000000000000000P002', rightsHolder: 'Synthetic holder' });
    const files = await Promise.all(Array.from({ length: 100 }, (_, i) => completedUpload(world, 'author', ` Synthetic ${i} ä.TXT `)));
    const response = await world.request('author', 'POST', '/attachments', { parentId: source.id, files: files.map(fileInput) });
    expect(response.status).toBe(201);
    const { ids } = await response.json<{ ids: string[] }>(); expect(ids).toHaveLength(100);
    const rows = await world.core().prepare('SELECT a.*, u.disclosure_level FROM attachments a JOIN units u ON u.id = a.unit_id').all<Record<string, unknown>>();
    expect(rows.results).toHaveLength(100); expect(rows.results[0]?.['original_name']).toBe(' Synthetic 0 ä.TXT ');
    expect(rows.results.every((r) => r['rights_status_id'] === '0000000000000000000000P002' && r['rights_holder'] === 'Synthetic holder' && r['disclosure_level'] === 'not_published')).toBe(true);
  });
  it('adds attachments in the transaction creating an Item or Reply and rejects reuse atomically', async () => {
    const uploadId = await completedUpload(world);
    const created = await world.create('author', 'topic', { ...itemBody('topic', world.projectId), files: [fileInput(uploadId)] }); expect(created.status).toBe(201);
    const { item } = await created.json<{ item: { id: string } }>();
    const replyUpload = await completedUpload(world);
    const reply = await world.request('author', 'POST', '/replies', { parentId: item.id, text: { text: 'Synthetic reply', spans: [] }, files: [fileInput(replyUpload)] }); expect(reply.status).toBe(201);
    const counts = await world.core().prepare('SELECT count(*) AS n FROM submissions').first('n');
    expect((await world.request('author', 'POST', '/attachments', { parentId: item.id, files: [fileInput(uploadId)] })).status).toBe(422);
    expect(await world.core().prepare('SELECT count(*) AS n FROM submissions').first('n')).toBe(counts);
  });
  it('keeps rights Unknown when a Source value was retired and on a new version', async () => {
    const parent = await world.created('author', 'topic'); const id = await attachedFile(world, parent.id);
    const version = await world.request('author', 'POST', '/attachments', { supersedesId: id, files: [fileInput(await completedUpload(world))] }); expect(version.status).toBe(201);
    const { ids } = await version.json<{ ids: string[] }>();
    expect(await world.core().prepare('SELECT rights_status_id FROM attachments WHERE unit_id = ?1').bind(ids[0]).first('rights_status_id')).toBe(BUILT_IN_VALUE_IDS.rightsUnknown);
    expect((await world.request('colleague', 'POST', '/attachments', { supersedesId: ids[0], files: [fileInput(await completedUpload(world, 'colleague'))] })).status).toBe(403);
  });
  it('serializes simultaneous versions and reports the winning tip', async () => {
    const parent = await world.created('author', 'topic'); const first = await attachedFile(world, parent.id);
    const uploads = await Promise.all([completedUpload(world), completedUpload(world)]);
    const responses = await Promise.all(uploads.map((id) => world.request('author', 'POST', '/attachments', { supersedesId: first, files: [fileInput(id)] })));
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const winner = await responses.find((response) => response.status === 201)!.json<{ ids: string[] }>();
    const refusal = await responses.find((response) => response.status === 409)!.json<{ details: { last: { id: string } } }>();
    expect(refusal.details.last.id).toBe(winner.ids[0]);
    const chain = await world.core().prepare('SELECT unit_id FROM attachments WHERE chain_id = ?1').bind(first).all(); expect(chain.results).toHaveLength(2);
  });
  it('replaces a retired inherited Rights Status with Unknown', async () => {
    const source = await world.created('author', 'source', { rightsStatusId: '0000000000000000000000P002' });
    await world.core().prepare("UPDATE config_values SET retired = 1 WHERE id = '0000000000000000000000P002'").run();
    try {
      const file = await attachedFile(world, source.id);
      expect(await world.core().prepare('SELECT rights_status_id FROM attachments WHERE unit_id = ?1').bind(file).first('rights_status_id')).toBe(BUILT_IN_VALUE_IDS.rightsUnknown);
    } finally { await world.core().prepare("UPDATE config_values SET retired = 0 WHERE id = '0000000000000000000000P002'").run(); }
  });
  it('sweeps abandoned complete and partial uploads but keeps submitted files and the 24-hour boundary', async () => {
    const parent = await world.created('author', 'topic'); const kept = await attachedFile(world, parent.id);
    const abandoned = await completedUpload(world); const boundary = await completedUpload(world);
    await world.core().prepare('UPDATE uploads SET created_at = ?1 WHERE id = ?2').bind('2026-10-26T18:00:00.001Z', boundary).run();
    await world.core().prepare('UPDATE uploads SET created_at = ?1 WHERE id = ?2').bind('2026-10-26T17:59:59.999Z', abandoned).run();
    await world.bindings.RF_PRIVATE_BUCKET.put(`files/${abandoned}`, 'synthetic');
    expect(await sweepUploads(world.bindings, world.at)).toBe(1);
    expect(await world.bindings.RF_PRIVATE_BUCKET.head(`files/${abandoned}`)).toBeNull();
    expect((await world.request('author', 'GET', `/attachments/${kept}`)).status).toBe(200);
    expect((await world.request('author', 'GET', `/uploads/${boundary}`)).status).toBe(200);
    expect(await sweepUploads(world.bindings, asTimestamp('2026-10-28T18:00:00.002Z'))).toBe(1);
  });
});
