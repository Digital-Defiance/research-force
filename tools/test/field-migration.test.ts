import { expect, it } from 'vitest';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { developmentManifest } from '../src/release-manifest';
import { rehearseRelease } from '../src/release-rehearsal';
import { migrateLocalFields } from '../migrate-fields';
import { ROOT } from './release-fixtures';
it('runs the exact canonical-field backfill on disposable current/prior-schema copies, resumes checkpoints and preserves source/history', async () => {
  const { directory } = await rehearseRelease(ROOT, developmentManifest(ROOT), tmpdir());
  try {
    const path = resolve(directory, 'core-10.sqlite');
    const before = new DatabaseSync(path); const text = before.prepare('SELECT unit_id,text,text_spans FROM entry_sections ORDER BY unit_id').all();
    const history = before.prepare('SELECT id,prev FROM revisions ORDER BY id').all(); before.close();
    const first = await migrateLocalFields(path, 2); expect(first.progress?.done).toBe(false);
    const final = await migrateLocalFields(path); expect(final.progress?.done).toBe(true);
    const after = new DatabaseSync(path);
    try {
      expect(after.prepare('SELECT unit_id,text,text_spans FROM entry_sections ORDER BY unit_id').all()).toEqual(text);
      expect(after.prepare('SELECT id,prev FROM revisions ORDER BY id').all()).toEqual(history);
      expect(Number(after.prepare('SELECT count(*) AS n FROM field_current').get()?.['n'])).toBeGreaterThan(5);
      const generation = final.progress!.generation;
      expect((await migrateLocalFields(path)).progress?.generation).toBe(generation);
    } finally { after.close(); }
    await expect(migrateLocalFields(resolve(directory, 'core-10-recovery.sqlite'))).rejects.toThrow(/working core/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 30_000);
