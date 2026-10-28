import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, expect, inject, it } from 'vitest';
import type { Env } from '../src/env';
const core = (env as unknown as Env).RF_CORE;
const migrations = inject('d1Migrations').core;
beforeAll(async () => {
  const index = migrations.findIndex((migration) => migration.name.startsWith('0009_files')); expect(index).toBeGreaterThan(0);
  await applyD1Migrations(core, migrations.slice(0, index));
  for (const [id, completed, attached] of [['pending', null, null], ['complete', '2026-10-27T18:00:00.000Z', null], ['attached', '2026-10-27T18:00:00.000Z', '2026-10-27T18:00:00.000Z']]) {
    await core.prepare(`INSERT INTO uploads(id,owner_type,owner_id,r2_key,file_name,size_bytes,sha256,mode,created_at,completed_at,attached_at)
      VALUES(?1,'member','synthetic',?1,'Synthetic.txt',0,?2,'single','2026-10-27T18:00:00.000Z',?3,?4)`).bind(id, '0'.repeat(64), completed, attached).run();
  }
  await applyD1Migrations(core, migrations);
});
it('preserves older uploads and derives their state without losing file metadata', async () => {
  const rows = await core.prepare('SELECT id, state, group_id AS groupId, file_name AS name FROM uploads ORDER BY id').all();
  expect(rows.results).toEqual([
    { id: 'attached', state: 'attached', groupId: null, name: 'Synthetic.txt' }, { id: 'complete', state: 'complete', groupId: null, name: 'Synthetic.txt' }, { id: 'pending', state: 'uploading', groupId: null, name: 'Synthetic.txt' },
  ]);
});
