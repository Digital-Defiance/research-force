import { beforeAll, describe, expect, it } from 'vitest';
import { GuardedBatch } from '@researchforce/db/batch';
import { collectField, DatabaseFieldReader, leaseField, linkCurrentField, prepareField, retainField } from '@researchforce/db/field-versions';
import { readRevisionSnapshot } from '@researchforce/db/field-snapshots';
import { readField } from '@researchforce/domain/text-fragments';
import { asTimestamp, asULID } from '@researchforce/domain/types';
import { migrated } from './d1';
let db: D1Database;
const now = asTimestamp('2026-10-29T12:00:00.000Z'); const actor = asULID('0'.repeat(25) + '1');
beforeAll(async () => { db = (await migrated()).RF_CORE; });
const value = { text: '😀'.repeat(300_000) + '\u0000 exact e\u0301', spans: [{ k: 'quote' as const, s: 126_000, e: 130_000, source: 'Synthetic source' }] };
describe('bounded immutable field storage', () => {
  it('seals exact pieces, refuses another owner, and enforces immutability/physical budgets in SQLite', async () => {
    const owner = { ownerType: 'unit', ownerId: 'field-test-one', field: 'text' };
    const reference = await prepareField(db, owner, value, now);
    expect(await readField(reference, new DatabaseFieldReader(db, owner))).toEqual(value);
    await expect(readField(reference, new DatabaseFieldReader(db, { ...owner, ownerId: 'other' }))).rejects.toThrow(/owner/);
    await expect(db.prepare('UPDATE text_fragments SET payload_json=? WHERE version_id=?').bind('changed', reference.id).run()).rejects.toThrow(/immutable/);
    await expect(db.prepare('DELETE FROM text_fragments WHERE version_id=?').bind(reference.id).run()).rejects.toThrow(/retained/);
    const sizes = await db.prepare('SELECT max(length(CAST(payload_json AS BLOB))) AS n FROM text_fragments WHERE version_id=?').bind(reference.id).first<number>('n');
    expect(sizes).toBeLessThanOrEqual(128_000);
    await expect(db.prepare('INSERT INTO text_fragments VALUES (?,?,?,?)').bind(reference.id, 99999, 'x'.repeat(128_001), '0'.repeat(64)).run()).rejects.toThrow();
  });
  it('links only complete matching owners atomically and retains versions for references and read leases', async () => {
    const owner = { ownerType: 'unit', ownerId: 'field-test-two', field: 'text' }; const reference = await prepareField(db, owner, { text: 'Exact retention test', spans: [] }, now);
    const failed = new GuardedBatch(db, { id: actor, now }); linkCurrentField(failed, { ...reference, ownerId: 'forged' }, null);
    await expect(failed.commit()).rejects.toThrow(/mismatch/);
    const saved = new GuardedBatch(db, { id: actor, now }); linkCurrentField(saved, reference, null); retainField(saved, reference, { type: 'citation', id: 'citation-test', slot: 'quoted' }); await saved.commit();
    await expect(collectField(db, reference.id, now)).rejects.toThrow(/retained/);
    await db.prepare('DELETE FROM field_current WHERE version_id=?').bind(reference.id).run();
    await expect(collectField(db, reference.id, now)).rejects.toThrow(/retained/);
    await db.prepare('DELETE FROM field_references WHERE version_id=?').bind(reference.id).run();
    await leaseField(db, reference, 'reader-test', now, 30);
    await expect(collectField(db, reference.id, now)).rejects.toThrow(/retained/);
    await collectField(db, reference.id, asTimestamp('2026-10-29T12:00:31.000Z'));
    expect(await db.prepare('SELECT id FROM field_versions WHERE id=?').bind(reference.id).first()).toBeNull();
  });
  it('stores large previous values as retained immutable references and reconstructs history without oversized Revision JSON', async () => {
    const batch = new GuardedBatch(db, { id: actor, now });
    batch.revision({ targetType: 'unit', targetId: 'field-history', kind: 'minor_edit', prev: { text: value, accessMembers: [actor] } });
    await batch.commit();
    const row = await db.prepare('SELECT id,prev,length(CAST(prev AS BLOB)) AS bytes FROM revisions WHERE target_id=?').bind('field-history').first<{ id: string; prev: string; bytes: number }>();
    expect(row!.bytes).toBeLessThan(512_000);
    expect(JSON.parse(row!.prev).accessMembers).toEqual([actor]);
    expect(await readRevisionSnapshot(db, row!.id, JSON.parse(row!.prev))).toEqual({ text: value, accessMembers: [actor] });
    expect(await db.prepare('SELECT count(*) AS n FROM field_references WHERE holder_id=?').bind(row!.id).first('n')).toBe(1);
  });
});

