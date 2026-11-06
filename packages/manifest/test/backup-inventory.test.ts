import { describe, expect, it } from 'vitest';
import {
  BACKUP_FORMAT_VERSION,
  MAX_PRECEDING_SCHEMAS,
  UnsupportedSchemaError,
  buildRegistry,
  rootDigest,
  selectTransform,
  supportedReleases,
  upgradeManifest,
} from '../src/backup/index';
import type { CompatibilityTransform, RootManifest, SchemaInventory } from '../src/backup/index';

// Feature: research-collab-cms — schema/table inventory registry + compatibility transforms (R36.16, R60.5).

const HASH = (s: string): string => s.padEnd(64, '0').slice(0, 64).replace(/[^0-9a-f]/g, '0');

const inv = (schemaRelease: string, tables: string[], fieldOwners: string[]): SchemaInventory => ({ schemaRelease, tables, fieldOwners });

function manifestAt(schemaRelease: string, extra: Partial<RootManifest> = {}): RootManifest {
  const draft = {
    kind: 'rf-internal-backup-root' as const,
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaRelease,
    installationId: 'rf-prod',
    snapshot: { sequence: 1, at: '2026-10-29T00:00:00.000Z' },
    tables: [{ table: 'research_items', rows: 1, sha256: HASH('a') }],
    fields: [],
    files: [],
    counts: { tables: 1, fields: 0, files: 0, rows: 1 },
    trust: { custodians: [] },
    ...extra,
  };
  const sealed = { ...draft, trust: { ...draft.trust, manifestFingerprint: '0'.repeat(64) } } as RootManifest;
  return { ...sealed, trust: { ...sealed.trust, manifestFingerprint: rootDigest(sealed) } };
}

/** A transform that renames the research_items table from the old release to the new. */
const renameTransform = (from: string, to: string): CompatibilityTransform => ({
  from,
  to,
  note: 'added "attachments" coverage; research_items unchanged',
  upgrade: (m) => ({ ...m, schemaRelease: to }),
});

describe('inventory registry: supported window (R36.16)', () => {
  it('supports the current and two preceding releases, newest first', () => {
    const registry = buildRegistry({
      current: inv('r3', ['research_items', 'attachments'], ['research_item']),
      preceding: [
        { inventory: inv('r2', ['research_items'], ['research_item']), transform: renameTransform('r2', 'r3') },
        { inventory: inv('r1', ['research_items'], ['research_item']), transform: renameTransform('r1', 'r3') },
      ],
    });
    expect(supportedReleases(registry)).toEqual(['r3', 'r2', 'r1']);
    expect(MAX_PRECEDING_SCHEMAS).toBe(2);
  });

  it('refuses more than two preceding releases', () => {
    expect(() =>
      buildRegistry({
        current: inv('r4', ['t'], ['o']),
        preceding: [
          { inventory: inv('r3', ['t'], ['o']), transform: renameTransform('r3', 'r4') },
          { inventory: inv('r2', ['t'], ['o']), transform: renameTransform('r2', 'r4') },
          { inventory: inv('r1', ['t'], ['o']), transform: renameTransform('r1', 'r4') },
        ],
      }),
    ).toThrow(RangeError);
  });

  it('refuses a transform whose target is not the current release', () => {
    expect(() =>
      buildRegistry({
        current: inv('r3', ['t'], ['o']),
        preceding: [{ inventory: inv('r2', ['t'], ['o']), transform: renameTransform('r2', 'rX') }],
      }),
    ).toThrow(/must target the current release/);
  });
});

describe('inventory registry: transform selection and upgrade', () => {
  const registry = buildRegistry({
    current: inv('r3', ['research_items', 'attachments'], ['research_item']),
    preceding: [
      { inventory: inv('r2', ['research_items'], ['research_item']), transform: renameTransform('r2', 'r3') },
      { inventory: inv('r1', ['research_items'], ['research_item']), transform: renameTransform('r1', 'r3') },
    ],
  });

  it('reads a current-version backup via the identity transform', () => {
    const transform = selectTransform(registry, 'r3');
    expect(transform.from).toBe('r3');
    expect(transform.to).toBe('r3');
    const upgraded = upgradeManifest(registry, manifestAt('r3'));
    expect(upgraded.schemaRelease).toBe('r3');
  });

  it('reads a v-1 backup via its transform, producing the current reader view', () => {
    const upgraded = upgradeManifest(registry, manifestAt('r2'));
    expect(upgraded.schemaRelease).toBe('r3');
  });

  it('reads a v-2 backup via its transform', () => {
    const upgraded = upgradeManifest(registry, manifestAt('r1'));
    expect(upgraded.schemaRelease).toBe('r3');
  });

  it('rejects an unknown/too-old version with a clear error (R36.8)', () => {
    expect(() => selectTransform(registry, 'r0')).toThrow(UnsupportedSchemaError);
    try {
      upgradeManifest(registry, manifestAt('r0'));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedSchemaError);
      expect((error as Error).message).toContain('not supported');
      expect((error as Error).message).toContain('quarantined');
    }
  });
});
