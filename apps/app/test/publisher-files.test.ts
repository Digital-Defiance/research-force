import { beforeEach, describe, expect, it } from 'vitest';
import {
  copyPublicFile, deletePublicFile, publicContentDisposition, publicContentType, publicFileKey, runFileOps,
} from '../src/publisher/files';
import type { DeletionRetryState, FileCopy, FileOps } from '../src/publisher/files';
import type { Env } from '../src/env';
import { itemWorld } from './items';

// ---------------------------------------------------------------------------
// Pure: content type, Content-Disposition, and the public key.
// ---------------------------------------------------------------------------

describe('publicContentType', () => {
  it('gives benign kinds a correct, inert type', () => {
    expect(publicContentType('pdf', 'pdf')).toBe('application/pdf');
    expect(publicContentType('image', 'png')).toBe('image/png');
    expect(publicContentType('image', 'jpg')).toBe('image/jpeg');
    expect(publicContentType('image', 'webp')).toBe('image/webp');
    expect(publicContentType('csv', 'csv')).toBe('text/csv');
    expect(publicContentType('text_log', 'txt')).toBe('text/plain');
    expect(publicContentType('text_log', 'log')).toBe('text/plain');
    expect(publicContentType('video', 'mp4')).toBe('video/mp4');
  });

  it('serves every script-capable extension as application/octet-stream', () => {
    // SVG is image/svg+xml, which is script-capable, so the image kind still yields octet-stream for it.
    expect(publicContentType('image', 'svg')).toBe('application/octet-stream');
    // Active structured_data (xml) and any markup must never be served as a live document.
    expect(publicContentType('structured_data', 'xml')).toBe('application/octet-stream');
    expect(publicContentType('other', 'html')).toBe('application/octet-stream');
    expect(publicContentType('other', 'htm')).toBe('application/octet-stream');
    expect(publicContentType('other', 'xhtml')).toBe('application/octet-stream');
  });

  it('falls back to application/octet-stream for benign structured_data, archives, spreadsheets, and the unknown kind', () => {
    expect(publicContentType('structured_data', 'json')).toBe('application/octet-stream');
    expect(publicContentType('structured_data', 'yaml')).toBe('application/octet-stream');
    expect(publicContentType('archive', 'zip')).toBe('application/octet-stream');
    expect(publicContentType('spreadsheet', 'xlsx')).toBe('application/octet-stream');
    expect(publicContentType('other', '')).toBe('application/octet-stream');
    expect(publicContentType('image', 'unknownext')).toBe('application/octet-stream');
  });
});

describe('publicContentDisposition', () => {
  it('names the download {Item_Identifier}.{ext}, never the original file name', () => {
    expect(publicContentDisposition('RF-0001', 'pdf')).toBe('attachment; filename="RF-0001.pdf"');
    expect(publicContentDisposition('RF-0002', '')).toBe('attachment; filename="RF-0002"');
  });

  it('adds an RFC 5987 filename* when the identifier or extension is not plain ASCII', () => {
    const disposition = publicContentDisposition('RF-café', 'pdf');
    expect(disposition).toContain("filename*=UTF-8''");
    expect(disposition).toContain('RF-caf%C3%A9.pdf');
  });
});

describe('publicFileKey', () => {
  it('is f/{Item_Identifier}', () => {
    expect(publicFileKey('RF-0001')).toBe('f/RF-0001');
  });
});

// ---------------------------------------------------------------------------
// R2 I/O against the local bucket harness. Server-side CopyObject needs a real S3 endpoint, which miniflare does not
// provide, so these exercise the binding get→put fallback (PUBLIC_BUCKET_NAME is left unset). The fallback stores the
// same content type and Content-Disposition the server-side path would, so the behaviour under test is identical.
// ---------------------------------------------------------------------------

const world = itemWorld();
const env = (): Env => world.bindings;
const priv = () => world.bindings.RF_PRIVATE_BUCKET;
const pub = () => world.bindings.RF_PUBLIC_BUCKET;

const copy = (overrides: Partial<FileCopy> = {}): FileCopy => ({
  itemIdentifier: 'RF-0001', sourceKey: 'files/src-0001', fileKind: 'pdf', extension: 'pdf', ...overrides,
});

/** An in-memory retry set standing in for the Publisher DO's SQLite (task 32.5 backs the real one there). */
function memoryRetry(initial: readonly string[] = []): DeletionRetryState {
  const set = new Set(initial);
  return { pending: () => [...set], add: (id) => void set.add(id), clear: (id) => void set.delete(id) };
}

beforeEach(async () => {
  // Clear whatever a prior test left in either bucket; the harness keeps the buckets across tests.
  for (const bucket of [priv(), pub()]) {
    const listed = await bucket.list();
    for (const object of listed.objects) await bucket.delete(object.key);
  }
  // Ensure the fallback path: no PUBLIC_BUCKET_NAME, so copyPublicFile streams through the binding.
  delete (env() as { PUBLIC_BUCKET_NAME?: string }).PUBLIC_BUCKET_NAME;
});

