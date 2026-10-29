import { fc } from './fc';

/** What the Journal_Parser must produce for a generated journal (R27.1 to R27.3). */
export interface ExpectedEntry {
  readonly phaseId: string | null;
  readonly headingText: string | null;
  readonly title: string;
  readonly sections: number;
}
export interface JournalCase { readonly markdown: string; readonly expected: readonly ExpectedEntry[]; }

interface Block {
  readonly source: string;
  readonly sections: number;
  readonly phase?: { readonly id: string; readonly text: string };
  /** The text of a level-1 ATX heading. */
  readonly level1?: string;
}

// Synthetic vocabulary only: Unicode letters, typographic punctuation, mathematical symbols, and an astral character.
const WORDS = ['alpha', 'ünder', 'straße', 'naïve', 'résumé', 'Ωmega', 'Кирилл', 'a–b', '“quoted”', 'it’s', '∑x', '≤', '€5', '𝔸lgebra', 'log'];
const wordArb = fc.constantFrom(...WORDS);
const wordsArb = (min: number, max: number): fc.Arbitrary<string> => fc.array(wordArb, { minLength: min, maxLength: max }).map((list) => list.join(' '));
const inlineArb = fc.oneof(
  { weight: 6, arbitrary: wordArb },
  { weight: 1, arbitrary: fc.constantFrom('`code $x$`', '`a.pdf`', '*em*', '**strong**', '[link](https://example.test/a)', '$x^2$', '$\\frac{a}{b}$', '$5 and', 'x\\_y', '&amp;', '\\$7', '<span>raw</span>') },
);
const lineArb = fc.array(inlineArb, { minLength: 1, maxLength: 6 }).map((parts) => parts.join(' '));
const phaseIdArb = fc.oneof(fc.nat({ max: 120 }).map(String), fc.tuple(fc.nat({ max: 90 }), fc.nat({ max: 30 })).map(([a, b]) => `${a}.${b}`), fc.constant('51.12.3'));

const phaseArb: fc.Arbitrary<Block> = fc.record({
  id: phaseIdArb, rest: fc.oneof(wordsArb(0, 4), fc.constant('*bold* `code`'), wordsArb(60, 80)), closing: fc.boolean(),
}).map(({ id, rest, closing }) => {
  const text = rest ? `${id} ${rest}` : id;
  return { source: `### ${text}${closing ? ' ###' : ''}`, sections: 0, phase: { id, text } };
});
const headingArb: fc.Arbitrary<Block> = fc.oneof(
  wordsArb(1, 4).map((text) => ({ source: `# ${text}`, sections: 1, level1: text })),
  fc.constant({ source: '#', sections: 1, level1: '' }),
  fc.tuple(fc.constantFrom('##', '####', '#####'), wordsArb(1, 3)).map(([marks, text]) => ({ source: `${marks} ${text}`, sections: 1 })),
  wordsArb(1, 3).map((text) => ({ source: `#### 3 ${text}`, sections: 1 })),
  wordsArb(1, 3).map((text) => ({ source: `### Notes ${text}`, sections: 1 })),
);
const paragraphArb: fc.Arbitrary<Block> = fc.array(lineArb, { minLength: 1, maxLength: 3 }).map((lines) => ({ source: lines.join('\n'), sections: 1 }));
const listArb: fc.Arbitrary<Block> = fc.record({
  ordered: fc.boolean(), start: fc.integer({ min: 1, max: 12 }), bullet: fc.constantFrom('-', '*', '+'), loose: fc.boolean(),
  items: fc.array(fc.record({ text: lineArb, nested: fc.option(fc.array(wordsArb(1, 3), { minLength: 1, maxLength: 2 }), { nil: undefined }) }), { minLength: 1, maxLength: 4 }),
}).map(({ ordered, start, bullet, loose, items }) => {
  const source = items.map((item, index) => {
    const marker = ordered ? `${start + index}.` : bullet;
    const indent = ' '.repeat(marker.length + 1);
    const nested = item.nested ? item.nested.map((text) => `\n${indent}- ${text}`).join('') : '';
    return `${marker} ${item.text}${nested}`;
  }).join(loose ? '\n\n' : '\n');
  return { source, sections: items.length };
});
const tableArb: fc.Arbitrary<Block> = fc.integer({ min: 1, max: 3 }).chain((columns) => fc.record({
  header: fc.array(wordArb, { minLength: columns, maxLength: columns }),
  align: fc.array(fc.constantFrom('---', ':--', '--:', ':-:'), { minLength: columns, maxLength: columns }),
  rows: fc.array(fc.array(fc.oneof(wordArb, fc.constant('`x`'), fc.constant('$y$')), { minLength: columns, maxLength: columns }), { maxLength: 3 }),
})).map(({ header, align, rows }) => {
  const row = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;
  return { source: [row(header), row(align), ...rows.map(row)].join('\n'), sections: 1 + rows.length };
});
const codeArb: fc.Arbitrary<Block> = fc.record({
  fence: fc.constantFrom('```', '~~~'), lang: fc.constantFrom('', 'js', 'text'),
  lines: fc.array(fc.constantFrom('### 1 not a heading', '- not a list', '| not | a table |', '$x$ and $$y$$', '', 'let x = 1 < 2;', '    indented'), { maxLength: 4 }),
}).map(({ fence, lang, lines }) => ({ source: [`${fence}${lang}`, ...lines, fence].join('\n'), sections: 1 }));
const mathArb: fc.Arbitrary<Block> = fc.constantFrom('$$\n\\sum_{i=1}^{n} i\n$$', '$$x^2 + y^2$$', '$$\n\\badmacro{}\n$$').map((source) => ({ source, sections: 1 }));
const htmlArb: fc.Arbitrary<Block> = wordsArb(1, 3).chain((text) => fc.constantFrom(
  `<div class="note">\n${text}\n</div>`, `<!-- ${text} -->`, `<details>\n<summary>${text}</summary>\n${text}\n</details>`,
)).map((source) => ({ source, sections: 1 }));
const definitionArb: fc.Arbitrary<Block> = fc.record({ label: fc.constantFrom('ref', 'ledger', 'a b'), slug: fc.constantFrom('x.pdf', 'files/y.png'), title: fc.boolean() })
  .map(({ label, slug, title }) => ({ source: `[${label}]: https://example.test/${slug}${title ? ' "A title"' : ''}`, sections: 1 }));
