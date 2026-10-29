import { describe, expect, it } from 'vitest';
import { ITEM_KINDS } from '../src/types';
import { BUILT_IN_VALUE_IDS as builtIn } from '../src/value-sets';
import { validate } from '../src/schemas/common';
import { JOURNAL_LIMITS, researchItemSchema } from '../src/schemas/items';
import { itemFixture, SCHEMA_CONTEXT as context, SCHEMA_IDS as ids, schemaId, schemaText as rt } from './schema-fixtures';

describe('all Research Item kinds', () => {
  it.each(ITEM_KINDS)('accepts a valid %s and refuses server-owned and unknown fields', (kind) => {
    const input = itemFixture(kind);
    const snapshot = structuredClone(input);
    expect(researchItemSchema(kind, context).safeParse(input).success).toBe(true);
    expect(researchItemSchema(kind, context).safeParse({ ...input, ownerId: ids.revoked, disclosureLevel: 'public' }).success).toBe(false);
    expect(input).toEqual(snapshot);
  });

  it.each(ITEM_KINDS)('applies submission, import, and existing-summary rules for %s', (kind) => {
    const input = itemFixture(kind);
    const required = kind !== 'journal_entry' && kind !== 'topic' && kind !== 'research_question';
    for (const summary of [undefined, rt(' \u0085 ')]) expect(researchItemSchema(kind, context).safeParse({ ...input, logSummary: summary }).success).toBe(!required);
    expect(researchItemSchema(kind, context, { mode: 'import' }).safeParse({ ...input, logSummary: undefined }).success).toBe(true);
    const saved = researchItemSchema(kind, context).parse(input);
    const edit = researchItemSchema(kind, context, { mode: 'edit', previous: { logSummary: rt('Saved summary'), sectionCount: 1, sectionCharacters: 14 } });
    expect(edit.safeParse({ ...saved, logSummary: rt('') }).success).toBe(false);
    expect(researchItemSchema(kind, context).safeParse({ ...input, groupNote: rt('   ') }).success).toBe(true);
    expect(researchItemSchema(kind, context).safeParse({ ...input, groupNote: rt('😀'.repeat(50_001)) }).success).toBe(false);
  });
});

