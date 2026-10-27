import { eq } from 'drizzle-orm';
import { topics } from '@researchforce/db/schema/core';
import { richColumns, richText, rowsOf } from './kind';
import type { ItemFields, KindAdapter } from './kind';

function row(fields: ItemFields) {
  const body = richColumns(fields['body']);
  return { body: body.text!, bodySpans: body.spans };
}

export const topic: KindAdapter = {
  kind: 'topic',
  classes: () => ({ body: 'content' }),
  load: (db, id) => [db.prepare('SELECT body, body_spans AS bodySpans FROM topics WHERE unit_id = ?1').bind(id)],
  read([result]) {
    const stored = rowsOf<{ body: string; bodySpans: string }>(result)[0];
    return { fields: stored ? { body: richText(stored.body, stored.bodySpans) } : {} };
  },
  dates: () => ({ kind: 'topic' }),
  insert: (batch, item, fields) => { batch.insert(topics, { unitId: item.id, ...row(fields) }); },
  update(batch, item, _before, after, changed) {
    if (changed.has('body')) batch.update(topics, row(after), eq(topics.unitId, item.id));
  },
};
