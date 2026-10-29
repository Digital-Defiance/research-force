import { eq } from 'drizzle-orm';
import { researchQuestions } from '@researchforce/db/schema/core';
import { richColumns, richText, rowsOf } from './kind';
import type { ItemFields, KindAdapter } from './kind';

/**
 * The Research_Question's own columns (R50.1). Its Question_Groups and their Addresses entries are written by the records pipeline in task 55.2;
 * until then the kind cannot be submitted through the API.
 */
function row(fields: ItemFields) {
  const introduction = richColumns(fields['introduction']);
  return { question: String(fields['question']), introduction: introduction.text, introductionSpans: introduction.spans };
}

export const question: KindAdapter = {
  kind: 'research_question',
  classes: () => ({ question: 'content', introduction: 'content' }),
  load: (db, id) => [db.prepare('SELECT question, introduction, introduction_spans AS introductionSpans FROM research_questions WHERE unit_id = ?1').bind(id)],
  read([result]) {
    const stored = rowsOf<{ question: string; introduction: string | null; introductionSpans: string }>(result)[0];
    if (!stored) return { fields: {} };
    const introduction = richText(stored.introduction, stored.introductionSpans);
    return { fields: { question: stored.question, ...(introduction === undefined ? {} : { introduction }) } };
  },
  dates: () => ({ kind: 'research_question' }),
  insert: (batch, item, fields) => { batch.insert(researchQuestions, { unitId: item.id, ...row(fields) }); },
  update(batch, item, _before, after, changed) {
    if (changed.has('question') || changed.has('introduction')) batch.update(researchQuestions, row(after), eq(researchQuestions.unitId, item.id));
  },
};
