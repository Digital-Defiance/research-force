// Feature: research-collab-cms, Property 33: History reconstructs every past state
import { describe, expect, it } from 'vitest';
import { GuardedBatch } from '@researchforce/db/batch';
import type { HistoryState } from '@researchforce/domain/history';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { itemWorld, rich } from '../items';
import type { ItemView } from '../items';

const world = itemWorld();
const STATUSES = ['0000000000000000000000C001', '0000000000000000000000C002', '0000000000000000000000C003', '0000000000000000000000C004', '0000000000000000000000C005'];

type Content = { text: string; spans?: readonly unknown[] };
type Sections = { id: string; content: Content; disclosure: { level: string } }[];
interface Snapshot { title: unknown; logSummary: unknown; statusValueId: unknown; withdrawalReason: unknown; sections: { id: string; content: Content }[]; levels: Record<string, unknown> }
interface Entry { id: string; kind: string }

const editArb = fc.record({
  type: fc.constant('edit' as const), title: fc.boolean(), summary: fc.boolean(), status: fc.nat({ max: STATUSES.length }),
  keep: fc.array(fc.boolean(), { maxLength: 4 }), change: fc.array(fc.boolean(), { maxLength: 4 }), add: fc.boolean(), label: fc.boolean(), correction: fc.boolean(),
});
const opArb = fc.oneof(
  { arbitrary: editArb, weight: 4 },
  { arbitrary: fc.record({ type: fc.constant('withdraw' as const) }), weight: 1 },
  { arbitrary: fc.record({ type: fc.constant('disclose' as const), section: fc.nat({ max: 5 }) }), weight: 2 },
  { arbitrary: fc.record({ type: fc.constant('restore' as const), point: fc.nat({ max: 10 }) }), weight: 2 },
);

const snapshotOf = (view: ItemView): Snapshot => {
  const sections = view['sections'] as unknown as Sections;
  return {
    title: view.title, logSummary: view['logSummary'] ?? null, statusValueId: view['statusValueId'] ?? null,
    withdrawalReason: (view.withdrawal as { reason?: string } | null | undefined)?.reason ?? null,
    sections: sections.map((section) => ({ id: section.id, content: section.content })),
    levels: Object.fromEntries(sections.map((section) => [section.id, section.disclosure.level])),
  };
};
const reconstructed = (state: HistoryState): Snapshot => {
  const sections = (state.item['sections'] ?? []) as Snapshot['sections'];
  return {
    title: state.item['title'], logSummary: state.item['logSummary'] ?? null, statusValueId: state.item['statusValueId'] ?? null,
    withdrawalReason: state.item['withdrawalReason'] ?? null, sections,
    levels: Object.fromEntries(sections.map((section) => [section.id, state.sections[section.id]?.['disclosureLevel']])),
  };
};

