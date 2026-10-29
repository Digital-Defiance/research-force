import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { GuardedBatch, GuardViolation } from '@researchforce/db/batch';
import type { RevisionInput } from '@researchforce/db/batch';
import type { OUTBOX_TOPICS, REVISION_TARGET_TYPES } from '@researchforce/db/schema/core';
import type { RichText } from '@researchforce/domain/richtext';
import { REVISION_KINDS } from '@researchforce/domain/types';
import type { RevisionKind, Timestamp, ULID } from '@researchforce/domain/types';
import { canonicalJson } from '@researchforce/kernel/views';
import { announceRevisions } from '../activity/flags';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';

/**
 * The Revision_Kind a changed field belongs to. `content` takes the edit's Minor_Edit or Correction
 * mark; `detail` is always a Minor_Edit (Project fields, R39.8); the others are their own kinds.
 */
export type FieldClass = 'content' | 'detail' | 'status' | 'withdrawal' | 'disclosure';
export interface FieldChange { readonly field: string; readonly before: unknown; readonly after: unknown; readonly fieldClass: FieldClass }
export interface EditMark { readonly mark: 'minor_edit' | 'correction'; readonly reason?: string }
export interface ChangeSet {
  readonly fields: readonly FieldChange[];
  readonly mark?: EditMark;
  /** A Restoration names the restored point and needs no mark (R22.2, R22.5). */
  readonly restoredPoint?: string;
  readonly reasons?: { readonly status?: string; readonly withdrawal?: string };
}
export type RevisionTargetType = typeof REVISION_TARGET_TYPES[number];
export interface SaveTarget { readonly type: RevisionTargetType; readonly id: string; readonly rootId?: string | null }

const FIXED_KINDS: Readonly<Record<Exclude<FieldClass, 'content'>, RevisionKind>> = {
  detail: 'minor_edit', status: 'status_change', withdrawal: 'withdrawal', disclosure: 'disclosure_change',
};
/** The row that carries each target's `rev`. */
const REV_ROWS: Readonly<Record<RevisionTargetType, { readonly table: string; readonly key: string }>> = {
  unit: { table: 'units', key: 'id' }, project: { table: 'projects', key: 'id' }, policy_page: { table: 'policy_pages', key: 'page_key' },
};

/** The fields of `after` whose value differs from `before`, each with its class. */
export function diffFields<T extends object>(before: T, after: Partial<T>, classes: Readonly<Record<keyof T & string, FieldClass>>): FieldChange[] {
  return (Object.keys(classes) as (keyof T & string)[]).flatMap((field) => {
    if (!Object.hasOwn(after, field)) return [];
    const previous = before[field] ?? null;
    const next = after[field] ?? null;
    return canonicalJson(previous) === canonicalJson(next) ? [] : [{ field, before: previous, after: next, fieldClass: classes[field] }];
  });
}

/** Content edits need a Minor_Edit or Correction mark, except Restorations (R22.2). */
export function needsEditMark(change: ChangeSet): boolean {
  return change.restoredPoint === undefined && change.fields.some((field) => field.fieldClass === 'content');
}

/** A label-only edit leaves every character of its field unchanged (R11.7); its Revision keeps the old spans (R11.8). */
export function checkLabelOnly(fields: readonly FieldChange[], labelOnly: readonly string[]): void {
  const changed = fields.filter((field) => labelOnly.includes(field.field) && (field.before as RichText | null)?.text !== (field.after as RichText | null)?.text);
  if (changed.length > 0) throw new ApiError('validation', { fields: changed.map((field) => ({ field: `${field.field}.text`, rule: 'A label change must leave every character of the text unchanged.' })) });
}

