import type { Context } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { BatchTooLarge, GuardedBatch, GuardViolation } from '@researchforce/db/batch';
import { attachments, moderationDecisions, outgoingEmails, outsideSubmissions, replies, researchItems, responseLinks, units } from '@researchforce/db/schema/core';
import { DECISION_KINDS } from '@researchforce/db/schema/core';
import { dateSortKey, itemDate, logDate } from '@researchforce/domain/dates';
import { fileKind } from '@researchforce/domain/file-kinds';
import { newULID } from '@researchforce/domain/identifiers';
import { RETENTION } from '@researchforce/domain/retention';
import type { RichText } from '@researchforce/domain/richtext';
import { validate } from '@researchforce/domain/schemas/common';
import { researchItemSchema } from '@researchforce/domain/schemas/items';
import { attachmentMetadataSchema, replySchema } from '@researchforce/domain/schemas/other';
import { ITEM_KINDS, isULID } from '@researchforce/domain/types';
import type { CreditEntry, ItemKind, OutsideSubmissionType, Timestamp, ULID } from '@researchforce/domain/types';
import { BUILT_IN_VALUE_IDS } from '@researchforce/domain/value-sets';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import type { FieldIssue } from '../api/errors';
import { parse } from '../api/input';
import { authorize } from '../auth/authorize';
import { decisionEmailContent } from '../mail/outside';
import type { UploadRow } from '../files/uploads';
import { KIND_ADAPTERS } from '../records/kinds';
import { prepareSections } from '../records/kinds/journal';
import { rowsOf } from '../records/kinds/kind';
import { validationContext } from '../records/items';
import { addGroupNote, logSummaryColumns, present } from '../records/log-summary';
import { addSubmission, commitWithIdentifiers, completeSubmission, visibleTo } from '../records/submissions';
import { contactReviewDueAt } from './contact-review';

/** The longest message or reason an Administrator may write for a Submitter (R32.10). */
export const DECISION_TEXT_LIMIT = 5_000;
/** A Removal_Request statement is 1 to 5,000 characters (R32.12). */
const STATEMENT_LIMIT = 5_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The decision an Administrator records, named the way the Moderation_Service applies it. */
export type DecisionKind = typeof DECISION_KINDS[number];
/** The references a Removal_Request records as changed; kept verbatim, never resolved (R32.12, R46.23). */
const CHANGED_KINDS = ['item', 'entry_section', 'dissent_note', 'external_party', 'policy_page'] as const;

/** 1 to 5,000 characters, at least one non-whitespace, matching the Submitter text limit (R32.10). */
const decisionText = z.string().min(1).max(DECISION_TEXT_LIMIT).refine((value) => value.trim().length > 0, 'Enter the message.');
/** A Removal_Request statement: 1 to 5,000 characters, at least one non-whitespace (R32.12). */
const statementText = z.string().min(1).max(STATEMENT_LIMIT).refine((value) => value.trim().length > 0, 'Enter a statement.');
/** One element a Removal_Request names as changed (R46.23); the kind and a free-text reference, stored as given. */
const changedRef = z.strictObject({ kind: z.enum(CHANGED_KINDS), reference: z.string().min(1).max(200) });

/** A local handle an acceptance uses to make one created Item the Parent of another in the same batch. */
const localRef = z.string().min(1).max(64);
/** The Parent of a Reply or Attachment: an existing unit by id, or an Item created earlier in this acceptance. */
const parentChoice = z.union([
  z.strictObject({ existing: z.string().refine(isULID, 'Choose an existing Item.') }),
  z.strictObject({ created: localRef }),
]);
type ParentChoice = z.output<typeof parentChoice>;

