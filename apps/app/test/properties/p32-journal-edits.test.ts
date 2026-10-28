// Feature: research-collab-cms, Property 32: Journal_Entry edits preserve surviving sections and their order
import { describe, expect, it } from 'vitest';
import { newULID } from '@researchforce/domain/identifiers';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { itemWorld, rich } from '../items';
import type { ItemView } from '../items';

const world = itemWorld();
/** Disclosure states a section can hold; Unclassified units stay Not_Published (R26.5). */
const STATES = [
  { level: 'not_published', classification: null, line: null }, { level: 'not_published', classification: 'unclassified', line: null },
  { level: 'public', classification: 'classified', line: null }, { level: 'withheld', classification: null, line: '{"kindOfMaterial":"entry","date":{"value":"2026","approx":false},"partyIds":[]}' },
] as const;

interface ModelSection { id: string; text: string; state: number; links: number; revisions: number }
const editArb = fc.record({
  keep: fc.array(fc.boolean(), { maxLength: 8 }), order: fc.array(fc.nat({ max: 20 }), { maxLength: 8 }),
  change: fc.array(fc.boolean(), { maxLength: 8 }), added: fc.array(fc.nat({ max: 8 }), { maxLength: 2 }),
});
const runArb = fc.record({
  initial: fc.integer({ min: 1, max: 5 }),
  setup: fc.array(fc.record({ state: fc.nat({ max: STATES.length - 1 }), links: fc.nat({ max: 2 }), revisions: fc.nat({ max: 2 }) }), { minLength: 5, maxLength: 5 }),
  edits: fc.array(editArb, { minLength: 1, maxLength: 3 }),
});

describe('Property 32: Journal_Entry edits preserve surviving sections and their order', () => {
  it('keeps each surviving section’s level, classification, Revisions, and links, in the order of the latest save', async () => {
    const core = world.core();
    const others = await Promise.all([0, 1].map(() => world.created('author', 'topic')));
    let counter = 0;
    await fc.assert(fc.asyncProperty(runArb, async (run) => {
      const entry = await world.created('author', 'journal_entry', { sections: Array.from({ length: run.initial }, () => ({ content: rich(`S${++counter}`) })) });
      let model: ModelSection[] = (entry['sections'] as { id: string; content: { text: string } }[]).map((section, index) => ({ id: section.id, text: section.content.text, ...run.setup[index]! }));
      for (const section of model) {
        const state = STATES[section.state]!;
        const statements = [core.prepare('UPDATE units SET disclosure_level = ?2, classification_state = ?3, disclosure_line = ?4 WHERE id = ?1').bind(section.id, state.level, state.classification, state.line)];
        for (let index = 0; index < section.links; index++) {
          statements.push(core.prepare('INSERT INTO cross_links (id, origin_id, target_id, added_by, added_at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(newULID(world.at), others[index]!.id, section.id, world.ids.author, world.at));
        }
        for (let index = 0; index < section.revisions; index++) {
          statements.push(core.prepare("INSERT INTO revisions (id, target_type, target_id, root_id, kind, member_id, at, prev, seq) VALUES (?1, 'unit', ?2, ?3, 'disclosure_change', ?4, ?5, '{}', 0)")
            .bind(newULID(world.at), section.id, entry.id, world.ids.admin, world.at));
        }
        await core.batch(statements);
      }
      let rev = entry.rev;
      for (const edit of run.edits) {
        const removed = model.filter((_section, index) => edit.keep[index] === false);
        let next: (ModelSection | { id?: undefined; text: string })[] = model
          .filter((_section, index) => edit.keep[index] !== false)
          .map((section) => ({ section, key: edit.order[model.indexOf(section)] ?? model.indexOf(section) }))
          .sort((a, b) => a.key - b.key)
          .map(({ section }) => (edit.change[model.indexOf(section)] ? { ...section, text: `${section.text}′` } : section));
        for (const position of edit.added) next.splice(position % (next.length + 1), 0, { text: `S${++counter}` });
        if (next.length === 0) next = [{ text: `S${++counter}` }];
        const response = await world.edit('author', entry.id, {
          rev, mark: { mark: 'minor_edit' }, sections: next.map((section) => ({ ...(section.id === undefined ? {} : { id: section.id }), content: rich(section.text) })),
        });
        expect(response.status).toBe(200);
        const { item } = await response.json<{ item: ItemView }>();
        rev = item.rev;
        const saved = item['sections'] as { id: string; content: { text: string } }[];
        expect(saved.map((section) => section.content.text)).toEqual(next.map((section) => section.text));
        model = next.map((section, index) => (section.id === undefined ? { id: saved[index]!.id, text: section.text, state: 0, links: 0, revisions: 0 } : section as ModelSection));
        expect(saved.map((section) => section.id)).toEqual(model.map((section) => section.id));
        if (removed.length > 0) {
          expect(await core.prepare('SELECT count(*) AS n FROM units WHERE id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(removed.map((section) => section.id))).first('n')).toBe(0);
        }
      }
      const rows = await core.prepare(`SELECT u.id, u.position, u.disclosure_level AS level, u.classification_state AS classification,
          (SELECT count(*) FROM cross_links l WHERE l.target_id = u.id AND l.removed_at IS NULL) AS links,
          (SELECT count(*) FROM revisions r WHERE r.target_id = u.id) AS revisions
        FROM units u WHERE u.parent_id = ?1 AND u.unit_type = 'entry_section' ORDER BY u.position`).bind(entry.id)
        .all<{ id: string; position: number; level: string; classification: string | null; links: number; revisions: number }>();
      expect(rows.results).toEqual(model.map((section, position) => ({
        id: section.id, position, level: STATES[section.state]!.level, classification: STATES[section.state]!.classification, links: section.links, revisions: section.revisions,
      })));
      const shown = await world.view('colleague', entry.id);
      expect((shown['sections'] as { id: string }[]).map((section) => section.id)).toEqual(model.map((section) => section.id));
    }));
  }, 200 * FC_RUNS);
});
