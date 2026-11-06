import type { Context } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { base64url } from '@researchforce/db/downloads';
import { GuardedBatch } from '@researchforce/db/batch';
import { consentRequestItems, consentRequests, outgoingEmails } from '@researchforce/db/schema/core';
import { CONSENT_REQUEST_KINDS, CONSENT_REQUEST_LIMITS } from '@researchforce/domain/consent-requests';
import type { ConsentRequestKind } from '@researchforce/domain/consent-requests';
import { newULID } from '@researchforce/domain/identifiers';
import { LEVELS } from '@researchforce/domain/types';
import type { DisclosureLine, Level, PublicPresentation, Timestamp, ULID } from '@researchforce/domain/types';
import { isULID } from '@researchforce/domain/types';
import type { RichText } from '@researchforce/domain/richtext';
import { richTextSchema, textField } from '@researchforce/domain/schemas/common';
import { applyChange, checkGates } from '@researchforce/kernel/preview';
import type { ChangeSet, GateFailure, UnitChange } from '@researchforce/kernel/preview';
import { project } from '@researchforce/kernel/project';
import { canonicalJson, unitKey } from '@researchforce/kernel/views';
import type { PublicView, UnitKey } from '@researchforce/kernel/views';
import { composeConsentEmail } from '@researchforce/public-render/email/consent';
import type { ConsentSnapshot } from '@researchforce/public-render/email/consent';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import { parse } from '../api/input';
import { authorize, authorizeRead } from '../auth/authorize';
import { loadProjectionInput } from '../kernel-input';
import { previewSecret } from '../disclosure/preview';

/**
 * Emailed Consent_Requests: the Administrator-facing preview, send, list, and cancel of a request to an
 * External_Party (R51.2 to R51.4, R51.11, design "Permission evidence and addressed Consent_Requests").
 *
 * `POST /consent-requests/preview` runs the checks of R51.3, renders each named element's Consent_Page
 * snapshot with the kernel under the proposed values, and returns the exact email text, the snapshots, and a
 * preview token over the ordered snapshot digests. `POST /consent-requests` with that token stores the
 * request, one item per element with its snapshot and SHA-256, the Consent_Link token's hash, and the expiry;
 * sets each named Correspondence's Consent_Status to Requested unless it is already Granted; and queues the
 * email through the Mailer, counted against the Recipient_Cap. The Consent_Link's random token lives only as
 * its SHA-256; the plaintext travels only in the queued email. `GET /consent-requests` lists requests, and
 * `POST /consent-requests/{id}/cancel` cancels an open one without changing any status (R51.11).
 *
 * Answering, withdrawal, the public pages, reminders, and coverage are later tasks; this module implements
 * only the sending side and the email template it composes.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** The preview token is good only briefly; a stale token is refused and the dialog previews again (R51.2). */
export const CONSENT_PREVIEW_TOKEN_LIFETIME_MS = 30 * 60_000;

const PUBLIC_PRESENTATIONS = ['summary_only', 'full_content'] as const;
const keyPattern = /^u:[A-Za-z0-9]+$/u;
/** One named element with the values proposed for publication (R51.2). */
const unitSchema = z.strictObject({
  key: z.string().regex(keyPattern, 'A unit key is `u:<id>`.'),
  level: z.enum(LEVELS).optional(),
  presentation: z.enum(PUBLIC_PRESENTATIONS).optional(),
  publicSummary: richTextSchema().nullable().optional(),
  disclosureLine: z.record(z.string(), z.unknown()).nullable().optional(),
});
const previewSchema = z.strictObject({
  partyId: z.string(),
  kind: z.enum(CONSENT_REQUEST_KINDS),
  units: z.array(unitSchema).min(CONSENT_REQUEST_LIMITS.minUnits).max(CONSENT_REQUEST_LIMITS.maxUnits),
  message: textField(CONSENT_REQUEST_LIMITS.messageCodePoints).optional(),
});
const sendSchema = previewSchema.extend({ token: z.string().min(1).max(1_000_000) });
type PreviewInput = z.infer<typeof previewSchema>;

const idOf = (key: UnitKey): string => key.slice(2);

