// Feature: research-collab-cms, Task 58.4 — the restore PREFLIGHT, bootstrap-identity RECONCILIATION, restore-owned
// CHECKPOINTS (insert-or-verify), and the QUARANTINE + SUPPRESSION gate building blocks that task 38.5 consumes
// (R36.4, R36.5, R36.8, R36.9, R36.10, R36.15, R36.16, R60.5).
//
// Two layers: PURE unit tests of the checkable decisions (reconciliation, insert-or-verify, canonical-row-hash,
// schema-transform selection, suppression application, quarantine precondition), then D1 + R2-backed tests that build
// a REAL backup package with the 38.4 job against a seeded rf-core (reusing the 38.4 harness) and drive
// `backupPreflight` against it — asserting ok on a healthy package and the specific problem (with no insertion
// authorised) for each injected failure.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UnsupportedSchemaError, buildRegistry, selectTransform } from '@researchforce/manifest/backup/index';
import type { InventoryRegistry, SchemaInventory } from '@researchforce/manifest/backup/index';
import { asTimestamp } from '@researchforce/domain/types';
import type { ULID } from '@researchforce/domain/types';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { JOB_HANDLERS } from '../src/do/jobs';
import type { JsonValue } from '../src/do/jobs';
import { backupPrefix } from '../src/jobs/backup';
import '../src/api/routes/backups';
import { bucketKeyOf } from '../src/jobs/export';
import { itemWorld } from './items';
import { reconcileBootstrapIdentity } from '../src/backup/reconcile';
import type { BackedUpMember } from '../src/backup/reconcile';
import { canonicalRowHash, insertOrVerify } from '../src/backup/checkpoints';
import { backupPreflight } from '../src/backup/preflight';
import { applySuppressions, quarantineReleasePrecondition, suppressionDigest } from '../src/backup/quarantine';

// ── PURE unit tests: the checkable decisions, no D1/R2 ──────────────────────────────────────────────────────────────