/** One unit an acceptance creates (R32.4). A Research_Item carries its kind fields; a Reply or Attachment names a Parent. */
const selectionSchema = z.discriminatedUnion('unit', [
  z.strictObject({
    unit: z.literal('research_item'),
    ref: localRef.optional(),
    kind: z.enum(ITEM_KINDS),
    /** The Project for this Research_Item; required for the General_Choice, else the Outside_Submission's Project unless overridden (R32.18). */
    projectId: z.string().refine(isULID, 'Choose a Project.').optional(),
    fields: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({ unit: z.literal('reply'), parent: parentChoice, text: z.record(z.string(), z.unknown()) }),
  z.strictObject({ unit: z.literal('attachment'), parent: parentChoice, uploadId: z.ulid(), metadata: z.record(z.string(), z.unknown()) }),
]);
export type Selection = z.output<typeof selectionSchema>;

/** The body of `POST /moderation/{id}/decide`. A preview omits confirmation; an apply confirms the exact email text (R32.10). */
const decideSchema = z.discriminatedUnion('decision', [
  z.strictObject({ decision: z.literal('accepted'), confirm: z.boolean().default(false), text: decisionText, items: z.array(selectionSchema).min(1, 'Select at least one Item to create.') }),
  z.strictObject({ decision: z.literal('rejected'), confirm: z.boolean().default(false), text: decisionText }),
  z.strictObject({ decision: z.literal('more_information_requested'), confirm: z.boolean().default(false), text: decisionText }),
  z.strictObject({ decision: z.literal('removal_accepted'), confirm: z.boolean().default(false), statement: statementText, changed: z.array(changedRef).max(200).default([]) }),
  z.strictObject({ decision: z.literal('removal_rejected'), confirm: z.boolean().default(false), statement: statementText, changed: z.array(changedRef).max(200).default([]) }),
]);
export type DecideInput = z.output<typeof decideSchema>;

interface SubmissionRow {
  readonly id: ULID;
  readonly reference: string;
  readonly type: OutsideSubmissionType;
  readonly projectId: ULID | null;
  readonly name: string;
  readonly email: string | null;
  readonly affiliation: string | null;
  readonly receivedAt: Timestamp;
}
interface FinalRow {
  readonly id: ULID;
  readonly kind: DecisionKind;
  readonly adminId: ULID;
  readonly displayName: string | null;
  readonly at: Timestamp;
}

/** The recorded final decision shown when a decision is refused (R32.16). */
export interface RecordedDecision {
  readonly kind: DecisionKind;
  readonly admin: { readonly id: ULID; readonly displayName: string | null };
  readonly at: Timestamp;
}

/** The outcome of a decision: the exact email text first, and, once confirmed, what was created or scheduled. */
export interface DecisionResult {
  readonly reference: string;
  /** The email the Submitter would receive, shown for confirmation and sent on apply (R32.10). */
  readonly email: { readonly subject: string; readonly body: readonly string[] };
  /** Set only once applied. */
  readonly applied?: {
    readonly decisionId: ULID;
    readonly kind: DecisionKind;
    /** The Items created by an acceptance, in selection order (R32.4, R32.13). */
    readonly createdUnitIds: readonly ULID[];
  };
}

/** The email kind an `outgoing_emails` row carries for a decision; the Mailer composes it the same way as the acknowledgement. */
function emailKind(kind: DecisionKind): 'more_information' | 'decision' {
  return kind === 'more_information_requested' ? 'more_information' : 'decision';
}

/** The base of the public Response_Link URL, on the public site that serves the page (falling back to the Workspace origin, `app.` → `submit.`). */
function respondBase({ WORKSPACE_ORIGIN: workspaceOrigin, PUBLIC_SITE_ORIGIN: siteOrigin }: { WORKSPACE_ORIGIN: string; PUBLIC_SITE_ORIGIN?: string | undefined }): string {
  if (siteOrigin) return `${siteOrigin}/respond`;
  try {
    const url = new URL(workspaceOrigin);
    url.hostname = url.hostname.replace(/^app\./u, 'submit.');
    return `${url.origin}/respond`;
  } catch {
    return 'https://submit.researchforce.org/respond';
  }
}

/** The SHA-256 hex of the Response_Link token; only the hash is stored (R32.14). */
async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A 128-bit Response_Link token in Crockford base32, which travels in the Submitter's email URL fragment (R32.6, R32.14). */
function newResponseToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

/** The Outside_Submission to decide on, with any final decision already recorded (R32.16). */
async function loadSubmission(c: Context<ApiEnv>, id: string): Promise<{ submission: SubmissionRow; final: RecordedDecision | null }> {
  if (!isULID(id)) throw new ApiError('not_found');
  const db = c.env.RF_CORE;
  const [subRows, finalRows] = await c.get('accountant').track(db.batch([
    db.prepare(`SELECT id, reference, type, project_id AS projectId, name, email, affiliation, received_at AS receivedAt
      FROM outside_submissions WHERE id = ?1`).bind(id),
    db.prepare(`SELECT d.id, d.kind, d.admin_id AS adminId, p.display_name AS displayName, d.at
      FROM moderation_decisions d LEFT JOIN profiles p ON p.member_id = d.admin_id WHERE d.outside_submission_id = ?1 AND d.final = 1`).bind(id),
  ]));
  const submission = rowsOf<SubmissionRow>(subRows)[0];
  if (!submission) throw new ApiError('not_found');
  const row = rowsOf<FinalRow>(finalRows)[0];
  return { submission, final: row ? { kind: row.kind, admin: { id: row.adminId, displayName: row.displayName }, at: row.at } : null };
}

/** The 409 for a decision refused because a final one is already recorded, showing it with the deciding Administrator and time (R32.16). */
function decidedConflict(final: RecordedDecision, cause?: unknown): ApiError {
  return new ApiError('conflict', { details: { rule: 'decision_open', decision: final } }, { cause });
}

/** The confirmed-email facts for a decision, from which decide.ts and the Mailer build the identical Submitter email (R32.10). */
function emailContent(kind: DecisionKind, submission: SubmissionRow, text: string, responseUrl?: string): { subject: string; body: string[] } {
  return decisionEmailContent({ decisionKind: kind, type: submission.type, reference: submission.reference, receivedAt: submission.receivedAt, text, ...(responseUrl ? { responseUrl } : {}) });
}

interface ResolvedParent { readonly id: ULID; readonly rootId: ULID; readonly projectId: ULID }
interface UnitPlan { write(batch: GuardedBatch, issued: ReadonlyMap<ULID, string>): void; readonly uploadId?: string }
interface PlanState {
  readonly actor: ULID;
  readonly now: Timestamp;
  readonly submissionId: ULID;
  readonly credit: readonly CreditEntry[];
  readonly context: Awaited<ReturnType<typeof validationContext>>;
  readonly refs: Map<string, ResolvedParent>;
  readonly existingParents: ReadonlyMap<string, ResolvedParent>;
  readonly issues: FieldIssue[];
  /** Every created unit, in selection order, recorded with the decision (R32.13). */
  readonly unitIds: ULID[];
  /** The units that need a new Item_Identifier: Research_Items and Attachments, not Replies (R15.1, R15.6). */
  readonly identifierIds: ULID[];
  /** The `publish` and `search` scopes, emitted once at the end so a large acceptance stays within the batch limit. */
  readonly publishScopes: string[];
  readonly searchScopes: string[];
  readonly plans: UnitPlan[];
}

/**
 * Validate the Items an acceptance would create and plan their writes, all into one batch that creates them as one
 * Submission by the accepting Administrator, credited to the Submitter, Not_Published and Unclassified (R32.4, R32.5,
 * R32.18, R41.2). A Parent is an existing Item or one created earlier in the same acceptance. The plan is all-or-nothing:
 * any invalid selection throws before anything is written, and the single batch commits everything or nothing (R32.15).
 */
async function planAcceptance(
  c: Context<ApiEnv>,
  submission: SubmissionRow,
  selections: readonly Selection[],
  credit: readonly CreditEntry[],
  submissionId: ULID,
): Promise<{ unitIds: ULID[]; identifierIds: ULID[]; write: (batch: GuardedBatch, issued: ReadonlyMap<ULID, string>) => void }> {
  const actor = c.get('session').member.id;
  const now = c.get('now');
  const context = await validationContext(c);

  // Parents named as existing Items must be visible to the accepting Administrator; read them up front so a bad id fails
  // the whole acceptance before any write (R32.15). A Parent created in the same acceptance resolves from `refs`.
  const existingIds = [...new Set(selections.flatMap((s) => (s.unit !== 'research_item' && 'existing' in s.parent ? [s.parent.existing] : [])))];
  const parentRows = existingIds.length === 0 ? [] : rowsOf<ResolvedParent>(await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT u.id, u.root_id AS rootId, u.project_id AS projectId FROM units u
      WHERE u.id IN (SELECT value FROM json_each(?1)) AND u.unit_type IN ('research_item', 'attachment', 'reply') AND ${visibleTo('u', '?2')}
        AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = u.id)`,
  ).bind(JSON.stringify(existingIds), actor).all()));

  const state: PlanState = {
    actor, now, submissionId, credit, context, refs: new Map(), existingParents: new Map(parentRows.map((row) => [row.id, row])),
    issues: [], unitIds: [], identifierIds: [], publishScopes: [], searchScopes: [], plans: [],
  };

  for (const [index, selection] of selections.entries()) {
    if (selection.unit === 'research_item') planResearchItem(submission, selection, index, state);
    else if (selection.unit === 'reply') planReply(selection, index, state);
    else await planAttachment(c, selection, index, state);
  }

  const uploads = [...new Set(state.plans.flatMap((plan) => (plan.uploadId ? [plan.uploadId] : [])))];
  if (state.issues.length > 0) throw new ApiError('validation', { fields: state.issues });

  return { unitIds: state.unitIds, identifierIds: state.identifierIds, write(batch, issued) {
    for (const plan of state.plans) plan.write(batch, issued);
    if (uploads.length > 0) {
      const list = JSON.stringify(uploads);
      batch.guard('upload_ready', sql`(SELECT count(*) FROM uploads WHERE id IN (SELECT value FROM json_each(${list})) AND owner_id = ${actor} AND state = 'complete' AND hash_verified_at IS NOT NULL AND attached_at IS NULL) = ${uploads.length}`);
      batch.run(sql`UPDATE uploads SET attached_at = ${now}, state = 'attached' WHERE id IN (SELECT value FROM json_each(${list}))`);
    }
    // One outbox row per distinct scope and topic, in one statement each, so a many-Item acceptance stays bounded.
    batch.outboxMany('publish', state.publishScopes).outboxMany('search', state.searchScopes);
  } };
}

/** Resolve a Reply's or Attachment's Parent to an existing visible unit or one created earlier in this acceptance. */
function resolveParent(choice: ParentChoice, index: number, state: PlanState): ResolvedParent | null {
  if ('existing' in choice) {
    const row = state.existingParents.get(choice.existing);
    if (!row) { state.issues.push({ field: `items.${index}.parent`, rule: 'Choose an existing Item you can read.' }); return null; }
    return row;
  }
  const created = state.refs.get(choice.created);
  if (!created) { state.issues.push({ field: `items.${index}.parent`, rule: 'Name an Item created earlier in this acceptance.' }); return null; }
  return created;
}

/** Guard that a Parent still exists under its Root when the batch runs, so a deletion between read and commit refuses the acceptance. */
function guardLiveParent(batch: GuardedBatch, parent: ResolvedParent): void {
  batch.guard('reply_parent', sql`EXISTS (SELECT 1 FROM units p WHERE p.id = ${parent.id} AND p.root_id = ${parent.rootId} AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = p.id OR d.unit_id = p.root_id))`);
}

/** Validate and plan one accepted Research_Item, crediting the Submitter and recording its local ref for later Parents (R32.4, R32.18, R41.2). */
function planResearchItem(submission: SubmissionRow, selection: Extract<Selection, { unit: 'research_item' }>, index: number, state: PlanState): void {
  const kind = selection.kind;
  // The Project: the Administrator's choice, else the Outside_Submission's Project; the General_Choice requires a choice (R32.18).
  const projectId = selection.projectId ?? submission.projectId ?? null;
  if (projectId === null) { state.issues.push({ field: `items.${index}.projectId`, rule: 'Choose a Project for this Item.' }); return; }
  if (!state.context.projects.some((project) => project.id === projectId)) { state.issues.push({ field: `items.${index}.projectId`, rule: 'Choose an existing Project.' }); return; }

  const result = validate(researchItemSchema(kind, state.context, { mode: 'submit' }), { ...selection.fields, projectId, kind });
  if (!result.ok) { state.issues.push(...result.issues.filter((issue) => issue.field !== 'projectId').map((issue) => ({ field: `items.${index}.${issue.field}`, rule: issue.message }))); return; }
  const fields = result.value as unknown as Record<string, unknown>;

  const id = newULID(state.now);
  if (selection.ref !== undefined) {
    if (state.refs.has(selection.ref)) { state.issues.push({ field: `items.${index}.ref`, rule: 'Each reference names one created Item.' }); return; }
    state.refs.set(selection.ref, { id, rootId: id, projectId: projectId as ULID });
  }
  state.unitIds.push(id);
  state.identifierIds.push(id);

  const adapter = KIND_ADAPTERS[kind];
  const groupNote = fields['groupNote'] as RichText | undefined;
  // A Journal_Entry's Entry_Sections come from its body, as on the normal submit path; prepareSections assigns their ids.
  let withFields = fields;
  if (kind === 'journal_entry') {
    const prepared = prepareSections(fields, undefined, state.now);
    if (prepared.issues.length > 0) { state.issues.push(...prepared.issues.map((issue) => ({ field: `items.${index}.${issue.field}`, rule: issue.rule }))); return; }
    withFields = { ...fields, sections: prepared.sections };
  }

  const newItem = { id, projectId: projectId as ULID, ownerId: state.actor, credit: [...state.credit], submissionId: state.submissionId, now: state.now };
  state.plans.push({ write(batch, issued) {
    batch.insert(units, {
      id, unitType: 'research_item', projectId: projectId as ULID, rootId: id, ownerId: state.actor, credit: [...state.credit],
      submissionId: state.submissionId, createdAt: state.now, classificationState: 'unclassified',
    });
    batch.insert(researchItems, {
      unitId: id, kind, itemIdentifier: issued.get(id)!, projectId: projectId as ULID, title: withFields['title'] as string,
      statusValueId: (withFields['statusValueId'] as string | undefined) ?? null,
      ...dateKeys(kind, withFields, state.now), ...logSummaryColumns(withFields['logSummary'] as RichText | undefined),
    });
    adapter.insert(batch, newItem, withFields);
    if (present(groupNote)) addGroupNote(batch, { id: newULID(state.now), itemId: id, projectId: projectId as ULID, memberId: state.actor, submissionId: state.submissionId, now: state.now, text: groupNote });
  } });
  state.publishScopes.push(`unit:${id}`);
  state.searchScopes.push(`root:${id}`);
}

/** Validate and plan one accepted Reply on its Parent, credited to the Submitter (R32.4). */
function planReply(selection: Extract<Selection, { unit: 'reply' }>, index: number, state: PlanState): void {
  const parent = resolveParent(selection.parent, index, state);
  const parsed = validate(replySchema, selection.text);
  if (!parsed.ok) { state.issues.push(...parsed.issues.map((issue) => ({ field: `items.${index}.text`, rule: issue.message }))); return; }
  if (!parent) return;
  const id = newULID(state.now);
  state.unitIds.push(id);
  const text = parsed.value as RichText;
  state.plans.push({ write(batch) {
    guardLiveParent(batch, parent);
    batch.insert(units, {
      id, unitType: 'reply', projectId: parent.projectId, rootId: parent.rootId, parentId: parent.id, position: 1,
      ownerId: state.actor, credit: [...state.credit], submissionId: state.submissionId, createdAt: state.now, classificationState: 'unclassified',
    }).insert(replies, { unitId: id, text: text.text, textSpans: [...text.spans], isGroupNote: false });
  } });
  state.publishScopes.push(`unit:${id}`);
  state.searchScopes.push(`unit:${id}`);
}

/** Validate and plan one accepted Attachment on its Parent, credited to the Submitter, Rights_Status Unknown (R32.4, R33.2). */
async function planAttachment(c: Context<ApiEnv>, selection: Extract<Selection, { unit: 'attachment' }>, index: number, state: PlanState): Promise<void> {
  const parent = resolveParent(selection.parent, index, state);
  const upload = await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT id, group_id AS groupId, state, owner_type AS ownerType, owner_id AS ownerId, r2_key AS r2Key, file_name AS fileName,
        size_bytes AS sizeBytes, sha256, mode, multipart_id AS multipartId, created_at AS createdAt, completed_at AS completedAt, attached_at AS attachedAt, hash_verified_at AS hashVerifiedAt
      FROM uploads WHERE id = ?1 AND owner_type = 'member' AND owner_id = ?2`,
  ).bind(selection.uploadId, state.actor).all<UploadRow>());
  const file = upload.results[0];
  if (file?.state === 'complete' && file.hashVerifiedAt === null) {
    state.issues.push({ field: `items.${index}.uploadId`, rule: 'The uploaded file is still being verified. Wait a moment and retry.' });
    return;
  }
  if (!file || file.state !== 'complete' || file.completedAt === null || file.attachedAt !== null) {
    state.issues.push({ field: `items.${index}.uploadId`, rule: 'The uploaded file is unavailable, incomplete, or already used.' });
    return;
  }
  let metadata: Record<string, unknown>;
  try {
    metadata = parse(attachmentMetadataSchema(state.context), { title: file.fileName, rightsStatusId: BUILT_IN_VALUE_IDS.rightsUnknown, ...selection.metadata }) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) { state.issues.push(...(error.extra.fields ?? []).map((issue) => ({ field: `items.${index}.metadata.${issue.field}`, rule: issue.rule }))); return; }
    throw error;
  }
  if (!parent) return;
  const id = newULID(state.now);
  state.unitIds.push(id);
  state.identifierIds.push(id);
  state.plans.push({ uploadId: file.id, write(batch, issued) {
    guardLiveParent(batch, parent);
    batch.insert(units, {
      id, unitType: 'attachment', projectId: parent.projectId, rootId: parent.rootId, parentId: parent.id,
      ownerId: state.actor, credit: [...state.credit], submissionId: state.submissionId, createdAt: state.now, classificationState: 'unclassified',
    });
    batch.insert(attachments, { unitId: id, itemIdentifier: issued.get(id)!, ...metadata,
      fileKind: fileKind(file.fileName), originalName: file.fileName, sizeBytes: file.sizeBytes, sha256: file.sha256,
      r2Key: file.r2Key, uploadedAt: file.completedAt!, chainId: id, supersedesUnitId: null } as never);
  } });
  state.publishScopes.push(`root:${parent.rootId}`);
  state.searchScopes.push(`root:${parent.rootId}`);
}

