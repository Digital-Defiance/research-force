import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { EPOCH, GuardedBatch } from '@researchforce/db/batch';
import type { Timestamp } from '@researchforce/domain/types';
import {
  beginOperation,
  fence,
  operationId,
  promoteUnderEpoch,
  readEpoch,
  readOperation,
  reconcile,
  settleOperation,
  shouldPreempt,
} from '@researchforce/db/publication-epoch';
import type { Generation } from '@researchforce/db/publication-epoch';
import type { Env } from '../src/env';
import { migrated } from './d1';

let bindings: Env;
const core = () => bindings.RF_CORE;
const now = (): Timestamp => new Date().toISOString() as Timestamp;
const gen = (run: string, epoch: number): Generation => ({ run, epoch });

beforeAll(async () => { bindings = await migrated(); });
beforeEach(async () => {
  await core().batch([
    core().prepare("DELETE FROM counters WHERE k = 'epoch'"),
    core().prepare('DELETE FROM outbox'),
    core().prepare('DELETE FROM external_operations'),
  ]);
});

describe('durable publication epoch', () => {
  it('reads 0 before the first confidentiality-affecting save', async () => {
    expect(await readEpoch(core())).toBe(0);
  });

  it('increments the epoch in the same transaction as the publish outbox row', async () => {
    await new GuardedBatch(core(), { id: null, now: now() }).bumpEpoch().outbox('publish', 'unit:a').commit();
    expect(await readEpoch(core())).toBe(1);
    // One publish row written in the same batch that bumped the epoch.
    expect(await core().prepare("SELECT count(*) AS n FROM outbox WHERE topic = 'publish'").first('n')).toBe(1);
    await new GuardedBatch(core(), { id: null, now: now() }).bumpEpoch().outbox('publish', 'unit:b').commit();
    expect(await readEpoch(core())).toBe(2);
  });

  it('advances the epoch exactly once even when bumpEpoch is called many times in one save', async () => {
    await new GuardedBatch(core(), { id: null, now: now() }).bumpEpoch().bumpEpoch().bumpEpoch().outbox('publish', 'unit:a').commit();
    expect(await readEpoch(core())).toBe(1);
  });

  it('leaves the epoch untouched when a batch commits without bumping it', async () => {
    await new GuardedBatch(core(), { id: null, now: now() }).bumpEpoch().commit();
    await new GuardedBatch(core(), { id: null, now: now() }).outbox('publish', 'unit:c').commit();
    expect(await readEpoch(core())).toBe(1);
  });

  it('does not advance the epoch when the batch aborts on a guard', async () => {
    await new GuardedBatch(core(), { id: null, now: now() }).bumpEpoch().commit();
    await expect(new GuardedBatch(core(), { id: null, now: now() }).bumpEpoch().guard('rev', sql`0`).commit()).rejects.toThrow();
    expect(await readEpoch(core())).toBe(1);
  });

  it('exposes the current epoch to other statements through the EPOCH reader', async () => {
    await new GuardedBatch(core(), { id: null, now: now() }).bumpEpoch().bumpEpoch().commit();
    // The EPOCH fragment reads the same value readEpoch returns, usable inside any batch statement that
    // wants to stamp the epoch a row was written under (e.g. a publish_runs row in task 32.2).
    await new GuardedBatch(core(), { id: null, now: now() })
      .run(sql`INSERT INTO outbox (topic, scope, change_seq, created_at) VALUES ('publish', ${sql`'epoch=' || ${EPOCH}`}, 0, ${now()})`)
      .commit();
    const scope = await core().prepare("SELECT scope FROM outbox WHERE topic = 'publish' ORDER BY seq DESC LIMIT 1").first<{ scope: string }>();
    expect(scope?.scope).toBe('epoch=1');
  });
});

describe('generation fencing', () => {
  it('authorizes an addition or promotion step only while its epoch is current', () => {
    expect(fence(gen('r1', 3), 3, 'addition')).toMatchObject({ authorized: true, reason: 'current' });
    expect(fence(gen('r1', 3), 3, 'promotion')).toMatchObject({ authorized: true, reason: 'current' });
    expect(fence(gen('r1', 2), 3, 'addition')).toMatchObject({ authorized: false, reason: 'stale_generation' });
    expect(fence(gen('r1', 2), 3, 'promotion')).toMatchObject({ authorized: false, reason: 'stale_generation' });
  });

  it('always authorizes a removal step, so suppression is never blocked by a newer epoch', () => {
    expect(fence(gen('r1', 1), 5, 'removal')).toMatchObject({ authorized: true, reason: 'removal_always' });
  });

  it('preempts an older addition generation once the epoch advances', () => {
    expect(shouldPreempt(gen('r1', 2), 3)).toBe(true);
    expect(shouldPreempt(gen('r1', 3), 3)).toBe(false);
    expect(shouldPreempt(gen('r1', 4), 3)).toBe(false);
  });
});