describe('Journal Entry limits', () => {
  const fixture = itemFixture('journal_entry');
  const section = { content: rt('x') };

  it('distinguishes submitted, parser-created, and edited entries without accepting a client-selected mode', () => {
    expect(researchItemSchema('journal_entry', context).safeParse({ ...fixture, sections: [] }).success).toBe(false);
    const parser = researchItemSchema('journal_entry', context, { mode: 'parser', sourceBytes: 20_000 });
    expect(parser.safeParse({ ...fixture, sections: [] }).success).toBe(true);
    expect(parser.safeParse({ ...fixture, sections: Array.from({ length: 6000 }, () => section) }).success).toBe(true);
    expect(researchItemSchema('journal_entry', context).safeParse({ ...fixture, sections: Array.from({ length: 5001 }, () => section) }).success).toBe(false);
    const edit = researchItemSchema('journal_entry', context, { mode: 'edit', previous: { sectionCount: 6000, sectionCharacters: 6000 } });
    expect(edit.safeParse({ ...fixture, sections: Array.from({ length: 6000 }, () => section) }).success).toBe(true);
    expect(edit.safeParse({ ...fixture, sections: Array.from({ length: 6001 }, () => section) }).success).toBe(false);
    expect(edit.safeParse({ ...fixture, sections: [] }).success).toBe(false);
    const emptyEdit = researchItemSchema('journal_entry', context, { mode: 'edit', previous: { sectionCount: 0, sectionCharacters: 0 } });
    expect(emptyEdit.safeParse({ ...fixture, sections: [] }).success).toBe(true);
    expect(researchItemSchema('journal_entry', context, { mode: 'restore' }).safeParse({ ...fixture, sections: [] }).success).toBe(true);
    expect(researchItemSchema('journal_entry', context).safeParse({ ...fixture, mode: 'parser', sourceBytes: 0, sections: [] }).success).toBe(false);
    expect(() => researchItemSchema('journal_entry', context, { mode: 'parser', sourceBytes: 2_000_001 })).toThrow(RangeError);
    expect(() => researchItemSchema('journal_entry', context, { mode: 'edit', previous: {} })).toThrow(RangeError);
  });

  it('counts aggregate code points, allows existing oversized entries to shrink, and validates each section', () => {
    const long = rt('😀'.repeat(JOURNAL_LIMITS.codePoints));
    const schema = researchItemSchema('journal_entry', context);
    expect(schema.safeParse({ ...fixture, sections: [{ content: long }] }).success).toBe(true);
    expect(schema.safeParse({ ...fixture, sections: [{ content: { ...long, text: `${long.text}x` } }] }).success).toBe(false);
    const edit = researchItemSchema('journal_entry', context, { mode: 'edit', previous: { sectionCount: 1, sectionCharacters: JOURNAL_LIMITS.codePoints + 1 } });
    expect(edit.safeParse({ ...fixture, sections: [{ content: { ...long, text: `${long.text}x` } }] }).success).toBe(true);
    const result = validate(schema, { ...fixture, title: 123, sections: [{ id: schemaId(500), content: rt('') }, { id: schemaId(500), content: rt('x') }], startDate: { value: '1944', approx: false }, endDate: { value: '1943', approx: false } });
    if (result.ok) throw new Error('Expected all independent errors.');
    expect(result.issues.map((issue) => issue.field)).toEqual(expect.arrayContaining(['title', 'sections.0.content.text', 'sections.1.id', 'endDate']));
  });

  it('checks staged sections by their totals with the same caps, and refuses sections in the body of a staged save', () => {
    const { sections: _sections, ...metadata } = fixture;
    const issues = (options: Parameters<typeof researchItemSchema>[2], input: unknown = metadata) => {
      const result = validate(researchItemSchema('journal_entry', context, options), input);
      return result.ok ? [] : result.issues.map((issue) => `${issue.field}: ${issue.message}`);
    };
    expect(issues({ mode: 'submit', staged: { count: 1, characters: 0 } })).toEqual([]);
    expect(issues({ mode: 'submit', staged: { count: JOURNAL_LIMITS.sections, characters: JOURNAL_LIMITS.codePoints } })).toEqual([]);
    expect(issues({ mode: 'submit', staged: { count: 0, characters: 0 } })).toEqual(['sections: A Journal Entry needs at least one Entry Section.']);
    expect(issues({ mode: 'submit', staged: { count: JOURNAL_LIMITS.sections + 1, characters: 1 } })).toEqual(['sections: A Journal Entry can hold at most 5000 Entry Sections.']);
    expect(issues({ mode: 'submit', staged: { count: 1, characters: JOURNAL_LIMITS.codePoints + 1 } })).toEqual(['sections: Entry Section text must total at most 2000000 Unicode code points.']);
    expect(issues({ mode: 'submit', staged: { count: 1, characters: 1 } }, fixture)).toEqual(['sections: Send the Entry Sections as parts of the staged save.']);
    const previous = { sectionCount: 6000, sectionCharacters: JOURNAL_LIMITS.codePoints + 5 };
    expect(issues({ mode: 'edit', previous, staged: { count: 6000, characters: JOURNAL_LIMITS.codePoints + 5 } })).toEqual([]);
    expect(issues({ mode: 'edit', previous, staged: { count: 6001, characters: 1 } })).toEqual(['sections: A Journal Entry can hold at most 6000 Entry Sections.']);
    expect(issues({ mode: 'edit', previous: { sectionCount: 0, sectionCharacters: 0 }, staged: { count: 0, characters: 0 } })).toEqual([]);
    expect(() => researchItemSchema('journal_entry', context, { mode: 'submit', staged: { count: -1, characters: 0 } })).toThrow(RangeError);
    expect(() => researchItemSchema('journal_entry', context, { mode: 'submit', staged: { count: 1, characters: 0.5 } })).toThrow(RangeError);
  });
});

