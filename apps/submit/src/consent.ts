import { CONSENT_REQUEST_LIMITS, PUBLICATION_ANSWER_CHOICES, RIGHTS_ANSWER_CHOICES } from '@researchforce/domain/consent-requests';
import type { ConsentAnswerChoice, ConsentRequestKind } from '@researchforce/domain/consent-requests';
import type { FileKind } from '@researchforce/domain/file-kinds';
import { newULID } from '@researchforce/domain/identifiers';
import { cpLength } from '@researchforce/domain/text';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import { GuardViolation } from '@researchforce/db/batch';
import {
  buildConsentAnswerBatch,
  buildConsentWithdrawalBatch,
  choiceSuitsKind,
} from '@researchforce/db/consent/answer';
import type { AnswerItem, ConsentActionPlan, SubmittedChoice } from '@researchforce/db/consent/answer';
import type { Env } from './index';
import { verifyTurnstile } from './sessions';

/**
 * The public Consent_Page and Change_Link endpoints for `rf-submit` (task 56.3, design "Answering", R51.5 to
 * R51.8, R51.10, R51.12, R51.14).
 *
 * A Consent_Link lets the people in a Correspondence, or the holders of rights in a document, answer a
 * Consent_Request with one click and no account. The 128-bit token reaches the person only through the request
 * email and travels in the URL fragment, so it never appears in a server request path, query, or Referer; this
 * Worker only ever stores and compares its SHA-256 hash (R51.4). The flow mirrors the Response_Link flow:
 *
 *   - `POST /v1/consent/view` returns the stored Consent_Page snapshots and the answer options for an open,
 *     unexpired, unanswered request, and otherwise the one fixed "no longer valid" response. Viewing writes
 *     nothing, because mail scanners open links (R51.5, R51.12).
 *   - `POST /v1/consent/answer` needs a Turnstile token (the Bot_Check) and, for a usable Consent_Link, records
 *     a Consent_Answer through the shared batch builder (R51.6 to R51.8).
 *   - `POST /v1/consent/change/view` and `POST /v1/consent/change` are the same for the Change_Link: the view
 *     shows what was answered, and the submit records a withdrawal, both guarded as single use (R51.10, R51.12).
 *
 * Every unusable Consent_Link or Change_Link — unknown, expired, cancelled, already answered, or a Change_Link
 * already fully withdrawn — gets the one fixed refusal, revealing nothing about the Consent_Request (R51.12).
 * The Budget gate and the `noindex`/no-cache headers are applied by the router (R51.14).
 */

/** A Consent_Link and Change_Link token is 128 bits in Crockford base32 (26 characters), as the sender mints it. */
const TOKEN_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/** The Crockford base32 alphabet, used to mint the Change_Link token a Consent_Answer attaches (R51.8). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A refusal the person sees, naming only that the link is no longer valid; never any stored content (R51.12). */
export interface ConsentRefusal {
  readonly error: string;
  readonly message: string;
}
function refuse(error: string, message: string): ConsentRefusal {
  return { error, message };
}
/** The one fixed "no longer valid" refusal every unusable link gets, revealing nothing about the request (R51.12). */
const FIXED_REFUSAL = refuse('invalid_link', 'This link is no longer valid.');