/** The kernel change set from the proposed values, so the snapshot is the resulting Public_View (R51.5). */
function changeSetOf(input: PreviewInput): ChangeSet {
  const units = input.units.map((entry): UnitChange => ({
    key: entry.key,
    ...(entry.level === undefined ? {} : { level: entry.level as Level }),
    ...(entry.presentation === undefined ? {} : { presentation: entry.presentation as PublicPresentation }),
    ...(entry.publicSummary === undefined ? {} : { publicSummary: entry.publicSummary as RichText | null }),
    ...(entry.disclosureLine === undefined ? {} : { disclosureLine: entry.disclosureLine as DisclosureLine | null }),
  }));
  return { units };
}

/** The exact proposed values for one element, stored on its item row as the evidence of what was asked (R51.2). */
function proposedValuesOf(entry: PreviewInput['units'][number]): Record<string, unknown> {
  return {
    ...(entry.level === undefined ? {} : { level: entry.level }),
    ...(entry.presentation === undefined ? {} : { presentation: entry.presentation }),
    ...(entry.publicSummary === undefined ? {} : { publicSummary: entry.publicSummary }),
    ...(entry.disclosureLine === undefined ? {} : { disclosureLine: entry.disclosureLine }),
  };
}

/** The External_Party a request names, with the Contact_Email R51.3 requires and the name shown on a publication snapshot. */
interface PartyFacts {
  readonly id: ULID;
  readonly name: string;
  readonly doNotName: boolean;
  readonly genericLabel: string | null;
  readonly contactEmail: string | null;
}

/** One named element, resolved to its Root_Item and its kind, so R51.3 can check it suits the request kind. */
interface ElementFacts {
  readonly key: UnitKey;
  readonly unitId: ULID;
  readonly rootId: ULID;
  readonly unitType: string;
  readonly itemKind: string | null;
  /** The document identity a rights snapshot carries; present for an Attachment or a Source's file (R51.16). */
  readonly document?: { readonly identifier: string; readonly title: string; readonly fileName: string; readonly sizeBytes: number; readonly sha256: string };
  /** Whether this External_Party is a Party of this Correspondence, for a publication request (R51.2). */
  readonly partyIsParty: boolean;
  /** The current Consent_Status for this Party on this Correspondence; so the send leaves a Granted one alone (R51.4). */
  readonly consentStatus: string | null;
}

interface ElementRow {
  id: ULID; rootId: ULID; unitType: string; itemKind: string | null;
  attachmentIdentifier: string | null; attachmentTitle: string | null; fileName: string | null; sizeBytes: number | null; sha256: string | null;
  partyIsParty: number; consentStatus: string | null;
}

/** Load the External_Party and the named elements for the request, each resolved to its kind and (for rights) its file identity. */
async function loadFacts(c: Context<ApiEnv>, input: PreviewInput): Promise<{ party: PartyFacts; elements: ElementFacts[] }> {
  if (!isULID(input.partyId)) throw new ApiError('not_found');
  const unitIds = input.units.map((entry) => idOf(entry.key));
  if (new Set(unitIds).size !== unitIds.length) throw new ApiError('validation', { fields: [{ field: 'units', rule: 'Each element may be named once.' }] });
  const db = c.env.RF_CORE;
  const unitJson = JSON.stringify(unitIds);
  const [partyRows, elementRows] = await c.get('accountant').track(db.batch([
    db.prepare('SELECT id, name, do_not_name AS doNotName, generic_label AS genericLabel, contact_email AS contactEmail FROM external_parties WHERE id = ?1').bind(input.partyId),
    db.prepare(`SELECT u.id, u.root_id AS rootId, u.unit_type AS unitType, ri.kind AS itemKind,
        at.item_identifier AS attachmentIdentifier, at.title AS attachmentTitle, at.original_name AS fileName, at.size_bytes AS sizeBytes, at.sha256,
        CASE WHEN EXISTS (SELECT 1 FROM correspondence_parties cp WHERE cp.unit_id = u.id AND cp.party_kind = 'external' AND cp.party_id = ?2) THEN 1 ELSE 0 END AS partyIsParty,
        (SELECT cp.consent_status FROM correspondence_parties cp WHERE cp.unit_id = u.id AND cp.party_kind = 'external' AND cp.party_id = ?2) AS consentStatus
      FROM units u
        LEFT JOIN research_items ri ON ri.unit_id = u.id
        LEFT JOIN attachments at ON at.unit_id = u.id
      WHERE u.id IN (SELECT value FROM json_each(?1)) AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = u.id)`).bind(unitJson, input.partyId),
  ]));
  const partyRow = (partyRows as D1Result<{ id: ULID; name: string; doNotName: number; genericLabel: string | null; contactEmail: string | null }>).results[0];
  if (!partyRow) throw new ApiError('not_found');
  const byId = new Map<string, ElementRow>((elementRows as D1Result<ElementRow>).results.map((row) => [row.id, row]));
  const elements = input.units.map((entry): ElementFacts => {
    const row = byId.get(idOf(entry.key));
    if (!row) throw new ApiError('not_found');
    return {
      key: entry.key, unitId: row.id, rootId: row.rootId, unitType: row.unitType, itemKind: row.itemKind,
      ...(row.unitType === 'attachment' && row.fileName !== null && row.sha256 !== null && row.sizeBytes !== null
        ? { document: { identifier: row.attachmentIdentifier ?? '', title: row.attachmentTitle ?? '', fileName: row.fileName, sizeBytes: row.sizeBytes, sha256: row.sha256 } }
        : {}),
      partyIsParty: row.partyIsParty === 1,
      consentStatus: row.consentStatus,
    };
  });
  return {
    party: { id: partyRow.id, name: partyRow.name, doNotName: partyRow.doNotName === 1, genericLabel: partyRow.genericLabel, contactEmail: partyRow.contactEmail },
    elements,
  };
}

