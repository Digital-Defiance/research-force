import { eq, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { questionAssessments, researchQuestions, units } from '@researchforce/db/schema/core';
import { fragmentDigest } from '@researchforce/domain/text-fragments';
import type { RichText } from '@researchforce/domain/richtext';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import { ASSESSMENT_EVIDENCE_KINDS, assessmentInputSchema, assessmentIssues } from '@researchforce/domain/work';
import type { QuestionState } from '@researchforce/domain/work';
import { canonicalJson } from '@researchforce/kernel/views';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import type { FieldIssue } from '../api/errors';
import { parse } from '../api/input';
import { authorize } from '../auth/authorize';
import { loadItem } from './items';
import { richColumns, richText, rowsOf } from './kinds/kind';
import { commitSave } from './pipeline';
import type { FieldChange } from './pipeline';
import { visibleTo } from './submissions';

const EVIDENCE_KINDS: ReadonlySet<string> = new Set(ASSESSMENT_EVIDENCE_KINDS);
const gone = (unit: string): string => `NOT EXISTS (SELECT 1 FROM deletions x WHERE x.unit_id IN (${unit}.id, ${unit}.root_id))`;

interface EvidenceRow { targetId: ULID; targetKind: string; targetRev: number; sha256: string }
/** The identity of one version of a record, so an assessment names exactly what it rested on and a later edit is visible as a change. */
const versionDigest = (id: string, rev: number): string => fragmentDigest({ version: 'assessment-evidence-v1', id, rev });

export interface AssessmentVersionView {
  readonly version: number;
  readonly state: QuestionState;
  readonly assessment?: RichText;
  readonly reason: string | null;
  readonly responsibleId: ULID;
  readonly responsibleName: string | null;
  readonly recordedAt: Timestamp;
  /** Only the evidence the viewer can read; an unreadable record shows no title, count or trace (R50.10, R50.11). */
  readonly evidence: readonly { targetId: ULID; targetKind: string; title: string; targetRev: number; sha256: string; changedSince: boolean }[];
}
export interface AssessmentView {
  readonly questionId: ULID;
  readonly state: QuestionState;
  readonly version: number;
  readonly current: AssessmentVersionView | null;
  readonly history: readonly AssessmentVersionView[];
}

interface VersionRow { version: number; state: QuestionState; assessment: string | null; assessmentSpans: string; reason: string | null; responsibleId: ULID; responsibleName: string | null; recordedAt: Timestamp }

async function loadQuestion(c: Context<ApiEnv>, id: string) {
  const item = await loadItem(c, id);
  if (item.base.kind !== 'research_question') throw new ApiError('not_found');
  return item;
}

/** Every recorded version of the Question's assessment with the evidence the Member can read, oldest first (R50.9, R50.10). */
export async function readAssessment(c: Context<ApiEnv>, id: string): Promise<AssessmentView> {
  const question = await loadQuestion(c, id);
  const db = c.env.RF_CORE;
  const viewer = c.get('session').member.id;
  const [versions, evidence] = await c.get('accountant').track(db.batch([
    db.prepare(`SELECT a.version, a.state, a.assessment, a.assessment_spans AS assessmentSpans, a.reason, a.responsible_id AS responsibleId, p.display_name AS responsibleName, a.recorded_at AS recordedAt
      FROM question_assessments a LEFT JOIN profiles p ON p.member_id = a.responsible_id WHERE a.question_id = ?1 ORDER BY a.version`).bind(id),
    db.prepare(`SELECT e.version, e.target_id AS targetId, e.target_kind AS targetKind, e.target_rev AS targetRev, e.sha256, ri.title, r.rev AS currentRev
      FROM question_assessment_evidence e JOIN units u ON u.id = e.target_id JOIN units r ON r.id = u.root_id JOIN research_items ri ON ri.unit_id = u.id
      WHERE e.question_id = ?1 AND ${visibleTo('u', '?2')} AND ${gone('u')} ORDER BY e.version, e.position`).bind(id, viewer),
  ]));
  const found = rowsOf<{ version: number; targetId: ULID; targetKind: string; targetRev: number; sha256: string; title: string; currentRev: number }>(evidence);
  const history = rowsOf<VersionRow>(versions).map((row): AssessmentVersionView => {
    const assessment = richText(row.assessment, row.assessmentSpans);
    return {
      version: row.version, state: row.state, ...(assessment === undefined ? {} : { assessment }), reason: row.reason, responsibleId: row.responsibleId,
      responsibleName: row.responsibleName, recordedAt: row.recordedAt,
      evidence: found.filter((entry) => entry.version === row.version).map(({ version: _version, currentRev, ...entry }) => ({ ...entry, changedSince: currentRev !== entry.targetRev })),
    };
  });
  return {
    questionId: question.base.id, state: (question.extra['investigationState'] ?? 'open') as QuestionState, version: (question.extra['assessmentVersion'] ?? 0) as number,
    current: history.at(-1) ?? null, history,
  };
}

/** The evidence a Member names, as it reads now: each a Finding, Run, Source or Decision_Record the Member can read, at its current revision (R50.10). */
async function resolveEvidence(c: Context<ApiEnv>, questionId: string, targets: readonly { targetId: string }[]): Promise<EvidenceRow[]> {
  const ids = [...new Set(targets.map((target) => target.targetId))];
  if (ids.length === 0) return [];
  const found = await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT u.id, u.unit_type AS unitType, ri.kind, r.rev FROM units u LEFT JOIN research_items ri ON ri.unit_id = u.id JOIN units r ON r.id = u.root_id
      WHERE u.id IN (SELECT value FROM json_each(?1)) AND ${visibleTo('u', '?2')} AND ${gone('u')}`,
  ).bind(JSON.stringify(ids), c.get('session').member.id).all<{ id: ULID; unitType: string; kind: string | null; rev: number }>());
  const byId = new Map<string, typeof found.results[number]>(found.results.map((row) => [row.id, row]));
  const issues: FieldIssue[] = [];
  const rows: EvidenceRow[] = [];
  ids.forEach((id, index) => {
    const row = byId.get(id);
    if (!row || id === questionId) issues.push({ field: `evidence.${index}`, rule: 'This record does not exist, has been permanently deleted, or cannot be read.' });
    else if (row.unitType !== 'research_item' || row.kind === null || !EVIDENCE_KINDS.has(row.kind)) issues.push({ field: `evidence.${index}`, rule: 'Evidence is a Finding, Run, Source, or Decision Record.' });
    else rows.push({ targetId: id as ULID, targetKind: row.kind, targetRev: row.rev, sha256: versionDigest(id, row.rev) });
  });
  if (issues.length > 0) throw new ApiError('validation', { fields: issues });
  return rows;
}

/**
 * Record the next version of a Question's assessment and investigation state, as an ordinary edit of the Question: the same Permission,
 * revision check, history and notices. Answered needs a non-blank assessment and readable supporting evidence; parking and reopening
 * need a reason, and the earlier conclusions and their evidence stay (R50.9, R50.10). The lead is a role, not an Owner or access change.
 */
export async function recordAssessment(c: Context<ApiEnv>, id: string, body: unknown): Promise<AssessmentView> {
  const input = parse(assessmentInputSchema, body);
  const question = await loadQuestion(c, id);
  if (question.base.withdrawnAt !== null) throw new ApiError('validation', { fields: [{ field: 'state', rule: 'This Research Question has been withdrawn.' }] });
  await authorize(c, [{ permission: 'item.edit', target: { type: 'research_item', ownerId: question.base.ownerId, itemKind: 'research_question', field: 'content' } }]);
  const from = (question.extra['investigationState'] ?? 'open') as QuestionState;
  const version = (question.extra['assessmentVersion'] ?? 0) as number;
  const db = c.env.RF_CORE;
  const [latest, carried] = await c.get('accountant').track(db.batch([
    db.prepare('SELECT assessment, assessment_spans AS assessmentSpans FROM question_assessments WHERE question_id = ?1 AND version = ?2').bind(id, version),
    db.prepare(`SELECT e.target_id AS targetId, e.target_kind AS targetKind, e.target_rev AS targetRev, e.sha256, (${visibleTo('u', '?3')} AND ${gone('u')}) AS readable
      FROM question_assessment_evidence e LEFT JOIN units u ON u.id = e.target_id WHERE e.question_id = ?1 AND e.version = ?2 ORDER BY e.position`).bind(id, version, c.get('session').member.id),
  ]));
  const previous = rowsOf<{ assessment: string | null; assessmentSpans: string }>(latest)[0];
  const earlier = previous === undefined ? undefined : richText(previous.assessment, previous.assessmentSpans);
  const stored = rowsOf<EvidenceRow & { readable: number | null }>(carried);
  const fresh = input.evidence === undefined ? undefined : await resolveEvidence(c, id, input.evidence);
  const assessment = input.assessment ?? earlier;
  const contentChanged = (input.assessment !== undefined && canonicalJson(input.assessment) !== canonicalJson(earlier ?? null))
    || (fresh !== undefined && canonicalJson(fresh.map((row) => row.targetId)) !== canonicalJson(stored.map((row) => row.targetId)));
  const issues = assessmentIssues(from, input, {
    assessment: assessment?.text, evidence: fresh === undefined ? stored.filter((row) => row.readable === 1).length : fresh.length, changesContent: contentChanged,
  });
  if (issues.length > 0) throw new ApiError('validation', { fields: issues });

  const next = version + 1;
  const changes: FieldChange[] = [];
  if (input.state !== from) changes.push({ field: 'investigationState', before: from, after: input.state, fieldClass: 'status' });
  if (input.assessment !== undefined && canonicalJson(input.assessment) !== canonicalJson(earlier ?? null)) changes.push({ field: 'assessment', before: earlier ?? null, after: input.assessment, fieldClass: 'detail' });
  if (fresh !== undefined && contentChanged) changes.push({ field: 'assessmentEvidence', before: stored.map((row) => row.targetId), after: fresh.map((row) => row.targetId), fieldClass: 'detail' });
  const columns = richColumns(assessment);
  await commitSave(c, {
    target: { type: 'unit', id, rootId: id },
    startedFrom: input.rev,
    change: { fields: changes, ...(input.reason === undefined ? {} : { reasons: { status: input.reason } }) },
    write: (batch) => {
      batch.guard('rev', sql`(SELECT assessment_version FROM research_questions WHERE unit_id = ${id}) = ${version}`);
      batch.update(units, {}, eq(units.id, id));
      batch.update(researchQuestions, { investigationState: input.state, assessmentVersion: next }, eq(researchQuestions.unitId, id));
      batch.insert(questionAssessments, {
        questionId: id, version: next, state: input.state, assessment: columns.text, assessmentSpans: columns.spans, reason: input.reason ?? null,
        responsibleId: batch.actor.id!, recordedAt: batch.actor.now,
      });
      if (fresh === undefined) {
        batch.run(sql`INSERT INTO question_assessment_evidence (question_id, version, position, target_id, target_kind, target_rev, sha256)
          SELECT question_id, ${next}, position, target_id, target_kind, target_rev, sha256 FROM question_assessment_evidence WHERE question_id = ${id} AND version = ${version}`);
      } else {
        for (const [position, row] of fresh.entries()) {
          batch.run(sql`INSERT INTO question_assessment_evidence (question_id, version, position, target_id, target_kind, target_rev, sha256)
            VALUES (${id}, ${next}, ${position}, ${row.targetId}, ${row.targetKind}, ${row.targetRev}, ${row.sha256})`);
        }
      }
    },
    outbox: [['publish', `unit:${id}`], ['search', `unit:${id}`]],
  });
  return readAssessment(c, id);
}
