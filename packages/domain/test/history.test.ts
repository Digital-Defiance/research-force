import { describe, expect, it } from 'vitest';
import { compareFields, wordDiff } from '../src/compare';
import { CREATION, inSaveOrder, sameValue, sectionIds, stableJson, stateAt, undoFields } from '../src/history';
import type { HistoryState, StoredRevision } from '../src/history';
import { addedBack, restoreFields, restoreSection } from '../src/restore';
import type { RichText } from '../src/richtext';

const rich = (text: string, spans: RichText['spans'] = []): RichText => ({ text, spans });
const revision = (id: string, seq: number, prev: Record<string, unknown>, extra: Partial<StoredRevision> = {}): StoredRevision => ({
  id, seq, targetId: 'item', kind: 'minor_edit', prev, ...extra,
});

describe('stableJson and sameValue', () => {
  it('ignore key order and treat missing as null', () => {
    expect(stableJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    expect(sameValue({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(sameValue(undefined, null)).toBe(true);
    expect(sameValue('x', 'y')).toBe(false);
    expect(stableJson(undefined)).toBe('null');
  });
});

describe('inSaveOrder', () => {
  it('orders by save, then by Revision_Kind within a save, then by id', () => {
    const ordered = inSaveOrder([
      revision('d', 2, {}), revision('a', 1, {}, { kind: 'withdrawal' }), revision('c', 1, {}, { kind: 'status_change' }), revision('b', 1, {}, { kind: 'status_change' }),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(['b', 'c', 'a', 'd']);
  });
});

describe('undoFields', () => {
  it('sets stored previous values and removes fields that had none', () => {
    expect(undoFields({ title: 'New', note: 'Added', keep: 1 }, { title: 'Old', note: null })).toEqual({ title: 'Old', keep: 1 });
  });

  it('rebuilds Entry_Sections from the previous order and the content of changed or removed sections', () => {
    const after = { sections: [{ id: 's2', content: rich('two, edited') }, { id: 's3', content: rich('three') }] };
    const before = undoFields(after, { sections: { order: ['s1', 's2'], content: { s1: rich('one'), s2: rich('two') } } });
    expect(before['sections']).toEqual([{ id: 's1', content: rich('one') }, { id: 's2', content: rich('two') }]);
  });

  it('drops a section the previous order names without any content to restore it from', () => {
    const before = undoFields({ sections: [] }, { sections: { order: ['ghost'], content: {} } });
    expect(before['sections']).toEqual([]);
  });

  it('treats a sections value without the order shape as an ordinary field', () => {
    expect(undoFields({ sections: 'x' }, { sections: 'y' })).toEqual({ sections: 'y' });
  });
});

describe('stateAt', () => {
  const current: HistoryState = {
    id: 'item',
    item: { title: 'Third', statusValueId: 'confirmed', sections: [{ id: 's1', content: rich('one') }] },
    sections: { s1: { disclosureLevel: 'public' } },
  };
  const revisions = [
    revision('r1', 1, { title: 'First' }),
    revision('r2', 2, { title: 'Second' }, { kind: 'correction' }),
    revision('r2s', 2, { statusValueId: 'open' }, { kind: 'status_change' }),
    revision('r3', 3, { disclosureLevel: 'private' }, { targetId: 's1', kind: 'disclosure_change' }),
    revision('del', 4, { kind: 'finding' }, { kind: 'deletion' }),
  ];

  it('returns the current state after the newest point', () => {
    expect(stateAt(current, revisions, 'r3')).toEqual(current);
  });

  it('undoes every later save, including Entry_Section Revisions', () => {
    expect(stateAt(current, revisions, 'r2')).toEqual({ ...current, sections: { s1: { disclosureLevel: 'private' } } });
    expect(stateAt(current, revisions, 'r1').item).toEqual({ title: 'Second', statusValueId: 'open', sections: current.item['sections'] });
  });

  it('treats a point as the state after its whole save', () => {
    expect(stateAt(current, revisions, 'r2s')).toEqual(stateAt(current, revisions, 'r2'));
  });

  it('rebuilds the creation state, whatever order the Revisions arrive in', () => {
    const state = stateAt(current, [...revisions].reverse(), CREATION);
    expect(state.item).toEqual({ title: 'First', statusValueId: 'open', sections: current.item['sections'] });
  });

  it('leaves Deletion Revisions out of the reconstruction', () => {
    expect(stateAt(current, revisions, 'del')).toEqual(current);
  });

  it('keeps unit fields only for Entry_Sections the Item has at the point', () => {
    const added: HistoryState = { id: 'item', item: { sections: [{ id: 's1', content: rich('one') }] }, sections: { s1: { disclosureLevel: 'public' } } };
    const history = [revision('add', 1, { sections: { order: [], content: {} } })];
    expect(stateAt(added, history, CREATION)).toEqual({ id: 'item', item: { sections: [] }, sections: {} });
    // A removed section's unit row is gone, so its unit fields at earlier points are unknown and left out.
    const removed: HistoryState = { id: 'item', item: { sections: [] }, sections: {} };
    const removal = [revision('remove', 1, { sections: { order: ['s9'], content: { s9: rich('nine') } } })];
    expect(stateAt(removed, removal, CREATION)).toEqual({ id: 'item', item: { sections: [{ id: 's9', content: rich('nine') }] }, sections: {} });
    // Added back by a Restoration under its old id, the section's new unit row says nothing about the old one.
    const readded: HistoryState = { id: 'item', item: { sections: [{ id: 's9', content: rich('nine') }] }, sections: { s9: { disclosureLevel: 'private' } } };
    const cycle = [
      revision('public', 1, { disclosureLevel: 'private' }, { targetId: 's9', kind: 'disclosure_change' }),
      revision('remove', 2, { sections: { order: ['s9'], content: { s9: rich('nine') } } }),
      revision('back', 3, { sections: { order: [], content: {} } }, { kind: 'restoration' }),
    ];
    expect(stateAt(readded, cycle, 'public').sections).toEqual({});
    expect(stateAt(readded, cycle, 'back').sections).toEqual({ s9: { disclosureLevel: 'private' } });
  });

  it('refuses a point outside the history', () => {
    expect(() => stateAt(current, revisions, 'unknown')).toThrow(RangeError);
  });
});

describe('sectionIds', () => {
  it('covers current sections and every section a Revision of the Item named', () => {
    const current: HistoryState = { id: 'item', item: { sections: [{ id: 's1', content: rich('one') }] }, sections: {} };
    const ids = sectionIds(current, [
      revision('r1', 1, { sections: { order: ['s0', 's1'], content: { s0: rich('zero') } } }),
      revision('r2', 2, { sections: { order: ['other'], content: {} } }, { targetId: 's1' }),
      revision('r3', 3, { title: 'x' }),
    ]);
    expect([...ids].sort()).toEqual(['s0', 's1']);
    expect([...sectionIds({ id: 'item', item: {}, sections: {} }, [])]).toEqual([]);
  });
});

describe('wordDiff', () => {
  it('marks added and removed words', () => {
    expect(wordDiff('the quick brown fox', 'the slow brown fox jumps')).toEqual([
      { value: 'the ' }, { value: 'quick', removed: true }, { value: 'slow', added: true }, { value: ' brown fox' }, { value: ' jumps', added: true },
    ]);
    expect(wordDiff('same', 'same')).toEqual([{ value: 'same' }]);
    expect(wordDiff('', '')).toEqual([]);
  });
});

describe('compareFields', () => {
  it('lists only differing fields, with both values and word diffs for text', () => {
    expect(compareFields({ title: 'Old title', kept: 1, gone: 'x' }, { title: 'New title', kept: 1, added: 2 })).toEqual([
      { field: 'title', before: 'Old title', after: 'New title', words: [{ value: 'Old', removed: true }, { value: 'New', added: true }, { value: ' title' }] },
      { field: 'gone', before: 'x', after: null, words: [{ value: 'x', removed: true }] },
      { field: 'added', before: null, after: 2 },
    ]);
  });

  it('reports label differences of rich text even when the words are the same', () => {
    const label = { s: 0, e: 4, k: 'quote' as const, source: 'Source' };
    expect(compareFields({ claim: rich('Text') }, { claim: rich('Text', [label]) })).toEqual([
      { field: 'claim', before: rich('Text'), after: rich('Text', [label]), words: [{ value: 'Text' }], labels: { removed: [], added: [label] } },
    ]);
    const lang = { s: 0, e: 2, k: 'lang' as const, lang: 'de' };
    const other = { ...label, source: 'Another source' };
    expect(compareFields({ claim: rich('Text', [label, lang]) }, { claim: rich('Text', [other, lang]) })[0]!.labels).toEqual({ removed: [label], added: [other] });
  });

  it('compares Entry_Sections one by one and their order', () => {
    const before = { sections: [{ id: 'a', content: rich('alpha') }, { id: 'b', content: rich('beta') }] };
    const after = { sections: [{ id: 'b', content: rich('beta') }, { id: 'a', content: rich('alpha two') }, { id: 'c', content: rich('gamma') }] };
    expect(compareFields(before, after)).toEqual([
      { field: 'sections.order', before: ['a', 'b'], after: ['b', 'a', 'c'] },
      { field: 'sections.a', before: rich('alpha'), after: rich('alpha two'), words: [{ value: 'alpha' }, { value: ' two', added: true }] },
      { field: 'sections.c', before: null, after: rich('gamma'), words: [{ value: 'gamma', added: true }] },
    ]);
    expect(compareFields({}, { sections: [{ id: 'a', content: rich('x') }] }).map((entry) => entry.field)).toEqual(['sections.order', 'sections.a']);
    expect(compareFields(after, { sections: after.sections.map((section) => (section.id === 'c' ? { id: 'c', content: rich('gamma!') } : section)) }).map((entry) => entry.field)).toEqual(['sections.c']);
  });
});

describe('restoreFields', () => {
  const current = { title: 'Now', statusValueId: 'confirmed', logSummary: rich('Current summary'), added: 'later' };
  const point = { title: 'Then', statusValueId: 'open', logSummary: rich('Old summary'), removed: 'earlier' };
  const kept = new Set(['statusValueId']);

  it('returns every field to the point except the kept fields', () => {
    expect(restoreFields({ current, point, kept, restorerIsOwner: true })).toEqual({ title: 'Then', statusValueId: 'confirmed', logSummary: rich('Old summary'), removed: 'earlier' });
  });

  it('keeps the current Log_Summary when the restorer is not the Owner', () => {
    expect(restoreFields({ current, point, kept, restorerIsOwner: false })['logSummary']).toEqual(rich('Current summary'));
  });

  it('keeps the current Log_Summary when the point had none', () => {
    const { logSummary: _none, ...bare } = point;
    expect(restoreFields({ current, point: bare, kept, restorerIsOwner: true })['logSummary']).toEqual(rich('Current summary'));
  });

  it('leaves out a kept field that has no current value', () => {
    expect(restoreFields({ current: { title: 'Now' }, point: { title: 'Then', statusValueId: 'open' }, kept, restorerIsOwner: true })).toEqual({ title: 'Then' });
  });
});

describe('restoreSection and addedBack', () => {
  const now = [{ id: 'a', content: rich('A2') }, { id: 'c', content: rich('C') }];
  const point = [{ id: 'a', content: rich('A1') }, { id: 'b', content: rich('B') }, { id: 'c', content: rich('C') }];

  it('restores a section the Item still has in place', () => {
    expect(restoreSection(now, point, 'a')).toEqual([{ id: 'a', content: rich('A1') }, now[1]]);
  });

  it('adds a removed section back at its position at the point, or at the end', () => {
    expect(restoreSection(now, point, 'b')).toEqual([now[0], { id: 'b', content: rich('B') }, now[1]]);
    expect(restoreSection([], point, 'c')).toEqual([{ id: 'c', content: rich('C') }]);
  });

  it('refuses a section that did not exist at the point', () => {
    expect(() => restoreSection(now, point, 'z')).toThrow(RangeError);
  });

  it('names the sections a restored list adds back', () => {
    expect(addedBack(now, point)).toEqual(['b']);
    expect(addedBack(point, now)).toEqual([]);
  });
});