/** One reason R51.3 refuses to send; the response lists every reason so the Administrator sees all of them at once. */
export interface ConsentCheckFailure { readonly reason: string; readonly message: string; readonly key?: UnitKey; readonly details?: readonly string[] }

/** How many Consent_Requests were sent to this Party in the recent window, for the R51.3 cap (at most 5 in 30 days). */
async function recentCount(c: Context<ApiEnv>, partyId: string, now: Timestamp): Promise<number> {
  const since = new Date(Date.parse(now) - CONSENT_REQUEST_LIMITS.recentWindowDays * DAY_MS).toISOString();
  const row = await c.get('accountant').track(c.env.RF_CORE.prepare(
    'SELECT count(*) AS n FROM consent_requests WHERE party_id = ?1 AND sent_at >= ?2',
  ).bind(partyId, since).all<{ n: number }>());
  return row.results[0]?.n ?? 0;
}

/**
 * The checks of R51.3, run in the preview and re-run on send: the Party has a Contact_Email; each named element
 * suits the request kind (publication => a Correspondence the Party is a Party of; rights => a Source or
 * Attachment); the Party has fewer than the cap of recent requests; and the kernel's Owner-consent, hold, and
 * Restricted gates pass for the proposed values (R23.20, R48.4). Every failing reason is returned.
 */
function kindChecks(kind: ConsentRequestKind, party: PartyFacts, elements: readonly ElementFacts[], recent: number): ConsentCheckFailure[] {
  const failures: ConsentCheckFailure[] = [];
  if (party.contactEmail === null) {
    failures.push({ reason: 'no_contact_email', message: 'This External Party has no Contact Email, so a Consent Request cannot be sent.' });
  }
  if (recent >= CONSENT_REQUEST_LIMITS.recentCap) {
    failures.push({ reason: 'recent_cap', message: `This External Party already has ${CONSENT_REQUEST_LIMITS.recentCap} Consent Requests sent in the last ${CONSENT_REQUEST_LIMITS.recentWindowDays} days.` });
  }
  for (const element of elements) {
    if (kind === 'publication') {
      if (element.unitType !== 'research_item' || element.itemKind !== 'correspondence') {
        failures.push({ reason: 'wrong_kind', key: element.key, message: 'A Publication Consent Request may name only Correspondences.' });
      } else if (!element.partyIsParty) {
        failures.push({ reason: 'not_a_party', key: element.key, message: 'This External Party is not a Party of this Correspondence.' });
      }
    } else if (element.unitType !== 'attachment' && !(element.unitType === 'research_item' && element.itemKind === 'source')) {
      failures.push({ reason: 'wrong_kind', key: element.key, message: 'A Rights Permission Request may name only Sources and Attachments.' });
    }
  }
  return failures;
}