describe('Property 33: History reconstructs every past state', () => {
  it('reconstructs the state after every save, with one Revision per kind each save involved', async () => {
    const core = world.core();
    let counter = 0;
    await fc.assert(fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 6 }), async (ops) => {
      const created = await world.created('author', 'journal_entry');
      const points: string[] = ['creation'];
      const snapshots: Snapshot[] = [snapshotOf(created)];
      const kinds: string[][] = [];
      let view = created;
      let entries = 1;
      const record = async (expected: string[], next: ItemView) => {
        view = next;
        const { entries: listed } = await (await world.request('author', 'GET', `/items/${created.id}/history`)).json<{ entries: Entry[] }>();
        const added = listed.slice(0, listed.length - entries);
        entries = listed.length;
        expect(added.map((entry) => entry.kind).sort()).toEqual([...expected].sort());
        if (added.length === 0) return;
        points.push(added[0]!.id);
        snapshots.push(snapshotOf(next));
        kinds.push(added.map((entry) => entry.kind));
      };
      for (const op of ops) {
        const current = snapshotOf(view);
        if (op.type === 'edit') {
          const body: Record<string, unknown> = { rev: view.rev, mark: op.correction ? { mark: 'correction', reason: 'Synthetic correction.' } : { mark: 'minor_edit' } };
          if (op.title) body['title'] = `Title ${++counter}`;
          if (op.summary) body['logSummary'] = rich(`Summary ${++counter}`);
          const status = STATUSES[op.status];
          if (status !== undefined) body['statusValueId'] = status;
          let sections = current.sections.filter((_section, index) => op.keep[index] !== false)
            .map((section, index) => (op.change[index] ? { ...section, content: rich(`${section.content.text}′`) } : section));
          if (op.label && sections[0] !== undefined) {
            const first = sections[0];
            const spans = (first.content.spans ?? []).length > 0 ? [] : [{ k: 'lang', s: 0, e: 1, lang: 'de' }];
            sections = [{ ...first, content: { ...first.content, spans } }, ...sections.slice(1)];
          }
          if (op.add || sections.length === 0) sections.push({ content: rich(`S${++counter}`) } as Snapshot['sections'][number]);
          body['sections'] = sections.map((section) => (section.id === undefined ? { content: section.content } : section));
          const response = await world.edit('author', created.id, body);
          expect(response.status).toBe(200);
          const next = (await response.json<{ item: ItemView }>()).item;
          const after = snapshotOf(next);
          const content = ['title', 'logSummary', 'sections'].some((key) => JSON.stringify(after[key as keyof Snapshot]) !== JSON.stringify(current[key as keyof Snapshot]));
          const expected = [...(content ? [op.correction ? 'correction' : 'minor_edit'] : []), ...(after.statusValueId === current.statusValueId ? [] : ['status_change'])];
          await record(expected, next);
        } else if (op.type === 'withdraw') {
          if (current.withdrawalReason !== null) continue;
          const response = await world.request('author', 'POST', `/items/${created.id}/withdraw`, { rev: view.rev, reason: `Reason ${++counter}`, confirm: { reasonPublic: false } });
          expect(response.status).toBe(200);
          await record(['withdrawal'], (await response.json<{ item: ItemView }>()).item);
        } else if (op.type === 'disclose') {
          const section = current.sections[op.section % current.sections.length]!;
          const level = current.levels[section.id] === 'public' ? 'not_published' : 'public';
          await core.prepare('UPDATE units SET disclosure_level = ?2 WHERE id = ?1').bind(section.id, level).run();
          await new GuardedBatch(core, { id: world.ids.admin, now: world.at })
            .revision({ targetType: 'unit', targetId: section.id, rootId: created.id, kind: 'disclosure_change', prev: { disclosureLevel: current.levels[section.id] } })
            .commit();
          await record(['disclosure_change'], await world.view('author', created.id));
        } else {
          const point = points[op.point % points.length]!;
          const response = await world.request('author', 'POST', `/items/${created.id}/restore`, { rev: view.rev, point });
          expect(response.status).toBe(200);
          const body = await response.json<{ restored: boolean; item: ItemView }>();
          await record(body.restored ? ['restoration'] : [], body.item);
        }
      }
      for (const save of kinds) expect(new Set(save).size).toBe(save.length);
      for (const [index, point] of points.entries()) {
        const response = await world.request('author', 'GET', `/items/${created.id}/history?point=${point}`);
        expect(response.status).toBe(200);
        const state = reconstructed((await response.json<{ state: HistoryState }>()).state);
        const expected = snapshots[index]!;
        // A reported level is always right; it is known for certain while the section's unit row has lasted since the point.
        const lasted = (id: string) => snapshots.slice(index).every((later) => later.levels[id] !== undefined);
        const levels = Object.fromEntries(expected.sections.map(({ id }) => [id, lasted(id) || state.levels[id] !== undefined ? expected.levels[id] : undefined]));
        expect(state).toEqual({ ...expected, levels });
      }
    }));
  }, 300 * FC_RUNS);
});