/** SHA-256 hex of a token; only the hash is ever stored or compared (R51.4). */
async function sha256Hex(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Mint a fresh 128-bit Change_Link token in Crockford base32, which travels only in the confirmation email (R51.8). */
function newChangeToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += CROCKFORD[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out;
}

/** The base of the Change_Link URL, from the Consent_Page's own origin, so the token stays in the fragment and on the same host. */
function changeBase(origin: string): string {
  try {
    return `${new URL(origin).origin}/consent/change`;
  } catch {
    return 'https://submit.researchforce.org/consent/change';
  }
}

/** The request as a usable-view and the answer need it: its facts plus the Contact_Email the confirmation goes to. */
interface RequestRow {
  readonly id: ULID;
  readonly kind: ConsentRequestKind;
  readonly requestedBy: ULID;
  readonly partyId: ULID;
  readonly contactEmail: string;
  readonly state: string;
  readonly expiresAt: string;
  readonly changeExpiresAt: string | null;
}

/** One named element loaded for the view and the batch: the stored snapshot and the columns the downgrade needs. */
interface ItemRow {
  readonly id: ULID;
  readonly unitId: ULID;
  readonly rootId: ULID;
  readonly position: number;
  readonly unitType: string;
  readonly itemKind: string | null;
  readonly disclosureLevel: string;
  readonly snapshot: string;
  readonly snapshotHash: string;
  readonly answerId: string | null;
  readonly fileKind: string | null;
  readonly uploadedAt: string | null;
  readonly corrDate: string | null;
  readonly corrDateApprox: number | null;
  readonly partyIds: string | null;
}

/** Load a Consent_Request by its Consent_Link token hash, with the Contact_Email and state a usable check needs. */
async function loadByToken(env: Env, tokenHash: string): Promise<RequestRow | null> {
  return env.RF_CORE
    .prepare(`SELECT id, kind, requested_by AS requestedBy, party_id AS partyId, contact_email AS contactEmail, state, expires_at AS expiresAt, change_expires_at AS changeExpiresAt
       FROM consent_requests WHERE token_hash = ?1`)
    .bind(tokenHash)
    .first<RequestRow>();
}

/** Load a Consent_Request by its Change_Link token hash (R51.10). */
async function loadByChangeToken(env: Env, changeTokenHash: string): Promise<RequestRow | null> {
  return env.RF_CORE
    .prepare(`SELECT id, kind, requested_by AS requestedBy, party_id AS partyId, contact_email AS contactEmail, state, expires_at AS expiresAt, change_expires_at AS changeExpiresAt
       FROM consent_requests WHERE change_token_hash = ?1`)
    .bind(changeTokenHash)
    .first<RequestRow>();
}

/** Load the named items of a request, in request order, with the snapshot and the downgrade columns. */
async function loadItems(env: Env, requestId: string): Promise<ItemRow[]> {
  const rows = await env.RF_CORE
    .prepare(`SELECT i.id, i.unit_id AS unitId, i.root_id AS rootId, i.position, u.unit_type AS unitType, ri.kind AS itemKind,
          u.disclosure_level AS disclosureLevel, i.snapshot_json AS snapshot, i.snapshot_hash AS snapshotHash, i.answer_id AS answerId,
          at.file_kind AS fileKind, at.uploaded_at AS uploadedAt, co.date AS corrDate, co.date_approx AS corrDateApprox,
          (SELECT json_group_array(cp.party_id) FROM correspondence_parties cp WHERE cp.unit_id = i.unit_id ORDER BY cp.position) AS partyIds
        FROM consent_request_items i
        JOIN units u ON u.id = i.unit_id
        LEFT JOIN research_items ri ON ri.unit_id = i.unit_id
        LEFT JOIN attachments at ON at.unit_id = i.unit_id
        LEFT JOIN correspondences co ON co.unit_id = i.unit_id
       WHERE i.request_id = ?1 ORDER BY i.position`)
    .bind(requestId)
    .all<ItemRow>();
  return rows.results;
}

/** The element kind the batch keys status and downgrade off, from the stored unit type and item kind. */
function elementOf(row: ItemRow): AnswerItem['element'] | null {
  if (row.unitType === 'attachment') return 'attachment';
  if (row.unitType === 'research_item' && row.itemKind === 'correspondence') return 'correspondence';
  if (row.unitType === 'research_item' && row.itemKind === 'source') return 'source';
  return null;
}

/** An item row resolved to the {@link AnswerItem} the shared builder needs. */
function answerItemOf(row: ItemRow): AnswerItem | null {
  const element = elementOf(row);
  if (element === null) return null;
  const base: AnswerItem = {
    itemId: row.id, unitId: row.unitId, rootId: row.rootId, element, disclosureLevel: row.disclosureLevel,
    seenSnapshot: JSON.parse(row.snapshot) as unknown, seenSnapshotHash: row.snapshotHash,
  };
  if (element === 'attachment' && row.fileKind !== null && row.uploadedAt !== null) {
    return { ...base, fileKind: row.fileKind as FileKind, uploadedAt: row.uploadedAt };
  }
  if (element === 'correspondence' && row.corrDate !== null) {
    return { ...base, date: { value: row.corrDate, approx: row.corrDateApprox === 1 }, partyIds: JSON.parse(row.partyIds ?? '[]') as string[] };
  }
  return base;
}

/** The answer options offered for one element, from its kind alone (R51.6). */
function optionsFor(kind: ConsentRequestKind): readonly string[] {
  return kind === 'publication' ? PUBLICATION_ANSWER_CHOICES : RIGHTS_ANSWER_CHOICES;
}

/** One named element the Consent_Page shows: its item id (so the page can build an answer per element) and its stored snapshot (R51.5, R51.6). */
export interface ConsentViewItem {
  readonly itemId: string;
  readonly snapshot: unknown;
}

/**
 * What `/v1/consent/view` returns for a usable Consent_Link: the answer options and one entry per named
 * element, in request order, carrying its item id and its stored snapshot (R51.5, R51.6). The item id is not
 * confidential — it only lets the Consent_Page post a choice for each element — and `snapshots` is kept as the
 * ordered snapshots alone so existing callers (the email preview, Property 5) are unchanged.
 */
export interface ConsentView {
  readonly kind: ConsentRequestKind;
  readonly options: readonly string[];
  readonly items: readonly ConsentViewItem[];
  readonly snapshots: readonly unknown[];
}

/** Whether a Consent_Link is usable: an open, unexpired, unanswered request; otherwise the fixed refusal (R51.12). */
function answerRefusal(request: RequestRow | null, now: number): ConsentRefusal | null {
  if (request === null) return FIXED_REFUSAL;
  if (request.state !== 'sent') return FIXED_REFUSAL; // answered, cancelled, or expired
  if (Date.parse(request.expiresAt) <= now) return FIXED_REFUSAL;
  return null;
}

/** Whether a Change_Link is usable: an answered request whose Change_Link has not expired past 12 months (R51.10, R51.12). */
function changeRefusal(request: RequestRow | null, now: number): ConsentRefusal | null {
  if (request === null) return FIXED_REFUSAL;
  if (request.state !== 'answered') return FIXED_REFUSAL;
  if (request.changeExpiresAt === null || Date.parse(request.changeExpiresAt) <= now) return FIXED_REFUSAL;
  return null;
}

/**
 * `POST /v1/consent/view`. Return the stored Consent_Page snapshots and the answer options for a usable
 * Consent_Link, or the one fixed "no longer valid" refusal otherwise (R51.5, R51.12). Writes nothing.
 */
export async function viewConsent(env: Env, token: string, now: number = Date.now()): Promise<ConsentView | ConsentRefusal> {
  if (!TOKEN_PATTERN.test(token)) return FIXED_REFUSAL;
  const request = await loadByToken(env, await sha256Hex(token));
  const refusal = answerRefusal(request, now);
  if (refusal !== null) return refusal;
  const items = await loadItems(env, request!.id);
  return viewOf(request!.kind, items);
}

/**
 * `POST /v1/consent/change/view`. Return the stored snapshots and the answer options for a usable Change_Link,
 * or the one fixed refusal otherwise (R51.10, R51.12). Writes nothing.
 */
export async function viewChange(env: Env, token: string, now: number = Date.now()): Promise<ConsentView | ConsentRefusal> {
  if (!TOKEN_PATTERN.test(token)) return FIXED_REFUSAL;
  const request = await loadByChangeToken(env, await sha256Hex(token));
  const refusal = changeRefusal(request, now);
  if (refusal !== null) return refusal;
  const items = await loadItems(env, request!.id);
  return viewOf(request!.kind, items);
}

/** Build the {@link ConsentView} from the loaded item rows: the options, each element's id and snapshot, and the snapshots alone. */
function viewOf(kind: ConsentRequestKind, items: readonly ItemRow[]): ConsentView {
  const parsed = items.map((item) => ({ itemId: item.id as string, snapshot: JSON.parse(item.snapshot) as unknown }));
  return { kind, options: optionsFor(kind), items: parsed, snapshots: parsed.map((entry) => entry.snapshot) };
}

/** The confirmation of a recorded answer or withdrawal: only the time, and nothing about the request (R51.8, R51.12). */
export interface ConsentConfirmation {
  readonly recordedAt: string;
}

/** What the answer body carries: the token (from the fragment), one choice per item, and an optional comment and Generic_Label. */
interface AnswerBody {
  readonly token: string;
  readonly turnstileToken: string;
  readonly answers: readonly { readonly itemId: string; readonly choice: string }[];
  readonly comment: string | null;
  readonly genericLabel: string | null;
}

/** Validate the submit body shape, returning the usable parts or a refusal naming the first problem. */
function readAnswerBody(body: Record<string, unknown> | null): AnswerBody | ConsentRefusal {
  const token = typeof body?.['token'] === 'string' ? (body['token'] as string) : '';
  if (!TOKEN_PATTERN.test(token)) return FIXED_REFUSAL;
  const turnstileToken = typeof body?.['turnstileToken'] === 'string' ? (body['turnstileToken'] as string) : '';
  const rawAnswers = Array.isArray(body?.['answers']) ? (body!['answers'] as unknown[]) : [];
  const answers: { itemId: string; choice: string }[] = [];
  for (const entry of rawAnswers) {
    if (entry === null || typeof entry !== 'object') return refuse('invalid', 'Answer every element before submitting.');
    const itemId = (entry as { itemId?: unknown }).itemId;
    const choice = (entry as { choice?: unknown }).choice;
    if (typeof itemId !== 'string' || typeof choice !== 'string') return refuse('invalid', 'Answer every element before submitting.');
    answers.push({ itemId, choice });
  }
  const comment = typeof body?.['comment'] === 'string' ? (body['comment'] as string) : null;
  if (comment !== null && cpLength(comment) > CONSENT_REQUEST_LIMITS.commentCodePoints) {
    return refuse('invalid', `A comment may be at most ${CONSENT_REQUEST_LIMITS.commentCodePoints} characters.`);
  }
  const genericLabel = typeof body?.['genericLabel'] === 'string' ? (body['genericLabel'] as string) : null;
  if (genericLabel !== null && (cpLength(genericLabel) < 1 || cpLength(genericLabel) > CONSENT_REQUEST_LIMITS.genericLabelCodePoints)) {
    return refuse('invalid', `A label may be 1 to ${CONSENT_REQUEST_LIMITS.genericLabelCodePoints} characters.`);
  }
  return { token, turnstileToken, answers, comment: comment === null || comment.trim() === '' ? null : comment, genericLabel };
}

/**
 * `POST /v1/consent/answer`. Record a Consent_Answer after the Bot_Check (R51.6 to R51.8). The body carries the
 * Consent_Link token (re-validated here so a link cancelled, expired, or answered between the view and the
 * submit is refused), a choice for every named element, and the optional comment and Generic_Label. On success,
 * the shared builder records the answers, the Consent_Status, Do_Not_Name, and Rights_Status changes, the
 * R33.5/R34.3 downgrades, the Revisions and Item_Update events, the `publish` rows, and the confirmation email
 * with a Change_Link valid for 12 months, all in one D1 batch guarded as single use.
 */
export async function answerConsent(env: Env, origin: string, body: Record<string, unknown> | null, now: number = Date.now()): Promise<ConsentConfirmation | ConsentRefusal> {
  const parsed = readAnswerBody(body);
  if ('error' in parsed) return parsed;

  const ok = await verifyTurnstile(env, parsed.turnstileToken, null);
  if (!ok) return refuse('bot_check', 'Complete the verification to continue.');

  const request = await loadByToken(env, await sha256Hex(parsed.token));
  const refusal = answerRefusal(request, now);
  if (refusal !== null) return refusal;

  const items = await loadItems(env, request!.id);
  // Every named element must be answered exactly once, and each choice must suit its kind (R51.6).
  const byId = new Map<string, ItemRow>(items.map((item) => [item.id, item]));
  const answered = new Set<string>();
  const choices: SubmittedChoice[] = [];
  for (const answer of parsed.answers) {
    const row = byId.get(answer.itemId);
    if (row === undefined || answered.has(answer.itemId)) return refuse('invalid', 'Answer every element exactly once.');
    const choice = answer.choice as ConsentAnswerChoice;
    if (!choiceSuitsKind(request!.kind, choice)) return refuse('invalid', 'That answer is not valid for this element.');
    answered.add(answer.itemId);
    choices.push({ itemId: answer.itemId as ULID, choice });
  }
  if (answered.size !== items.length) return refuse('invalid', 'Answer every element before submitting.');

  const answerItems: AnswerItem[] = [];
  for (const row of items) {
    const item = answerItemOf(row);
    if (item === null) return FIXED_REFUSAL; // a named element lost its unit; treat as no longer valid
    answerItems.push(item);
  }

  const changeToken = newChangeToken();
  const plan: ConsentActionPlan = {
    requestId: request!.id, kind: request!.kind, requestedBy: request!.requestedBy, partyId: request!.partyId,
    comment: parsed.comment, items: answerItems, contactEmail: request!.contactEmail, emailId: newULID(new Date(now).toISOString() as Timestamp),
    changeTokenHash: await sha256Hex(changeToken), changeUrl: `${changeBase(origin)}#${changeToken}`,
  };

  const recordedAt = new Date(now).toISOString();
  try {
    await buildConsentAnswerBatch(env.RF_CORE, plan, choices, parsed.genericLabel, recordedAt as Timestamp).commit();
  } catch (error) {
    // The single-use guard aborts a second answer or an answer that raced a cancel/expire; it reads as no longer valid.
    if (error instanceof GuardViolation) return FIXED_REFUSAL;
    throw error;
  }
  return { recordedAt };
}

/** What the change (withdrawal) body carries: the Change_Link token, the Turnstile token, and an optional comment. */
interface ChangeBody {
  readonly token: string;
  readonly turnstileToken: string;
  readonly comment: string | null;
}

function readChangeBody(body: Record<string, unknown> | null): ChangeBody | ConsentRefusal {
  const token = typeof body?.['token'] === 'string' ? (body['token'] as string) : '';
  if (!TOKEN_PATTERN.test(token)) return FIXED_REFUSAL;
  const turnstileToken = typeof body?.['turnstileToken'] === 'string' ? (body['turnstileToken'] as string) : '';
  const comment = typeof body?.['comment'] === 'string' ? (body['comment'] as string) : null;
  if (comment !== null && cpLength(comment) > CONSENT_REQUEST_LIMITS.commentCodePoints) {
    return refuse('invalid', `A comment may be at most ${CONSENT_REQUEST_LIMITS.commentCodePoints} characters.`);
  }
  return { token, turnstileToken, comment: comment === null || comment.trim() === '' ? null : comment };
}

/**
 * `POST /v1/consent/change`. Record a withdrawal through the Change_Link after the Bot_Check (R51.10). It sets
 * every withdrawn consent to Refused and every withdrawn permission to Restricted, applies the same R33.5/R34.3
 * downgrades and Item_Update events as a refusal, leaves the Party's Do_Not_Name flag on, and queues the same
 * confirmation email, all in one D1 batch guarded as single use (R51.10, R51.12).
 */
export async function changeConsent(env: Env, origin: string, body: Record<string, unknown> | null, now: number = Date.now()): Promise<ConsentConfirmation | ConsentRefusal> {
  const parsed = readChangeBody(body);
  if ('error' in parsed) return parsed;

  const ok = await verifyTurnstile(env, parsed.turnstileToken, null);
  if (!ok) return refuse('bot_check', 'Complete the verification to continue.');

  const request = await loadByChangeToken(env, await sha256Hex(parsed.token));
  const refusal = changeRefusal(request, now);
  if (refusal !== null) return refusal;

  const items = await loadItems(env, request!.id);
  const answerItems: AnswerItem[] = [];
  for (const row of items) {
    // Only the items that were answered can be withdrawn; an item with no answer is skipped (R51.10).
    if (row.answerId === null) continue;
    const item = answerItemOf(row);
    if (item === null) return FIXED_REFUSAL;
    answerItems.push(item);
  }
  if (answerItems.length === 0) return FIXED_REFUSAL;

  // A withdrawal reuses the same Change_Link, so the confirmation carries it again.
  const plan: ConsentActionPlan = {
    requestId: request!.id, kind: request!.kind, requestedBy: request!.requestedBy, partyId: request!.partyId,
    comment: parsed.comment, items: answerItems, contactEmail: request!.contactEmail, emailId: newULID(new Date(now).toISOString() as Timestamp),
    changeTokenHash: await sha256Hex(parsed.token), changeUrl: `${changeBase(origin)}#${parsed.token}`,
  };

  const recordedAt = new Date(now).toISOString();
  try {
    await buildConsentWithdrawalBatch(env.RF_CORE, plan, recordedAt as Timestamp).commit();
  } catch (error) {
    if (error instanceof GuardViolation) return FIXED_REFUSAL;
    throw error;
  }
  return { recordedAt };
}