/** Map a kernel gate failure to a Consent_Request check failure: the Restricted, hold, rights, and Owner-consent gates of R51.3. */
function gateFailure(failure: GateFailure): ConsentCheckFailure {
  return { reason: failure.reason, message: failure.message, ...(failure.key ? { key: failure.key } : {}), ...(failure.details ? { details: failure.details } : {}) };
}

/** The Consent_Page snapshot for each named element under the proposed values, in request order (R51.5, R51.16). */
function snapshotsOf(kind: ConsentRequestKind, party: PartyFacts, elements: readonly ElementFacts[], views: ReadonlyMap<UnitKey, PublicView>): ConsentSnapshot[] {
  return elements.map((element): ConsentSnapshot => {
    const view = views.get(element.key) ?? withheldPlaceholder(element.key);
    if (kind === 'publication') {
      return { kind: 'publication', key: element.key, view, partyName: party.doNotName ? (party.genericLabel ?? 'a correspondent') : party.name };
    }
    return {
      kind: 'rights', key: element.key, view,
      document: element.document ?? { identifier: '', title: '', fileName: '', sizeBytes: 0, sha256: '' },
    };
  });
}

/** A unit that is Not_Published under the proposed values leaves no public projection; the snapshot shows only that it is not published. */
function withheldPlaceholder(key: UnitKey): PublicView {
  return { tag: 'withheld', key, line: { kindOfMaterial: 'Not published', date: { value: '', approx: false }, parties: [] } } as unknown as PublicView;
}

/** SHA-256 hex of UTF-8 text. */
async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 over the ordered item snapshot digests, binding the sent request to exactly what was previewed (R51.2, R51.9). */
async function previewDigestOf(hashes: readonly string[]): Promise<string> {
  return sha256Hex(canonicalJson(hashes));
}

/** A 128-bit Consent_Link token in Crockford base32, which travels only in the queued email's URL fragment (R51.4). */
function newConsentToken(): string {
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

/** The base of the Consent_Page URL, derived from the Workspace origin (`app.` => `submit.`), so the token stays in the fragment. */
function consentBase(workspaceOrigin: string): string {
  try {
    const url = new URL(workspaceOrigin);
    url.hostname = url.hostname.replace(/^app\./u, 'submit.');
    return `${url.origin}/consent`;
  } catch {
    return 'https://submit.researchforce.org/consent';
  }
}

/** The UTC date a Consent_Link expires, as "26 Nov 2026 UTC" (R51.4, R51.11). */
function expiryDate(expiresAt: string): string {
  return `${new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(expiresAt))} UTC`;
}

/** What a preview token binds: the party, kind, the ordered snapshot digests, the requester, and when it was issued. */
interface PreviewClaim {
  readonly partyId: string;
  readonly kind: ConsentRequestKind;
  readonly digests: readonly string[];
  readonly requesterId: string;
  readonly issuedAt: number;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encoding');
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));
}
function payloadOf(claim: PreviewClaim): string {
  return canonicalJson({ partyId: claim.partyId, kind: claim.kind, digests: claim.digests, requesterId: claim.requesterId, issuedAt: claim.issuedAt });
}

/** An HMAC over the party, kind, and ordered snapshot digests, so the send binds to exactly what was previewed (R51.2). */
async function issuePreviewToken(claim: PreviewClaim, secret: string): Promise<string> {
  const payload = base64url(new TextEncoder().encode(payloadOf(claim)));
  const signature = base64url(new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(payload))));
  return `${payload}.${signature}`;
}

/** The claim a preview token carries, or null when it is invalid, forged, expired, or future; fails closed. */
async function verifyPreviewToken(token: string, secret: string, now: number): Promise<PreviewClaim | null> {
  try {
    if (token.length > 1_000_000) return null;
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra !== undefined) return null;
    if (!(await crypto.subtle.verify('HMAC', await hmacKey(secret), decode(signature), new TextEncoder().encode(payload)))) return null;
    const claim = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(decode(payload))) as PreviewClaim;
    if (!Number.isSafeInteger(claim.issuedAt) || now < claim.issuedAt || now - claim.issuedAt > CONSENT_PREVIEW_TOKEN_LIFETIME_MS) return null;
    if (typeof claim.requesterId !== 'string' || !Array.isArray(claim.digests)) return null;
    return claim;
  } catch {
    return null;
  }
}

