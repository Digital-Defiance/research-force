// Feature: research-collab-cms, Task 67.3 — the reference-safe OPERATIONAL-RETENTION sweeps (R28.8, R28.17, R57.2,
// R60.7, R60.8). These are D1-backed: they insert operational rows (outbox, external-operation side-effect payloads,
// restore checkpoints, failed-operation metadata) and the live dependencies (citation, release, proposal, backup) and
// assert each sweep expires only what R60.8 allows at its 30d/90d horizon and NEVER removes a row a live
// citation/release/proposal/backup still depends on.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newULID } from '@researchforce/domain/identifiers';
import { RETENTION } from '@researchforce/domain/retention';
import { asTimestamp } from '@researchforce/domain/types';
import type { Env } from '../src/env';
import {
  liveReferences, sweepClosedCheckpoints, sweepFailureMetadata, sweepReconciledOutbox, sweepReconciledSideEffects,
} from '../src/jobs/operational-cron';
import { migrated } from './d1';

const NOW = asTimestamp('2027-06-01T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const atDays = (days: number): string => new Date(Date.parse(NOW) - days * DAY_MS).toISOString();
let env: Env;
const core = () => env.RF_CORE;

const id = (): string => newULID(NOW);

async function clear(): Promise<void> {
  await core().batch([
    core().prepare('DELETE FROM outbox'),
    core().prepare('DELETE FROM external_operations'),
    core().prepare('DELETE FROM operation_failure_aggregates'),
    core().prepare('DELETE FROM restore_checkpoints'),
    core().prepare('DELETE FROM restores'),
    core().prepare('DELETE FROM evidence_citations'),
    core().prepare('DELETE FROM release_artifacts'),
    core().prepare('DELETE FROM research_releases'),
    core().prepare('DELETE FROM edit_proposals'),
    core().prepare('DELETE FROM backup_points'),
    core().prepare('DELETE FROM suppression_generations'),
  ]);
}

/** Insert an outbox row with `done_at` set (reconciled) or NULL (pending). */
async function outbox(doneAt: string | null, topic = 'mail'): Promise<number> {
  const result = await core().prepare(
    'INSERT INTO outbox (topic, scope, change_seq, created_at, done_at) VALUES (?1, ?2, 0, ?3, ?4) RETURNING seq',
  ).bind(topic, `root:${id()}`, atDays(200), doneAt).first<{ seq: number }>();
  return result!.seq;
}

/** Insert an external-operation side-effect payload in a given state, reconciled/updated at `updatedAt`. */
async function sideEffect(opId: string, state: string, updatedAt: string, kind = 'mail', detail: string | null = null): Promise<void> {
  await core().prepare(
    'INSERT INTO external_operations (id, kind, request_hash, state, detail, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
  ).bind(opId, kind, 'h', state, detail, atDays(200), updatedAt).run();
}

/** Insert a restore in a given state with a closure time, and one checkpoint it owns. Returns the checkpoint rowid. */
async function restoreWithCheckpoint(state: string, closedAt: string | null): Promise<number> {
  const restoreId = id();
  const released = state === 'released';
  await core().prepare(
    `INSERT INTO restores (id, source_export_id, requested_by, started_at, finished_at, released_at, released_by, state)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  ).bind(restoreId, id(), id(), atDays(200), released ? null : closedAt, released ? closedAt : null, released ? id() : null, state).run();
  await core().prepare(
    'INSERT INTO restore_checkpoints (restore_id, table_name, row_key, payload_hash, installed_at) VALUES (?1, ?2, ?3, ?4, ?5)',
  ).bind(restoreId, 'units', id(), 'a'.repeat(64), atDays(200)).run();
  return (await core().prepare('SELECT rowid FROM restore_checkpoints WHERE restore_id = ?1').bind(restoreId).first<{ rowid: number }>())!.rowid;
}

const count = async (table: string): Promise<number> => (await core().prepare(`SELECT count(*) AS n FROM ${table}`).first<number>('n'))!;

beforeAll(async () => { env = await migrated(); });
beforeEach(clear);

describe('reconciled outbox payloads expire 30 days after reconciliation (R60.8)', () => {
  it('expires a reconciled row past 30 days, keeps one within 30 days, and never touches a pending row', async () => {
    const pending = await outbox(null);
    const recent = await outbox(atDays(RETENTION.operationalRecords.reconciledPayloadDays - 1));
    const old = await outbox(atDays(RETENTION.operationalRecords.reconciledPayloadDays + 1));

    expect(await sweepReconciledOutbox(env, NOW)).toBe(1);
    const remaining = (await core().prepare('SELECT seq FROM outbox ORDER BY seq').all<{ seq: number }>()).results.map((row) => row.seq);
    expect(remaining).toEqual([pending, recent].sort((a, b) => a - b));
    expect(remaining).not.toContain(old);
    // Idempotent: a second run removes nothing more.
    expect(await sweepReconciledOutbox(env, NOW)).toBe(0);
  });
});

describe('reconciled side-effect payloads expire 30 days after reconciliation; in-flight ones are kept (R60.2, R60.8)', () => {
  it('expires accepted/confirmed/failed past 30 days but keeps pending/uncertain regardless of age', async () => {
    const days = RETENTION.operationalRecords.reconciledPayloadDays + 1;
    await sideEffect('accepted', 'accepted', atDays(days));
    await sideEffect('confirmed', 'confirmed', atDays(days));
    await sideEffect('failed', 'failed', atDays(days), 'mail', 'status-503');
    await sideEffect('pending-old', 'pending', atDays(days));
    await sideEffect('uncertain-old', 'uncertain', atDays(days));
    await sideEffect('accepted-recent', 'accepted', atDays(RETENTION.operationalRecords.reconciledPayloadDays - 1));

    expect(await sweepReconciledSideEffects(env, NOW)).toBe(3);
    const ids = (await core().prepare('SELECT id FROM external_operations ORDER BY id').all<{ id: string }>()).results.map((row) => row.id);
    // The in-flight sends and the recent accepted one survive; the three reconciled old ones go.
    expect(ids).toEqual(['accepted-recent', 'pending-old', 'uncertain-old']);
  });
});

describe('restore checkpoints are kept while active and expire 30 days after the restore closes (R36.10, R60.8)', () => {
  it('keeps a running restore\u2019s checkpoints, expires a closed restore\u2019s after 30 days, keeps a recently closed one', async () => {
    const closedDays = RETENTION.operationalRecords.closedCheckpointDays;
    const running = await restoreWithCheckpoint('running', null);
    const releasedOld = await restoreWithCheckpoint('released', atDays(closedDays + 1));
    const failedOld = await restoreWithCheckpoint('failed', atDays(closedDays + 1));
    const incompleteRecent = await restoreWithCheckpoint('incomplete', atDays(closedDays - 1));

    expect(await sweepClosedCheckpoints(env, NOW)).toBe(2);
    const rowids = (await core().prepare('SELECT rowid FROM restore_checkpoints ORDER BY rowid').all<{ rowid: number }>()).results.map((row) => row.rowid);
    expect(rowids.sort((a, b) => a - b)).toEqual([running, incompleteRecent].sort((a, b) => a - b));
    expect(rowids).not.toContain(releasedOld);
    expect(rowids).not.toContain(failedOld);
  });
});

describe('failed-operation metadata is aggregated then dropped at 90 days (R60.6, R60.8)', () => {
  it('folds expired failures into the content-free aggregate and drops the per-failure rows, keeping recent ones', async () => {
    const days = RETENTION.operationalRecords.failureMetadataDays + 1;
    await sideEffect('f1', 'failed', atDays(days + 5), 'mail', 'status-503');
    await sideEffect('f2', 'failed', atDays(days), 'mail', 'status-503');
    await sideEffect('f3', 'failed', atDays(days), 'mail', 'not-sent');
    await sideEffect('recent-fail', 'failed', atDays(RETENTION.operationalRecords.failureMetadataDays - 1), 'mail', 'status-503');

    expect(await sweepFailureMetadata(env, NOW)).toBe(3);
    // The per-failure rows older than 90 days are gone; the recent failure remains.
    const remaining = (await core().prepare("SELECT id FROM external_operations WHERE state = 'failed' ORDER BY id").all<{ id: string }>()).results.map((row) => row.id);
    expect(remaining).toEqual(['recent-fail']);
    // The audited aggregate keeps counts by (kind, detail) with the window it covers, no bodies.
    const buckets = (await core().prepare('SELECT kind, detail, count, first_at AS firstAt, last_at AS lastAt FROM operation_failure_aggregates ORDER BY kind, detail').all<{ kind: string; detail: string; count: number; firstAt: string; lastAt: string }>()).results;
    expect(buckets).toEqual([
      { kind: 'mail', detail: 'not-sent', count: 1, firstAt: atDays(days), lastAt: atDays(days) },
      { kind: 'mail', detail: 'status-503', count: 2, firstAt: atDays(days + 5), lastAt: atDays(days) },
    ]);

    // Running again after another 90-day failure folds into the same bucket and advances the count, never losing history.
    await sideEffect('f4', 'failed', atDays(days), 'mail', 'status-503');
    expect(await sweepFailureMetadata(env, NOW)).toBe(1);
    expect(await core().prepare("SELECT count FROM operation_failure_aggregates WHERE kind = 'mail' AND detail = 'status-503'").first<number>('count')).toBe(3);
  });
});

describe('PROOF: operational cleanup cannot remove a live citation, release, proposal, or backup dependency (R28.8, R60.8)', () => {
  /** Insert a live Evidence_Citation that pins a target version/unit id. */
  async function citation(targetVersionId: string, targetUnitId: string): Promise<void> {
    await core().prepare(
      `INSERT INTO evidence_citations (id, citing_unit_id, citing_root_id, citing_field, target_type, target_unit_id, target_root_id, target_field, target_version_id, target_rev, content_hash, role, locator_type, locator_json, created_by, created_at, updated_seq)
       VALUES (?1, ?2, ?2, 'claim', 'text', ?3, ?3, 'claim', ?4, 1, ?5, 'supports', 'unresolved', '{}', ?6, ?7, 0)`,
    ).bind(id(), id(), targetUnitId, targetVersionId, 'b'.repeat(64), id(), atDays(500)).run();
  }
  /** Insert a draft Research_Release and one artifact that pins a unit id. */
  async function releaseArtifact(unitId: string): Promise<void> {
    const releaseId = id();
    await core().prepare(
      `INSERT INTO research_releases (id, name, scope, rationale, licence_version, state, snapshot_seq, snapshot_at, contents_digest, created_by, created_at, updated_seq)
       VALUES (?1, 'Synthetic release', 'all', 'why', 'L1', 'draft', 0, ?2, ?3, ?4, ?2, 0)`,
    ).bind(releaseId, atDays(5), 'e'.repeat(64), id()).run();
    await core().prepare(
      `INSERT INTO release_artifacts (release_id, position, kind, unit_id, root_id, owner_id, revision, sha256, public_approved)
       VALUES (?1, 0, 'record', ?2, ?2, ?3, 1, ?4, 0)`,
    ).bind(releaseId, unitId, id(), 'c'.repeat(64)).run();
  }
  /** Insert an open Edit_Proposal that pins a target id. */
  async function openProposal(targetId: string): Promise<void> {
    await core().prepare(
      `INSERT INTO edit_proposals (id, target_id, target_root_id, proposer_id, base_rev, applies_to_rev, state, diff, explanation, reference_ids, created_at, updated_seq)
       VALUES (?1, ?2, ?2, ?3, 1, 1, 'open', '{}', 'why', '[]', ?4, 0)`,
    ).bind(id(), targetId, id(), atDays(10)).run();
  }
  /** Insert a verified backup point / suppression row that pins an id. */
  async function backupDependency(pointId: string, suppressedId: string): Promise<void> {
    await core().prepare(
      "INSERT INTO backup_points (export_id, slot_key, started_at, state, copy_state, verified_at, created_at) VALUES (?1, ?2, ?3, 'complete', 'transferred', ?3, ?3)",
    ).bind(pointId, id(), atDays(5)).run();
    await core().prepare(
      'INSERT INTO suppression_generations (id, backup_point_id, suppressed_id, generation, suppressed_at, digest) VALUES (?1, ?2, ?3, 1, ?4, ?5)',
    ).bind(id(), pointId, suppressedId, atDays(5), 'd'.repeat(64)).run();
  }

  it('loads the live reference sets from citations, releases, open proposals, and verified backups', async () => {
    await citation('v-cited', 'u-cited');
    await releaseArtifact('u-released');
    await openProposal('u-proposed');
    await backupDependency('bp-live', 'u-suppressed');

    const live = await liveReferences(env);
    expect(live.citations.has('v-cited')).toBe(true);
    expect(live.citations.has('u-cited')).toBe(true);
    expect(live.releases.has('u-released')).toBe(true);
    expect(live.proposals.has('u-proposed')).toBe(true);
    expect(live.backups.has('bp-live')).toBe(true);
    expect(live.backups.has('u-suppressed')).toBe(true);
  });

  it('never expires a reconciled side-effect payload whose id is still pinned by a live dependency, even past 30 days', async () => {
    const days = RETENTION.operationalRecords.reconciledPayloadDays + 100;
    // Four reconciled, well-aged side-effect rows whose ids are ALSO (adversarially) named by each kind of live
    // dependency. A correct cleanup must refuse to remove any of them.
    await citation('v-cited', 'op-citation'); // the citation pins the op id as a target unit
    await releaseArtifact('op-release');
    await openProposal('op-proposal');
    await backupDependency('op-backup', 'sup');
    for (const opId of ['op-citation', 'op-release', 'op-proposal', 'op-backup']) await sideEffect(opId, 'accepted', atDays(days));
    // One reconciled, well-aged row with NO live dependency: it is the only one that may go.
    await sideEffect('op-free', 'accepted', atDays(days));

    const removed = await sweepReconciledSideEffects(env, NOW);
    expect(removed).toBe(1);
    const ids = (await core().prepare('SELECT id FROM external_operations ORDER BY id').all<{ id: string }>()).results.map((row) => row.id);
    // Every live-referenced payload survives; only the unreferenced one was cleaned up.
    expect(ids.sort()).toEqual(['op-backup', 'op-citation', 'op-proposal', 'op-release']);
    expect(ids).not.toContain('op-free');
  });

  it('does not block cleanup of operational rows a live dependency does not name', async () => {
    await citation('v-cited', 'u-cited');
    await sideEffect('unrelated', 'accepted', atDays(RETENTION.operationalRecords.reconciledPayloadDays + 1));
    expect(await sweepReconciledSideEffects(env, NOW)).toBe(1);
    expect(await count('external_operations')).toBe(0);
  });
});
