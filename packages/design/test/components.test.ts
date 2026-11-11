import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { labelTextFor } from '@researchforce/domain/label-marks';
import { text, type ViewNode } from '@researchforce/domain/tree';
import {
  attachmentList, brandMark, breadcrumb, button, card, citationBlock, dataTable, disclosureLineBlock, dissentNoteBlock, emptyState, formField, labelMark, linkButton,
  mainContent, notice, pageHeader, pageLayout, pageWindow, pagination, siteFooter, siteHeader, skeleton, statusBlock, tabs, ACCESS_DATE_PLACEHOLDER, FORM_FOOTER_LINK,
} from '../src/components/index';
import { GROUP_STATEMENT, POLICY_PAGES, SITE_PATHS } from '../src/fixed-texts';
import { renderToString } from '../src/render-string';

const LICENCE = { name: 'Example Licence 1.0', url: 'https://licences.example/1.0' };
/** Visible text: tags removed, entities decoded, and visually hidden text kept, as a screen reader reads it. */
const visible = (node: ViewNode): string => renderToString(node).replace(/<[^>]*>/gu, '')
  .replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"').replace(/&#x27;/gu, "'").replace(/&amp;/gu, '&');

describe('page frame', () => {
  it('starts with a skip link to the main landmark and a masthead link to the given home', () => {
    const html = renderToString(siteHeader({ home: '/workspace', name: 'Synthetic Collective', strapline: 'A visibly different strapline', navigation: [{ label: 'Items', href: '/items', current: true }, { label: 'Logs', href: '/logs' }] }));
    expect(html).toMatch(/^<a class="rf-skip-link" href="#main">Skip to main content<\/a><header/u);
    expect(html).toContain('<header class="rf-header rf-header--site">');
    expect(html).toContain('href="/workspace"><svg class="rf-mark rf-mark--header"');
    expect(html).toContain('</svg><span class="rf-header__name">Synthetic Collective</span><span class="rf-header__strapline">A visibly different strapline</span></a>');
    expect(html).toContain('<nav class="rf-nav" aria-label="Main">');
    expect(html).toContain('href="/items" aria-current="page">Items</a>');
    expect(html).not.toContain('href="/logs" aria-current');
    expect(renderToString(mainContent([]))).toBe('<main id="main" class="rf-main" tabindex="-1"></main>');
    expect(renderToString(mainContent([], 'rf-main--bleed'))).toBe('<main id="main" class="rf-main rf-main--bleed" tabindex="-1"></main>');
  });

  it('notes that the site is open source and links its source code on GitHub, apart from the content licence', () => {
    const html = renderToString(siteFooter(LICENCE));
    expect(html).toContain('<p class="rf-footer__source">ResearchForce is itself an open source project.');
    expect(html).toContain('<a href="https://github.com/Digital-Defiance/research-force" rel="noopener noreferrer">ResearchForce source code on GitHub</a>');
    expect(html).toContain('MIT licence, which is separate from the licence for published work');
    expect(html).not.toMatch(/[{}]/u);
  });
  it('puts the Group_Statement, the copyright statement with the licence link, and the six Policy_Pages and the form in the footer', () => {
    const footer = siteFooter(LICENCE);
    const html = renderToString(footer);
    expect(visible(footer)).toContain(GROUP_STATEMENT.paragraphs[0]);
    expect(html).toContain(`<a href="${LICENCE.url}" rel="license">${LICENCE.name}</a>`);
    expect(visible(footer)).not.toMatch(/[{}]/u);
    const links = [...html.matchAll(/<a class="rf-footer-nav__link" href="([^"]*)">([^<]*)<\/a>/gu)].map((match) => [match[2], match[1]]);
    expect(links).toEqual([...POLICY_PAGES.map((page) => [page.title, page.path]), [FORM_FOOTER_LINK, SITE_PATHS.submit]]);
  });
});