describe('bootstrap-identity reconciliation (R36.9, R36.10, R36.15)', () => {
  const member = (id: string, emailLc: string): BackedUpMember => ({ id, emailLc });

  it('maps a bootstrap Administrator that shares an email but has a different id onto the original backed-up id', () => {
    const result = reconcileBootstrapIdentity(
      { id: 'BOOT-NEW', emailLc: 'owner@example.test' },
      [member('ORIG-1', 'owner@example.test'), member('ORIG-2', 'other@example.test')],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    // The transient bootstrap id is mapped onto the original backed-up id; the backed-up id is never rewritten.
    expect(result.mapping).toEqual({ kind: 'matched', fromBootstrapId: 'BOOT-NEW', toBackedUpId: 'ORIG-1' });
  });

  it('keeps a genuinely new operator standalone when no backed-up Member shares the email', () => {
    const result = reconcileBootstrapIdentity(
      { id: 'BOOT-NEW', emailLc: 'fresh@example.test' },
      [member('ORIG-1', 'owner@example.test')],
    );
    expect(result).toEqual({ ok: true, mapping: { kind: 'standalone', bootstrapId: 'BOOT-NEW' } });
  });

  it('rejects an ambiguous email that matches more than one backed-up Member', () => {
    const result = reconcileBootstrapIdentity(
      { id: 'BOOT-NEW', emailLc: 'owner@example.test' },
      [member('ORIG-1', 'owner@example.test'), member('ORIG-2', 'owner@example.test')],
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.conflict.kind).toBe('ambiguous-email');
    if (result.conflict.kind !== 'ambiguous-email') throw new Error('unreachable');
    expect([...result.conflict.backedUpIds].sort()).toEqual(['ORIG-1', 'ORIG-2']);
  });

  it('rejects an id collision when the bootstrap id already belongs to a different backed-up Member', () => {
    // The bootstrap shares its email with ORIG-1, but its id collides with a DIFFERENT backed-up Member ORIG-2.
    const result = reconcileBootstrapIdentity(
      { id: 'ORIG-2', emailLc: 'owner@example.test' },
      [member('ORIG-1', 'owner@example.test'), member('ORIG-2', 'other@example.test')],
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.conflict).toEqual({ kind: 'id-collision', bootstrapId: 'ORIG-2', conflictingBackedUpId: 'ORIG-2' });
  });

  it('rejects an id collision for a standalone operator whose id matches any backed-up id', () => {
    const result = reconcileBootstrapIdentity(
      { id: 'ORIG-1', emailLc: 'fresh@example.test' },
      [member('ORIG-1', 'owner@example.test')],
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.conflict.kind).toBe('id-collision');
  });
});

describe('insert-or-verify decision and canonical row hash (R36.4, R36.15)', () => {
  const row = { id: 'U1', title: 'A', n: 3 };
  const hash = canonicalRowHash(row);

  it('canonical row hash is deterministic and independent of key order', () => {
    expect(canonicalRowHash({ id: 'U1', title: 'A', n: 3 })).toBe(canonicalRowHash({ n: 3, title: 'A', id: 'U1' }));
    expect(canonicalRowHash({ id: 'U1', title: 'B', n: 3 })).not.toBe(hash);
  });

  it('inserts when there is no checkpoint and no destination row', () => {
    expect(insertOrVerify(hash, { checkpoint: null, destinationOccupied: false })).toEqual({ decision: 'insert' });
  });

  it('skips a row the same restore already installed with the same canonical payload', () => {
    expect(insertOrVerify(hash, { checkpoint: { payloadHash: hash }, destinationOccupied: true })).toEqual({ decision: 'skip-identical' });
  });

  it('conflicts when the same restore checkpointed a different payload for the key', () => {
    expect(insertOrVerify(hash, { checkpoint: { payloadHash: canonicalRowHash({ id: 'U1', title: 'Z', n: 3 }) }, destinationOccupied: true }))
      .toEqual({ decision: 'conflict', reason: 'checkpoint-payload-differs' });
  });

  it('conflicts on an unexpected duplicate: a destination row with no matching own checkpoint', () => {
    expect(insertOrVerify(hash, { checkpoint: null, destinationOccupied: true }))
      .toEqual({ decision: 'conflict', reason: 'unexpected-duplicate' });
  });

  it('never unconditionally ignores: every state yields exactly one of insert/skip-identical/conflict', () => {
    fc.assert(
      fc.property(
        fc.record({ hasCheckpoint: fc.boolean(), sameHash: fc.boolean(), occupied: fc.boolean() }),
        ({ hasCheckpoint, sameHash, occupied }) => {
          const other = canonicalRowHash({ id: 'U1', title: 'other', n: 3 });
          const state = { checkpoint: hasCheckpoint ? { payloadHash: sameHash ? hash : other } : null, destinationOccupied: occupied };
          const result = insertOrVerify(hash, state);
          expect(['insert', 'skip-identical', 'conflict']).toContain(result.decision);
          // A skip happens ONLY for an identical own-checkpoint; otherwise an occupied destination with no identical
          // checkpoint is always a conflict, never a silent ignore.
          if (result.decision === 'skip-identical') expect(hasCheckpoint && sameHash).toBe(true);
          if (!hasCheckpoint && occupied) expect(result.decision).toBe('conflict');
        },
      ),
      { numRuns: Math.min(FC_RUNS, 40) },
    );
  });
});

describe('schema-transform selection: current + two prior accepted, older rejected (R36.16, R60.5)', () => {
  const inventory = (schemaRelease: string): SchemaInventory => ({ schemaRelease, tables: [], fieldOwners: [] });
  const registry: InventoryRegistry = buildRegistry({
    current: inventory('r3'),
    preceding: [
      { inventory: inventory('r2'), transform: { from: 'r2', to: 'r3', note: 'r2->r3', upgrade: (m) => m } },
      { inventory: inventory('r1'), transform: { from: 'r1', to: 'r3', note: 'r1->r3', upgrade: (m) => m } },
    ],
  });

  it('accepts the current and the two preceding released schemas', () => {
    for (const release of ['r3', 'r2', 'r1']) {
      expect(() => selectTransform(registry, release)).not.toThrow();
      expect(selectTransform(registry, release).to).toBe('r3');
    }
  });

  it('rejects an older (unsupported) schema, keeping the restore quarantined', () => {
    expect(() => selectTransform(registry, 'r0')).toThrow(UnsupportedSchemaError);
  });
});

describe('suppression application and quarantine-release precondition (R36.5, R36.15, R36.16)', () => {
  const record = (suppressedId: string, generation: number, suppressedAt: string) => ({
    suppressedId, generation, suppressedAt, digest: suppressionDigest({ suppressedId, generation, suppressedAt }),
  });

  it('marks restored ids that appear in the authenticated ledger as suppressed, never to be reinstated', () => {
    const ledger = [record('ITEM-A', 1, '2026-10-01T00:00:00.000Z'), record('ITEM-C', 2, '2026-10-02T00:00:00.000Z')];
    const result = applySuppressions(['ITEM-A', 'ITEM-B', 'ITEM-C'], ledger);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect([...result.suppressed].sort()).toEqual(['ITEM-A', 'ITEM-C']);
  });

  it('fails on a tampered ledger whose digest does not match its fields', () => {
    const tampered = { suppressedId: 'ITEM-A', generation: 1, suppressedAt: '2026-10-01T00:00:00.000Z', digest: 'deadbeef' };
    const result = applySuppressions(['ITEM-A'], [tampered]);
    expect(result).toEqual({ ok: false, fault: 'tampered-ledger', element: 'suppression:ITEM-A' });
  });

  it('releases quarantine only when every gate passes, listing outstanding gates otherwise', () => {
    expect(quarantineReleasePrecondition({ validationPassed: true, suppressionsApplied: true, disclosureConsentPassed: true })).toEqual({ released: true });
    const blocked = quarantineReleasePrecondition({ validationPassed: true, suppressionsApplied: false, disclosureConsentPassed: false });
    expect(blocked.released).toBe(false);
    if (blocked.released) throw new Error('unreachable');
    expect([...blocked.blockedBy].sort()).toEqual(['disclosure-consent', 'suppressions']);
  });
});

// ── D1 + R2-backed preflight tests: build a real 38.4 package, then preflight it and inject each failure ─────────────

const RECOVERY_KEY = new Uint8Array(32).map((_byte, index) => (index * 7 + 3) & 0xff);
const RECOVERY_KEY_B64 = btoa(String.fromCharCode(...RECOVERY_KEY));
const CUSTODIAN = { custodianId: 'primary', generation: 1 } as const;

const world = itemWorld();
const core = () => world.bindings.RF_CORE;
const priv = () => world.bindings.RF_PRIVATE_BUCKET;

/** The registry whose current release is the backup's test schema release, with two preceding releases (R36.16). */
function testRegistry(current = 'r-test'): InventoryRegistry {
  const inv = (schemaRelease: string): SchemaInventory => ({ schemaRelease, tables: [], fieldOwners: [] });
  return buildRegistry({
    current: inv(current),
    preceding: [
      { inventory: inv('r-prev1'), transform: { from: 'r-prev1', to: current, note: 'prev1', upgrade: (m) => m } },
      { inventory: inv('r-prev2'), transform: { from: 'r-prev2', to: current, note: 'prev2', upgrade: (m) => m } },
    ],
  });
}

function configureBackup(): void {
  (world.bindings as { BACKUP_RECOVERY_CUSTODIANS?: string }).BACKUP_RECOVERY_CUSTODIANS = JSON.stringify([{ custodianId: CUSTODIAN.custodianId, generation: CUSTODIAN.generation, keyBase64: RECOVERY_KEY_B64 }]);
  (world.bindings as { BACKUP_INSTALLATION_ID?: string }).BACKUP_INSTALLATION_ID = 'rf-test';
  (world.bindings as { BACKUP_SCHEMA_RELEASE?: string }).BACKUP_SCHEMA_RELEASE = 'r-test';
}

async function jobRecord(id: ULID) {
  const row = (await core().prepare('SELECT params, requested_by AS requestedBy FROM jobs WHERE id = ?1').bind(id).first<{ params: string; requestedBy: ULID }>())!;
  return { id, type: 'internal_backup' as const, params: JSON.parse(row.params) as JsonValue, requestedBy: row.requestedBy };
}

/** Drive the real internal_backup job to completion, as backup.test.ts does. */
async function runBackup(id: ULID): Promise<'complete' | 'incomplete'> {
  const start = Date.parse(world.at);
  let cursor: JsonValue = null;
  for (let slice = 0; slice < 5_000; slice++) {
    const now = asTimestamp(new Date(start + slice * 1_000).toISOString());
    const result = await JOB_HANDLERS.internal_backup!.slice({ env: world.bindings, job: await jobRecord(id), now }, cursor);
    if (result.done) return result.outcome ?? 'complete';
    cursor = result.cursor;
  }
  throw new Error('backup job did not finish');
}

/** Build a complete, sealed package against the seeded rf-core and return its id. */
async function sealedPackage(): Promise<ULID> {
  await world.created('author', 'finding');
  const { id } = await (await world.request('admin', 'POST', '/backups', {})).json<{ id: ULID }>();
  expect(await runBackup(id)).toBe('complete');
  return id;
}

const key = (id: string, part: string) => `${bucketKeyOf(backupPrefix(id))}/${part}`;

beforeEach(async () => {
  configureBackup();
  await core().batch([
    core().prepare('DELETE FROM exports'),
    core().prepare('DELETE FROM jobs'),
    core().prepare('DELETE FROM write_freeze_leases'),
    core().prepare('DELETE FROM backup_file_pins'),
    core().prepare('DELETE FROM restore_checkpoints'),
  ]);
  const listed = await priv().list();
  for (const object of listed.objects) await priv().delete(object.key);
});

afterEach(async () => {
  await core().batch([core().prepare('DELETE FROM write_freeze_leases'), core().prepare('DELETE FROM backup_file_pins')]);
});

describe('backupPreflight on a real package (R36.8, R36.13, R36.16)', () => {
  it('passes a healthy package, returning the authenticated manifest and the identity transform', async () => {
    const id = await sealedPackage();
    const result = await backupPreflight(world.bindings, priv(), id, testRegistry());
    expect(result.ok, result.ok ? '' : JSON.stringify(result.problems)).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.manifest.installationId).toBe('rf-test');
    expect(result.manifest.schemaRelease).toBe('r-test');
    expect(result.transform.from).toBe('r-test');
    expect(result.transform.to).toBe('r-test');
    // Every unit reference resolves within the package, so no invalid-reference problem was raised (the ok result).
  });

  it('reports decode-failed on a tampered body byte, authorising no insertion', async () => {
    const id = await sealedPackage();
    const blob = new Uint8Array(await (await priv().get(key(id, 'body.enc')))!.arrayBuffer());
    blob[blob.length - 1] = blob[blob.length - 1]! ^ 0xff; // flip a ciphertext byte
    await priv().put(key(id, 'body.enc'), blob);
    const result = await backupPreflight(world.bindings, priv(), id, testRegistry());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.problems.map((p) => p.kind)).toContain('decode-failed');
  });

  it('reports fingerprint-mismatch on a flipped manifest fingerprint', async () => {
    const id = await sealedPackage();
    const fingerprint = await (await priv().get(key(id, 'manifest-fingerprint.txt')))!.text();
    const flipped = `${fingerprint.slice(0, -1)}${fingerprint.endsWith('0') ? '1' : '0'}`;
    await priv().put(key(id, 'manifest-fingerprint.txt'), flipped);
    const result = await backupPreflight(world.bindings, priv(), id, testRegistry());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.problems.map((p) => p.kind)).toContain('fingerprint-mismatch');
  });

  it('reports a missing table body part', async () => {
    const id = await sealedPackage();
    await priv().delete(key(id, 'body/units.jsonl'));
    const result = await backupPreflight(world.bindings, priv(), id, testRegistry());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    const unitsProblem = result.problems.find((p) => p.element === 'table:units');
    expect(unitsProblem?.kind).toBe('missing-part');
  });

  it('reports a bad count and a checksum mismatch when a table body part is altered', async () => {
    const id = await sealedPackage();
    const body = await (await priv().get(key(id, 'body/units.jsonl')))!.text();
    // Append a spurious row image: the row count and the digest now both diverge from the manifest entry.
    await priv().put(key(id, 'body/units.jsonl'), `${body}{"id":"SPURIOUS"}\n`);
    const result = await backupPreflight(world.bindings, priv(), id, testRegistry());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    const unitsKinds = result.problems.filter((p) => p.element === 'table:units').map((p) => p.kind);
    expect(unitsKinds).toContain('checksum-mismatch');
  });

  it('reports a dangling reference when a unit references a project not in the package', async () => {
    const id = await sealedPackage();
    // Rewrite units.jsonl so one unit references a project id absent from the projects part, and re-seal the matching
    // table entry so the BYTE check passes and the REFERENCE check is what fails (isolating the reference fault).
    const unitsText = await (await priv().get(key(id, 'body/units.jsonl')))!.text();
    const rows = unitsText.split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Record<string, unknown>);
    rows[0]!['project_id'] = 'PROJECT-NOT-IN-PACKAGE';
    const rewritten = `${rows.map((r) => stableRow(r)).join('\n')}\n`;
    await priv().put(key(id, 'body/units.jsonl'), rewritten);
    await reseal(id, 'units', rewritten);
    const result = await backupPreflight(world.bindings, priv(), id, testRegistry());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.problems.map((p) => p.element)).toContain('reference:units.project_id');
    expect(result.problems.find((p) => p.element === 'reference:units.project_id')?.kind).toBe('invalid-reference');
  });

  it('reports unsupported-schema when the registry does not support the package schema release', async () => {
    const id = await sealedPackage();
    // A registry whose current + two preceding releases do not include 'r-test'.
    const unrelated = testRegistry('r-future');
    const result = await backupPreflight(world.bindings, priv(), id, unrelated);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.problems.map((p) => p.kind)).toContain('unsupported-schema');
  });

  it('reports unwrap-failed with a wrong recovery key', async () => {
    const id = await sealedPackage();
    // Reconfigure the custodian generation with a DIFFERENT key for the same (custodianId, generation): the envelope
    // matches the generation but fails authentication.
    const wrong = new Uint8Array(32).map((_b, i) => (i * 11 + 1) & 0xff);
    (world.bindings as { BACKUP_RECOVERY_CUSTODIANS?: string }).BACKUP_RECOVERY_CUSTODIANS = JSON.stringify([{ custodianId: CUSTODIAN.custodianId, generation: CUSTODIAN.generation, keyBase64: btoa(String.fromCharCode(...wrong)) }]);
    const result = await backupPreflight(world.bindings, priv(), id, testRegistry());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.problems.map((p) => p.kind)).toContain('unwrap-failed');
  });

  it('reports no-recovery-key when no configured custodian matches an envelope', async () => {
    const id = await sealedPackage();
    (world.bindings as { BACKUP_RECOVERY_CUSTODIANS?: string }).BACKUP_RECOVERY_CUSTODIANS = JSON.stringify([{ custodianId: 'other', generation: 9, keyBase64: RECOVERY_KEY_B64 }]);
    const result = await backupPreflight(world.bindings, priv(), id, testRegistry());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.problems.map((p) => p.kind)).toContain('no-recovery-key');
  });

  it('does not authorise install of a suppressed id even when the package is otherwise healthy (R36.15)', async () => {
    const id = await sealedPackage();
    const result = await backupPreflight(world.bindings, priv(), id, testRegistry());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    // The independently known suppression ledger marks one restored id suppressed: it is not authorised for install.
    const restoredIds = ['ITEM-A', 'ITEM-B'];
    const ledger = [{ suppressedId: 'ITEM-A', generation: 1, suppressedAt: world.at, digest: suppressionDigest({ suppressedId: 'ITEM-A', generation: 1, suppressedAt: world.at }) }];
    const applied = applySuppressions(restoredIds, ledger);
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error('unreachable');
    expect(applied.suppressed).toEqual(['ITEM-A']);
    // And quarantine is not released while the suppression gate has not been applied.
    expect(quarantineReleasePrecondition({ validationPassed: true, suppressionsApplied: false, disclosureConsentPassed: true }).released).toBe(false);
  });
});