describe('rf-ops serialized promotion check', () => {
  it('promotes only when the expected epoch matches before and after, and clears containment', () => {
    expect(promoteUnderEpoch({ expected: 4, before: 4, after: 4, containmentActive: true }))
      .toEqual({ promoted: true, keepContainment: false, reason: 'promoted' });
  });

  it('denies a stale promotion whose epoch already advanced before it ran, keeping any containment', () => {
    expect(promoteUnderEpoch({ expected: 4, before: 5, after: 5, containmentActive: true }))
      .toEqual({ promoted: false, keepContainment: true, reason: 'stale_before' });
    expect(promoteUnderEpoch({ expected: 4, before: 5, after: 5, containmentActive: false }))
      .toEqual({ promoted: false, keepContainment: false, reason: 'stale_before' });
  });

  it('denies a promotion raced by a confidentiality save during it and keeps containment on', () => {
    expect(promoteUnderEpoch({ expected: 4, before: 4, after: 5, containmentActive: false }))
      .toEqual({ promoted: false, keepContainment: true, reason: 'raced_after' });
  });
});

describe('reconciling ambiguous provider answers', () => {
  it('verifies only when the provider reflects the intent under a current generation', () => {
    expect(reconcile({ operation: gen('r1', 3), authoritative: 3, observed: 'absent', intent: 'absent' }))
      .toMatchObject({ resolved: true, keepDenied: false, reason: 'verified' });
    expect(reconcile({ operation: gen('r1', 3), authoritative: 3, observed: 'present', intent: 'present' }))
      .toMatchObject({ resolved: true, keepDenied: false });
  });

  it('keeps denial for a stale generation even when the provider happens to match', () => {
    expect(reconcile({ operation: gen('r1', 2), authoritative: 3, observed: 'absent', intent: 'absent' }))
      .toMatchObject({ resolved: false, keepDenied: true, reason: 'stale_generation' });
  });

  it('keeps denial when the provider does not reflect the intended effect', () => {
    expect(reconcile({ operation: gen('r1', 3), authoritative: 3, observed: 'present', intent: 'absent' }))
      .toMatchObject({ resolved: false, keepDenied: true, reason: 'provider_mismatch' });
  });

  it('never asserts success on an unknown provider read, and keeps denial for the removal', () => {
    expect(reconcile({ operation: gen('r1', 3), authoritative: 3, observed: 'unknown', intent: 'absent' }))
      .toMatchObject({ resolved: false, keepDenied: true, reason: 'provider_unknown' });
  });
});

describe('epoch-labelled external operation identities', () => {
  it('builds a deterministic id that bakes in the generation and epoch', () => {
    const id = operationId('deploy', 'r1', 4, 'version-xyz');
    expect(id).toBe('publish:deploy:r1:e4:version-xyz');
    // A different epoch is a different operation; a replay of the same generation reuses the same id.
    expect(operationId('deploy', 'r1', 5, 'version-xyz')).not.toBe(id);
    expect(operationId('deploy', 'r1', 4, 'version-xyz')).toBe(id);
  });

  it('records a pending operation, settles it, and reads it back; a re-entry reuses the row', async () => {
    const id = operationId('file_delete', 'r1', 2, 'AAAA-BBBB-CCCC');
    await beginOperation(core(), { id, kind: 'file_delete', requestHash: 'd'.repeat(64) }, now());
    expect(await readOperation(core(), id)).toMatchObject({ id, kind: 'file_delete', state: 'pending' });
    // A lost answer: no settle yet, then a re-entry of the same generation re-marks pending (no duplicate row).
    await beginOperation(core(), { id, kind: 'file_delete', requestHash: 'd'.repeat(64) }, now());
    expect(await core().prepare('SELECT count(*) AS n FROM external_operations WHERE id = ?1').bind(id).first('n')).toBe(1);
    await settleOperation(core(), id, { state: 'uncertain', detail: 'no-response' }, now());
    expect(await readOperation(core(), id)).toMatchObject({ state: 'uncertain', detail: 'no-response' });
    await settleOperation(core(), id, { state: 'confirmed', providerRef: 'ref-1' }, now());
    expect(await readOperation(core(), id)).toMatchObject({ state: 'confirmed', providerRef: 'ref-1' });
  });

  it('returns null for an unknown operation id', async () => {
    expect(await readOperation(core(), operationId('deploy', 'r9', 0, 'missing'))).toBeNull();
  });
});
