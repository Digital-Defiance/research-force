import { eq, sql } from 'drizzle-orm';
import { correspondenceParties, correspondences } from '@researchforce/db/schema/core';
import type { ConsentStatus, PartialDate, ULID } from '@researchforce/domain/types';
import type { KindRecord } from '@researchforce/kernel/input';
import { prefillCorrespondenceLine } from '@researchforce/kernel/substitute';
import { classesOf, defined, richColumns, richText, rowsOf, storedDate } from './kind';
import type { ItemFields, KindAdapter, KindRules } from './kind';

type Party = { readonly kind: 'member'; readonly id: string } | { readonly kind: 'external'; readonly id: string; readonly consent: ConsentStatus };
interface CorrespondenceRow { date: string; dateApprox: number; channel: string; direction: 'sent' | 'received'; content: string; contentSpans: string }

const partiesOf = (fields: ItemFields) => (fields['parties'] ?? []) as readonly Party[];
function row(fields: ItemFields) {
  const date = fields['date'] as PartialDate;
  const content = richColumns(fields['content']);
  return { date: date.value, dateApprox: date.approx, channel: fields['channel'] as string, direction: fields['direction'] as 'sent' | 'received', content: content.text!, contentSpans: content.spans };
}
/** One Consent_Status per External_Party of this Correspondence, initially Not_Asked (R34.1). */
const partyRows = (id: ULID, fields: ItemFields) => partiesOf(fields).map((party, position) => ({
  unitId: id, position, partyKind: party.kind, partyId: party.id, consentStatus: party.kind === 'external' ? party.consent : null,
}));

export const correspondence: KindAdapter = {
  kind: 'correspondence',
  classes: () => classesOf(['date', 'channel', 'direction', 'content', 'parties'], 'content'),
  load: (db, id) => [
    db.prepare('SELECT date, date_approx AS dateApprox, channel, direction, content, content_spans AS contentSpans FROM correspondences WHERE unit_id = ?1').bind(id),
    db.prepare('SELECT party_kind AS kind, party_id AS id, consent_status AS consent FROM correspondence_parties WHERE unit_id = ?1 ORDER BY position').bind(id),
  ],
  read([result, parties]) {
    const stored = rowsOf<CorrespondenceRow>(result)[0];
    if (!stored) return { fields: {} };
    return {
      fields: defined({
        date: storedDate(stored.date, stored.dateApprox), channel: stored.channel, direction: stored.direction, content: richText(stored.content, stored.contentSpans),
        parties: rowsOf<{ kind: 'member' | 'external'; id: string; consent: ConsentStatus | null }>(parties)
          .map((party): Party => (party.kind === 'member' ? { kind: 'member', id: party.id } : { kind: 'external', id: party.id, consent: party.consent ?? 'not_asked' })),
      }),
    };
  },
  dates: (fields) => ({ kind: 'correspondence', date: fields['date'] as PartialDate }),
  insert: (batch, item, fields) => { batch.insert(correspondences, { unitId: item.id, ...row(fields) }).bulkInsert(correspondenceParties, partyRows(item.id, fields)); },
  update(batch, item, _before, after, changed) {
    if (['date', 'channel', 'direction', 'content'].some((field) => changed.has(field))) batch.update(correspondences, row(after), eq(correspondences.unitId, item.id));
    if (changed.has('parties')) batch.run(sql`DELETE FROM correspondence_parties WHERE unit_id = ${item.id}`).bulkInsert(correspondenceParties, partyRows(item.id, after));
  },
  /**
   * A Public Correspondence that the save leaves with an External_Party whose consent is not Granted becomes Withheld
   * in the same save, with the pre-filled Disclosure_Line and a Disclosure_Change by the saving Member (R9.6, R34.3).
   */
  async rules(_c, save): Promise<KindRules> {
    if (save.base?.disclosureLevel !== 'public' || partiesOf(save.after).every((party) => party.kind === 'member' || party.consent === 'granted')) return { issues: [] };
    const { line } = prefillCorrespondenceLine(save.after as unknown as Extract<KindRecord, { kind: 'correspondence' }>, { members: new Map(), parties: new Map() });
    return {
      issues: [],
      unit: { disclosureLevel: 'withheld', disclosureLine: line },
      changes: [
        { field: 'disclosureLevel', before: 'public', after: 'withheld', fieldClass: 'disclosure' },
        { field: 'disclosureLine', before: save.base.disclosureLine, after: line, fieldClass: 'disclosure' },
      ],
    };
  },
};