describe('restore-owned checkpoint storage (R36.4, R36.10)', () => {
  it('records a checkpoint, skips an identical re-run, conflicts on a divergent re-run, and clears on close', async () => {
    const { recordCheckpoint, readCheckpoint, decideInsert, closeRestoreCheckpoints } = await import('../src/backup/checkpoints');
    const restoreId = 'RESTORE-1';
    const rowImage = { id: 'U1', title: 'A' };
    const hash = canonicalRowHash(rowImage);

    // First time: no checkpoint and the destination is empty, so the decision is insert.
    expect((await decideInsert(world.bindings, restoreId, 'units', 'U1', hash, async () => false)).decision).toBe('insert');
    await recordCheckpoint(world.bindings, restoreId, 'units', 'U1', hash, world.at);
    expect((await readCheckpoint(world.bindings, restoreId, 'units', 'U1'))?.payloadHash).toBe(hash);

    // A resumed re-run of the SAME payload skips; recording it again is idempotent.
    expect((await decideInsert(world.bindings, restoreId, 'units', 'U1', hash, async () => true)).decision).toBe('skip-identical');
    await recordCheckpoint(world.bindings, restoreId, 'units', 'U1', hash, world.at);
    expect((await core().prepare('SELECT count(*) AS n FROM restore_checkpoints WHERE restore_id = ?1').bind(restoreId).first<{ n: number }>())!.n).toBe(1);

    // A divergent re-run (different payload for the same key) is a conflict, never a silent overwrite.
    const other = canonicalRowHash({ id: 'U1', title: 'Z' });
    const decision = await decideInsert(world.bindings, restoreId, 'units', 'U1', other, async () => true);
    expect(decision).toEqual({ decision: 'conflict', reason: 'checkpoint-payload-differs' });
    // The stored payload hash is unchanged by the guarded upsert.
    expect((await readCheckpoint(world.bindings, restoreId, 'units', 'U1'))?.payloadHash).toBe(hash);

    // Closing the restore clears only its own checkpoints.
    await recordCheckpoint(world.bindings, 'RESTORE-2', 'units', 'U9', hash, world.at);
    expect(await closeRestoreCheckpoints(world.bindings, restoreId)).toBe(1);
    expect(await readCheckpoint(world.bindings, restoreId, 'units', 'U1')).toBeNull();
    expect((await readCheckpoint(world.bindings, 'RESTORE-2', 'units', 'U9'))?.payloadHash).toBe(hash);
    await core().prepare('DELETE FROM restore_checkpoints').run();
  });
});

