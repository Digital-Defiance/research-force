import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// A truncated download must give an actionable message and exit 1, not a stack trace (R36.7).
describe('verify-backup on a truncated tar', () => {
  it('explains the incomplete download and exits 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rf-verify-test-'));
    try {
      // One tar member whose data is cut off: a 512-byte header promising 4096 bytes, then only 100.
      const header = Buffer.alloc(512);
      header.write('files/synthetic', 0, 'ascii');
      header.write('0000644\0', 100, 'ascii');
      header.write('00000010000\0', 124, 'ascii');
      header.write('0', 156, 'ascii');
      header.write('ustar\0' + '00', 257, 'ascii');
      header.write('        ', 148, 'ascii');
      let sum = 0;
      for (const byte of header) sum += byte;
      header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
      const tarPath = join(dir, 'package.tar');
      writeFileSync(tarPath, Buffer.concat([header, Buffer.alloc(100, 1)]));
      const keyPath = join(dir, 'key.txt');
      writeFileSync(keyPath, Buffer.alloc(32, 7).toString('base64'));
      const run = spawnSync(process.execPath, ['--import', 'tsx', 'tools/verify-backup.ts', tarPath, keyPath], { encoding: 'utf8' });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('NOT VERIFIED');
      expect(run.stderr).toContain('incomplete');
      expect(run.stderr).toContain('curl -C -');
      expect(run.stderr).not.toContain('    at ');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
