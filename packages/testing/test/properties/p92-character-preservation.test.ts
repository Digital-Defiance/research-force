// Feature: research-collab-cms, Property 92: Characters and digit strings survive storage and output
import { describe, expect, it } from 'vitest';
import { renderSite } from '@researchforce/public-render/render-site';
import { fileFor } from '@researchforce/public-render/paths';
import type { CreditView, ProjectView, PublicView, ResearchItemView } from '@researchforce/kernel/views';
import { fc, FC_RUNS } from '../../src/fc';
import { isElement, parseHtml, type HtmlNode } from '../../src/html';
import { syntheticSite } from '../../src/site';

/**
 * Validates R7.2, R45.13.
 *
 * Property 92: for any stored text value — letters with diacritics, the letter ß, mixed case, leading, trailing, and
 * inner whitespace, line breaks, typographic punctuation, mathematical symbols, quotes, backslashes, control
 * characters, astral code points, and grapheme clusters — and any digit or numeric-looking string ("007", "000",
 * "9007199254740993", "1e400", "-0"), storing the value and then rendering the Public_Site page that shows it returns
 * the value character for character, with no character replaced by a different character or by a replacement mark, and
 * a digit string stays a string, never coerced to a JS number or reformatted.
 *
 *  - R45.13 — the Research_CMS keeps each character of stored and imported text as that same character on every page,
 *             in every email, and in every Public_Archive_Export, so no character is replaced by a different character
 *             or a replacement mark.
 *  - R7.2  — a Run's stored values, including the free-text and the up-to-30-digit numeric-looking fields, are kept and
 *            shown without rounding or reformatting; a digit string survives as the same string.
 *
 * Chosen layer and pool. The single production path that turns a stored text value into output is the Public_Site
 * build: `renderSite` (packages/public-render/src/render-site.ts) assembles the page tree from the stored views, and
 * the tree is serialised to HTML by the production serialiser `renderToString` (packages/design/src/render-string.ts),
 * whose `escapeHtml` is the exact function R45.13 annotates — it escapes only `< > & " '` and writes every other
 * character unchanged. So this property stores adversarial text in a Research_Item's verbatim text slots (its title,
 * its Item_Identifier, and a Credit name — the fields the item page writes through a plain text node, the way R45.14
 * requires member-supplied text be "shown exactly as stored"), drives the REAL `renderSite` to build and serialise the
 * item's page, and reads the HTML back with the production-mirroring reader (`parseHtml`/`decodeHtml`, which inverts
 * the same five entity escapes). The round trip is store → render → parse → compare, character for character. It never
 * reimplements storage or rendering: the page, its escaping, and its entity decoding all come from production code.
 *
 * This is a pure path — `syntheticSite`, `renderSite`, and `parseHtml` run over generated values with no D1, R2, or
 * Durable Object — so, like the sibling pure properties p72/p73/p75, it lives in the node pool (`packages/<name>/test`
 * runs in node; `apps/<name>/test` runs in the Workers pool), and the p88 per-run reset and the p78 run cap that the
 * stateful export/record properties use do not apply: it runs the full `FC_RUNS` with no setup between runs.
 *
 * Why verbatim slots, not the Markdown render. A Research_Item's rich-text bodies (Public_Summary, Log_Summary, Entry
 * sections) are stored as Markdown, and the Markdown renderer deliberately interprets its own syntax and collapses
 * runs of whitespace, so it is not, and is not meant to be, character-preserving for arbitrary input. R45.13's promise
 * — stored text shown as the same characters — is about the escape-and-output boundary, which the title, identifier,
 * and Credit name exercise directly through a plain text node. Those are the slots this property drives.
 */

// --- Adversarial leaf generators (mirroring p72) ---------------------------------------------------------------------

/** Strings carrying the characters R45.13 names and the characters a round trip through HTML could mangle. */
const trickyString = fc.oneof(
  fc.string({ maxLength: 24 }),
  fc.constantFrom(
    'plain', 'Émile Example', 'äöü façade', 'MiXeD CaSe', '  leading and trailing  ', 'inner   runs   of   space',
    'line one\nline two', 'tab\tbetween', 'carriage\r\nreturn', 'quote "inside" and \\backslash\\', 'a/relative\\path',
    '</script>', '&amp; not decoded', 'null\0byte', 'control\u0001\u001f', 'astral \u{1F9EA} and \u{1D11E}',
    'ẞ ligature', 'the letter ß', 'typographic \u2018\u2019 \u201c\u201d \u2014', 'maths \u2211 \u221a \u2260 \u00b1',
    'grapheme e\u0301 and \u{1F469}\u200d\u{1F4BB}', '\u6b4b\u672c\u8a9e', '\u0639\u0631\u0628\u064a',
    'zero\u200bwidth', '\u00a0nbsp\u00a0',
  ),
);
/** Digit strings and numeric-looking strings that must survive AS STRINGS, never coerced to a JS number (R7.2, R45.13). */
const digitString = fc.oneof(
  fc.string({ unit: fc.constantFrom(...'0123456789'.split('')), minLength: 1, maxLength: 30 }),
  fc.constantFrom('0', '007', '000', '9007199254740993', '12345678901234567890', '123456789012345678901234567890', '1e400', '0.1000', '-0', '+1', '3.14', '0x10'),
);
/** The adversarial core of a slot: tricky text or a digit string, leaning on the digit strings. */
const coreText = fc.oneof({ weight: 3, arbitrary: trickyString }, { weight: 2, arbitrary: digitString });

