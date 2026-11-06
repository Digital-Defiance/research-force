import { sql } from 'drizzle-orm';
import { FILE_KIND_LABELS } from '@researchforce/domain/file-kinds';
import type { FileKind } from '@researchforce/domain/file-kinds';
import { newULID } from '@researchforce/domain/identifiers';
import { CONSENT_REQUEST_LIMITS, PUBLICATION_ANSWER_CHOICES, RIGHTS_ANSWER_CHOICES } from '@researchforce/domain/consent-requests';
import type { ConsentAnswerChoice, ConsentRequestKind } from '@researchforce/domain/consent-requests';
import type { DisclosureLine, Timestamp, ULID } from '@researchforce/domain/types';
import { CHANGE_SEQ, GuardedBatch } from '../batch';
import { consentAnswers, consentRequestItems, consentRequests, consentWithdrawals, outgoingEmails, units } from '../schema/core';

/**
 * The shared batch builder for answering a Consent_Request through its Consent_Link and for withdrawing through
 * the Change_Link (R51.6 to R51.8, R51.10, R51.12). Both the `rf-submit` answer endpoint and its change endpoint
 * (task 56.3) build their one atomic D1 batch here, so the two paths apply the same single-use guard, write the
 * same append-only rows, and make the same Consent_Status, Do_Not_Name, Rights_Status, downgrade, Revision,
 * Item_Update, publish, and confirmation-email effects. It is the consent analogue of `events/outside.ts`: the
 * public Worker loads the request and its items, validates the submitted choices against the stored snapshots,
 * and hands a resolved plan here; this module owns every write.
 *
 * The seeded Rights_Status identities a Consent_Answer sets (R51.7). These ids are stable across an
 * Administrator renaming the value, so "yes" and "no" always resolve to the same two values. A `granted` answer
 * sets Permission_Granted; a `refused` answer (or a withdrawal) sets Restricted.
 */
export const RIGHTS_PERMISSION_GRANTED_ID = '0000000000000000000000P004' as ULID;
export const RIGHTS_RESTRICTED_ID = '0000000000000000000000P005' as ULID;

const DEFAULT_EMAIL_MODE = 'immediate';
/** The Generic_Label used for a "do not name me" answer that gives none and the Party has none (R51.7). */
const DEFAULT_GENERIC_LABEL = 'a correspondent';
const MAX_LINE_PARTIES = 20;
/** Roughly 12 months, counted as days so the Change_Link's expiry is one deterministic stamp (R51.8, R51.10). */
const MONTH_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The confirmation email's `payload_ref`: `consent_confirmation:{requestId}:{action}:{changeUrl}`, the only place the Change_Link lives as plaintext (R51.8). */
export function confirmationPayloadRef(requestId: string, action: 'answer' | 'withdrawal', changeUrl: string): string {
  return `consent_confirmation:${requestId}:${action}:${changeUrl}`;
}

/** Whether a submitted choice is valid for the kind of a named element: publication choices for a Correspondence, rights choices for a Source or Attachment (R51.6). */
export function choiceSuitsKind(kind: ConsentRequestKind, choice: ConsentAnswerChoice): boolean {
  return kind === 'publication'
    ? (PUBLICATION_ANSWER_CHOICES as readonly string[]).includes(choice)
    : (RIGHTS_ANSWER_CHOICES as readonly string[]).includes(choice);
}

/** One named element of the request, resolved to everything the batch needs to answer or withdraw it. */
export interface AnswerItem {
  /** The `consent_request_items` row this answer is for. */
  readonly itemId: ULID;
  readonly unitId: ULID;
  readonly rootId: ULID;
  /** The unit kind, for the status change and the downgrade: a Correspondence, a Source, or an Attachment. */
  readonly element: 'correspondence' | 'source' | 'attachment';
  /** The current Disclosure_Level of the unit, so a Public unit losing its consent or permission is downgraded (R51.8). */
  readonly disclosureLevel: string;
  /** The stored Consent_Page snapshot for this element, copied onto the append-only row as the evidence of what was seen (R51.7). */
  readonly seenSnapshot: unknown;
  /** SHA-256 of the stored snapshot (R51.7). */
  readonly seenSnapshotHash: string;
  /** The Attachment's file kind and upload date, for the R33.5 downgrade Disclosure_Line (Attachments only). */
  readonly fileKind?: FileKind;
  readonly uploadedAt?: string;
  /** The Correspondence's date and ordered Party ids, for the R34.3 downgrade Disclosure_Line (Correspondences only). */
  readonly date?: DisclosureLine['date'];
  readonly partyIds?: readonly string[];
}

/** One submitted choice, matched to its item by `itemId`; a withdrawal carries no choice. */
export interface SubmittedChoice {
  readonly itemId: ULID;
  readonly choice: ConsentAnswerChoice;
}

