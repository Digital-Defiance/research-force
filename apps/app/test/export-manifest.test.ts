// Feature: research-collab-cms, Task 38.2 — the Public_Archive_Export pure helpers (R35.6–R35.11, R35.10, R46.34).
import { describe, expect, it } from 'vitest';
import type { ManifestEntry } from '@researchforce/public-render/export/manifest';
import {
  labelsFor, manifestMisses, requestedExpired, scheduledToDelete, volumeManifests,
} from '../src/jobs/export-manifest';
import type { CurrentState, UnitIndex, VerifiedFile } from '../src/jobs/export-manifest';

const entry = (path: string, bytes: number | null, sha256: string | null): ManifestEntry => ({ path, bytes, sha256 });
const stored = (files: VerifiedFile[]): Map<string, VerifiedFile> => new Map(files.map((f) => [f.path, f]));

describe('manifestMisses (R35.6, R35.7)', () => {
  it('reports no misses when every entry matches its stored size and checksum', () => {
    const entries = [entry('index.html', 10, 'aa'), entry('files/f/X', 3, 'bb')];
    const map = stored([{ path: 'index.html', bytes: 10, sha256: 'aa' }, { path: 'files/f/X', bytes: 3, sha256: 'bb' }]);
    expect(manifestMisses(entries, map)).toEqual([]);
  });

  it('lists a missing file, a size mismatch, and a checksum mismatch', () => {
    const entries = [entry('a', 1, 'aa'), entry('b', 2, 'bb'), entry('c', 3, 'cc'), entry('d', null, null)];
    const map = stored([{ path: 'a', bytes: 1, sha256: 'aa' }, { path: 'b', bytes: 9, sha256: 'bb' }, { path: 'c', bytes: 3, sha256: 'zz' }]);
    expect(manifestMisses(entries, map)).toEqual([
      { path: 'b', reason: 'size' }, { path: 'c', reason: 'checksum' }, { path: 'd', reason: 'missing' },
    ]);
  });

  it('matches a checksum case-insensitively', () => {
    expect(manifestMisses([entry('a', 1, 'ABCD')], stored([{ path: 'a', bytes: 1, sha256: 'abcd' }]))).toEqual([]);
  });
});

describe('volumeManifests (R35.9)', () => {
  it('splits files into volumes of at most 900 members, preserving order', () => {
    const paths = Array.from({ length: 1850 }, (_v, index) => `files/f/${index}`);
    const volumes = volumeManifests(paths, (path) => `exports/E/${path}`);
    expect(volumes).toHaveLength(3);
    expect(volumes[0]!.members).toHaveLength(900);
    expect(volumes[1]!.members).toHaveLength(900);
    expect(volumes[2]!.members).toHaveLength(50);
    // The bucket key drops rf-private and the name is the package-relative path (the shape rf-dl reads).
    expect(volumes[0]!.members[0]).toEqual({ key: 'exports/E/files/f/0', name: 'files/f/0' });
  });
});

describe('scheduledToDelete (R35.6)', () => {
  const scheduled = (id: string, state: string, startedAt: string) => ({ id, state, startedAt });
  it('keeps the 3 most recent complete scheduled exports and deletes older ones', () => {
    const exports = [
      scheduled('m1', 'complete', '2026-01-01T00:07:00.000Z'),
      scheduled('m2', 'complete', '2026-02-01T00:07:00.000Z'),
      scheduled('m3', 'complete', '2026-03-01T00:07:00.000Z'),
      scheduled('m4', 'complete', '2026-04-01T00:07:00.000Z'),
    ];
    // m1 is older than the 3rd newest complete (m2), so it goes; m2, m3, m4 stay.
    expect(scheduledToDelete(exports)).toEqual(['m1']);
  });

  it('never deletes a still-building scheduled export before 3 complete ones are newer than it', () => {
    const exports = [
      scheduled('m1', 'complete', '2026-01-01T00:07:00.000Z'),
      scheduled('m2', 'complete', '2026-02-01T00:07:00.000Z'),
      scheduled('running', 'running', '2026-03-01T00:07:00.000Z'),
    ];
    // Only 2 complete ones exist, so nothing is older than a 3rd; the running export is kept.
    expect(scheduledToDelete(exports)).toEqual([]);
  });

  it('deletes an incomplete scheduled export once 3 newer complete ones exist', () => {
    const exports = [
      scheduled('old', 'incomplete', '2026-01-01T00:07:00.000Z'),
      scheduled('m2', 'complete', '2026-02-01T00:07:00.000Z'),
      scheduled('m3', 'complete', '2026-03-01T00:07:00.000Z'),
      scheduled('m4', 'complete', '2026-04-01T00:07:00.000Z'),
    ];
    expect(scheduledToDelete(exports)).toEqual(['old']);
  });
});

describe('requestedExpired (R35.11)', () => {
  it('is false before 7 days and true at or after 7 days from the start', () => {
    const start = '2026-01-01T00:00:00.000Z';
    expect(requestedExpired(start, '2026-01-07T23:59:59.000Z')).toBe(false);
    expect(requestedExpired(start, '2026-01-08T00:00:00.000Z')).toBe(true);
  });
});

describe('labelsFor (R35.10, R46.34)', () => {
  const index: UnitIndex = {
    units: [{ key: 'u:a', level: 'public' }, { key: 'u:b', level: 'public' }, { key: 'u:c', level: 'withheld' }],
    parties: ['party1', 'party2'],
    emails: ['new@member.test', 'stranger@elsewhere.test'],
  };
  const state = (over: Partial<CurrentState>): CurrentState => ({
    level: () => 'public', doNotName: () => false, registeredEmail: () => false, ...over,
  });

  it('labels no package when nothing changed', () => {
    expect(labelsFor(index, state({}))).toEqual([]);
  });

  it('labels a unit exported Public now Withheld, and one now absent', () => {
    const labels = labelsFor(index, state({ level: (key) => (key === 'u:a' ? 'withheld' : key === 'u:b' ? 'absent' : 'withheld') }));
    expect(labels).toContainEqual({ kind: 'unit_withdrawn', key: 'u:a' });
    expect(labels).toContainEqual({ kind: 'unit_removed', key: 'u:b' });
  });

  it('labels a now-absent Withheld unit, a Do_Not_Name Party, and a now-registered Member address', () => {
    const labels = labelsFor(index, state({
      level: (key) => (key === 'u:c' ? 'absent' : 'public'),
      doNotName: (id) => id === 'party2',
      registeredEmail: (email) => email === 'new@member.test',
    }));
    expect(labels).toContainEqual({ kind: 'unit_removed', key: 'u:c' });
    expect(labels).toContainEqual({ kind: 'party_do_not_name', partyId: 'party2' });
    expect(labels).toContainEqual({ kind: 'member_email', email: 'new@member.test' });
  });
});