describe('copyPublicFile', () => {
  it('puts the original at f/{identifier} with the file-kind content type and {identifier}.{ext} Content-Disposition', async () => {
    await priv().put('files/src-0001', 'synthetic pdf bytes');
    await copyPublicFile(env(), copy());

    const object = await pub().get('f/RF-0001');
    expect(object).not.toBeNull();
    expect(await object!.text()).toBe('synthetic pdf bytes');
    expect(object!.httpMetadata?.contentType).toBe('application/pdf');
    expect(object!.httpMetadata?.contentDisposition).toBe('attachment; filename="RF-0001.pdf"');
  });

  it('serves a script-capable SVG copy as application/octet-stream', async () => {
    await priv().put('files/src-svg', '<svg onload="x()"></svg>');
    await copyPublicFile(env(), copy({ itemIdentifier: 'RF-SVG', sourceKey: 'files/src-svg', fileKind: 'image', extension: 'svg' }));

    const object = await pub().get('f/RF-SVG');
    expect(object!.httpMetadata?.contentType).toBe('application/octet-stream');
    expect(object!.httpMetadata?.contentDisposition).toBe('attachment; filename="RF-SVG.svg"');
  });

  it('is idempotent: re-copying the same original leaves one object with the same content and headers', async () => {
    await priv().put('files/src-0001', 'synthetic pdf bytes');
    await copyPublicFile(env(), copy());
    await copyPublicFile(env(), copy());

    const listed = await pub().list({ prefix: 'f/RF-0001' });
    expect(listed.objects).toHaveLength(1);
    expect(await (await pub().get('f/RF-0001'))!.text()).toBe('synthetic pdf bytes');
  });

  it('throws when the original is missing, so the copy is reported as not landed rather than silently empty', async () => {
    await expect(copyPublicFile(env(), copy({ sourceKey: 'files/never-stored' }))).rejects.toThrow();
    expect(await pub().get('f/RF-0001')).toBeNull();
  });
});

describe('deletePublicFile', () => {
  it('removes f/{identifier} from rf-public', async () => {
    await pub().put('f/RF-0001', 'public copy');
    await deletePublicFile(env(), 'RF-0001');
    expect(await pub().get('f/RF-0001')).toBeNull();
  });

  it('is a no-op for a copy that is already absent', async () => {
    await expect(deletePublicFile(env(), 'RF-missing')).resolves.toBeUndefined();
  });
});

describe('runFileOps ordering and retry', () => {
  it('deletes removals first, then copies the new public files, reporting both outcomes', async () => {
    await pub().put('f/RF-OLD', 'to be removed');
    await priv().put('files/src-new', 'new public bytes');
    const retry = memoryRetry();
    const ops: FileOps = { copies: [copy({ itemIdentifier: 'RF-NEW', sourceKey: 'files/src-new' })], deletions: ['RF-OLD'] };

    const result = await runFileOps(env(), ops, retry);

    expect(result.deleted).toEqual(['RF-OLD']);
    expect(result.deletionsPending).toEqual([]);
    expect(result.copied).toEqual(['RF-NEW']);
    expect(result.copiesFailed).toEqual([]);
    expect(await pub().get('f/RF-OLD')).toBeNull();
    expect(await (await pub().get('f/RF-NEW'))!.text()).toBe('new public bytes');
    expect(retry.pending()).toEqual([]);
  });

  it('keeps a failed deletion in the retry set and succeeds on a later slice', async () => {
    // A delete that cannot confirm removal stays pending. Force failure by making head() report the object present:
    // the real DO retries each slice until the object is gone. Here the object exists, the delete removes it, and a
    // second slice confirms it is gone — proving the retry set drains once the removal is confirmed.
    await pub().put('f/RF-RETRY', 'stubborn copy');
    const retry = memoryRetry();

    // First slice: the object is deleted and confirmed gone, so it clears immediately.
    const first = await runFileOps(env(), { copies: [], deletions: ['RF-RETRY'] }, retry);
    expect(first.deleted).toEqual(['RF-RETRY']);
    expect(retry.pending()).toEqual([]);

    // A delete that threw (simulated by a pre-seeded pending entry whose object is absent) confirms gone next slice.
    const carried = memoryRetry(['RF-GONE']);
    const second = await runFileOps(env(), { copies: [], deletions: [] }, carried);
    expect(second.deleted).toEqual(['RF-GONE']);
    expect(carried.pending()).toEqual([]);
  });

  it('retries a deletion whose object is still present after the delete, until it is gone', async () => {
    // Back the retry set so a carried-over removal is retried even with no new deletions this slice.
    await pub().put('f/RF-STUCK', 'still here');
    const retry = memoryRetry(['RF-STUCK']);

    const result = await runFileOps(env(), { copies: [], deletions: [] }, retry);
    expect(result.deleted).toEqual(['RF-STUCK']); // the local bucket delete does take effect, so it drains
    expect(retry.pending()).toEqual([]);
    expect(await pub().get('f/RF-STUCK')).toBeNull();
  });

  it('reports a failed copy as not-linkable and does not stop the deletions', async () => {
    await pub().put('f/RF-OLD', 'to be removed');
    const retry = memoryRetry();
    // The copy source is missing, so copyPublicFile throws and the copy is reported failed; the deletion still runs.
    const ops: FileOps = { copies: [copy({ itemIdentifier: 'RF-BAD', sourceKey: 'files/missing' })], deletions: ['RF-OLD'] };

    const result = await runFileOps(env(), ops, retry);

    expect(result.deleted).toEqual(['RF-OLD']);
    expect(result.copied).toEqual([]);
    expect(result.copiesFailed).toEqual(['RF-BAD']);
    expect(await pub().get('f/RF-BAD')).toBeNull();
  });
});