describe('brand mark', () => {
  it('is a decorative inline drawing that follows the text colour', () => {
    const html = renderToString(brandMark('rf-mark--hero'));
    expect(html).toMatch(/^<svg class="rf-mark rf-mark--hero"/u);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('stroke="currentColor"');
    expect(html).not.toMatch(/<title|style=|<use/u);
  });

  it('adds the wordmark to the footer only when given a name', () => {
    expect(renderToString(siteFooter(LICENCE))).not.toContain('rf-footer__brand');
    expect(renderToString(siteFooter(LICENCE, 'Synthetic Collective'))).toContain('<span class="rf-footer__name">Synthetic Collective</span>');
  });
});

describe('controls', () => {
  it('writes buttons with an explicit type and a variant class', () => {
    expect(renderToString(button({ label: 'Save', variant: 'primary', type: 'submit' }))).toBe('<button class="rf-button rf-button--primary" type="submit">Save</button>');
    expect(renderToString(button({ label: 'Remove', attributes: { 'data-action': 'remove' }, disabled: true })))
      .toBe('<button data-action="remove" class="rf-button rf-button--secondary" type="button" disabled="">Remove</button>');
    expect(renderToString(linkButton({ label: 'Open', href: '/x' }))).toBe('<a class="rf-button rf-button--secondary" href="/x">Open</a>');
  });

  it('labels each field and ties its hint and labelled error to the control', () => {
    const field = formField({ id: 'title', label: 'Title', hint: 'Shown on the page', error: 'Enter a title of at most 200 characters.', required: true, value: 'x' });
    const html = renderToString(field);
    expect(html).toContain('<label class="rf-field__label" for="title">Title<span class="rf-field__required"> (required)</span></label>');
    expect(html).toContain('<p class="rf-field__hint" id="title-hint">Shown on the page</p>');
    expect(html).toContain('<p class="rf-field__error" id="title-error"><span class="rf-visually-hidden">Error: </span>Enter a title of at most 200 characters.</p>');
    expect(html).toContain('<input id="title" name="title" required="" aria-describedby="title-hint title-error" aria-invalid="true" class="rf-input" type="text" value="x">');
    expect(html).toMatch(/^<div class="rf-field rf-field--invalid">/u);
    const plain = renderToString(formField({ id: 'q', label: 'Search', control: 'search' }));
    expect(plain).not.toMatch(/aria-describedby|aria-invalid|required/u);
  });

  it('writes textareas, selects, and checkboxes with their values', () => {
    expect(renderToString(formField({ id: 'b', label: 'Body', control: 'textarea', value: 'a < b' }))).toContain('<textarea id="b" name="b" class="rf-input rf-input--textarea" rows="6">a &lt; b</textarea>');
    const select = renderToString(formField({ id: 's', label: 'Kind', control: 'select', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B', selected: true }] }));
    expect(select).toContain('<option value="a">A</option><option value="b" selected="">B</option>');
    const checkbox = renderToString(formField({ id: 'c', label: 'Agree', control: 'checkbox', checked: true }));
    expect(checkbox).toMatch(/^<div class="rf-field rf-field--checkbox"><input [^>]*type="checkbox"[^>]*checked=""><label/u);
  });
});

describe('notices and statuses', () => {
  it('gives notices a role only when asked', () => {
    expect(renderToString(notice({ body: [text('Saved.')], tone: 'success', role: 'status' }))).toBe('<div class="rf-notice rf-notice--success" role="status"><div class="rf-notice__body">Saved.</div></div>');
    expect(renderToString(notice({ body: [text('Withdrawn.')], title: 'Notice' }))).toBe('<div class="rf-notice rf-notice--info"><p class="rf-notice__title">Notice</p><div class="rf-notice__body">Withdrawn.</div></div>');
  });

  it('keeps a status label and its companion fields in one block, linked to their Methods entries', () => {
    const html = renderToString(statusBlock({ label: 'Supported', href: '/methods#finding-status', tone: 'success' }, [{ label: 'Scope caveat', labelHref: '/methods#scope-caveat', value: [text('Two sites only.')] }]));
    expect(html).toBe('<div class="rf-status-block"><a class="rf-status rf-status--success" href="/methods#finding-status">Supported</a>'
      + '<p class="rf-companion"><span class="rf-companion__label"><a href="/methods#scope-caveat">Scope caveat</a>:</span> <span class="rf-companion__value">Two sites only.</span></p></div>');
  });
});

describe('content blocks', () => {
  it('marks labelled characters and shows the kind and source, or a footnote reference', () => {
    expect(visible(labelMark({ kind: 'paraphrase', source: 'A. Writer' }, [text('the claim')]))).toBe(`the claim${labelTextFor('paraphrase', 'A. Writer')}`);
    const marked = renderToString(labelMark({ kind: 'quote', source: 'B' }, [text('words')]).children[0]!);
    expect(marked).toBe('<q class="labelled labelled-quote">words</q>');
    expect(renderToString(labelMark({ kind: 'source_reported', footnote: { number: 2, id: 'label-2' } }, [text('x')]))).toContain('<sup class="label-ref"><a href="#label-2"');
  });

  it('writes the citation line with the access-date placeholder for the local-date script', () => {
    const html = renderToString(citationBlock([text('Writer, A. (2026). Title. ResearchForce. https://example.org/items/1')]));
    expect(html).toContain(`<span class="rf-citation__access" data-citation-access="">${ACCESS_DATE_PLACEHOLDER}</span>.`);
    expect(html).toContain('<h2 class="rf-citation__heading" id="cite-heading">Cite this item</h2>');
  });

  it('lists attachments with kind, size, credit, and caption', () => {
    const list = attachmentList([{ title: 'Scan', href: '/a/scan.pdf', kind: 'PDF', sizeLabel: '2 MB', credit: 'C. Owner', caption: 'Front page' }, { title: 'Photo', href: '/a/p.jpg', kind: 'Image' }]);
    expect(visible(list)).toBe('ScanPDF · 2 MB · Credit: C. OwnerFront pagePhotoImage');
    expect(renderToString(list)).toMatch(/^<ul class="rf-attachments" aria-label="Attachments">/u);
  });

  it('wraps tables in a labelled, focusable scroll region with aligned columns', () => {
    const html = renderToString(dataTable('Counts', [{ label: 'Name' }, { label: 'Count', align: 'right' }], [['a', '1']]));
    expect(html).toMatch(/^<div class="rf-table-scroll" role="region" aria-label="Counts" tabindex="0"><table class="rf-table"><caption>Counts<\/caption>/u);
    expect(html).toContain('<th scope="col" class="align-right">Count</th>');
    expect(html).toContain('<td>a</td><td class="align-right">1</td>');
  });

  it('shows the first, last, and neighbouring pages with gaps between them', () => {
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(1, 9)).toEqual([1, 2, null, 9]);
    expect(pageWindow(5, 9)).toEqual([1, null, 4, 5, 6, null, 9]);
    expect(pageWindow(3, 4)).toEqual([1, 2, 3, 4]);
    expect(pagination(1, 1, String)).toBeUndefined();
    const html = renderToString(pagination(2, 3, (page) => `?page=${page}`)!);
    expect(html).toContain('<a class="rf-pagination__link" href="?page=1" rel="prev">Previous</a>');
    expect(html).toContain('href="?page=2" aria-current="page" aria-label="Page 2">2</a>');
    expect(html).toContain('<a class="rf-pagination__link" href="?page=3" rel="next">Next</a>');
  });

  it('shows a Withheld unit as its Disclosure_Line, linked to the Methods entry', () => {
    const block = disclosureLineBlock({ kindOfMaterial: 'Letter', date: '3 March 1951', parties: ['A', 'B'], note: 'Held privately.', methodsHref: '/methods#withheld' });
    expect(renderToString(block)).toContain('<a class="rf-status rf-status--withheld" href="/methods#withheld">Withheld</a>');
    expect(visible(block)).toBe('WithheldLetter · 3 March 1951 · A, BHeld privately.');
    expect(visible(disclosureLineBlock({ kindOfMaterial: 'Photograph', date: '1960', parties: [], methodsHref: '/m' }))).toBe('WithheldPhotograph · 1960');
    expect(renderToString(disclosureLineBlock({ kindOfMaterial: 'Photograph', date: '1960', parties: [], methodsHref: '/m', href: '/r/X' }))).toContain('<a href="/r/X">Photograph · 1960</a>');
  });

  it('shows a Dissent_Note with its author, time, earlier-wording link, and withdrawal', () => {
    const block = dissentNoteBlock({
      authorName: 'D. Member', authorHref: '/people/d', savedAt: '27 October 2026', body: [text('I disagree.')], earlierWording: { href: '/logs/1/diff' }, withdrawn: { date: '28 October 2026', reason: 'Resolved' },
    });
    const html = renderToString(block);
    expect(html).toMatch(/^<aside class="rf-dissent rf-dissent--withdrawn" aria-label="Dissent note by D. Member">/u);
    expect(html).toContain('<a href="/people/d">D. Member</a>');
    expect(visible(block)).toBe('Dissent note by D. Member · last saved 27 October 2026Written about an earlier wordingWithdrawn on 28 October 2026: ResolvedI disagree.');
    expect(renderToString(dissentNoteBlock({ authorName: 'E', savedAt: 't', body: [] }))).not.toMatch(/withdrawn|earlier|href/u);
    expect(renderToString(dissentNoteBlock({ authorName: 'E', savedAt: 't', body: [], earlierWording: {} }))).toContain('<p class="rf-dissent__earlier">Written about an earlier wording</p>');
  });
});

describe('layout and page-header shells', () => {
  it('renders the breadcrumb as a labelled nav ending in the current page marked aria-current (R6.3)', () => {
    const html = renderToString(breadcrumb([{ label: 'Home', href: '/' }, { label: 'Projects', href: '/projects' }, { label: 'Alpha' }]));
    expect(html).toBe('<nav class="rf-breadcrumb" aria-label="Breadcrumb"><ol>'
      + '<li><a href="/">Home</a></li><li><a href="/projects">Projects</a></li><li><span aria-current="page">Alpha</span></li>'
      + '</ol></nav>');
    expect(renderToString(breadcrumb([{ label: 'Alpha' }], 'You are here'))).toMatch(/^<nav class="rf-breadcrumb" aria-label="You are here">/u);
  });

  it('renders the page header with its breadcrumb, single h1 title, description, and actions cluster (R6.1, R6.3, R6.4)', () => {
    const html = renderToString(pageHeader({ title: 'Alpha', description: 'A project', breadcrumb: [{ label: 'Home', href: '/' }, { label: 'Alpha' }], actions: [text('X')] }));
    expect(html).toMatch(/^<header class="rf-page-header"><nav class="rf-breadcrumb"/u);
    expect(html).toContain('<h1>Alpha</h1>');
    expect(html).toContain('<p class="rf-page-header__description">A project</p>');
    expect(html).toContain('<div class="rf-actions">X</div>');
    expect(renderToString(pageHeader({ title: 'Only' }))).toBe('<header class="rf-page-header"><h1>Only</h1></header>');
    expect(renderToString(pageHeader({ title: 'Empty', breadcrumb: [], actions: [] }))).not.toMatch(/rf-breadcrumb|rf-actions|rf-page-header__description/u);
  });

  it('wraps a dense page in the chosen wide or two-column layout variant (R6.2, R6.5)', () => {
    expect(renderToString(pageLayout('wide', [text('a')]))).toBe('<div class="rf-layout rf-layout--wide">a</div>');
    expect(renderToString(pageLayout('split', [text('b')]))).toBe('<div class="rf-layout rf-layout--split">b</div>');
  });
});

describe('content shells', () => {
  it('groups content in a card with an optional linked heading and header extra (R7.1)', () => {
    const html = renderToString(card({ heading: 'Reviews', headingHref: '/reviews', headingExtra: text('View all') }, [text('body')]));
    expect(html).toBe('<section class="rf-card"><div class="rf-card__header"><h2><a href="/reviews">Reviews</a></h2>View all</div>body</section>');
    expect(renderToString(card({ heading: 'Plain' }, [text('x')]))).toBe('<section class="rf-card"><div class="rf-card__header"><h2>Plain</h2></div>x</section>');
    expect(renderToString(card({}, [text('x')]))).toBe('<section class="rf-card">x</section>');
  });

  it('shows an empty state with a message and an optional next action (R7.4)', () => {
    expect(renderToString(emptyState('Nothing here', text('Add one')))).toBe('<div class="rf-empty"><p>Nothing here</p>Add one</div>');
    expect(renderToString(emptyState('Nothing here'))).toBe('<div class="rf-empty"><p>Nothing here</p></div>');
  });

  it('exposes the tablist/tab/tabpanel roles and ARIA relationships, hiding inactive panels (R7.7)', () => {
    const html = tabs([{ id: 'one', label: 'One', panel: [text('p1')] }, { id: 'two', label: 'Two', panel: [text('p2')] }], { label: 'Views' }).map(renderToString).join('');
    expect(html).toContain('<div class="rf-tablist" role="tablist" aria-label="Views">');
    expect(html).toContain('<button class="rf-tab" type="button" role="tab" id="tab-one" aria-controls="panel-one" aria-selected="true" tabindex="0">One</button>');
    expect(html).toContain('<button class="rf-tab" type="button" role="tab" id="tab-two" aria-controls="panel-two" aria-selected="false" tabindex="-1">Two</button>');
    expect(html).toContain('<div class="rf-tabpanel" role="tabpanel" id="panel-one" aria-labelledby="tab-one" tabindex="0">p1</div>');
    expect(html).toContain('<div class="rf-tabpanel" role="tabpanel" id="panel-two" aria-labelledby="tab-two" tabindex="0" hidden="">p2</div>');
    const second = tabs([{ id: 'one', label: 'One', panel: [] }, { id: 'two', label: 'Two', panel: [] }], { label: 'Views', selected: 'two' }).map(renderToString).join('');
    expect(second).toContain('id="tab-two" aria-controls="panel-two" aria-selected="true" tabindex="0"');
    expect(second).toContain('<div class="rf-tabpanel" role="tabpanel" id="panel-one" aria-labelledby="tab-one" tabindex="0" hidden="">');
  });

  it('renders a loading skeleton of aria-hidden rows beside a visually-hidden status message (R7.5)', () => {
    const html = skeleton({ rows: 2, label: 'Loading reviews' }).map(renderToString).join('');
    expect(html).toBe('<div class="rf-skeleton" aria-hidden="true"><div class="rf-skeleton__row"></div><div class="rf-skeleton__row"></div></div>'
      + '<p class="rf-visually-hidden" role="status">Loading reviews</p>');
    const html2 = skeleton().map(renderToString).join('');
    expect([...html2.matchAll(/rf-skeleton__row/gu)]).toHaveLength(3);
    expect(html2).toContain('<p class="rf-visually-hidden" role="status">Loading…</p>');
  });
});
describe('home page rhythm', () => {
  it('zeroes the first heading margin in every home section so the section padding sets the gap', () => {
    const css = readFileSync(new URL('../src/components.css', import.meta.url), 'utf8');
    const rule = /([^{}]*)\{\s*margin-block-start:\s*0;\s*\}/gu;
    const selectors = [...css.matchAll(rule)].flatMap((m) => m[1]!.split(',').map((x) => x.trim()));
    for (const selector of ['.rf-how h2', '.rf-home__featured h2', '.rf-home__mission h2']) expect(selectors).toContain(selector);
  });
});