/** The facts common to an answer and a withdrawal: the request, the Party, the comment, and the Change_Link to confirm. */
export interface ConsentActionPlan {
  readonly requestId: ULID;
  readonly kind: ConsentRequestKind;
  /** The requesting Administrator, to whom every Revision and Notification_Event is attributed (R51.7). */
  readonly requestedBy: ULID;
  /** The External_Party the request was sent to; its Do_Not_Name flag and Generic_Label are set here (R51.7). */
  readonly partyId: ULID;
  /** The optional comment of at most 2,000 characters, shared by every row of the submission (R51.6). */
  readonly comment: string | null;
  readonly items: readonly AnswerItem[];
  /** The confirmation email's recipient (the Contact_Email the request was sent to) and queued row id. */
  readonly contactEmail: string;
  readonly emailId: ULID;
  /** The Change_Link's token hash and the plaintext URL that travels only in the confirmation email (R51.8). */
  readonly changeTokenHash: string;
  readonly changeUrl: string;
}

/** The `publish` outbox scopes for the affected units, so the Publisher re-projects each changed Public_View (R51.7, R51.8). */
const publishScopes = (items: readonly AnswerItem[]): string[] => items.map((item) => `unit:${item.unitId}`);

/** The Withheld Disclosure_Line a downgrade writes for one element, from its stored columns (R33.5, R34.3). */
function downgradeLine(item: AnswerItem): DisclosureLine | null {
  if (item.element === 'attachment' && item.fileKind !== undefined && item.uploadedAt !== undefined) {
    return { kindOfMaterial: FILE_KIND_LABELS[item.fileKind], date: { value: item.uploadedAt.split('T')[0]!, approx: false }, partyIds: [] };
  }
  if (item.element === 'correspondence' && item.date !== undefined) {
    return { kindOfMaterial: 'correspondence', date: item.date, partyIds: (item.partyIds ?? []).slice(0, MAX_LINE_PARTIES) as ULID[] };
  }
  return null;
}

/**
 * Whether answering `choice` removes the consent or permission a Public unit relies on, so R33.5/R34.3 downgrade
 * it. Only a refusal does: a `named` or `unnamed` yes keeps the Correspondence published (just unnamed), and a
 * rights `granted` keeps the file published. A withdrawal always downgrades and does not pass through here.
 */
function losesPublication(choice: ConsentAnswerChoice): boolean {
  return choice === 'refused';
}

/**
 * Build the Item_Update Notification_Event INSERT for one answered or withdrawn request: one event for the
 * requesting Administrator and one for the Owner of each affected Research_Item, deduplicated so an
 * Administrator who also owns an Item gets one (R51.7). Only active Members receive events. The events are
 * attributed to the requesting Administrator (the save's actor), carry the request id in their detail, and copy
 * each recipient's current email mode, exactly as the app's Item_Update fan-out does.
 */
function itemUpdateEvents(batch: GuardedBatch, plan: ConsentActionPlan, now: Timestamp): void {
  const timePart = newULID(now).slice(0, 10);
  const roots = JSON.stringify([...new Set(plan.items.map((item) => item.rootId))]);
  // The recipient union: the requesting Administrator, and the Owner of each affected Root_Item.
  batch.run(sql`INSERT INTO notification_events (id, member_id, event_type, at, actor_id, root_id, detail, email_mode)
    SELECT ${timePart} || upper(hex(randomblob(8))), m.id, 'item_update', ${now}, ${plan.requestedBy},
      (SELECT root_id FROM units WHERE owner_id = m.id AND root_id IN (SELECT value FROM json_each(${roots})) LIMIT 1),
      ${JSON.stringify({ change: 'consent', requestId: plan.requestId })},
      COALESCE((SELECT np.email FROM notification_prefs np WHERE np.member_id = m.id AND np.event_type = 'item_update'), ${DEFAULT_EMAIL_MODE})
    FROM members m
    WHERE m.status = 'active' AND (
      m.id = ${plan.requestedBy}
      OR m.id IN (SELECT owner_id FROM units WHERE root_id IN (SELECT value FROM json_each(${roots})))
    )`);
}

/** The single-use guard: the request is open (Sent), not yet answered, when an answer commits (R51.6, R51.12). */
function guardAnswerOpen(batch: GuardedBatch, requestId: string): void {
  batch.guard('consent_link_open', sql`EXISTS (SELECT 1 FROM consent_requests WHERE id = ${requestId} AND state = 'sent' AND answered_at IS NULL)`);
}

