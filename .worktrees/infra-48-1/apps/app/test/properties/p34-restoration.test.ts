// Feature: research-collab-cms, Property 34: Restoration changes only content fields
import { describe, expect, it } from 'vitest';
import { GuardedBatch } from '@researchforce/db/batch';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { itemWorld, rich } from '../items';
import type { ItemView } from '../items';
import { addElement, addSubmissionRow } from '../units';

const world = itemWorld();
const STATUSES = ['0000000000000000000000C001', '0000000000000000000000C002', '0000000000000000000000C005'];

type Sections = { id: string; content: { text: string }; disclosure: { level: string } }[];
interface Snapshot { title: unknown; logSummary: unknown; statusValueId: unknown; withdrawalReason: unknown; sections: { id: string; content: { text: string } }[]; levels: Record<string, string> }

const opArb = fc.oneof(
  { arbitrary: fc.record({ type: fc.constant('edit' as const), title: fc.boolean(), summary: fc.boolean(), status: fc.nat({ max: STATUSES.length }), keep: fc.array(fc.boolean(), { maxLength: 4 }), change: fc.array(fc.boolean(), { maxLength: 4 }), add: fc.boolean() }), weight: 4 },
  { arbitrary: fc.record({ type: fc.constant('disclose' as const), section: fc.nat({ max: 5 }) }), weight: 2 },
  { arbitrary: fc.record({ type: fc.constant('withdraw' as const) }), weight: 1 },
);
const runArb = fc.record({ ops: fc.array(opArb, { minLength: 1, maxLength: 5 }), point: fc.nat({ max: 10 }), restorer: fc.constantFrom('author' as const, 'admin' as const) });

const snapshotOf = (view: ItemView): Snapshot => {
  const sections = view['sections'] as Sections;
  return {
    title: view.title, logSummary: view['logSummary'] ?? null, statusValueId: view['statusValueId'] ?? null,
    withdrawalReason: (view.withdrawal as { reason?: string } | null | undefined)?.reason ?? null,
    sections: sections.map((section) => ({ id: section.id, content: section.content })),
    levels: Object.fromEntries(sections.map((section) => [section.id, section.disclosure.level])),
  };
};

describe('Property 34: Restoration changes only content fields', () => {
  it('returns content to the point, keeps status, withdrawal, disclosure, Dissent_Note, and every Revision', async () => {
    const core = world.core();
    let counter = 0;
    await fc.assert(fc.asyncProperty(runArb, async (run) => {
      const created = await world.created('author', 'journal_entry');
      const place = { projectId: world.projectId, ownerId: world.ids.colleague, submissionId: await addSubmissionRow(core, world.ids.colleague, world.at), now: world.at };
      const note = await addElement(core, place, 'dissent_note', created.id);
      const noteRow = () => core.prepare('SELECT u.rev, u.disclosure_level AS level, d.* FROM units u JOIN dissent_notes d ON d.unit_id = u.id WHERE u.id = ?1').bind(note.id).first();
      const noteBefore = await noteRow();
      const revisionIds = async () => (await core.prepare('SELECT id FROM revisions WHERE root_id = ?1 OR target_id = ?1 ORDER BY id').bind(created.id).all<{ id: string }>()).results.map((row) => row.id);
      const latestPoint = async () => (await (await world.request('author', 'GET', `/items/${created.id}/history`)).json<{ entries: { id: string }[] }>()).entries[0]!.id;
      const points = new Map<string, Snapshot>([['creation', snapshotOf(created)]]);
      let view = created;
      const saved = async (next: ItemView) => {
        view = next;
        points.set(await latestPoint(), snapshotOf(next));
      };
      for (const op of run.ops) {
        const current = snapshotOf(view);
        if (op.type === 'edit') {
          const body: Record<string, unknown> = { rev: view.rev, mark: { mark: 'minor_edit' } };
          if (op.title) body['title'] = `Title ${++counter}`;
          if (op.summary) body['logSummary'] = rich(`Summary ${++counter}`);
          const status = STATUSES[op.status];
          if (status !== undefined) body['statusValueId'] = status;
          const sections: { id?: string; content: unknown }[] = current.sections.filter((_section, index) => op.keep[index] !== false)
            .map((section, index) => (op.change[index] ? { id: section.id, content: rich(`${section.content.text}′`) } : section));
          if (op.add || sections.length === 0) sections.push({ content: rich(`S${++counter}`) });
          body['sections'] = sections;
          const response = await world.edit('author', created.id, body);
          expect(response.status).toBe(200);
          await saved((await response.json<{ item: ItemView }>()).item);
        } else if (op.type === 'disclose') {
          const section = current.sections[op.section % current.sections.length]!;
          const level = current.levels[section.id] === 'public' ? 'not_published' : 'public';
          await core.prepare('UPDATE units SET disclosure_level = ?2 WHERE id = ?1').bind(section.id, level).run();
          await new GuardedBatch(core, { id: world.ids.admin, now: world.at })
            .revision({ targetType: 'unit', targetId: section.id, rootId: created.id, kind: 'disclosure_change', prev: { disclosureLevel: current.levels[section.id] } })
            .commit();
          await saved(await world.view('author', created.id));
        } else if (current.withdrawalReason === null) {
          const response = await world.request('author', 'POST', `/items/${created.id}/withdraw`, { rev: view.rev, reason: `Reason ${++counter}`, confirm: { reasonPublic: false } });
          expect(response.status).toBe(200);
          await saved((await response.json<{ item: ItemView }>()).item);
        }
      }
      const ids = [...points.keys()];
      const point = ids[run.point % ids.length]!;
      const target = points.get(point)!;
      const current = snapshotOf(view);
      const before = await revisionIds();

      const response = await world.request(run.restorer, 'POST', `/items/${created.id}/restore`, { rev: view.rev, point });
      expect(response.status).toBe(200);
      const body = await response.json<{ restored: boolean; item: ItemView }>();
      const after = snapshotOf(body.item);
      const summary = run.restorer === 'author' && target.logSummary !== null ? target.logSummary : current.logSummary;
      expect(after).toEqual({
        title: target.title, logSummary: summary, statusValueId: current.statusValueId, withdrawalReason: current.withdrawalReason, sections: target.sections,
        levels: Object.fromEntries(target.sections.map(({ id }) => [id, current.levels[id] ?? 'not_published'])),
      });
      const changed = JSON.stringify([after.title, after.logSummary, after.sections]) !== JSON.stringify([current.title, current.logSummary, current.sections]);
      expect(body.restored).toBe(changed);
      const remaining = await revisionIds();
      expect(remaining.filter((id) => before.includes(id))).toEqual(before);
      expect(remaining.length).toBe(before.length + (changed ? 1 : 0));
      expect(await noteRow()).toEqual(noteBefore);
    }));
  }, 300 * FC_RUNS);
});