describe('kind-specific validation', () => {
  it('uses status identities rather than display names for Withdrawn Findings and Eliminated Hypotheses', () => {
    const renamed = { ...context, valueSets: { ...context.valueSets, finding_status: context.valueSets.finding_status!.map((value) => value.id === builtIn.findingWithdrawn ? { ...value, name: 'Renamed status' } : value) } };
    const finding = researchItemSchema('finding', renamed);
    expect(finding.safeParse({ ...itemFixture('finding'), statusValueId: builtIn.findingWithdrawn }).success).toBe(false);
    expect(finding.safeParse({ ...itemFixture('finding'), statusValueId: builtIn.findingWithdrawn, withdrawalReason: 'Evidence corrected' }).success).toBe(true);
    expect(finding.safeParse({ ...itemFixture('finding'), statusValueId: builtIn.findingWithdrawn, withdrawalReason: 'x'.repeat(1001) }).success).toBe(false);
    const hypothesis = researchItemSchema('hypothesis', context);
    expect(hypothesis.safeParse({ ...itemFixture('hypothesis'), statusValueId: builtIn.hypothesisEliminated, eliminationScope: rt(' ') }).success).toBe(false);
    expect(hypothesis.safeParse({ ...itemFixture('hypothesis'), statusValueId: builtIn.hypothesisEliminated, eliminationScope: rt('A limited region') }).success).toBe(true);
    expect(hypothesis.safeParse({ ...itemFixture('hypothesis'), eliminationScope: rt('x'.repeat(1001)) }).success).toBe(false);
  });

  it('validates Source dates at their entered precision and retains retired current selections', () => {
    const source = researchItemSchema('source', context);
    expect(source.safeParse({ ...itemFixture('source'), documentDate: { start: { value: '1943-05', approx: true }, end: { value: '1943', approx: false } } }).success).toBe(true);
    expect(source.safeParse({ ...itemFixture('source'), reliabilityId: ids.retiredReliability }).success).toBe(false);
    const current = { ...context, previousSelections: { reliabilityId: [ids.retiredReliability] } };
    const saved = source.parse(itemFixture('source'));
    expect(researchItemSchema('source', current, { mode: 'edit', previous: {} }).safeParse({ ...saved, reliabilityId: ids.retiredReliability }).success).toBe(true);
    expect(researchItemSchema('source', current).safeParse({ ...saved, reliabilityId: ids.retiredReliability }).success).toBe(false);
    expect(researchItemSchema('source', current, { mode: 'restore' }).safeParse({ ...saved, reliabilityId: ids.retiredReliability }).success).toBe(true);
    const result = validate(source, { ...itemFixture('source'), title: false, sourceKind: 'unknown', documentDate: { start: { value: '1944', approx: false }, end: { value: '1943', approx: false } } });
    if (result.ok) throw new Error('Expected errors.');
    expect(new Set(result.issues.map((issue) => issue.field))).toEqual(new Set(['title', 'sourceKind', 'documentDate.end']));
  });

  it('keeps Run counts as exact digit strings and compares time offsets and long fractions', () => {
    const run = researchItemSchema('run', context);
    const counts = [{ name: 'Keys', value: '123456789012345678901234567890' }, { name: 'Hits', value: '000000000000000000000000000001' }];
    const parsed = run.parse({ ...itemFixture('run'), counts });
    const kind: 'run' = parsed.kind;
    const exactCount: string | undefined = parsed.counts?.[0]?.value;
    expect(kind).toBe('run');
    expect(exactCount).toBe(counts[0]!.value);
    expect(parsed).toMatchObject({ counts });
    for (const value of [-1, 1.5, 10, '-1', '1.5', 'x', '1'.repeat(31)]) expect(run.safeParse({ ...itemFixture('run'), counts: [{ name: 'Keys', value }] }).success).toBe(false);
    expect(run.safeParse({ ...itemFixture('run'), counts: [{ name: 'Keys', value: '0' }, { name: 'Keys', value: '1' }] }).success).toBe(false);
    expect(run.safeParse({ ...itemFixture('run'), counts: Array.from({ length: 21 }, (_, i) => ({ name: String(i), value: '0' })) }).success).toBe(false);
    expect(run.safeParse({ ...itemFixture('run'), startTime: '2026-03-07T12:00:00+05:45', endTime: '2026-03-07T06:15:00Z' }).success).toBe(true);
    expect(run.safeParse({ ...itemFixture('run'), startTime: '2026-03-07T12:00:00.0009Z', endTime: '2026-03-07T12:00:00.0001Z' }).success).toBe(false);
    const result = validate(run, { ...itemFixture('run'), title: 123, startTime: '2026-03-07T12:00:00Z', endTime: '2026-03-07T11:00:00Z', counts: [{ name: 'Keys', value: '0' }, { name: 'Keys', value: '1' }] });
    if (result.ok) throw new Error('Expected independent errors.');
    expect(result.issues.map((issue) => issue.field)).toEqual(expect.arrayContaining(['title', 'endTime', 'counts.1.name']));
  });

  it('checks local today and all Sent and Replied conditions, even beside unrelated type errors', () => {
    const correspondence = researchItemSchema('correspondence', context);
    expect(correspondence.safeParse({ ...itemFixture('correspondence'), date: { value: '2026-03-08', approx: false } }).success).toBe(false);
    const { timeZone: _zone, ...utc } = context;
    expect(researchItemSchema('correspondence', utc).safeParse({ ...itemFixture('correspondence'), date: { value: '2026-03-08', approx: false } }).success).toBe(true);
    expect(correspondence.safeParse({ ...itemFixture('correspondence'), parties: [{ kind: 'member', id: ids.member }, { kind: 'member', id: ids.member }] }).success).toBe(false);
    const archival = researchItemSchema('archival_request', context);
    const invalid = validate(archival, { ...itemFixture('archival_request'), title: 123, statusValueId: builtIn.archivalReplied });
    if (invalid.ok) throw new Error('Expected missing reply fields.');
    expect(new Set(invalid.issues.map((issue) => issue.field))).toEqual(new Set(['title', 'dateSent', 'replyDate', 'replyContent']));
    const replied = { ...itemFixture('archival_request'), statusValueId: builtIn.archivalReplied, dateSent: { value: '2026-03-06', approx: false }, replyDate: { value: '2026-03-07', approx: false }, replyContent: rt('Archive response') };
    expect(archival.safeParse(replied).success).toBe(true);
    expect(archival.safeParse({ ...replied, replyDate: { value: '2026-03-05', approx: false } }).success).toBe(false);
    expect(archival.safeParse({ ...replied, replyDate: { value: '2026-03-08', approx: false } }).success).toBe(false);
  });
});