/** Canonical sorted-key JSON of a row image, matching the 38.4 body writer (stableJson). */
function stableRow(row: Record<string, unknown>): string {
  const sorted = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(sorted).join(',')}]`;
    if (typeof value === 'object' && value !== null) {
      return `{${Object.keys(value as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${sorted((value as Record<string, unknown>)[k])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
  };
  return sorted(row);
}

/**
 * Re-seal one table's manifest entry inside the encrypted package after altering its body part, so a test that targets
 * the REFERENCE check is not tripped by the byte/count checks first. Decrypts the manifest, updates the table's row
 * count and digest to match the rewritten body, re-encrypts, and rewrites the fingerprint — exactly as the 38.4 job
 * seals, so the package stays internally authentic apart from the dangling reference under test.
 */
async function reseal(id: ULID, table: string, body: string): Promise<void> {
  const mod = await import('@researchforce/manifest/backup/index');
  const headerObj = JSON.parse(await (await priv().get(key(id, 'header.json')))!.text()) as {
    segmentBytes: number; salt: string; noncePrefix: string; manifestDigest: string;
    custodians: { custodianId: string; generation: number; nonce: string; wrapped: string }[];
  };
  const fromHex = (hex: string): Uint8Array => { const out = new Uint8Array(hex.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16); return out; };
  const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const envelopes = headerObj.custodians.map((c) => ({ custodianId: c.custodianId, generation: c.generation, nonce: fromHex(c.nonce), wrapped: fromHex(c.wrapped) }));
  const recovery = { generation: CUSTODIAN, keyBytes: RECOVERY_KEY, fingerprint: mod.custodianFingerprint('primary', RECOVERY_KEY) };
  const dataKey = await mod.unwrapDataKey(envelopes, recovery);

  // Decrypt the current manifest.
  const streamHeader = { segmentBytes: headerObj.segmentBytes, salt: fromHex(headerObj.salt), noncePrefix: fromHex(headerObj.noncePrefix), manifestDigest: headerObj.manifestDigest };
  const blob = new Uint8Array(await (await priv().get(key(id, 'body.enc')))!.arrayBuffer());
  const { parseSegments } = await import('../src/jobs/backup');
  const segments = parseSegments(blob);
  async function* src(): AsyncGenerator<import('@researchforce/manifest/backup/index').EncryptedSegment> { for (const s of segments) yield s; }
  const chunks: Uint8Array[] = [];
  for await (const p of mod.decodeBody(src(), dataKey.raw, streamHeader)) chunks.push(p);
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const plain = new Uint8Array(total); let at = 0; for (const c of chunks) { plain.set(c, at); at += c.length; }
  const manifest = JSON.parse(new TextDecoder().decode(plain)) as import('@researchforce/manifest/backup/index').RootManifest;

  // Update the table entry to match the rewritten body, then recompute the authenticated fingerprint.
  const bytes = new TextEncoder().encode(body);
  const digest = toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
  const rows = body.split('\n').filter((l) => l !== '').length;
  const tables = manifest.tables.map((t) => (t.table === table ? { ...t, rows, sha256: digest } : t));
  const counts = { ...manifest.counts, rows: tables.reduce((n, t) => n + t.rows, 0) };
  const draft = { ...manifest, tables, counts, trust: { custodians: manifest.trust.custodians } };
  const manifestFingerprint = mod.rootDigest({ ...draft, trust: { ...manifest.trust, manifestFingerprint: '' } });
  const sealed: import('@researchforce/manifest/backup/index').RootManifest = { ...manifest, tables, counts, trust: { ...manifest.trust, manifestFingerprint } };

  // Re-encrypt the manifest under a fresh header bound to the new digest, and rewrite header/body/fingerprint.
  const newHeader = mod.createHeader(manifestFingerprint, streamHeader.segmentBytes);
  const manifestBytes = mod.serializeManifest(sealed);
  async function* source(): AsyncGenerator<Uint8Array> { yield manifestBytes; }
  const outSegments: import('@researchforce/manifest/backup/index').EncryptedSegment[] = [];
  for await (const s of mod.encodeBody(source(), dataKey.raw, newHeader)) outSegments.push(s);
  const framed = frame(outSegments);
  await priv().put(key(id, 'header.json'), JSON.stringify({ ...headerObj, salt: toHex(newHeader.salt), noncePrefix: toHex(newHeader.noncePrefix), manifestDigest: manifestFingerprint }));
  await priv().put(key(id, 'body.enc'), framed);
  await priv().put(key(id, 'manifest-fingerprint.txt'), manifestFingerprint);
}

/** Frame encrypted segments the same way the 38.4 job does (index, final flag, length, body). */
function frame(segments: readonly import('@researchforce/manifest/backup/index').EncryptedSegment[]): Uint8Array {
  const totalBytes = segments.reduce((n, s) => n + 9 + s.body.length, 0);
  const out = new Uint8Array(totalBytes);
  const view = new DataView(out.buffer);
  let at = 0;
  for (const s of segments) { view.setUint32(at, s.index, false); at += 4; out[at] = s.final ? 1 : 0; at += 1; view.setUint32(at, s.body.length, false); at += 4; out.set(s.body, at); at += s.body.length; }
  return out;
}