const quoteArb: fc.Arbitrary<Block> = fc.array(lineArb, { minLength: 1, maxLength: 2 }).map((lines) => ({ source: lines.map((line) => `> ${line}`).join('\n'), sections: 1 }));
const ruleArb: fc.Arbitrary<Block> = fc.constantFrom('---', '***', '___').map((source) => ({ source, sections: 1 }));
const strayArb: fc.Arbitrary<Block> = fc.constantFrom('\\', '&copy; 1943', '<br>', '+++', '|', '%%', '[unmatched', '$').map((source) => ({ source, sections: 1 }));

const blockArb: fc.Arbitrary<Block> = fc.oneof(
  { weight: 3, arbitrary: phaseArb }, { weight: 2, arbitrary: headingArb }, { weight: 4, arbitrary: paragraphArb }, { weight: 3, arbitrary: listArb },
  { weight: 2, arbitrary: tableArb }, { weight: 1, arbitrary: codeArb }, { weight: 1, arbitrary: mathArb }, { weight: 1, arbitrary: htmlArb },
  { weight: 1, arbitrary: definitionArb }, { weight: 1, arbitrary: quoteArb }, { weight: 1, arbitrary: ruleArb }, { weight: 1, arbitrary: strayArb },
);
const separatorArb = fc.constantFrom('\n\n', '\n\n', '\n\n\n', '\n \n', '\n\t\n', '\n  \n\n');

const cut = (value: string): string => Array.from(value).slice(0, 200).join('');

/** Synthetic journal Markdown from a block grammar, with the entries and section counts the parser must produce. */
export const journalMarkdownArb: fc.Arbitrary<JournalCase> = fc.record({
  blocks: fc.array(blockArb, { minLength: 1, maxLength: 14 }),
  separators: fc.array(separatorArb, { minLength: 14, maxLength: 14 }),
  leading: fc.constantFrom('', '', '\n', '\n\n'),
  ending: fc.constantFrom('', '\n', '\n', '\n\n'),
}).map(({ blocks, separators, leading, ending }) => {
  const markdown = leading + blocks.map((block, index) => (index ? separators[index - 1]! : '') + block.source).join('') + ending;
  const expected: { phaseId: string | null; headingText: string | null; title: string; sections: number; titled?: true }[] = [];
  for (const block of blocks) {
    if (block.phase) { expected.push({ phaseId: block.phase.id, headingText: block.phase.text, title: cut(block.phase.text), sections: 0 }); continue; }
    let entry = expected.at(-1);
    if (!entry) { entry = { phaseId: null, headingText: null, title: 'Journal front matter', sections: 0 }; expected.push(entry); }
    entry.sections += block.sections;
    if (entry.phaseId === null && !entry.titled && block.level1 !== undefined && block.level1.trim() !== '') { entry.title = cut(block.level1); entry.titled = true; }
  }
  return { markdown, expected: expected.map(({ phaseId, headingText, title, sections }) => ({ phaseId, headingText, title, sections })) };
});