/** The Item_Date and Log_Date keys, from the kind's dated field or the creation day (R43.2). */
function dateKeys(kind: ItemKind, fields: Record<string, unknown>, createdAt: Timestamp) {
  const input = { ...KIND_ADAPTERS[kind].dates(fields), createdAt } as Parameters<typeof itemDate>[0];
  return {
    itemDateKey: dateSortKey(itemDate(input)), logDateKey: dateSortKey(logDate(input)),
    logDateIsCreation: kind === 'source' || Object.keys(input).length === 2,
  };
}

/**
 * Record a Moderation_Decision on an Outside_Submission (design "Moderation_Service and the public API", R32.4 to
 * R32.18, R41.2, R46.23, R46.33). The caller has authorized `moderation.decide`.
 *
 * Every decision first returns the exact email text; it is applied, and the email queued, only when the body confirms
 * that text (R32.10). The `decision_open` guard refuses a decision on an Outside_Submission that already has an Accepted
 * or Rejected one, including one another Administrator recorded a moment earlier, and the refusal shows that decision
 * (R32.16). Decision rows are append-only and record the Administrator, the time, the text, and any created Items
 * (R32.13). The email goes only to the address stored on that Outside_Submission (R32.11).
 *
 * Accept (Material, Correction, Comment) creates the selected Items as one Submission by the accepting Administrator,
 * all-or-nothing (R32.4, R32.5, R32.15). A Removal_Request needs a statement and records what it changed, creating no
 * Item (R32.12). More_Information_Requested sends the message with a Response_Link valid for 30 days (R32.6). Reject and
 * an accepted Removal_Request schedule the file deletion and email erasure (R32.8, R46.26).
 */