/** The single-use guard for a withdrawal: the request is answered and at least one of its items still had an answer but no earlier withdrawal (R51.10, R51.12). */
function guardChangeOpen(batch: GuardedBatch, requestId: string, items: readonly AnswerItem[], now: Timestamp): void {
  const withdrawnItems = JSON.stringify(items.map((item) => item.itemId));
  // The Change_Link is spent once every element it names has been withdrawn (R51.12). This batch has just
  // written this submission's withdrawal rows, all stamped `now`; the guard refuses if, excluding those rows,
  // every answered item named here already had a withdrawal — that is, this submission added nothing new.
  batch.guard('consent_link_open', sql`EXISTS (
    SELECT 1 FROM consent_requests WHERE id = ${requestId} AND state = 'answered'
  ) AND EXISTS (
    SELECT 1 FROM consent_request_items i
    WHERE i.request_id = ${requestId} AND i.id IN (SELECT value FROM json_each(${withdrawnItems})) AND i.answer_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM consent_withdrawals w WHERE w.item_id = i.id AND w.withdrawn_at <> ${now})
  )`);
}

/** Set the Consent_Status for the Party on one answered Correspondence (R51.7). */
function setConsentStatus(batch: GuardedBatch, item: AnswerItem, plan: ConsentActionPlan, status: 'granted' | 'refused'): void {
  batch.run(sql`UPDATE correspondence_parties SET consent_status = ${status}
    WHERE unit_id = ${item.unitId} AND party_kind = 'external' AND party_id = ${plan.partyId}`);
}

/** Set the Rights_Status (and fill an empty rights holder with the Party's name on a grant) for one answered Source or Attachment (R51.7). */
function setRightsStatus(batch: GuardedBatch, item: AnswerItem, plan: ConsentActionPlan, granted: boolean): void {
  const table = item.element === 'attachment' ? 'attachments' : 'sources';
  const rightsId = granted ? RIGHTS_PERMISSION_GRANTED_ID : RIGHTS_RESTRICTED_ID;
  if (granted) {
    batch.run(sql`UPDATE ${sql.identifier(table)}
      SET rights_status_id = ${rightsId},
          rights_holder = COALESCE(NULLIF(rights_holder, ''), (SELECT name FROM external_parties WHERE id = ${plan.partyId}))
      WHERE unit_id = ${item.unitId}`);
  } else {
    batch.run(sql`UPDATE ${sql.identifier(table)} SET rights_status_id = ${rightsId} WHERE unit_id = ${item.unitId}`);
  }
}

/** Downgrade one Public element to Withheld with its pre-filled Disclosure_Line, recording a Disclosure_Change Revision attributed to the Administrator (R33.5, R34.3). */
function downgrade(batch: GuardedBatch, item: AnswerItem): boolean {
  if (item.disclosureLevel !== 'public') return false;
  const line = downgradeLine(item);
  if (line === null) return false;
  batch.update(units, { disclosureLevel: 'withheld', disclosureLine: line }, sql`id = ${item.unitId}`);
  batch.revision({ targetType: 'unit', targetId: item.unitId, rootId: item.rootId, kind: 'disclosure_change', reason: 'Consent_Answer: consent or permission was refused.', prev: { disclosureLevel: 'public' } });
  return true;
}

/**
 * Record a Consent_Answer (R51.6 to R51.8). In one batch, after the single-use `consent_link_open` guard: the
 * append-only `consent_answers` rows (one per answered item), each with its choice, the comment, the stored
 * seen snapshot and its hash, and the resulting status; the Consent_Status for each answered Correspondence
 * (Granted for named/unnamed, Refused for refused) and, for `unnamed`, the Party's Do_Not_Name flag on with the
 * given Generic_Label (or the kept one, or "a correspondent"); the Rights_Status for each answered Source or
 * Attachment (Permission_Granted for granted, Restricted for refused), filling an empty rights holder with the
 * Party's name on a grant; the R33.5/R34.3 downgrades of any Public element that loses its consent or
 * permission, each with a Disclosure_Change Revision attributed to the requesting Administrator; the request
 * marked Answered with its Change_Link token hash and a 12-month expiry; each item linked to its answer row;
 * one Item_Update event for the Administrator and each Owner; a `publish` row per affected unit; and the
 * confirmation email carrying the Change_Link.
 */
