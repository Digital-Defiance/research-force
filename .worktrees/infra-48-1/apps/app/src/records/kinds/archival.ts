import { eq } from 'drizzle-orm';
import { archivalRequests } from '@researchforce/db/schema/core';
import { todayInZone } from '@researchforce/domain/dates';
import type { PartialDate, Timestamp } from '@researchforce/domain/types';
import { BUILT_IN_VALUE_IDS } from '@researchforce/domain/value-sets';
import { classesOf, dateColumns, defined, richColumns, richText, rowsOf, storedDate } from './kind';
import type { ItemFields, KindAdapter } from './kind';

const DAY_MS = 86_400_000;
type Party = { readonly kind: 'member' | 'external'; readonly id: string };
interface ArchivalRow {
  archiveKind: 'member' | 'external'; archiveId: string; contactKind: 'member' | 'external' | null; contactId: string | null; channel: string | null;
  requestText: string; requestSpans: string; dateSent: string | null; dateSentApprox: number; replyDate: string | null; replyDateApprox: number;
  replyContent: string | null; replySpans: string;
}

/**
 * Follow_Up_Due: the request is Sent, not withdrawn, and was sent at least one Follow_Up_Interval of whole days
 * before today in the Owner's time zone (R10.3, R10.4).
 */
export function isFollowUpDue(
  request: { readonly statusValueId: string | null; readonly dateSent?: PartialDate | null; readonly withdrawn: boolean },
  interval: number, ownerZone: string, now: Timestamp,
): boolean {
  if (request.statusValueId !== BUILT_IN_VALUE_IDS.archivalSent || request.withdrawn || !request.dateSent) return false;
  const today = Date.parse(`${todayInZone(now, ownerZone).value}T00:00:00Z`);
  const sent = Date.parse(`${request.dateSent.value}T00:00:00Z`);
  return today - sent >= interval * DAY_MS;
}

/** The archive or desk and the contact are Parties; the reply date and content are fields apart from the Thread (R10.1, R10.2). */
function row(fields: ItemFields) {
  const archive = fields['archiveOrDesk'] as Party;
  const contact = fields['contact'] as Party | undefined;
  const request = richColumns(fields['requestText']);
  const reply = richColumns(fields['replyContent']);
  const sent = dateColumns(fields['dateSent']);
  const replied = dateColumns(fields['replyDate']);
  return {
    archiveKind: archive.kind, archiveId: archive.id, contactKind: contact?.kind ?? null, contactId: contact?.id ?? null, channel: (fields['channel'] as string | undefined) ?? null,
    requestText: request.text!, requestTextSpans: request.spans, dateSent: sent.value, dateSentApprox: sent.approx, replyDate: replied.value, replyDateApprox: replied.approx,
    replyContent: reply.text, replyContentSpans: reply.spans,
  };
}
const FIELDS = ['archiveOrDesk', 'contact', 'channel', 'requestText', 'dateSent', 'replyDate', 'replyContent'];

export const archival: KindAdapter = {
  kind: 'archival_request',
  classes: () => classesOf(FIELDS, 'content', { statusValueId: 'status' }),
  load: (db, id) => [db.prepare(`SELECT archive_kind AS archiveKind, archive_id AS archiveId, contact_kind AS contactKind, contact_id AS contactId, channel,
      request_text AS requestText, request_text_spans AS requestSpans, date_sent AS dateSent, date_sent_approx AS dateSentApprox, reply_date AS replyDate,
      reply_date_approx AS replyDateApprox, reply_content AS replyContent, reply_content_spans AS replySpans FROM archival_requests WHERE unit_id = ?1`).bind(id)],
  read([result], base) {
    const stored = rowsOf<ArchivalRow>(result)[0];
    if (!stored) return { fields: {} };
    return {
      fields: defined({
        archiveOrDesk: { kind: stored.archiveKind, id: stored.archiveId }, contact: stored.contactKind === null ? undefined : { kind: stored.contactKind, id: stored.contactId! },
        channel: stored.channel ?? undefined, requestText: richText(stored.requestText, stored.requestSpans), statusValueId: base.statusValueId ?? undefined,
        dateSent: storedDate(stored.dateSent, stored.dateSentApprox), replyDate: storedDate(stored.replyDate, stored.replyDateApprox), replyContent: richText(stored.replyContent, stored.replySpans),
      }),
    };
  },
  dates: (fields) => ({ kind: 'archival_request', ...(fields['dateSent'] === undefined ? {} : { dateSent: fields['dateSent'] as PartialDate }) }),
  insert: (batch, item, fields) => { batch.insert(archivalRequests, { unitId: item.id, ...row(fields) }); },
  update(batch, item, _before, after, changed) {
    if (FIELDS.some((field) => changed.has(field))) batch.update(archivalRequests, row(after), eq(archivalRequests.unitId, item.id));
  },
};
