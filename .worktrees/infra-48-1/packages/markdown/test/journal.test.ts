import { describe, expect, it } from 'vitest';
import { resolveAttachmentParent, unreferencedFiles } from '../src/journal/attachments';
import { compareJournal, compareRendered, normalizeHtml } from '../src/journal/compare';
import { FRONT_MATTER_TITLE, MAX_JOURNAL_BYTES, assemble, parseJournal } from '../src/journal/parse';
import { printJournal } from '../src/journal/print';

describe('parseJournal', () => {
  it('titles the front matter from its first non-blank level-1 ATX heading, or with the fixed title', () => {
    expect(parseJournal('#\n\n# Synthetic journal\n\n### 1 First')[0]?.title).toBe('Synthetic journal');
    expect(parseJournal('Intro\n===\n\nText\n\n### 1 First')[0]?.title).toBe(FRONT_MATTER_TITLE);
    expect(parseJournal('### 1 First\n\nText').map((entry) => entry.importKey)).toEqual(['1']);
  });

  it('counts only top-level level-3 ATX headings that start with a number as Phase_Headings', () => {
    const entries = parseJournal('### 51.12 Phase\n\n> ### 2 quoted\n\n- ### 3 listed\n\n#### 4 deeper\n\n### Notes\n\n### 7');
    expect(entries.map((entry) => [entry.phaseId, entry.sections.length])).toEqual([['51.12', 4], ['7', 0]]);
  });

  it('cuts titles at 200 code points', () => {
    const heading = `1 ${'𝔸'.repeat(250)}`;
    const [entry] = parseJournal(`### ${heading}`);
    expect(entry?.headingText).toBe(heading);
    expect(Array.from(entry!.title)).toHaveLength(200);
  });

  it('keeps leading whitespace before a first Phase_Heading so the round trip is exact', () => {
    const source = '\n\n### 1 First\n\nText\n';
    const entries = parseJournal(source);
    expect(entries[0]?.leading).toBe('\n\n');
    expect(printJournal(entries)).toBe(source);
  });

  it('records non-whitespace text outside every block as an unassigned section with its lines', () => {
    const source = '### 1 First\n\nkept\nstray\n';
    const entries = assemble(source, [
      { kind: 'phase', start: 0, end: 11, phaseId: '1', headingText: '1 First' },
      { kind: 'section', start: 13, end: 17 },
    ]);
    expect(entries[0]?.sections).toEqual([
      { text: 'kept', sepBefore: '\n\n', lines: [3, 3] },
      { text: 'stray', sepBefore: '\n', lines: [4, 4], unassigned: true },
    ]);
    expect(printJournal(entries)).toBe(source);
  });

  it('refuses journals over 2 MB', () => {
    expect(() => parseJournal('a'.repeat(MAX_JOURNAL_BYTES + 1))).toThrow(RangeError);
  });
});

describe('printJournal', () => {
  it('separates added sections by a blank line, or a line break within the same list or table, and prints edited headings', () => {
    const printed = printJournal([
      { phaseId: '2', headingText: '2 Edited', sections: [{ text: '- a', group: { kind: 'list', id: 1 } }, { text: '- b', group: { kind: 'list', id: 1 } }, { text: 'After' }] },
      { phaseId: null, headingText: null, sections: [{ text: 'Front' }] },
    ]);
    expect(printed).toBe('### 2 Edited\n\n- a\n- b\n\nAfter\n\nFront\n');
  });
});

describe('compare', () => {
  it('collapses whitespace outside code and ignores leading and trailing whitespace', () => {
    expect(normalizeHtml(' <p>a \n b</p>\n<pre><code>x  y\n</code></pre> ')).toBe('<p>a b</p> <pre><code>x  y\n</code></pre>');
    expect(compareRendered('a\nb', 'a  b')).toBe(true);
    expect(compareRendered('```\na  b\n```', '```\na b\n```')).toBe(false);
  });

  it('names each entry whose printed Markdown renders differently from its source lines', () => {
    const source = '### 1 One\n\nText\n\n### 2 Two\n\nMore\n';
    const entries = parseJournal(source);
    const changed = [entries[0]!, { ...entries[1]!, sections: [{ ...entries[1]!.sections[0]!, text: 'Different' }] }];
    const comparison = compareJournal(source, changed);
    expect(comparison.passes).toBe(false);
    expect(comparison.mismatches).toEqual([{ title: '2 Two', importKey: '2', lines: [5, 7] }]);
    expect(compareJournal(source, entries)).toEqual({ printed: source, passes: true, mismatches: [] });
  });
});

describe('attachments', () => {
  const source = [
    '# Synthetic', 'See [the ledger][ledger].',
    '### 1 One', 'Mentions `files/scan-01.png` in code and <https://site.test/files/letter.pdf>.',
    '### 2 Two', 'Also `files/scan-01.png`, plus ![chart](/files/chart.svg) and /files/notes.txt.',
    '[ledger]: /files/ledger.pdf',
  ].join('\n\n');
  const entries = parseJournal(source);
  const file = (fileName: string) => ({ fileName, sitePath: `/files/${fileName}` });

  it('picks the first entry that references the file by a destination, autolink, or path token', () => {
    expect(['scan-01.png', 'letter.pdf', 'chart.svg', 'notes.txt', 'ledger.pdf'].map((name) => resolveAttachmentParent(entries, file(name))?.importKey))
      .toEqual(['1', '1', '2', '2', 'front-matter']);
  });

  it('lists files that no entry references, without matching mere name fragments', () => {
    expect(unreferencedFiles(entries, [file('scan-01.png'), file('missing.pdf'), file('01.png')]).map((entry) => entry.fileName)).toEqual(['missing.pdf', '01.png']);
  });
});