/** One built element: its facts, the snapshot, the canonical JSON, and the snapshot's SHA-256. */
interface BuiltItem { readonly element: ElementFacts; readonly snapshot: ConsentSnapshot; readonly snapshotJson: string; readonly snapshotHash: string }

/**
 * Run the R51.3 checks and build each element's snapshot under the proposed values. Shared by the preview and
 * the send, so both check the same rules and render the same snapshots; the send re-runs it so a change since
 * the preview is caught (R51.2, R51.3). Throws a `rule` error listing every reason when a check fails.
 */
async function build(c: Context<ApiEnv>, input: PreviewInput): Promise<{ party: PartyFacts; items: BuiltItem[] }> {
  const { party, elements } = await loadFacts(c, input);
  const now = c.get('now');
  const recent = await recentCount(c, party.id, now);

  // The kernel renders every named element's Public_View under the proposed values and runs the gates of R51.3.
  const roots = [...new Set(elements.map((element) => element.rootId))];
  const accountant = c.get('accountant');
  const { input: projectionInput, consent } = await loadProjectionInput(c.env.RF_CORE, roots, now, {
    track: accountant.track.bind(accountant), withConsent: true,
  });
  const change = changeSetOf(input);
  const requesterId = c.get('session').member.id;
  const contentLicence = c.get('contentLicence');
  const gateFailures = checkGates(change, { input: projectionInput, requesterId, contentLicence, ...(consent ? { consent } : {}) });

  const failures = [...kindChecks(input.kind, party, elements, recent), ...gateFailures.map(gateFailure)];
  if (failures.length > 0) throw new ApiError('rule', { details: { rule: 'consent_checks', failures } });

  const views = project(applyChange(projectionInput, change));
  const snapshots = snapshotsOf(input.kind, party, elements, views);
  const items = await Promise.all(elements.map(async (element, index): Promise<BuiltItem> => {
    const snapshot = snapshots[index]!;
    const snapshotJson = canonicalJson(snapshot);
    return { element, snapshot, snapshotJson, snapshotHash: await sha256Hex(snapshotJson) };
  }));
  return { party, items };
}

export interface ConsentPreview {
  /** The exact email text the Administrator confirms before sending (R51.2). */
  readonly email: { readonly subject: string; readonly text: string; readonly html: string };
  /** The stored Consent_Page snapshots, one per named element, in order (R51.5). */
  readonly snapshots: readonly ConsentSnapshot[];
  /** The token that binds a later send to exactly these snapshots (R51.2). */
  readonly token: string;
}

/**
 * `POST /consent-requests/preview`: run the checks of R51.3, render each named element's Consent_Page snapshot
 * under the proposed values, and return the exact email text, the snapshots, and a preview token over their
 * ordered digests (R51.2). Writes nothing. Open to Administrators (`consent.request`).
 */
export async function previewConsentRequest(c: Context<ApiEnv>, body: unknown): Promise<ConsentPreview> {
  await authorize(c, [{ permission: 'consent.request' }]);
  const input = parse(previewSchema, body);
  const { party, items } = await build(c, input);
  const digests = items.map((item) => item.snapshotHash);
  const consentUrl = `${consentBase(c.env.WORKSPACE_ORIGIN)}#<token>`;
  const requesterName = await requesterDisplayName(c);
  const expiresOn = expiryDate(new Date(Date.parse(c.get('now')) + CONSENT_REQUEST_LIMITS.consentLinkDays * DAY_MS).toISOString());
  const email = composeConsentEmail({
    kind: input.kind, requesterName, ...(input.message ? { message: input.message } : {}),
    consentUrl, expiresOn, snapshots: items.map((item) => item.snapshot),
  });
  const token = await issuePreviewToken(
    { partyId: party.id, kind: input.kind, digests, requesterId: c.get('session').member.id, issuedAt: Date.parse(c.get('now')) },
    previewSecret(c),
  );
  return { email: { subject: email.subject, text: email.text, html: email.html }, snapshots: items.map((item) => item.snapshot), token };
}