/** One Revision per Revision_Kind the change involves, each holding the previous value of its changed fields (R22.1). */
export function revisionsFor(target: SaveTarget, change: ChangeSet): RevisionInput[] {
  const groups = new Map<RevisionKind, FieldChange[]>();
  for (const field of change.fields) {
    let kind: RevisionKind;
    if (field.fieldClass !== 'content') kind = FIXED_KINDS[field.fieldClass];
    else if (change.restoredPoint !== undefined) kind = 'restoration';
    else if (change.mark) kind = change.mark.mark;
    else throw new Error('A content edit needs a Minor_Edit or Correction mark.');
    groups.set(kind, [...(groups.get(kind) ?? []), field]);
  }
  const reasonFor = (kind: RevisionKind): string | null => {
    if (kind === 'correction') return change.mark?.reason ?? null;
    if (kind === 'withdrawal') return change.reasons?.withdrawal ?? null;
    if (kind === 'status_change') return change.reasons?.status ?? null;
    return null;
  };
  return REVISION_KINDS.filter((kind) => groups.has(kind)).map((kind) => ({
    targetType: target.type, targetId: target.id, rootId: target.rootId ?? null, kind, reason: reasonFor(kind),
    prev: Object.fromEntries(groups.get(kind)!.map((field) => [field.field, field.before])),
    restoredPoint: kind === 'restoration' ? change.restoredPoint! : null,
  }));
}

export interface SavePlan {
  readonly target: SaveTarget;
  /** The `rev` the editor started from; the batch refuses the save when another came first (R4.9, R22.10). */
  readonly startedFrom: number;
  readonly change: ChangeSet;
  /** The writes and any automatic consequences, in batch order, after the `rev` guard. */
  readonly write: (batch: GuardedBatch) => void;
  readonly outbox: readonly (readonly [typeof OUTBOX_TOPICS[number], string])[];
}

/**
 * Commit one save as a single guarded batch: the `rev` guard, the writes, one Revision per
 * Revision_Kind, and the outbox rows. Nothing is saved unless everything is (R4.1, R28.13).
 */
export async function commitSave(c: Context<ApiEnv>, plan: SavePlan): Promise<void> {
  if (needsEditMark(plan.change) && !plan.change.mark) throw new ApiError('validation', { fields: [{ field: 'mark', rule: 'Mark the edit as a Minor Edit or a Correction.' }] });
  const row = REV_ROWS[plan.target.type];
  const batch = new GuardedBatch(c.env.RF_CORE, { id: c.get('session').member.id, now: c.get('now') })
    .guard('rev', sql`(SELECT rev FROM ${sql.identifier(row.table)} WHERE ${sql.identifier(row.key)} = ${plan.target.id}) = ${plan.startedFrom}`);
  plan.write(batch);
  const revisions = revisionsFor(plan.target, plan.change);
  for (const revision of revisions) batch.revision(revision);
  announceRevisions(batch, plan.target, revisions.map((revision) => revision.kind));
  for (const [topic, scope] of plan.outbox) batch.outbox(topic, scope);
  try {
    await batch.commit(c.get('accountant'));
  } catch (error) {
    if (error instanceof GuardViolation && error.code === 'rev') throw await conflictSince(c, plan.target, plan.startedFrom, error);
    throw error;
  }
}

export interface RevisionSummary { readonly kind: RevisionKind; readonly memberId: ULID; readonly displayName: string | null; readonly at: Timestamp }

/** The 409 for a stale save, listing the Revisions of the saves made since `startedFrom`, newest first (R4.9, R22.10). */
export async function conflictSince(c: Context<ApiEnv>, target: SaveTarget, startedFrom: number, cause?: unknown): Promise<ApiError> {
  const row = REV_ROWS[target.type];
  const db = c.env.RF_CORE;
  const current = await c.get('accountant').track(db.prepare(`SELECT rev FROM ${row.table} WHERE ${row.key} = ?1`).bind(target.id).all<{ rev: number }>());
  const rev = current.results[0]?.rev;
  if (rev === undefined) return new ApiError('not_found', {}, { cause });
  const revisions = await c.get('accountant').track(db.prepare(
    `SELECT r.kind, r.member_id AS memberId, p.display_name AS displayName, r.at FROM revisions r LEFT JOIN profiles p ON p.member_id = r.member_id
      WHERE r.target_type = ?1 AND r.target_id = ?2
        AND r.seq IN (SELECT DISTINCT seq FROM revisions WHERE target_type = ?1 AND target_id = ?2 ORDER BY seq DESC LIMIT ?3)
      ORDER BY r.seq DESC, r.id`,
  ).bind(target.type, target.id, Math.max(0, rev - startedFrom)).all<RevisionSummary>());
  return new ApiError('conflict', { details: { rev, revisions: revisions.results } }, { cause });
}
