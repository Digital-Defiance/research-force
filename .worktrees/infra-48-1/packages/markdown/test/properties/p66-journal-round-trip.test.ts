// Feature: research-collab-cms, Property 66: Journal print and parse round trip
import { expect, it } from 'vitest';
import { fc } from '@researchforce/testing/fc';
import { journalMarkdownArb } from '@researchforce/testing/journal';
import { parseJournal } from '../../src/journal/parse';
import type { ParsedEntry } from '../../src/journal/parse';
import { printJournal } from '../../src/journal/print';
import type { PrintableEntry } from '../../src/journal/print';

const shape = (entries: readonly ParsedEntry[]) => entries.map((entry) => ({
  phaseId: entry.phaseId, headingText: entry.headingText, title: entry.title, sections: entry.sections.map((section) => section.text),
}));

it('printing the parsed entries gives back the input exactly, and parsing the output gives the same entries and sections', () => {
  fc.assert(fc.property(journalMarkdownArb, ({ markdown }) => {
    const entries = parseJournal(markdown);
    const printed = printJournal(entries);
    expect(printed).toBe(markdown);
    expect(shape(parseJournal(printed))).toEqual(shape(entries));
  }));
});

it('sections without stored separators and edited headings print so that parsing gives the same entries and sections', () => {
  fc.assert(fc.property(journalMarkdownArb, fc.integer(), ({ markdown }, seed) => {
    const entries = parseJournal(markdown);
    const drop = (index: number): boolean => ((index + 1) * 2654435761 + seed) % 3 === 0;
    let counter = 0;
    const edited = entries.map((entry): PrintableEntry => ({
      phaseId: entry.phaseId, headingText: entry.headingText, leading: entry.leading, trailing: entry.trailing,
      headingRaw: drop(counter++) ? null : entry.headingRaw,
      sections: entry.sections.map((section) => (drop(counter++) ? { text: section.text, ...(section.group ? { group: section.group } : {}) } : section)),
    }));
    expect(shape(parseJournal(printJournal(edited)))).toEqual(shape(entries));
  }));
});
