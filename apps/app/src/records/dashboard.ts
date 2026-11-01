import type { Context } from 'hono';
import { canRead } from '@researchforce/db/access';
import type { QuestionState } from '@researchforce/domain/work';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import type { ApiEnv } from '../api/app';
import { rowsOf } from './kinds/kind';
import { visibleTo } from './submissions';

/**
 * The My_Work dashboard aggregation (R58.1, R58.5, R60.9). It gathers the outstanding work the viewer
 * owes attention — the Edit_Proposals an authorized editor must resolve, the archival derivations that
 * still await an independent review, and the Research_Questions the viewer follows — alongside the
 * counts of the pieces the Workspace already serves through their own routes (work, the review queue and
 * durable drafts). Every piece is evaluated through the viewer's current Can_Read, so a record the
 * viewer lost access to contributes no content and no count; a followed Question whose target became
 * unreadable is shown as a neutral unavailable entry rather than named. This endpoint reports only
 * outstanding work; it never reads or clears a New_Flag or Updated_Flag, so listing it is not the same
 * as opening the work, and unseen activity stays the separate concern of the badges (R58.5).
 */

const BOUND = 20;
/** The derivation review states that still invite an independent review (R55.3). */
const NEEDS_REVIEW = ['unreviewed', 'disputed'] as const;

/** An Edit_Proposal awaiting an authorized editor's decision on a record the viewer can read (R58.1, R57.6). */
export interface DashboardProposal {
  readonly id: ULID;
  readonly targetRootId: ULID;
  readonly identifier: string;
  readonly title: string;
  readonly explanation: string;
  readonly createdAt: Timestamp;
  /** True once the record moved past the base, so it needs the proposer's rebase before it can be accepted (R57.5). */
  readonly stale: boolean;
}

/** An Artifact_Derivation the viewer can read that still needs independent review, as an archival follow-up (R58.1, R55.3). */
export interface DashboardArchival {
  readonly id: ULID;
  readonly rootId: ULID;
  readonly identifier: string;
  readonly title: string;
  readonly kind: string;
  readonly reviewState: 'unreviewed' | 'disputed';
  readonly createdAt: Timestamp;
}

/** A followed Research_Question; a lost target is a neutral unavailable entry with no content (R58.1, R58.4). */
export interface DashboardQuestion {
  readonly followId: ULID;
  readonly available: boolean;
  readonly rootId: ULID | null;
  readonly identifier: string | null;
  readonly question: string | null;
  readonly state: QuestionState | null;
}

export interface DashboardView {
  /** The outstanding sections the page draws, each a readable slice with a total count that excludes hidden targets. */
  readonly proposals: { readonly total: number; readonly items: readonly DashboardProposal[] };
  readonly archival: { readonly total: number; readonly items: readonly DashboardArchival[] };
  readonly questions: readonly DashboardQuestion[];
}

interface ProposalRaw {
  id: ULID; targetRootId: ULID; identifier: string; title: string; explanation: string; createdAt: Timestamp; appliesToRev: number; targetRev: number | null;
}

/**
 * Open Edit_Proposals of records the viewer can read that the viewer did not write, since a proposer can
 * never accept or decline their own suggestion (R57.6). The acceptance route still re-checks every
 * changed field's Permission at the moment of acceptance, so this list is the set that may require the
 * viewer, never a grant of any editing right. A proposal of a record the viewer cannot read contributes
 * nothing, so neither its content nor its count can leak an unreadable record (R58.1).
 */
async function proposals(c: Context<ApiEnv>, viewer: string): Promise<DashboardView['proposals']> {
  const where = `p.state = 'open' AND p.proposer_id <> ?1
    AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id IN (u.id, u.root_id))
    AND ${canRead('?1', 'u.id')}`;
  const total = (await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT count(*) AS n FROM edit_proposals p JOIN units u ON u.id = p.target_root_id WHERE ${where}`,
  ).bind(viewer).all<{ n: number }>())).results[0]?.n ?? 0;
  const rows = rowsOf<ProposalRaw>(await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT p.id, p.target_root_id AS targetRootId, ri.item_identifier AS identifier, ri.title, p.explanation, p.created_at AS createdAt,
        p.applies_to_rev AS appliesToRev, u.rev AS targetRev
      FROM edit_proposals p JOIN units u ON u.id = p.target_root_id JOIN research_items ri ON ri.unit_id = u.id
      WHERE ${where} ORDER BY p.created_at DESC, p.id DESC LIMIT ${BOUND}`,
  ).bind(viewer).all()));
  return {
    total,
    items: rows.map(({ appliesToRev, targetRev, ...row }) => ({ ...row, stale: targetRev !== null && targetRev !== appliesToRev })),
  };
}

/**
 * Archival follow-ups: the current Artifact_Derivations whose output the viewer can read that are still
 * Unreviewed or Disputed, so an independent review would help (R55.3, R58.1). A corrected (superseded)
 * derivation is excluded, and a derivation of an output the viewer cannot read contributes no row and no
 * count, so the follow-up list reveals nothing hidden.
 */
