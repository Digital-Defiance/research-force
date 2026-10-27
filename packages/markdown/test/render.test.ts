import { describe, expect, it } from 'vitest';
import { renderMath } from '../src/math';
import { escapeHtml, renderHtml, renderMarkdown, toHtml } from '../src/render';
import { FOOTNOTE_FROM, LabelNotes, alignOffsets, renderNotes } from '../src/overlay';

describe('renderHtml', () => {
  it('escapes only <, >, &, and quotes and keeps every other character', () => {
    expect(escapeHtml(`a<b>&"'ä ß – ∑ 𝔸`)).toBe('a&lt;b&gt;&amp;&quot;&#39;ä ß – ∑ 𝔸');
    expect(renderHtml('Straße — “quoted” ≤ €5')).toBe('<p>Straße — “quoted” ≤ €5</p>');
  });

  it('shows raw HTML as written instead of interpreting it', () => {
    expect(renderHtml('<script>alert(1)</script>')).toBe('<div class="md-html">&lt;script&gt;alert(1)&lt;/script&gt;</div>');
    expect(renderHtml('a <b>bold</b>')).toBe('<p>a &lt;b&gt;bold&lt;/b&gt;</p>');
  });

  it('keeps relative, http(s), and mailto links and drops other schemes', () => {
    expect(renderHtml('[a](/x) [b](https://e.test) [c](mailto:x@e.test) [d](javascript:alert(1)) [e](%20javascript:x)')).toBe(
      '<p><a href="/x">a</a> <a href="https://e.test">b</a> <a href="mailto:x@e.test">c</a> d <a href="%20javascript:x">e</a></p>',
    );
    expect(renderHtml('![pic](data:image/png;base64,AA)')).toBe('<p>pic</p>');
  });

  it('renders tight lists without paragraphs and loose lists with them, and tables with alignment classes', () => {
    expect(renderHtml('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(renderHtml('3. a\n\n4. b')).toBe('<ol start="3"><li><p>a</p></li><li><p>b</p></li></ol>');
    expect(renderHtml('| a | b |\n|:-:|---|\n| 1 | 2 |')).toBe('<table><thead><tr><th class="align-center">a</th><th>b</th></tr></thead><tbody><tr><td class="align-center">1</td><td>2</td></tr></tbody></table>');
  });

  it('renders mathematics as MathML and shows an expression that fails with its delimiters', () => {
    expect(renderHtml('$x$')).toMatch(/^<p><math><semantics>.*<annotation encoding="application\/x-tex">x<\/annotation><\/semantics><\/math><\/p>$/u);
    expect(renderHtml('$$\\frac{a}{b}$$')).toContain('<math display="block" class="tml-display">');
    expect(renderHtml('Costs $\\badmacro$ here')).toBe('<p>Costs <span class="math-source">$\\badmacro$</span> here</p>');
    expect(toHtml(renderMath('\\frac{a', true))).toBe('<span class="math-source">$$\\frac{a$$</span>');
  });

  it('leaves dollar signs that do not form mathematics as written', () => {
    expect(renderHtml('$20,000 and $30,000')).toBe('<p>$20,000 and $30,000</p>');
    expect(renderHtml('a $ b$ and `$x$` and \\$y$')).toBe('<p>a $ b$ and <code>$x$</code> and $y$</p>');
    expect(renderHtml('$a$1')).toBe('<p>$a$1</p>');
  });
});

describe('overlay', () => {
  it('marks a Quote with <q> and a visible label, as one segment across inline markup', () => {
    const { tree } = renderMarkdown('Say *hello world* to all', [{ k: 'quote', s: 4, e: 17, source: 'Ann' }]);
    expect(toHtml(tree)).toBe('<p>Say <q class="labelled labelled-quote"><em>hello world</em></q><span class="label">Quote · Ann</span> to all</p>');
  });

  it('marks Paraphrase and Source_Reported without quotation marks and labels each', () => {
    const { tree } = renderMarkdown('one two three', [{ k: 'paraphrase', s: 0, e: 3, source: 'B' }, { k: 'source_reported', s: 8, e: 13 }]);
    expect(toHtml(tree)).toBe('<p><span class="labelled labelled-paraphrase">one</span><span class="label">Paraphrase · B</span> two '
      + '<span class="labelled labelled-source-reported">three</span><span class="label">Source-reported</span></p>');
  });

  it('gives a span that crosses blocks one segment per block and its label after the last', () => {
    const { tree } = renderMarkdown('first para\n\nsecond para', [{ k: 'quote', s: 6, e: 18, source: 'C' }]);
    expect(toHtml(tree)).toBe('<p>first <q class="labelled labelled-quote">para</q></p><p><q class="labelled labelled-quote">second</q><span class="label">Quote · C</span> para</p>');
  });

  it('identifies marked languages, splitting where they cross a label boundary', () => {
    const { tree } = renderMarkdown('ab cd ef', [{ k: 'quote', s: 0, e: 5, source: 'D' }, { k: 'lang', s: 3, e: 8, lang: 'de' }]);
    expect(toHtml(tree)).toBe('<p><q class="labelled labelled-quote">ab <span lang="de">cd</span></q><span class="label">Quote · D</span><span lang="de"> ef</span></p>');
  });

  it('labels long spans with a numbered footnote collected for the page', () => {
    const long = 'x'.repeat(FOOTNOTE_FROM);
    const notes = new LabelNotes();
    const first = renderMarkdown(long, [{ k: 'quote', s: 0, e: long.length, source: 'E' }], notes);
    const second = renderMarkdown('short', [{ k: 'paraphrase', s: 0, e: 5, source: 'F' }], notes);
    expect(toHtml(first.tree)).toBe(`<p><q class="labelled labelled-quote">${long}</q><sup class="label-ref"><a href="#label-note-1" id="label-note-1-ref">1</a></sup></p>`);
    expect(toHtml(second.tree)).toContain('<span class="label">Paraphrase · F</span>');
    expect(toHtml(renderNotes(notes)!)).toBe('<ol class="label-notes"><li id="label-note-1">Quote · E <a href="#label-note-1-ref" aria-label="Back to reference 1">↩</a></li></ol>');
  });

  it('places labels by source offsets through escapes and character references', () => {
    expect(alignOffsets('a*b&c', 'a\\*b&amp;c', 0, 10)).toEqual([0, 2, 3, 4, 9, 10]);
    const { tree } = renderMarkdown('x \\*y\\* &copy; z', [{ k: 'quote', s: 2, e: 7, source: 'G' }]);
    expect(toHtml(tree)).toBe('<p>x <q class="labelled labelled-quote">*y*</q><span class="label">Quote · G</span> © z</p>');
  });

  it('marks labelled characters inside code spans and code blocks', () => {
    const { tree } = renderMarkdown('```\nab cd\n```', [{ k: 'lang', s: 7, e: 9, lang: 'fr' }]);
    expect(toHtml(tree)).toBe('<pre><code>ab <span lang="fr">cd</span></code></pre>');
  });
});