export interface ConsentSendResult { readonly id: ULID }

/**
 * `POST /consent-requests`: store the request, its items with snapshots and SHA-256 digests, the Consent_Link
 * token's hash, and the expiry (sending plus 30 days); set each named Correspondence's Consent_Status for the
 * Party to Requested unless it is already Granted; and queue the email through the Mailer, counted against the
 * Recipient_Cap (R51.4). The checks of R51.3 are re-run, and the preview token must bind to exactly the
 * snapshots the send rebuilds, so a change since the preview is caught (R51.2). Open to Administrators.
 */
export async function createConsentRequest(c: Context<ApiEnv>, body: unknown): Promise<ConsentSendResult> {
  await authorize(c, [{ permission: 'consent.request' }]);
  const input = parse(sendSchema, body);
  const now = c.get('now');
  const claim = await verifyPreviewToken(input.token, previewSecret(c), Date.parse(now));
  if (claim === null || claim.partyId !== input.partyId || claim.kind !== input.kind) {
    throw new ApiError('preview_stale', { details: { rule: 'consent_preview', message: 'Preview the request again before sending.' } });
  }

  const { party, items } = await build(c, input);
  // The send binds to exactly the previewed snapshots: a change since the preview makes the digests differ (R51.2, R51.9).
  const digests = items.map((item) => item.snapshotHash);
  if (canonicalJson(digests) !== canonicalJson(claim.digests)) {
    throw new ApiError('preview_stale', { details: { rule: 'consent_preview', message: 'The content changed after the preview; preview the request again.' } });
  }
  if (party.contactEmail === null) throw new ApiError('rule', { details: { rule: 'consent_checks', failures: [{ reason: 'no_contact_email', message: 'This External Party has no Contact Email.' }] } });

  const requestId = newULID(now);
  const emailId = newULID(now);
  const token = newConsentToken();
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.parse(now) + CONSENT_REQUEST_LIMITS.consentLinkDays * DAY_MS).toISOString() as Timestamp;
  const previewDigest = await previewDigestOf(digests);
  const consentUrl = `${consentBase(c.env.WORKSPACE_ORIGIN)}#${token}`;

  const batch = new GuardedBatch(c.env.RF_CORE, { id: c.get('session').member.id, now })
    .insert(consentRequests, {
      id: requestId, partyId: party.id, requestedBy: c.get('session').member.id, kind: input.kind, contactEmail: party.contactEmail,
      message: input.message ?? null, tokenHash, previewDigest, state: 'sent', sentAt: now, expiresAt,
    });
  for (const [position, item] of items.entries()) {
    batch.insert(consentRequestItems, {
      id: newULID(now), requestId, unitId: item.element.unitId, rootId: item.element.rootId, position,
      proposedValues: proposedValuesOf(input.units[position]!) as unknown as Record<string, unknown>,
      snapshot: item.snapshot as unknown as Record<string, unknown>, snapshotHash: item.snapshotHash,
    });
  }

  // R51.4: for a Publication_Consent_Request, each named Correspondence's Consent_Status for this Party becomes
  // Requested unless it is already Granted; a Rights_Permission_Request changes no Consent_Status.
  if (input.kind === 'publication') {
    const unitJson = JSON.stringify(items.map((item) => item.element.unitId));
    const [external, requested, granted] = ['external', 'requested', 'granted'];
    batch.run(sql`UPDATE correspondence_parties SET consent_status = ${requested}
      WHERE party_kind = ${external} AND party_id = ${party.id} AND consent_status IS NOT ${granted}
        AND unit_id IN (SELECT value FROM json_each(${unitJson}))`);
    batch.outboxMany('publish', items.map((item) => `unit:${item.element.unitId}`));
  }

  // The Consent_Link URL travels only in this queued email; its payload_ref carries it so the Mailer composes the
  // same email the Administrator confirmed, sent from the Sending_Address to the Contact_Email alone (R51.4).
  batch.insert(outgoingEmails, {
    id: emailId, kind: 'consent', recipient: party.contactEmail, payloadRef: `consent:${requestId}:${consentUrl}`,
    state: 'queued', createdAt: now, sendableAt: now,
  });
  batch.outbox('mail', `email:${emailId}`);
  await batch.commit(c.get('accountant'));
  return { id: requestId };
}