describe('Research Question limits (R50.1, R50.6)', () => {
  const schema = researchItemSchema('research_question', context);
  const target = (n: number) => '0000000000000000000000' + String(n).padStart(4, '0');
  const group = (heading: string, count: number, start = 0) => ({ heading, entries: Array.from({ length: count }, (_, i) => ({ targetId: target(start + i) })) });
  const accepted = (value: Record<string, unknown>) => schema.safeParse({ ...itemFixture('research_question'), ...value }).success;

  it('takes a question of 1 to 500 characters and an introduction of at most 20,000 with labels', () => {
    expect(accepted({ question: 'Q' })).toBe(true);
    expect(accepted({ question: '😀'.repeat(500) })).toBe(true);
    for (const question of ['', '   ', '😀'.repeat(501)]) expect(accepted({ question })).toBe(false);
    expect(accepted({ question: undefined })).toBe(false);
    expect(accepted({ introduction: rt('😀'.repeat(20_000)) })).toBe(true);
    expect(accepted({ introduction: rt('😀'.repeat(20_001)) })).toBe(false);
    expect(accepted({ introduction: { text: 'Quoted words', spans: [{ k: 'quote', s: 0, e: 6, source: 'A source' }] } })).toBe(true);
    expect(accepted({ introduction: { text: 'Quoted words', spans: [{ k: 'quote', s: 0, e: 6 }] } })).toBe(false);
  });

  it('takes 0 to 20 groups with headings of 1 to 200 characters and at most 200 entries each', () => {
    expect(accepted({ groups: [] })).toBe(true);
    expect(schema.parse(itemFixture('research_question')).groups).toEqual([]);
    expect(accepted({ groups: Array.from({ length: 20 }, (_, i) => group(`Group ${i}`, 1, i)) })).toBe(true);
    expect(accepted({ groups: Array.from({ length: 21 }, (_, i) => group(`Group ${i}`, 1, i)) })).toBe(false);
    expect(accepted({ groups: [group('H'.repeat(200), 0)] })).toBe(true);
    for (const heading of ['', '  ', 'H'.repeat(201)]) expect(accepted({ groups: [group(heading, 0)] })).toBe(false);
    expect(accepted({ groups: [group('Full', 200)] })).toBe(true);
    expect(accepted({ groups: [group('Over', 201)] })).toBe(false);
    expect(accepted({ groups: [{ heading: 'Extra', entries: [], position: 3 }] })).toBe(false);
    expect(accepted({ groups: [{ heading: 'Bad target', entries: [{ targetId: 'not-an-id' }] }] })).toBe(false);
  });

  it('names every entry that repeats a target, in the group or across groups', () => {
    const result = validate(schema, { ...itemFixture('research_question'), groups: [group('One', 2), { heading: 'Two', entries: [{ targetId: target(1) }, { targetId: target(5) }, { targetId: target(0) }] }] });
    if (result.ok) throw new Error('Expected errors.');
    expect(result.issues.map((issue) => issue.field)).toEqual(['groups.1.entries.0.targetId', 'groups.1.entries.2.targetId']);
    expect(accepted({ groups: [group('One', 3), group('Two', 3, 3)] })).toBe(true);
  });

  it('names each invalid value together, not only the first', () => {
    const result = validate(schema, { ...itemFixture('research_question'), title: ' ', question: '', groups: [group('', 1)] });
    if (result.ok) throw new Error('Expected errors.');
    expect(new Set(result.issues.map((issue) => issue.field))).toEqual(new Set(['title', 'question', 'groups.0.heading']));
  });
});