/**
 * Each stored value wraps its adversarial core between two rare, non-ASCII sentinel characters, carrying a per-slot tag
 * so the stored string is itself unique and locatable in the page's visible text. Adjacent text nodes concatenate in
 * HTML, and a lone space or an empty core is not an isolated node, so the test looks for the whole stored string as a
 * substring of the recovered text — character for character, sentinels and all — rather than as a standalone node. The
 * sentinels are themselves characters R45.13 must preserve.
 */
const marked = (tag: string, core: string): string => `\u2045${tag}\u27e6${core}\u27e7\u2046`;
const slotArb = (tag: string): fc.Arbitrary<string> => coreText.map((core) => marked(tag, core));

const creditArb: fc.Arbitrary<CreditView> = fc.record(
  { name: slotArb('cn'), affiliation: slotArb('ca'), profiled: fc.constant(true as const) },
  { requiredKeys: ['name'] },
);

/** A Research_Item view carrying the generated text in its verbatim slots, keyed as the Public_Site stores it. */
const itemArb: fc.Arbitrary<ResearchItemView> = fc.record({
  title: slotArb('ti'),
  identifier: slotArb('id'),
  digitIdentifier: digitString,
  credit: fc.array(creditArb, { maxLength: 3 }),
}).map(({ title, identifier, digitIdentifier, credit }) => ({
  tag: 'research_item', key: 'u:1', path: '/p/synthetic/findings/u-1', kind: 'finding', title,
  itemDate: { value: '1950-03', approx: false }, logDate: { value: '1950', approx: false },
  // Half the runs carry a bare digit/numeric-looking identifier (the R7.2/R45.13 "stays a string" slot); the rest
  // carry a marked adversarial identifier, so the identifier exercises both coercion risk and arbitrary characters.
  credit, identifier: digitIdentifier.length % 2 === 0 ? digitIdentifier : identifier,
  project: { key: 'p:1', name: 'Synthetic', slug: 'synthetic', path: '/p/synthetic' },
  firstPublicOn: '2026-01-05', attachments: [], links: [],
}));

const PROJECT: ProjectView = { tag: 'project', key: 'p:1', path: '/p/synthetic', name: 'Synthetic', description: 'Synthetic.', slug: 'synthetic' };

/** Every text node under the nodes, in document order; the reader has already decoded each entity back to its character. */
function* textNodes(nodes: readonly HtmlNode[]): Generator<string> {
  for (const node of nodes) {
    if (isElement(node)) yield* textNodes(node.children);
    else yield node;
  }
}

/** Render the item's Public_Site page with the real build and read its text nodes back the way a reader's browser does. */
function renderedText(item: ResearchItemView): string[] {
  const site = syntheticSite([PROJECT, item as PublicView]);
  const files = new Map(renderSite(site).map((file) => [file.file, file.content]));
  const html = files.get(fileFor(item.path));
  if (html === undefined) throw new Error('The item page was not rendered.');
  return [...textNodes(parseHtml(html))];
}

describe('Property 92: Characters and digit strings survive storage and output', () => {
  it('renders every stored character of a title, identifier, and Credit name back unchanged, with digit strings kept as strings', () => {
    fc.assert(fc.property(itemArb, (item) => {
      // Store the adversarial text, then drive the REAL Public_Site render and read the page back. The recovered text
      // is every visible character the page shows, in document order, with each HTML entity already decoded to its
      // character by the production-mirroring reader.
      const recovered = renderedText(item).join('');
      // A stored value is shown exactly as stored iff its whole string occurs, character for character, somewhere in
      // the recovered text — no whitespace trimmed, no character replaced, and no replacement mark (R45.13). Adjacent
      // text nodes concatenate in HTML, so the check is substring containment, not an isolated node; the per-slot
      // sentinels keep each stored value unique so the match is its own value, not a coincidence of fixed page text.
      const shownVerbatim = (value: string): boolean => recovered.includes(value);

      // The title is shown exactly as stored (R45.13).
      expect(shownVerbatim(item.title), `title ${JSON.stringify(item.title)} is shown character for character`).toBe(true);

      // The Item_Identifier comes back the SAME string, never coerced to a JS number or reformatted; `renderSite` kept
      // it a string the whole way, so its characters appear unchanged (R7.2, R45.13). A JS-number round trip would have
      // dropped a leading zero, overflowed past 2^53, or rewritten `1e400`/`-0`, so the exact-substring match is the
      // guard that no numeric coercion happened.
      expect(typeof item.identifier, 'the stored identifier is a string').toBe('string');
      expect(shownVerbatim(item.identifier), `identifier ${JSON.stringify(item.identifier)} survives as the same string`).toBe(true);

      // Each Credit name and affiliation is shown exactly as stored, character for character (R45.13, R46.5).
      for (const credit of item.credit) {
        expect(shownVerbatim(credit.name), `credit name ${JSON.stringify(credit.name)} is shown character for character`).toBe(true);
        if (credit.affiliation !== undefined) {
          expect(shownVerbatim(credit.affiliation), `credit affiliation ${JSON.stringify(credit.affiliation)} is shown character for character`).toBe(true);
        }
      }

      // R45.13's "no replacement mark": the render introduces no U+FFFD that the stored text did not already carry.
      const stored = [item.title, item.identifier, ...item.credit.flatMap((credit) => [credit.name, credit.affiliation ?? ''])];
      if (!stored.some((value) => value.includes('\uFFFD'))) {
        expect(recovered.includes('\uFFFD'), 'no stored character was replaced by a U+FFFD replacement mark').toBe(false);
      }
    }), { numRuns: FC_RUNS });
  }, 50 * FC_RUNS);
});