/** One Consent_Request as the Member list shows it, with its state and the elements it names (R51.13). */
/** One recorded Consent_Answer on a named element, as a Member sees it on the Party's and the element's page (R51.13). */
export interface ConsentAnswerView {
  readonly unitId: ULID;
  readonly key: UnitKey;
  /** The choice the person gave: named/unnamed/refused for a Correspondence, granted/refused for a Source or Attachment. */
  readonly choice: string;
  /** The Generic_Label given with a "do not name me" answer; null otherwise. */
  readonly genericLabel: string | null;
  /** The optional comment the person left with the submission; null when none. */
  readonly comment: string | null;
  readonly answeredAt: Timestamp;
}

/** One recorded withdrawal through a Change_Link on a named element (R51.10, R51.13). */
export interface ConsentWithdrawalView {
  readonly unitId: ULID;
  readonly key: UnitKey;
  readonly comment: string | null;
  readonly withdrawnAt: Timestamp;
}

export interface ConsentRequestView {
  readonly id: ULID;
  readonly partyId: ULID;
  readonly kind: ConsentRequestKind;
  readonly state: string;
  readonly contactEmail: string;
  readonly message: string | null;
  readonly sentAt: Timestamp;
  readonly expiresAt: Timestamp;
  readonly units: readonly { readonly key: UnitKey; readonly unitId: ULID }[];
  /** The Consent_Answers recorded on this request's elements, in answer order (R51.13). */
  readonly answers: readonly ConsentAnswerView[];
  /** The withdrawals recorded on this request's elements, in withdrawal order (R51.10, R51.13). */
  readonly withdrawals: readonly ConsentWithdrawalView[];
}

interface RequestRow {
  id: ULID; partyId: ULID; kind: ConsentRequestKind; state: string; contactEmail: string; message: string | null; sentAt: Timestamp; expiresAt: Timestamp;
}
interface AnswerRow { requestId: ULID; unitId: ULID; choice: string; genericLabel: string | null; comment: string | null; answeredAt: Timestamp }
interface WithdrawalRow { requestId: ULID; unitId: ULID; comment: string | null; withdrawnAt: Timestamp }

/**
 * `GET /consent-requests`: the Consent_Requests, newest first, each with its state, the elements it names, and
 * the Consent_Answers, comments, and withdrawals recorded on those elements, optionally filtered by `party`.
 * Open to every active Member; token hashes and the stored snapshots are never returned (R51.13).
 */
