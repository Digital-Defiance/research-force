import { sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { z } from 'zod';
import { GuardedBatch } from '@researchforce/db/batch';
import { reproductionAttempts } from '@researchforce/db/schema/core';
import { newULIDAfter } from '@researchforce/domain/identifiers';
import { isULID } from '@researchforce/domain/types';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import { parse } from '../api/input';
import { authorize } from '../auth/authorize';
import { loadItem } from './items';
import { rowsOf } from './kinds/kind';
import { visibleTo } from './submissions';

export const REPRODUCTION_LIMITS = Object.freeze({ differences: 50, evidence: 20, textCodePoints: 500, noteCodePoints: 2000 });
export const REPRODUCTION_OUTCOME_NAMES = Object.freeze({ reproduced: 'Reproduced', not_reproduced: 'Not reproduced', inconclusive: 'Inconclusive' } as const);
const DIFFERENCE_KINDS = ['environment', 'configuration', 'code', 'data', 'hardware', 'other'] as const;

const text = (max: number) => z.string().min(1).refine((value) => [...value].length <= max, `At most ${max} characters.`);
const reproductionInput = z.strictObject({
  packageVersion: z.number().int().min(1),
  attemptRunId: z.string().refine(isULID, 'A Run id.'),
  outcome: z.enum(['reproduced', 'not_reproduced', 'inconclusive']),
  differences: z.array(z.strictObject({ kind: z.enum(DIFFERENCE_KINDS), name: text(100), original: text(REPRODUCTION_LIMITS.textCodePoints), attempt: text(REPRODUCTION_LIMITS.textCodePoints) })).max(REPRODUCTION_LIMITS.differences).default([]),
  evidence: z.array(z.string().refine(isULID, 'A record id.')).max(REPRODUCTION_LIMITS.evidence).default([]),
  note: text(REPRODUCTION_LIMITS.noteCodePoints).optional(),
});

export interface ReproductionView {
  readonly id: ULID;
  readonly runId: ULID;
  readonly packageVersion: number;
  readonly attemptRunId: ULID;
  readonly attemptRunIdentifier: string;
  readonly outcome: keyof typeof REPRODUCTION_OUTCOME_NAMES;
  readonly outcomeName: string;
  readonly differences: readonly { readonly kind: string; readonly name: string; readonly original: string; readonly attempt: string }[];
  readonly evidence: readonly ULID[];
  readonly note: string | null;
  readonly recordedBy: ULID;
  readonly recordedByName: string | null;
  readonly recordedAt: Timestamp;
}
interface Row { id: ULID; runId: ULID; packageVersion: number; attemptRunId: ULID; identifier: string; outcome: ReproductionView['outcome']; differences: string; evidence: string; note: string | null; recordedBy: ULID; name: string | null; recordedAt: Timestamp }

/**
 * The package's state from its attempts: incomplete while an ingredient is missing, disputed while any attempter's latest attempt did not reproduce,
 * reproduced when some attempter's latest attempt did, otherwise specified. Attempts are never changed; an attempter's newer attempt supersedes only
 * their own earlier one, so no attempt overwrites another Member's conclusion (R56.5).
 */
const refreshState = (runId: string, version: number) => sql`UPDATE compute_packages SET reproducibility_state = CASE
  WHEN missing_count > 0 THEN 'incomplete'
  WHEN EXISTS (SELECT 1 FROM reproduction_attempts a WHERE a.run_id = ${runId} AND a.package_version = ${version} AND a.outcome = 'not_reproduced'
    AND a.id = (SELECT MAX(b.id) FROM reproduction_attempts b WHERE b.run_id = a.run_id AND b.package_version = a.package_version AND b.recorded_by = a.recorded_by)) THEN 'disputed'
  WHEN EXISTS (SELECT 1 FROM reproduction_attempts a WHERE a.run_id = ${runId} AND a.package_version = ${version} AND a.outcome = 'reproduced'
    AND a.id = (SELECT MAX(b.id) FROM reproduction_attempts b WHERE b.run_id = a.run_id AND b.package_version = a.package_version AND b.recorded_by = a.recorded_by)) THEN 'reproduced'
  ELSE 'specified' END
  WHERE run_id = ${runId} AND package_version = ${version}`;

/**
 * Record an independent reproduction attempt of a package version. The attempt is its own Run, made by someone other than the package's author and
 * the original Run's Owner; the original Run, package and outcome are not touched (R56.5).
 */
export async function recordReproduction(c: Context<ApiEnv>, runId: string, body: unknown): Promise<ReproductionView> {
  const original = await loadItem(c, runId);
  if (original.base.kind !== 'run') throw new ApiError('not_found');
  const input = parse(reproductionInput, body);
  const actor = c.get('session').member.id;
  const db = c.env.RF_CORE;
  const bad = (field: string, rule: string): never => { throw new ApiError('validation', { fields: [{ field, rule }] }); };
  if (input.attemptRunId === runId) bad('attemptRunId', 'An attempt is a different Run from the one it reproduces.');
  const attempt = await loadItem(c, input.attemptRunId);
  if (attempt.base.kind !== 'run') bad('attemptRunId', 'The attempt must be a Run.');
  if (attempt.base.ownerId !== actor) bad('attemptRunId', 'The attempt must be your own Run.');
  if (attempt.base.withdrawnAt !== null) bad('attemptRunId', 'This Run has been withdrawn.');
  await authorize(c, [{ permission: 'item.edit', target: { type: 'research_item', ownerId: attempt.base.ownerId, itemKind: 'run', field: 'content' } }]);
  const [pkg, used, seen, mineBefore] = await c.get('accountant').track(db.batch([
    db.prepare('SELECT created_by AS author FROM compute_packages WHERE run_id = ?1 AND package_version = ?2').bind(runId, input.packageVersion),
    db.prepare('SELECT id FROM reproduction_attempts WHERE attempt_run_id = ?1').bind(input.attemptRunId),
    db.prepare(`SELECT COUNT(*) AS n FROM units u WHERE u.id IN (SELECT value FROM json_each(?1)) AND ${visibleTo('u', '?2')}`).bind(JSON.stringify(input.evidence), actor),
    db.prepare('SELECT MAX(id) AS id FROM reproduction_attempts WHERE run_id = ?1 AND package_version = ?2 AND recorded_by = ?3').bind(runId, input.packageVersion, actor),
  ]));
  const author = rowsOf<{ author: ULID }>(pkg)[0]?.author;
  if (author === undefined) bad('packageVersion', 'This Run has no such package version.');
  if (rowsOf(used).length > 0) bad('attemptRunId', 'This Run already records an attempt.');
  if (actor === author || actor === original.base.ownerId) bad('attemptRunId', 'An independent reproduction is made by someone other than the package author and the Run Owner.');
  if (rowsOf<{ n: number }>(seen)[0]!.n !== new Set(input.evidence).size) bad('evidence', 'Every evidence record must exist and be readable by you.');
  const id = newULIDAfter(c.get('now'), rowsOf<{ id: ULID | null }>(mineBefore)[0]?.id);
  const batch = new GuardedBatch(db, { id: actor, now: c.get('now') });
  batch.insert(reproductionAttempts, {
    id, runId, packageVersion: input.packageVersion, attemptRunId: input.attemptRunId, outcome: input.outcome, differences: JSON.stringify(input.differences),
    evidence: JSON.stringify([...new Set(input.evidence)]), note: input.note ?? null, recordedBy: actor, recordedAt: batch.actor.now,
  });
  batch.run(refreshState(runId, input.packageVersion));
  await batch.commit(c.get('accountant'));
  return (await listReproductions(c, runId)).find((entry) => entry.id === id)!;
}

/** The attempts on a Run's package whose attempt Runs the viewer can read, oldest first. A hidden attempt still counts toward the package's state. */
export async function listReproductions(c: Context<ApiEnv>, runId: string): Promise<ReproductionView[]> {
  const run = await loadItem(c, runId);
  if (run.base.kind !== 'run') throw new ApiError('not_found');
  const viewer = c.get('session').member.id;
  const found = await c.get('accountant').track(c.env.RF_CORE.prepare(`SELECT a.id, a.run_id AS runId, a.package_version AS packageVersion, a.attempt_run_id AS attemptRunId, ri.item_identifier AS identifier,
      a.outcome, a.differences, a.evidence, a.note, a.recorded_by AS recordedBy, p.display_name AS name, a.recorded_at AS recordedAt
    FROM reproduction_attempts a JOIN units u ON u.id = a.attempt_run_id JOIN research_items ri ON ri.unit_id = u.id LEFT JOIN profiles p ON p.member_id = a.recorded_by
    WHERE a.run_id = ?1 AND ${visibleTo('u', '?2')} AND NOT EXISTS (SELECT 1 FROM deletions x WHERE x.unit_id IN (u.id, u.root_id))
    ORDER BY a.id LIMIT 200`).bind(runId, viewer).all<Row>());
  return found.results.map((row) => ({
    id: row.id, runId: row.runId, packageVersion: row.packageVersion, attemptRunId: row.attemptRunId, attemptRunIdentifier: row.identifier, outcome: row.outcome,
    outcomeName: REPRODUCTION_OUTCOME_NAMES[row.outcome], differences: JSON.parse(row.differences) as ReproductionView['differences'], evidence: JSON.parse(row.evidence) as ULID[],
    note: row.note, recordedBy: row.recordedBy, recordedByName: row.name, recordedAt: row.recordedAt,
  }));
}