export function buildConsentAnswerBatch(
  db: D1Database,
  plan: ConsentActionPlan,
  choices: readonly SubmittedChoice[],
  genericLabel: string | null,
  now: Timestamp,
): GuardedBatch {
  const batch = new GuardedBatch(db, { id: plan.requestedBy, now });
  guardAnswerOpen(batch, plan.requestId);

  const choiceByItem = new Map(choices.map((choice) => [choice.itemId, choice.choice]));
  const changeExpiresAt = new Date(Date.parse(now) + CONSENT_REQUEST_LIMITS.changeLinkMonths * MONTH_DAYS * DAY_MS).toISOString() as Timestamp;
  let anyDowngrade = false;
  let setsDoNotName = false;

  for (const item of plan.items) {
    const choice = choiceByItem.get(item.itemId)!;
    const answerId = newULID(now);
    let resultStatus: string | null = null;

    if (item.element === 'correspondence') {
      const status = choice === 'refused' ? 'refused' : 'granted';
      resultStatus = status;
      setConsentStatus(batch, item, plan, status);
      if (choice === 'unnamed') setsDoNotName = true;
    } else {
      const granted = choice === 'granted';
      resultStatus = granted ? 'granted' : 'refused';
      setRightsStatus(batch, item, plan, granted);
    }

    // The append-only Consent_Answer row: the choice, the Generic_Label only for `unnamed`, the shared comment,
    // the stored seen snapshot and its hash, the resulting status, and the submission time (R51.7).
    batch.insert(consentAnswers, {
      id: answerId, requestId: plan.requestId, itemId: item.itemId, unitId: item.unitId, rootId: item.rootId,
      choice, genericLabel: choice === 'unnamed' ? (genericLabel ?? null) : null, comment: plan.comment,
      resultStatus, seenSnapshot: item.seenSnapshot as Record<string, unknown>, seenSnapshotHash: item.seenSnapshotHash, answeredAt: now,
    });
    batch.update(consentRequestItems, { answerId }, sql`id = ${item.itemId}`);

    if (losesPublication(choice) && downgrade(batch, item)) anyDowngrade = true;
  }

  // For "do not name me", turn the Party's Do_Not_Name flag on and set its Generic_Label: the given label, or
  // the kept one, or "a correspondent" when there is none (R51.7).
  if (setsDoNotName) {
    const label = genericLabel ?? null;
    batch.run(sql`UPDATE external_parties
      SET do_not_name = 1, generic_label = COALESCE(${label}, NULLIF(generic_label, ''), ${DEFAULT_GENERIC_LABEL}), rev = rev + 1, updated_seq = ${CHANGE_SEQ}, actor_id = ${plan.requestedBy}
      WHERE id = ${plan.partyId}`);
  }

  // Mark the request Answered, attach the Change_Link token hash and its 12-month expiry (R51.8).
  batch.update(consentRequests, {
    state: 'answered', answeredAt: now, changeTokenHash: plan.changeTokenHash, changeExpiresAt,
  }, sql`id = ${plan.requestId}`);

  itemUpdateEvents(batch, plan, now);
  batch.outboxMany('publish', publishScopes(plan.items));
  if (anyDowngrade) batch.bumpEpoch();
  queueConfirmation(batch, plan, 'answer', now);
  return batch;
}

/**
 * Record a withdrawal through a Change_Link (R51.10). In one batch, after the single-use `consent_link_open`
 * guard: the append-only `consent_withdrawals` rows (one per withdrawn item); each withdrawn Correspondence's
 * Consent_Status set to Refused and each withdrawn Source's or Attachment's Rights_Status to Restricted; the
 * same R33.5/R34.3 downgrades and Item_Update events as a refusal; the Party's Do_Not_Name flag left on; a
 * `publish` row per affected unit; and the confirmation email carrying the same Change_Link.
 */
export function buildConsentWithdrawalBatch(
  db: D1Database,
  plan: ConsentActionPlan,
  now: Timestamp,
): GuardedBatch {
  const batch = new GuardedBatch(db, { id: plan.requestedBy, now });
  // The withdrawal rows are written first; the guard then checks the Change_Link was open when the submission began.
  let anyDowngrade = false;

  for (const item of plan.items) {
    batch.insert(consentWithdrawals, {
      id: newULID(now), requestId: plan.requestId, itemId: item.itemId, unitId: item.unitId, rootId: item.rootId,
      comment: plan.comment, withdrawnAt: now,
    });
    if (item.element === 'correspondence') setConsentStatus(batch, item, plan, 'refused');
    else setRightsStatus(batch, item, plan, false);
    if (downgrade(batch, item)) anyDowngrade = true;
  }

  guardChangeOpen(batch, plan.requestId, plan.items, now);
  itemUpdateEvents(batch, plan, now);
  batch.outboxMany('publish', publishScopes(plan.items));
  if (anyDowngrade) batch.bumpEpoch();
  queueConfirmation(batch, plan, 'withdrawal', now);
  return batch;
}

/** Queue the confirmation email to the Contact_Email, carrying the Change_Link in its payload ref (R51.8, R51.10). */
function queueConfirmation(batch: GuardedBatch, plan: ConsentActionPlan, action: 'answer' | 'withdrawal', now: Timestamp): void {
  batch.insert(outgoingEmails, {
    id: plan.emailId, kind: 'consent_confirmation', recipient: plan.contactEmail,
    payloadRef: confirmationPayloadRef(plan.requestId, action, plan.changeUrl), state: 'queued', createdAt: now, sendableAt: now,
  });
  batch.outbox('mail', `email:${plan.emailId}`);
}