export async function listConsentRequests(c: Context<ApiEnv>): Promise<readonly ConsentRequestView[]> {
  await authorizeRead(c);
  const partyId = c.req.query('party');
  const filterParty = partyId !== undefined && isULID(partyId) ? partyId : null;
  const accountant = c.get('accountant');
  const columns = 'id, party_id AS partyId, kind, state, contact_email AS contactEmail, message, sent_at AS sentAt, expires_at AS expiresAt';
  const requestRows = (await accountant.track((filterParty === null
    ? c.env.RF_CORE.prepare(`SELECT ${columns} FROM consent_requests ORDER BY sent_at DESC, id DESC`)
    : c.env.RF_CORE.prepare(`SELECT ${columns} FROM consent_requests WHERE party_id = ?1 ORDER BY sent_at DESC, id DESC`).bind(filterParty)
  ).all<RequestRow>())).results;
  if (requestRows.length === 0) return [];
  const ids = JSON.stringify(requestRows.map((row) => row.id));
  // The named elements, the recorded answers, and the withdrawals for these requests, read in three bounded
  // queries. Only the fields a Member may see are selected; the stored snapshots and token hashes are not.
  const [itemResult, answerResult, withdrawalResult] = await accountant.track(c.env.RF_CORE.batch([
    c.env.RF_CORE.prepare('SELECT request_id AS requestId, unit_id AS unitId FROM consent_request_items WHERE request_id IN (SELECT value FROM json_each(?1)) ORDER BY request_id, position').bind(ids),
    c.env.RF_CORE.prepare('SELECT request_id AS requestId, unit_id AS unitId, choice, generic_label AS genericLabel, comment, answered_at AS answeredAt FROM consent_answers WHERE request_id IN (SELECT value FROM json_each(?1)) ORDER BY answered_at, id').bind(ids),
    c.env.RF_CORE.prepare('SELECT request_id AS requestId, unit_id AS unitId, comment, withdrawn_at AS withdrawnAt FROM consent_withdrawals WHERE request_id IN (SELECT value FROM json_each(?1)) ORDER BY withdrawn_at, id').bind(ids),
  ]));
  const itemRows = (itemResult as D1Result<{ requestId: ULID; unitId: ULID }>).results;
  const answerRows = (answerResult as D1Result<AnswerRow>).results;
  const withdrawalRows = (withdrawalResult as D1Result<WithdrawalRow>).results;
  const unitsByRequest = new Map<ULID, { key: UnitKey; unitId: ULID }[]>();
  for (const row of itemRows) unitsByRequest.set(row.requestId, [...(unitsByRequest.get(row.requestId) ?? []), { key: unitKey(row.unitId), unitId: row.unitId }]);
  const answersByRequest = new Map<ULID, ConsentAnswerView[]>();
  for (const row of answerRows) answersByRequest.set(row.requestId, [...(answersByRequest.get(row.requestId) ?? []), { unitId: row.unitId, key: unitKey(row.unitId), choice: row.choice, genericLabel: row.genericLabel, comment: row.comment, answeredAt: row.answeredAt }]);
  const withdrawalsByRequest = new Map<ULID, ConsentWithdrawalView[]>();
  for (const row of withdrawalRows) withdrawalsByRequest.set(row.requestId, [...(withdrawalsByRequest.get(row.requestId) ?? []), { unitId: row.unitId, key: unitKey(row.unitId), comment: row.comment, withdrawnAt: row.withdrawnAt }]);
  return requestRows.map((row) => ({
    id: row.id, partyId: row.partyId, kind: row.kind, state: row.state, contactEmail: row.contactEmail, message: row.message,
    sentAt: row.sentAt, expiresAt: row.expiresAt, units: unitsByRequest.get(row.id) ?? [],
    answers: answersByRequest.get(row.id) ?? [], withdrawals: withdrawalsByRequest.get(row.id) ?? [],
  }));
}

/**
 * `POST /consent-requests/{id}/cancel`: an Administrator cancels an open Consent_Request. The request becomes
 * Cancelled, and every Consent_Status and Rights_Status is left unchanged (R51.11). A request that is not open
 * (answered, already cancelled, or expired) is refused. Open to Administrators (`consent.request`).
 */
export async function cancelConsentRequest(c: Context<ApiEnv>, id: string): Promise<{ readonly cancelled: true }> {
  await authorize(c, [{ permission: 'consent.request' }]);
  if (!isULID(id)) throw new ApiError('not_found');
  const now = c.get('now');
  const row = await c.get('accountant').track(c.env.RF_CORE.prepare('SELECT state FROM consent_requests WHERE id = ?1').bind(id).all<{ state: string }>());
  const request = row.results[0];
  if (!request) throw new ApiError('not_found');
  if (request.state !== 'sent') throw new ApiError('rule', { details: { rule: 'not_open', message: 'Only an open Consent Request can be cancelled.' } });
  await new GuardedBatch(c.env.RF_CORE, { id: c.get('session').member.id, now })
    // The request is still open when the cancel commits; a concurrent answer makes this one abort (R51.11).
    .guard('consent_link_open', sql`EXISTS (SELECT 1 FROM consent_requests WHERE id = ${id} AND state = 'sent')`)
    .update(consentRequests, { state: 'cancelled', cancelledAt: now }, eq(consentRequests.id, id))
    .commit(c.get('accountant'));
  return { cancelled: true };
}

/** The requesting Administrator's display name, for the email (R51.4). */
async function requesterDisplayName(c: Context<ApiEnv>): Promise<string> {
  const row = await c.get('accountant').track(c.env.RF_CORE.prepare('SELECT display_name AS displayName FROM profiles WHERE member_id = ?1').bind(c.get('session').member.id).all<{ displayName: string | null }>());
  return row.results[0]?.displayName ?? 'An administrator';
}