export async function decide(c: Context<ApiEnv>, id: string, body: unknown): Promise<DecisionResult> {
  await authorize(c, [{ permission: 'moderation.decide' }]);
  const input = parse(decideSchema, body);
  const { submission, final } = await loadSubmission(c, id);
  if (final) throw decidedConflict(final);
  checkDecisionType(submission.type, input);

  const actor = c.get('session').member.id;
  const now = c.get('now');
  const kind: DecisionKind = input.decision === 'removal_accepted' ? 'accepted' : input.decision === 'removal_rejected' ? 'rejected' : input.decision;
  const isAccepted = input.decision === 'accepted' || input.decision === 'removal_accepted';
  const isRejected = input.decision === 'rejected' || input.decision === 'removal_rejected';

  // The exact email text, assembled before anything is written and shown for confirmation (R32.10). A Response_Link URL
  // placeholder is shown in the preview for More_Information_Requested; the real token is minted only on apply.
  const text = 'statement' in input ? input.statement : input.text;
  const previewUrl = kind === 'more_information_requested' ? `${respondBase(c.env)}#<link>` : undefined;
  const previewEmail = emailContent(kind, submission, text, previewUrl);
  if (!input.confirm) return { reference: submission.reference, email: previewEmail };

  const credit: CreditEntry[] = [{ outside: { name: submission.name, ...(submission.affiliation ? { affiliation: submission.affiliation } : {}) } }];
  const submissionId = input.decision === 'accepted' ? newULID(now) : null;
  const decisionId = newULID(now);
  const emailId = newULID(now);

  // The acceptance's Items, validated and planned before the batch; a validation failure throws here, so no decision row
  // is written, the Outside_Submission is unchanged, and no email is queued (R32.15).
  const plan = input.decision === 'accepted' ? await planAcceptance(c, submission, input.items, credit, submissionId!) : null;

  // The Response_Link for More_Information_Requested: a fresh token, valid 30 days, stored only as its hash (R32.6, R32.14).
  const token = kind === 'more_information_requested' ? newResponseToken() : null;
  const tokenHash = token ? await sha256Hex(token) : null;
  const responseUrl = token ? `${respondBase(c.env)}#${token}` : undefined;
  // The email the Mailer composes and sends; for More_Information_Requested it carries the real Response_Link.
  const sentEmail = emailContent(kind, submission, text, responseUrl);

  try {
    await commitWithIdentifiers(c.env.RF_CORE, { id: actor, now }, plan?.identifierIds ?? [], (batch, issued) => {
      // The guard refuses a decision if a final one already exists, even one written a moment earlier (R32.16).
      batch.guard('decision_open', sql`NOT EXISTS (SELECT 1 FROM moderation_decisions WHERE outside_submission_id = ${submission.id} AND final = 1)`);

      if (plan && submissionId) {
        addSubmission(batch, { id: submissionId, memberId: actor, kind: 'member', now, complete: false });
        plan.write(batch, issued);
      }

      batch.insert(moderationDecisions, {
        id: decisionId, outsideSubmissionId: submission.id, kind, final: kind !== 'more_information_requested', adminId: actor, at: now,
        text, createdUnitIds: plan ? [...plan.unitIds] : null, changedRefs: 'changed' in input ? input.changed : null, submissionId,
      });

      // The Outside_Submission's state follows the decision (R32.13). A rejection and an accepted Removal_Request schedule
      // the email erasure 90 days on, read by the retention sweep (R32.8, R46.26); the file deletion is scheduled the same way.
      const state = kind === 'accepted' ? 'accepted' : kind === 'rejected' ? 'rejected' : 'more_information_requested';
      const schedulesErasure = isRejected || (isAccepted && submission.type === 'removal_request');
      const eraseAfter = schedulesErasure ? new Date(Date.parse(now) + RETENTION.finalDecisionFilesAndEmail.emailMinDays * DAY_MS).toISOString() : null;
      // Accepting an Outside_Submission other than a Removal_Request schedules the first Contact_Review of its
      // Submitter_Contact 12 months on, read by the Contact_Review sweep (R32.19). The accept path never schedules
      // erasure, so the two are mutually exclusive.
      const contactReviewDue = input.decision === 'accepted' ? contactReviewDueAt(now) : null;
      batch.update(outsideSubmissions, {
        state, ...(eraseAfter ? { emailEraseAfter: eraseAfter } : {}), ...(contactReviewDue ? { contactReviewDueAt: contactReviewDue } : {}),
      }, eq(outsideSubmissions.id, submission.id));

      // The acceptance's Submission is completed so its Items become visible as one Submission by the Administrator (R18.1, R32.5).
      if (submissionId) completeSubmission(batch, submissionId, now);

      if (tokenHash) {
        batch.insert(responseLinks, { tokenHash, outsideSubmissionId: submission.id, decisionId, createdAt: now,
          expiresAt: new Date(Date.parse(now) + RETENTION.responseLinks.validDays * DAY_MS).toISOString() });
      }

      // Queue the outcome email to the Submitter's address only, composed and sent by the Mailer (R32.9, R32.11). A
      // Submitter whose email has been erased gets no email; the decision row is still recorded.
      if (submission.email) {
        // The payload_ref names the decision the Mailer rebuilds the text from; for More_Information_Requested it also
        // carries the Response_Link URL, which reaches the Submitter only through this queued email (R32.14).
        const payloadRef = `${emailKind(kind)}:${decisionId}${responseUrl ? `:${responseUrl}` : ''}`;
        batch.insert(outgoingEmails, { id: emailId, kind: emailKind(kind), recipient: submission.email, outsideSubmissionId: submission.id,
          payloadRef, state: 'queued', createdAt: now, sendableAt: now });
        batch.outbox('mail', `email:${emailId}`);
      }
    }, { accountant: c.get('accountant') });
  } catch (error) {
    if (error instanceof GuardViolation && error.code === 'decision_open') {
      // Another Administrator recorded a final decision after this attempt began; show it (R32.16).
      const after = await loadSubmission(c, id);
      if (after.final) throw decidedConflict(after.final, error);
    }
    // An acceptance is one atomic save (R32.5, R32.15), so it is bounded by the save's statement budget. When the
    // selection would need more statements than one save allows, nothing is written (the budget is checked before any
    // statement runs); refuse with a clear message to accept fewer Items at once, rather than surface a 500 (R32.15).
    if (error instanceof BatchTooLarge) {
      throw new ApiError('validation', { fields: [{ field: 'items', rule: 'This acceptance creates too many Items to save at once; accept fewer Items in each acceptance.' }] }, { cause: error });
    }
    throw error;
  }

  return { reference: submission.reference, email: sentEmail, applied: { decisionId, kind, createdUnitIds: plan?.unitIds ?? [] } };
}

/** The decision the Submission_Type allows: a Removal_Request is accepted, rejected, or asked for more; the others follow the Material/Correction/Comment path. */
function checkDecisionType(type: OutsideSubmissionType, input: DecideInput): void {
  const removal = input.decision === 'removal_accepted' || input.decision === 'removal_rejected';
  if (type === 'removal_request' && (input.decision === 'accepted' || input.decision === 'rejected')) {
    throw new ApiError('validation', { fields: [{ field: 'decision', rule: 'A Removal Request is accepted or rejected with a statement.' }] });
  }
  if (type !== 'removal_request' && removal) {
    throw new ApiError('validation', { fields: [{ field: 'decision', rule: 'Only a Removal Request takes a removal decision.' }] });
  }
}
