import { eq } from 'drizzle-orm';
import { sources } from '@researchforce/db/schema/core';
import type { DateRange, DocumentDate, PartialDate } from '@researchforce/domain/types';
import { classesOf, defined, richColumns, richText, rowsOf, storedDate } from './kind';
import type { ItemFields, KindAdapter } from './kind';

const FIELDS = ['sourceKind', 'reliabilityId', 'documentDate', 'archiveOrCollection', 'archivalReference', 'recoverer', 'reliabilityNote', 'rightsStatusId', 'rightsHolder', 'rightsTerms'];
type Party = { readonly kind: 'member' | 'external'; readonly id: string };
interface SourceRow {
  sourceKind: 'primary' | 'secondary'; reliabilityId: string; docDate: string | null; docDateApprox: number; docDateEnd: string | null; docDateEndApprox: number;
  archiveOrCollection: string | null; archivalReference: string | null; recovererKind: 'member' | 'external' | null; recovererId: string | null;
  note: string | null; noteSpans: string; rightsStatusId: string; rightsHolder: string | null; rightsTerms: string | null;
}

/** A partial document date is stored exactly as entered, at its precision and with any approximate mark (R6.7). */
function row(fields: ItemFields) {
  const date = fields['documentDate'] as DocumentDate | undefined;
  const [start, end]: [PartialDate | undefined, PartialDate | undefined] = date === undefined ? [undefined, undefined] : 'start' in date ? [date.start, date.end] : [date, undefined];
  const recoverer = fields['recoverer'] as Party | undefined;
  const note = richColumns(fields['reliabilityNote']);
  const text = (name: string) => (fields[name] as string | undefined) ?? null;
  return {
    sourceKind: fields['sourceKind'] as 'primary' | 'secondary', reliabilityId: fields['reliabilityId'] as string,
    docDate: start?.value ?? null, docDateApprox: start?.approx ?? false, docDateEnd: end?.value ?? null, docDateEndApprox: end?.approx ?? false,
    archiveOrCollection: text('archiveOrCollection'), archivalReference: text('archivalReference'),
    recovererKind: recoverer?.kind ?? null, recovererId: recoverer?.id ?? null, reliabilityNote: note.text, reliabilityNoteSpans: note.spans,
    rightsStatusId: fields['rightsStatusId'] as string, rightsHolder: text('rightsHolder'), rightsTerms: text('rightsTerms'),
  };
}

export const source: KindAdapter = {
  kind: 'source',
  classes: () => classesOf(FIELDS, 'content'),
  load: (db, id) => [db.prepare(`SELECT source_kind AS sourceKind, reliability_id AS reliabilityId, doc_date AS docDate, doc_date_approx AS docDateApprox,
      doc_date_end AS docDateEnd, doc_date_end_approx AS docDateEndApprox, archive_or_collection AS archiveOrCollection, archival_reference AS archivalReference,
      recoverer_kind AS recovererKind, recoverer_id AS recovererId, reliability_note AS note, reliability_note_spans AS noteSpans,
      rights_status_id AS rightsStatusId, rights_holder AS rightsHolder, rights_terms AS rightsTerms FROM sources WHERE unit_id = ?1`).bind(id)],
  read([result]) {
    const stored = rowsOf<SourceRow>(result)[0];
    if (!stored) return { fields: {} };
    const start = storedDate(stored.docDate, stored.docDateApprox);
    const end = storedDate(stored.docDateEnd, stored.docDateEndApprox);
    const documentDate: DocumentDate | undefined = start && end ? ({ start, end } satisfies DateRange) : start;
    return {
      fields: defined({
        sourceKind: stored.sourceKind, reliabilityId: stored.reliabilityId, documentDate, archiveOrCollection: stored.archiveOrCollection ?? undefined,
        archivalReference: stored.archivalReference ?? undefined, recoverer: stored.recovererKind === null ? undefined : { kind: stored.recovererKind, id: stored.recovererId! },
        reliabilityNote: richText(stored.note, stored.noteSpans), rightsStatusId: stored.rightsStatusId, rightsHolder: stored.rightsHolder ?? undefined, rightsTerms: stored.rightsTerms ?? undefined,
      }),
    };
  },
  dates: (fields) => ({ kind: 'source', ...(fields['documentDate'] === undefined ? {} : { documentDate: fields['documentDate'] as DocumentDate }) }),
  insert: (batch, item, fields) => { batch.insert(sources, { unitId: item.id, ...row(fields) }); },
  update(batch, item, _before, after, changed) {
    if (FIELDS.some((field) => changed.has(field))) batch.update(sources, row(after), eq(sources.unitId, item.id));
  },
};
