// Feature: research-collab-cms, Property 67: Journal parsing loses nothing and preserves rendering
import { expect, it } from 'vitest';
import { fc } from '@researchforce/testing/fc';
import { journalMarkdownArb } from '@researchforce/testing/journal';
import { compareJournal } from '../../src/journal/compare';
import { FRONT_MATTER_KEY, parseJournal } from '../../src/journal/parse';

it('creates one entry per Phase_Heading, a front-matter entry exactly when blocks precede the first, and one section per block, list item, and table row', () => {
  fc.assert(fc.property(journalMarkdownArb, ({ markdown, expected }) => {
    const entries = parseJournal(markdown);
    expect(entries.map((entry) => ({ phaseId: entry.phaseId, headingText: entry.headingText, title: entry.title, sections: entry.sections.length }))).toEqual(expected);
    for (const entry of entries) {
      expect(entry.importKey).toBe(entry.phaseId ?? FRONT_MATTER_KEY);
      for (const section of entry.sections) {
        expect(section.unassigned).toBeUndefined();
        expect(Object.keys(section).every((key) => ['text', 'sepBefore', 'group', 'lines'].includes(key))).toBe(true);
        expect(section.sepBefore.trim()).toBe('');
      }
    }
  }));
});

it('the source lines of every section and entry hold its text', () => {
  fc.assert(fc.property(journalMarkdownArb, ({ markdown }) => {
    const lines = markdown.split('\n');
    for (const entry of parseJournal(markdown)) {
      const entryLines = lines.slice(entry.lines[0] - 1, entry.lines[1]).join('\n');
      if (entry.headingRaw !== null) expect(entryLines.startsWith(entry.headingRaw)).toBe(true);
      for (const section of entry.sections) {
        expect(lines.slice(section.lines[0] - 1, section.lines[1]).join('\n')).toContain(section.text);
        expect(entryLines).toContain(section.text);
      }
    }
  }));
});

it('the printed Markdown of an unedited import renders to the same normalized HTML as the source, overall and per entry', () => {
  fc.assert(fc.property(journalMarkdownArb, ({ markdown }) => {
    const comparison = compareJournal(markdown, parseJournal(markdown));
    expect(comparison.passes).toBe(true);
    expect(comparison.mismatches).toEqual([]);
  }));
});
