import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendEntry, EVIDENCE_LEDGER_FILE, EvidenceRejection, prepareEntry, readLedger, recordEvidence, type EvidenceInput } from '../src/evidence-recorder';
import { certifyScopes, GATE_BUILDERS, launchEvidenceSchema, manifestsForGraph } from '../src/launch-gates';

const NOW = '2026-03-01T10:00:00.000Z';
const good: EvidenceInput = {
  gate: 'team_archive', requirement: 'drafts_files', result: 'passed', scope: 'deployed-staging',
  releaseId: 'rel-2026.03.01', evidenceRef: 'docs/acceptance/reports/r2-summary.md',
};
const reasons = (fn: () => unknown): readonly string[] => {
  try { fn(); } catch (error) { if (error instanceof EvidenceRejection) return error.reasons; throw error; }
  return [];
};

describe('prepareEntry', () => {
  it('builds a schema-valid entry, derives kind and stamps recordedAt', () => {
    const entry = prepareEntry(good, NOW);
    expect(entry).toMatchObject({ kind: 'infra-staging', recordedAt: NOW, remediationTasks: [] });
  });

  it('refuses passed against local-synthetic', () => {
    expect(reasons(() => prepareEntry({ ...good, scope: 'local-synthetic' }, NOW)).join()).toContain('local-synthetic');
    expect(prepareEntry({ ...good, scope: 'local-synthetic', result: 'blocked' }, NOW).result).toBe('blocked');
  });

  it('requires releaseId and evidenceRef', () => {
    const { releaseId: _r, evidenceRef: _e, ...rest } = good;
    const found = reasons(() => prepareEntry(rest, NOW)).join();
    expect(found).toContain('releaseId is required');
    expect(found).toContain('evidenceRef is required');
  });

  it('refuses an unknown gate, unknown requirement and a kind the checker would not accept', () => {
    expect(reasons(() => prepareEntry({ ...good, gate: 'nope' }, NOW)).join()).toContain('unknown gate');
    expect(reasons(() => prepareEntry({ ...good, requirement: 'nope' }, NOW)).join()).toContain('no requirement');
    expect(reasons(() => prepareEntry({ ...good, kind: 'infra-restore' }, NOW)).join()).toContain('only satisfied by kind "infra-staging"');
    expect(reasons(() => prepareEntry({ ...good, kind: 'unit-test' }, NOW)).join()).toContain('only satisfied by kind');
  });

  it('accepts every requirement of every gate with its derived kind', () => {
    for (const [gate, builder] of Object.entries(GATE_BUILDERS)) {
      for (const requirement of builder.requirements) {
        expect(prepareEntry({ ...good, gate, requirement: requirement.id, kind: requirement.infra }, NOW).kind).toBe(requirement.infra);
      }
    }
  });

  it.each([
    ['a bearer link', 'https://dl.example.test/t/aGVsbG8gd29ybGQ.c2lnbmF0dXJlMTIzNDU2'],
    ['a bearer header', 'Authorization: Bearer abcdefgh12345678'],
    ['a provider token', 'ghp_abcdefghijklmnop1234'],
    ['a JWT', 'eyJhbGciOiJI.eyJzdWIiOiIx'],
    ['a long hex string', '0123456789abcdef0123456789abcdef'],
    ['a secret assignment', 'password=hunter22'],
    ['a query token', 'https://x.example.test/r?token=abc'],
  ])('rejects an evidenceRef and a note containing %s', (_name, text) => {
    expect(reasons(() => prepareEntry({ ...good, evidenceRef: text }, NOW)).join()).toContain('evidenceRef looks like');
    expect(reasons(() => prepareEntry({ ...good, note: text }, NOW)).join()).toContain('note looks like');
  });

  it('allows an ordinary long report path', () => {
    expect(() => prepareEntry({ ...good, evidenceRef: 'docs/acceptance/reports/2026-03-01-team-archive-restore-rehearsal-summary.md', note: 'checked by the operator on staging' }, NOW)).not.toThrow();
  });
});

describe('appendEntry', () => {
  const entry = prepareEntry(good, NOW);
  it('refuses a duplicate gate+requirement+release unless replace is given', () => {
    const once = appendEntry({ schemaVersion: 1, entries: [] }, entry);
    expect(reasons(() => appendEntry(once, entry)).join()).toContain('already exists');
    const failed = prepareEntry({ ...good, result: 'failed' }, NOW);
    expect(appendEntry(once, failed, { replace: true }).entries).toEqual([failed]);
  });

  it('allows the same requirement for another release', () => {
    const once = appendEntry({ schemaVersion: 1, entries: [] }, entry);
    expect(appendEntry(once, prepareEntry({ ...good, releaseId: 'rel-2' }, NOW)).entries).toHaveLength(2);
  });
});

describe('recordEvidence (file)', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'rf-evidence-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('creates the ledger when absent and appends one valid entry', () => {
    expect(existsSync(join(root, EVIDENCE_LEDGER_FILE))).toBe(false);
    recordEvidence(root, good, { now: NOW });
    const ledger = launchEvidenceSchema.parse(JSON.parse(readFileSync(join(root, EVIDENCE_LEDGER_FILE), 'utf8')));
    expect(ledger.entries).toHaveLength(1);
    expect(readLedger(root).schemaVersion).toBe(1);
  });

  it('writes nothing on rejection', () => {
    expect(() => recordEvidence(root, { ...good, scope: 'local-synthetic' })).toThrow(EvidenceRejection);
    expect(existsSync(join(root, EVIDENCE_LEDGER_FILE))).toBe(false);
  });

  it('records entries the checker accepts', () => {
    const manifests = manifestsForGraph([{ id: 'team_archive', requiredEvidence: [] }]);
    const requirements = GATE_BUILDERS['team_archive']!.requirements;
    for (const requirement of requirements) recordEvidence(root, { ...good, requirement: requirement.id }, { now: NOW });
    expect(certifyScopes(manifests, readLedger(root), ['team_archive']).certified).toBe(true);
  });
});
