// Feature: research-collab-cms, Property 37: Labels never change text and follow edits
import { expect, it } from 'vitest';
import { fc } from '@researchforce/testing/fc';
import { scalarTextArb } from '../arbitraries';
import { applyEdit, labelsOnlyChanged, validateSpans } from '../../src/richtext';
import type { RichText, Span } from '../../src/richtext';

interface Character { value: string; marks: ReadonlySet<number>; }
type Mark = Omit<Extract<Span, { k: 'lang' }>, 's' | 'e'> | { k: 'quote' | 'paraphrase'; source: string } | { k: 'source_reported'; source: string };
const operationArb = fc.record({
  kind: fc.constantFrom('edit', 'add', 'change', 'remove'),
  a: fc.nat({ max: 100 }), b: fc.nat({ max: 100 }), target: fc.nat({ max: 100 }), insert: scalarTextArb,
});

it('matches a per-character mark model through label operations and edit sequences', () => {
  fc.assert(fc.property(scalarTextArb, fc.array(operationArb, { minLength: 1, maxLength: 35 }), fc.boolean(), (initial, operations, paraphrase) => {
    let characters: Character[] = Array.from(initial, (value) => ({ value, marks: new Set<number>() }));
    let rich: RichText = { text: initial, spans: [] };
    const marks = new Map<number, Mark>();
    let nextId = 0;
    const reconstruct = (): RichText => {
      let position = 0;
      const positions = characters.map((character) => { const start = position; position += character.value.length; return start; });
      const spans: Span[] = [];
      for (const [id, mark] of marks) {
        const indices = characters.flatMap((character, index) => character.marks.has(id) ? [index] : []);
        if (indices.length) {
          const first = indices[0]!;
          const last = indices.at(-1)!;
          spans.push({ ...mark, s: positions[first]!, e: positions[last]! + characters[last]!.value.length });
        }
      }
      return { text: characters.map((character) => character.value).join(''), spans: spans.sort((a, b) => a.s - b.s) };
    };

    for (const operation of operations) {
      const a = operation.a % (characters.length + 1);
      const b = operation.b % (characters.length + 1);
      const from = Math.min(a, b);
      const to = Math.max(a, b);
      const existing = [...marks.keys()].filter((id) => characters.some((character) => character.marks.has(id)));
      if (operation.kind === 'edit') {
        const left = characters[from - 1];
        const right = characters[to];
        const inside = new Set([...(left?.marks ?? [])].filter((id) => right?.marks.has(id)));
        const before = characters.slice(0, from).map((character) => character.value).join('').length;
        const end = characters.slice(0, to).map((character) => character.value).join('').length;
        rich = applyEdit(rich, { from: before, to: end, insert: operation.insert });
        characters = [...characters.slice(0, from), ...Array.from(operation.insert, (value) => ({ value, marks: inside })), ...characters.slice(to)];
      } else {
        const before = rich;
        if (operation.kind === 'add' && from < to) {
          const id = nextId++;
          const hasLanguage = existing.some((entry) => marks.get(entry)!.k === 'lang');
          const mark: Mark = !hasLanguage && operation.target % 3 === 0 ? { k: 'lang', lang: 'de' }
            : operation.target % 2 === 0 ? { k: 'source_reported', source: 'Reported source' }
              : { k: paraphrase ? 'paraphrase' : 'quote', source: 'Original source' };
          marks.set(id, mark);
          characters = characters.map((character, index) => index >= from && index < to ? { ...character, marks: new Set([...character.marks, id]) } : character);
        } else if (existing.length) {
          const id = existing[operation.target % existing.length]!;
          if (operation.kind === 'remove') characters = characters.map((character) => ({ ...character, marks: new Set([...character.marks].filter((value) => value !== id)) }));
          if (operation.kind === 'change') {
            const mark = marks.get(id)!;
            marks.set(id, mark.k === 'lang' ? { k: 'lang', lang: mark.lang === 'de' ? 'fr' : 'de' } : { ...mark, source: `${mark.source} é` });
          }
        }
        rich = reconstruct();
        expect(labelsOnlyChanged(before, rich)).toBe(true);
        expect(rich.text).toBe(before.text);
      }
      const expected = reconstruct();
      // Equal starts can retain different stable orders; annotation meaning is order-independent there.
      const ordered = (spans: readonly Span[]): Span[] => [...spans].sort((a, b) => {
        const value = (span: Span): string => JSON.stringify([span.s, span.e, span.k, 'lang' in span ? span.lang : 'source' in span ? span.source : '']);
        return value(a).localeCompare(value(b));
      });
      expect({ text: rich.text, spans: ordered(rich.spans) }).toEqual({ text: expected.text, spans: ordered(expected.spans) });
      expect(validateSpans(rich)).toEqual([]);
    }
  }), {
    // Regression simplified from seed 2023126397: deleting a prefix gives two marks the same start.
    examples: [['abc', [
      { kind: 'add', a: 1, b: 3, target: 0, insert: '' },
      { kind: 'add', a: 0, b: 2, target: 0, insert: '' },
      { kind: 'edit', a: 0, b: 1, target: 0, insert: '' },
    ], false]],
  });
});