it('keeps incomplete versions unreachable and accepts only identical part replays before sealing', async () => {
  const { beginFieldVersion, putFieldFragment, sealFieldVersion } = await import('@researchforce/db/field-versions');
  const { fieldManifest, fieldFragments } = await import('@researchforce/domain/text-fragments');
  const owner = { ownerType: 'unit', ownerId: 'partwise-field', field: 'text' }; const manifest = fieldManifest(value);
  const reference = await beginFieldVersion(db, owner, manifest, now); const parts = [...fieldFragments(value)];
  const invalid = new GuardedBatch(db, { id: actor, now }); linkCurrentField(invalid, reference, null);
  await expect(invalid.commit()).rejects.toThrow(/mismatch/);
  await putFieldFragment(db, owner, reference, parts[0]!);
  await putFieldFragment(db, owner, reference, Object.fromEntries(Object.entries(parts[0]!).reverse()) as unknown as typeof parts[number]);
  await expect(sealFieldVersion(db, owner, reference)).rejects.toThrow(/Missing|Incomplete/);
  for (const part of parts.slice(1)) await putFieldFragment(db, owner, reference, part);
  await sealFieldVersion(db, owner, reference); await sealFieldVersion(db, owner, reference);
  expect(await readField(reference, new DatabaseFieldReader(db, owner))).toEqual(value);
});

it('migrates legacy current fields and immutable Revisions with resumable atomic cursors', async () => {
  const { migrateLegacyFieldSlice, LEGACY_RICH_FIELDS } = await import('@researchforce/db/field-backfill');
  // The large previous-value fixture above remains readable while a sidecar is prepared; its original bytes stay immutable.
  const { newULID } = await import('@researchforce/domain/identifiers');
  const legacyId = newULID(now); const legacyPrev = JSON.stringify({ text: value });
  await db.prepare('INSERT INTO revisions(id,target_type,target_id,kind,member_id,at,prev,seq) VALUES(?,?,?,?,?,?,?,?)').bind(legacyId,'unit','legacy-large','minor_edit',actor,now,legacyPrev,0).run();
  const before = await db.prepare('SELECT id,prev FROM revisions ORDER BY id').all<{ id: string; prev: string }>();
  let progress = await migrateLegacyFieldSlice(db, { id: actor, now }, 'field-test-migration', 0);
  await expect(migrateLegacyFieldSlice(db, { id: actor, now }, 'field-test-migration', 0)).rejects.toThrow(/Stale/);
  for (let i = 0; !progress.done && i < LEGACY_RICH_FIELDS.length + 10; i++) progress = await migrateLegacyFieldSlice(db, { id: actor, now }, 'field-test-migration', progress.generation);
  expect(progress.done).toBe(true);
  expect(await db.prepare('SELECT prev FROM revisions WHERE id=?').bind(legacyId).first('prev')).toBe(legacyPrev);
  expect(await readRevisionSnapshot(db, legacyId, JSON.parse(legacyPrev))).toEqual({ text: value });
  expect(await db.prepare('SELECT id,prev FROM revisions ORDER BY id').all()).toMatchObject({ results: before.results });
  expect((await migrateLegacyFieldSlice(db, { id: actor, now }, 'field-test-migration', progress.generation)).done).toBe(true);
});

it('holds an automatic scoped read lease until a streaming reader closes and blocks preparation during freeze', async () => {
  const owner = { ownerType: 'unit', ownerId: 'automatic-lease', field: 'text' };
  const reference = await prepareField(db, owner, { text: 'leased '.repeat(30_000), spans: [] }, now);
  await db.prepare('DELETE FROM field_read_leases WHERE version_id=?').bind(reference.id).run();
  const reader = new DatabaseFieldReader(db, owner).fragments(reference);
  await reader.next();
  const actualNow = asTimestamp(new Date().toISOString());
  await expect(collectField(db, reference.id, actualNow)).rejects.toThrow(/retained/);
  await reader.return(undefined); await collectField(db, reference.id, actualNow);
  await db.prepare("UPDATE counters SET v=1 WHERE k='frozen'").run();
  try { await expect(prepareField(db, owner, { text: 'frozen', spans: [] }, now)).rejects.toThrow(/paused/); }
  finally { await db.prepare("UPDATE counters SET v=0 WHERE k='frozen'").run(); }
});
