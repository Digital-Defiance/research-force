import { sql } from 'drizzle-orm';
import type { GuardedBatch } from '@researchforce/db/batch';
import { decisionAcknowledgements } from '@researchforce/db/schema/core';
import { acknowledgementStatus } from '@researchforce/domain/decisions';
import type { AcknowledgementInput, AcknowledgementResponse, AcknowledgementStatus } from '@researchforce/domain/decisions';
import type { Timestamp, ULID } from '@researchforce/domain/types';

/**
 * Add the acting Member's own response to a Team decision to `batch` (R53.2, R53.3). The response is always the actor's: the Member comes
 * from the batch, never from the input. Three guards decide whether it is recorded when the batch runs, not when it was prepared:
 * the actor is a named, active participant of a live Team decision; the decision still reads as the response's digest says; and the
 * actor's latest response is the one the input replaced. A response is a new version, so earlier ones stay as history.
 */
export function recordAcknowledgement(batch: GuardedBatch, decisionId: ULID, input: AcknowledgementInput): GuardedBatch {
  const memberId = batch.actor.id;
  if (memberId === null) throw new TypeError('A response is always a Member’s own, so scheduled work cannot record one.');
  batch.guard('decision_participant', sql`EXISTS (SELECT 1 FROM decisions d JOIN units u ON u.id = d.unit_id JOIN decision_participants p ON p.decision_id = d.unit_id JOIN members m ON m.id = p.member_id
    WHERE d.unit_id = ${decisionId} AND d.scope = 'team' AND d.state IN ('proposed', 'adopted') AND p.member_id = ${memberId} AND m.status = 'active'
      AND u.withdrawn_at IS NULL AND NOT EXISTS (SELECT 1 FROM deletions x WHERE x.unit_id IN (u.id, u.root_id)))`);
  batch.guard('decision_wording', sql`EXISTS (SELECT 1 FROM decisions WHERE unit_id = ${decisionId} AND wording_digest = ${input.digest} AND wording_version = ${input.wordingVersion})`);
  batch.guard('acknowledgement_version', sql`(SELECT COALESCE(MAX(version), 0) FROM decision_acknowledgements WHERE decision_id = ${decisionId} AND member_id = ${memberId}) = ${input.expectedVersion}`);
  return batch.insert(decisionAcknowledgements, {
    decisionId, memberId, version: input.expectedVersion + 1, response: input.response, digest: input.digest, wordingVersion: input.wordingVersion,
    comment: input.comment ?? null, at: batch.actor.now,
  });
}

/** One named participant of a Team decision and what they have recorded, if anything. */
export interface ParticipantResponse {
  readonly memberId: ULID;
  /** `no_response` is shown as such; it never reads as agreement (R53.2). */
  readonly status: AcknowledgementStatus;
  readonly latest?: { readonly version: number; readonly response: AcknowledgementResponse; readonly wordingVersion: number; readonly comment: string | null; readonly at: Timestamp };
}

interface ResponseRow {
  memberId: ULID; version: number | null; response: AcknowledgementResponse | null; digest: string | null; wordingVersion: number | null; comment: string | null; at: Timestamp | null;
}

/**
 * Each named participant's latest response judged against the wording as it is now. Only a Team decision lists them; a response to
 * wording that has since changed counts as earlier-wording evidence, and no response stays no response (R53.2, R53.3).
 */
export async function readParticipantResponses(db: D1Database, decisionId: string): Promise<ParticipantResponse[]> {
  const decision = await db.prepare('SELECT scope, wording_digest AS digest FROM decisions WHERE unit_id = ?1').bind(decisionId).first<{ scope: string; digest: string }>();
  if (decision?.scope !== 'team') return [];
  const rows = await db.prepare(
    `SELECT p.member_id AS memberId, a.version, a.response, a.digest, a.wording_version AS wordingVersion, a.comment, a.at
      FROM decision_participants p
      LEFT JOIN decision_acknowledgements a ON a.decision_id = p.decision_id AND a.member_id = p.member_id
        AND a.version = (SELECT MAX(version) FROM decision_acknowledgements WHERE decision_id = p.decision_id AND member_id = p.member_id)
      WHERE p.decision_id = ?1 ORDER BY p.position`,
  ).bind(decisionId).all<ResponseRow>();
  return rows.results.map((row) => ({
    memberId: row.memberId,
    status: acknowledgementStatus(row.response === null ? undefined : { response: row.response, digest: row.digest! }, decision.digest),
    ...(row.response === null ? {} : { latest: { version: row.version!, response: row.response, wordingVersion: row.wordingVersion!, comment: row.comment, at: row.at! } }),
  }));
}

/** Every response one Member recorded to a decision, oldest first: the attributed history of their own position (R53.3). */
export async function readResponseHistory(db: D1Database, decisionId: string, memberId: string): Promise<NonNullable<ParticipantResponse['latest']>[]> {
  const rows = await db.prepare(
    `SELECT version, response, wording_version AS wordingVersion, comment, at FROM decision_acknowledgements WHERE decision_id = ?1 AND member_id = ?2 ORDER BY version`,
  ).bind(decisionId, memberId).all<NonNullable<ParticipantResponse['latest']>>();
  return rows.results;
}