async function archival(c: Context<ApiEnv>, viewer: string): Promise<DashboardView['archival']> {
  const needsReview = NEEDS_REVIEW.map((state) => `'${state}'`).join(', ');
  const where = `dv.corrected_by IS NULL AND dv.review_state IN (${needsReview})
    AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id IN (u.id, u.root_id))
    AND ${visibleTo('u', '?1')}`;
  const total = (await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT count(*) AS n FROM artifact_derivations dv JOIN units u ON u.id = dv.output_unit_id WHERE ${where}`,
  ).bind(viewer).all<{ n: number }>())).results[0]?.n ?? 0;
  const rows = rowsOf<DashboardArchival>(await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT dv.id, u.root_id AS rootId, ri.item_identifier AS identifier, ri.title, dv.kind, dv.review_state AS reviewState, dv.created_at AS createdAt
      FROM artifact_derivations dv JOIN units u ON u.id = dv.output_unit_id JOIN research_items ri ON ri.unit_id = u.root_id
      WHERE ${where} ORDER BY dv.created_at DESC, dv.id DESC LIMIT ${BOUND}`,
  ).bind(viewer).all()));
  return { total, items: rows };
}

interface QuestionRaw {
  followId: ULID; targetRootId: ULID; identifier: string | null; question: string | null; state: QuestionState | null; readable: 0 | 1;
}

/**
 * The Research_Questions the viewer follows, newest follow first (R58.1). Each row is marked readable or
 * not through the viewer's current access; an unreadable target keeps its place as a neutral unavailable
 * entry with no identifier, question text, or state, so the viewer sees that they followed something
 * without learning what it now is (R58.4). A Follow grants no read access, so this never widens it.
 */
async function questions(c: Context<ApiEnv>, viewer: string): Promise<readonly DashboardQuestion[]> {
  // Each Follow carries a readable flag computed from current access; the identifying columns are only read when readable.
  const readable = `(EXISTS (SELECT 1 FROM units u WHERE u.id = f.target_root_id AND ${canRead('?1', 'u.id')}
    AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = u.id)))`;
  const rows = rowsOf<QuestionRaw>(await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT f.id AS followId, f.target_root_id AS targetRootId,
        CASE WHEN ${readable} THEN ri.item_identifier END AS identifier,
        CASE WHEN ${readable} THEN rq.question END AS question,
        CASE WHEN ${readable} THEN rq.investigation_state END AS state,
        ${readable} AS readable
      FROM follows f
        LEFT JOIN research_items ri ON ri.unit_id = f.target_root_id
        LEFT JOIN research_questions rq ON rq.unit_id = f.target_root_id
      WHERE f.member_id = ?1 AND f.kind = 'question'
      ORDER BY f.created_at DESC, f.id DESC LIMIT ${BOUND}`,
  ).bind(viewer).all()));
  return rows.map((row) => {
    const available = row.readable === 1;
    return {
      followId: row.followId, available,
      rootId: available ? row.targetRootId : null,
      identifier: available ? row.identifier : null,
      question: available ? row.question : null,
      state: available ? row.state : null,
    };
  });
}

/** The My_Work dashboard: outstanding proposals, archival follow-ups and followed Questions the viewer can read (R58.1, R58.5). */
export async function readDashboard(c: Context<ApiEnv>): Promise<DashboardView> {
  const viewer = c.get('session').member.id;
  const [proposalsPart, archivalPart, questionsPart] = await Promise.all([proposals(c, viewer), archival(c, viewer), questions(c, viewer)]);
  return { proposals: proposalsPart, archival: archivalPart, questions: questionsPart };
}

/** A readable Research_Question's lifecycle progress on a team dashboard, by Project (R58.5). */
export interface TeamQuestion {
  readonly rootId: ULID;
  readonly identifier: string;
  readonly question: string;
  readonly state: QuestionState;
  readonly leadName: string | null;
}
export interface TeamDashboardView { readonly questions: { readonly total: number; readonly items: readonly TeamQuestion[] } }

/**
 * A Project's team dashboard (R58.5). It lists the Research_Question progress the viewer can read in one
 * Project — the question, its lifecycle state, and its lead — alongside the readable work the Project's
 * own work list already serves. It publishes no participation or access-list information: a Question the
 * viewer cannot read contributes no row and no count, so the dashboard shows only authorized context.
 */
export async function readTeamDashboard(c: Context<ApiEnv>, projectId: string): Promise<TeamDashboardView> {
  const viewer = c.get('session').member.id;
  const where = `ri.kind = 'research_question' AND u.project_id = ?2 AND u.withdrawn_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id IN (u.id, u.root_id)) AND ${visibleTo('u', '?1')}`;
  const total = (await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT count(*) AS n FROM research_items ri JOIN units u ON u.id = ri.unit_id WHERE ${where}`,
  ).bind(viewer, projectId).all<{ n: number }>())).results[0]?.n ?? 0;
  const rows = rowsOf<TeamQuestion>(await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT u.id AS rootId, ri.item_identifier AS identifier, rq.question, rq.investigation_state AS state, p.display_name AS leadName
      FROM research_items ri JOIN units u ON u.id = ri.unit_id JOIN research_questions rq ON rq.unit_id = u.id
        LEFT JOIN profiles p ON p.member_id = rq.lead_id
      WHERE ${where} ORDER BY ri.item_identifier LIMIT ${BOUND}`,
  ).bind(viewer, projectId).all()));
  return { questions: { total, items: rows } };
}
