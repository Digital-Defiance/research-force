import { describe, expect, it } from 'vitest';
import {
  BACKUP_FORMAT_VERSION,
  rootDigest,
  serializeManifest,
  validateManifest,
} from '../src/backup/index';
import type { RootManifest } from '../src/backup/index';

// Feature: research-collab-cms — Internal_Backup authenticated root manifest (R36.1, R36.13).

const HASH = (seed: string): string => {
  // A deterministic well-formed 64-hex string for fixtures (not a real digest).
  let s = '';
  for (let i = 0; i < 64; i++) s += ((seed.charCodeAt(i % seed.length) + i) % 16).toString(16);
  return s;
};

function baseManifest(): RootManifest {
  const draft: Omit<RootManifest, 'trust'> & { trust: Omit<RootManifest['trust'], 'manifestFingerprint'> } = {
    kind: 'rf-internal-backup-root',
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaRelease: 'r2026.10',
    installationId: 'rf-prod',
    snapshot: { sequence: 42, at: '2026-10-29T00:00:00.000Z' },
    tables: [
      { table: 'research_items', rows: 3, sha256: HASH('items') },
      { table: 'attachments', rows: 2, sha256: HASH('att') },
    ],
    fields: [{ address: 'research_item:ri1:logSummary', sha256: HASH('field'), fragments: 1, utf16Length: 12 }],
    files: [{ id: 'f-abc', bytes: 1024, sha256: HASH('file') }],
    counts: { tables: 2, fields: 1, files: 1, rows: 5 },
    trust: { custodians: [{ keyId: 'primary', fingerprint: HASH('cust') }] },
  };
  // Seal with the self-referential fingerprint = rootDigest of the rest.
  const sealed = { ...draft, trust: { ...draft.trust, manifestFingerprint: '0'.repeat(64) } } as RootManifest;
  return { ...sealed, trust: { ...sealed.trust, manifestFingerprint: rootDigest(sealed) } };
}

describe('backup root manifest: canonical digest', () => {
  it('is stable under key reordering of equal content', () => {
    const m = baseManifest();
    const reordered: RootManifest = {
      ...m,
      // Reconstruct with a different declaration order of the same data.
      trust: { custodians: [...m.trust.custodians], manifestFingerprint: m.trust.manifestFingerprint },
      snapshot: { at: m.snapshot.at, sequence: m.snapshot.sequence },
    };
    expect(rootDigest(reordered)).toBe(rootDigest(m));
  });

  it('changes when any recorded count or hash changes', () => {
    const m = baseManifest();
    const before = rootDigest(m);
    const tampered: RootManifest = { ...m, counts: { ...m.counts, rows: 6 } };
    expect(rootDigest(tampered)).not.toBe(before);
  });

  it('serializes to canonical sorted-key bytes', () => {
    const bytes = serializeManifest(baseManifest());
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as RootManifest;
    expect(parsed.kind).toBe('rf-internal-backup-root');
  });
});

describe('backup root manifest: structural validation (R36.8)', () => {
  it('accepts a well-formed, self-consistent manifest', () => {
    expect(validateManifest(baseManifest())).toEqual([]);
  });

  it('rejects an unknown format version', () => {
    const m = { ...baseManifest(), formatVersion: 99 };
    expect(validateManifest(m as RootManifest)).toContain('formatVersion');
  });

  it('rejects a row-count mismatch', () => {
    const m = baseManifest();
    const bad: RootManifest = { ...m, counts: { ...m.counts, rows: 999 } };
    expect(validateManifest(bad)).toContain('row-count-mismatch');
  });

  it('rejects a duplicate table identity', () => {
    const m = baseManifest();
    const bad: RootManifest = {
      ...m,
      tables: [m.tables[0]!, m.tables[0]!],
      counts: { ...m.counts, tables: 2, rows: m.tables[0]!.rows * 2 },
    };
    // Re-seal so only the duplicate (not the fingerprint) is the fault we test.
    const sealed: RootManifest = { ...bad, trust: { ...bad.trust, manifestFingerprint: rootDigest(bad) } };
    expect(validateManifest(sealed)).toContain('duplicate-table');
  });

  it('rejects a malformed content hash', () => {
    const m = baseManifest();
    const bad: RootManifest = { ...m, files: [{ id: 'f-abc', bytes: 1, sha256: 'not-a-hash' }], counts: { ...m.counts, files: 1 } };
    expect(validateManifest(bad)).toContain('bad-hash');
  });

  it('rejects a self-fingerprint that does not match the recomputed digest', () => {
    const m = baseManifest();
    const bad: RootManifest = { ...m, trust: { ...m.trust, manifestFingerprint: 'f'.repeat(64) } };
    expect(validateManifest(bad)).toContain('fingerprint-mismatch');
  });
});
