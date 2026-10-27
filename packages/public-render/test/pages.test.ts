import { describe, expect, it } from 'vitest';
import { ABOUT_STATUS, GROUP_STATEMENT, PEOPLE_NO_PROFILE_STATEMENT } from '@researchforce/design/fixed-texts';
import { byClass, byTag, find, findAll, readPage, textOf, type Page } from '@researchforce/testing/html';
import type { PublicView, ResearchItemView } from '@researchforce/kernel/views';
import { profileHref } from '../src/format';
import { SUPERSEDED_HREF, WITHDRAWN_HREF, WITHHELD_HREF, labelKindHref, termHref, valueHref } from '../src/methods';
import { renderSite, type SiteFile } from '../src/render-site';
import type { SiteInput } from '../src/site';
import { FILE_NEW, FILE_OLD, FINDING, HYPOTHESIS, PROJECT, VALUES, WITHHELD_PROJECT, site } from './fixtures';

function build(input: SiteInput = site()): Map<string, SiteFile> {
  return new Map(renderSite(input).map((file) => [file.file, file]));
}
function page(files: Map<string, SiteFile>, file: string): Page {
  const found = files.get(file);
  if (!found) throw new Error(`No file ${file}; have ${[...files.keys()].join(', ')}`);
  return readPage(found.content);
}
const meta = (view: Page, name: string): string[] =>
  findAll(view.head.children, (node) => node.tag === 'meta' && (node.attributes.get('name') === name || node.attributes.get('property') === name)).map((node) => node.attributes.get('content')!);
const linkTo = (view: Page, href: string): string[] => view.links.filter((link) => link.href === href).map((link) => link.text);

describe('item page', () => {
  const files = build();
  const view = page(files, 'r/AAAA-1111-BBBB.html');

  it('shows every R24 and R29 field with the companion fields in one status block', () => {
    for (const value of ['Finding', 'A synthetic finding', 'The public summary.', '2 April 1951', 'AAAA-1111-BBBB', 'Bob Outside (Example University)', 'The claim text.', 'The log summary.']) {
      expect(view.mainText).toContain(value);
    }
    const block = find(view.main.children, byClass('rf-status-block'))!;
    expect(textOf(block.children)).toContain('Scope caveat: HoldsQuote · Lab notes for the tested batch only.');
    expect(textOf(block.children)).toContain('Superseded by');
    expect(linkTo(view, valueHref(VALUES.superseded.id))).toContain('Superseded');
    expect(linkTo(view, termHref('term.scope_caveat'))).toEqual(['Scope caveat']);
    expect(linkTo(view, SUPERSEDED_HREF)).toEqual(['Superseded by', 'Superseded']);
  });

  it('links Credit names to Public_Profiles only while those are shown', () => {
    expect(linkTo(view, profileHref('Ada Example'))).toEqual(['Ada Example', 'Ada Example', 'Ada Example']);
    expect(view.links.some((link) => link.text === 'Bob Outside')).toBe(false);
  });

  it('shows the withdrawal notice, the Project link, and the accent', () => {
    const withdrawn = findAll(view.main.children, byClass('rf-notice')).map((node) => textOf(node.children));
    expect(withdrawn).toContain('Withdrawn on 3 February 2026: Replaced by later work.');
    expect(linkTo(view, WITHDRAWN_HREF)).toContain('Withdrawn');
    expect(linkTo(view, PROJECT.path)).toContain(PROJECT.name);
    expect(view.body.attributes.get('data-accent')).toBe('teal');
  });

  it('places Dissent_Notes after the Log_Summary, with the earlier-wording mark but no comparison', () => {
    const summary = find(view.main.children, (node) => node.attributes.get('aria-labelledby') === 'log-summary-heading')!;
    const notes = findAll(summary.children, byClass('rf-dissent'));
    expect(notes).toHaveLength(1);
    const earlier = find(notes[0]!.children, byClass('rf-dissent__earlier'))!;
    expect(textOf(earlier.children)).toBe('Written about an earlier wording');
    expect(find(earlier.children, byTag('a'))).toBeUndefined();
    expect(findAll(summary.children, byClass('rf-disclosure-line')).map((node) => textOf(node.children))).toEqual(['WithheldDissent note · 1954 · A Correspondent']);
  });

  it('shows Withheld Replies and Attachments as Disclosure_Lines in their positions', () => {
    const discussion = find(view.main.children, (node) => node.attributes.get('aria-labelledby') === 'discussion-heading')!;
    expect(textOf(discussion.children)).toContain('A reply in the thread.');
    expect(textOf(find(discussion.children, byClass('rf-replies--nested'))!.children)).toBe('WithheldReply · 1955 · A Correspondent');
    const attachments = findAll(view.main.children, byClass('rf-attachment'));
    expect(attachments.map((node) => textOf(node.children).slice(0, 19))).toEqual(['Scan, first version', 'WithheldPhotograph ']);
    for (const line of findAll(view.main.children, byClass('rf-disclosure-line'))) expect(find(line.children, byTag('a'))!.attributes.get('href')).toBe(WITHHELD_HREF);
  });

  it('offers each Public Attachment with rights, licence coverage, download, and supersession notice', () => {
    const [entry] = findAll(view.main.children, byClass('rf-attachment'));
    const text = textOf(entry!.children);
    for (const value of ['PDF · 2.5 MB', 'Rights holder: An Archive', 'Rights terms: Reproduced by permission.', 'does not cover this file', 'a later version was uploaded on 4 March 2026']) {
      expect(text).toContain(value);
    }
    expect(view.links.map((link) => link.href)).toContain('https://files.researchforce.org/f/EEEE-3333-FFFF');
    expect(linkTo(view, FILE_NEW.path)).toEqual(['Open the later version']);
  });

  it('shows Cross_Links by the views at their other ends', () => {
    const links = find(view.main.children, byClass('rf-links'))!;
    expect(textOf(links.children)).toContain('Links to Related A synthetic hypothesis (Hypothesis) Eliminated');
    expect(textOf(links.children)).toContain('Linked from WithheldLetter · March 1950 · A Correspondent');
  });

  it('links label kinds to their Methods page entries', () => {
    expect(linkTo(view, labelKindHref('quote'))).toEqual(['Quote']);
  });

  it('links the label kind of a footnoted label to its Methods page entry', () => {
    const long = 'A synthetic reported passage. '.repeat(8);
    const item: ResearchItemView = { ...FINDING, publicSummary: { text: long, spans: [{ k: 'source_reported', s: 0, e: long.length, source: 'A Witness' }] } };
    const notes = find(page(build(site({ views: new Map([...site().views, [item.key, item]]) })), 'r/AAAA-1111-BBBB.html').main.children, byClass('label-notes'))!;
    const links = findAll(notes.children, byTag('a')).filter((link) => link.attributes.get('href') === labelKindHref('source_reported'));
    expect(links.map((link) => textOf(link.children))).toEqual(['Source-reported']);
  });

  it('gives the Citation_Line and the metadata from the page’s own values', () => {
    const citation = textOf(find(view.main.children, byClass('rf-citation__line'))!.children);
    expect(citation).toBe('Ada Example, Bob Outside. “A synthetic finding.” Alpha Project, ResearchForce, 5 January 2026. AAAA-1111-BBBB. https://researchforce.org/r/AAAA-1111-BBBB, accessed [date of access].');
    expect(meta(view, 'citation_title')).toEqual(['A synthetic finding']);
    expect(meta(view, 'citation_author')).toEqual(['Ada Example', 'Bob Outside']);
    expect(meta(view, 'citation_publication_date')).toEqual(['2026/01/05']);
    expect(meta(view, 'og:description')).toEqual(['The public summary.']);
    expect(meta(view, 'og:type')).toEqual(['article']);
    const script = find(view.head.children, (node) => node.tag === 'script' && node.attributes.get('type') === 'application/ld+json')!;
    expect(JSON.parse(textOf(script.children))).toMatchObject({
      name: 'A synthetic finding', datePublished: '2026-01-05', identifier: 'AAAA-1111-BBBB', isPartOf: { name: 'Alpha Project' }, license: 'https://licence.example.test/1.0',
      author: [{ name: 'Ada Example' }, { name: 'Bob Outside' }],
    });
    expect(find(view.head.children, byTag('title'))!.children).toEqual(['A synthetic finding · ResearchForce']);
    expect(find(view.main.children, (node) => node.attributes.has('data-url'))!.attributes.get('data-url')).toBe('https://researchforce.org/r/AAAA-1111-BBBB');
  });

  it('shows the header link and the footer on every page', () => {
    for (const [name, file] of files) {
      if (!name.endsWith('.html')) continue;
      const current = readPage(file.content);
      expect(linkTo(current, '/')).toContain('ResearchForce');
      expect(current.text).toContain(GROUP_STATEMENT.paragraphs[0]!);
      expect(linkTo(current, 'https://licence.example.test/1.0')).toContain('Synthetic Licence 1.0');
      for (const path of ['/about', '/people', '/methods', '/licence', '/privacy', '/corrections', '/submit']) expect(current.links.some((link) => link.href === path)).toBe(true);
      expect(find(current.nodes, byTag('html'))!.attributes.get('lang')).toBe('en');
    }
  });
});

describe('Summary_Only item page', () => {
  it('shows the Elimination_Scope with the status and no Log_Summary, fields, or thread', () => {
    const view = page(build(), 'r/CCCC-2222-DDDD.html');
    expect(view.mainText).toContain('Elimination scope: Rules out the night route.');
    expect(linkTo(view, termHref('term.elimination_scope'))).toEqual(['Elimination scope']);
    for (const heading of ['log-summary-heading', 'details-heading', 'discussion-heading']) expect(find(view.main.children, (node) => node.attributes.get('id') === heading)).toBeUndefined();
    expect(meta(view, 'og:description')).toEqual([]);
  });
});

describe('attachment page', () => {
  it('shows the Attachment’s fields, rights, download, and Parent', () => {
    const files = build();
    const old = page(files, 'a/EEEE-3333-FFFF.html');
    for (const value of ['Scan, first version', 'PDF', '2.5 MB', 'Page one', 'Scanned by a member', 'EEEE-3333-FFFF', 'Licensed']) expect(old.mainText).toContain(value);
    expect(linkTo(old, FINDING.path)).toEqual([FINDING.title]);
    expect(linkTo(old, SUPERSEDED_HREF)).toEqual(['Superseded']);
    const fresh = page(files, 'a/GGGG-4444-HHHH.html');
    expect(fresh.mainText).toContain('This file is licensed under the Synthetic Licence 1.0.');
    expect(fresh.links.some((link) => link.href === SUPERSEDED_HREF)).toBe(false);
  });
});

describe('Withheld pages', () => {
  it('show only the Disclosure_Line, without Project, accent, citation tags, or JSON-LD', () => {
    const files = build();
    for (const file of ['r/WWWW-0000-WWWW.html', 'a/IIII-5555-JJJJ.html', 'p/hidden-slug.html']) {
      const view = page(files, file);
      expect(findAll(view.main.children, byClass('rf-disclosure-line'))).toHaveLength(1);
      expect(view.links.some((link) => link.href === PROJECT.path)).toBe(false);
      expect(view.body.attributes.has('data-accent')).toBe(false);
      expect(findAll(view.head.children, (node) => node.tag === 'meta' && (node.attributes.get('name') ?? '').startsWith('citation_'))).toEqual([]);
      expect(find(view.head.children, byTag('script'))).toBeUndefined();
    }
    expect(files.has('p/hidden-slug/log.html')).toBe(false);
  });

  it('do not take the address of a Public Root_Item', () => {
    expect(page(build(), 'r/AAAA-1111-BBBB.html').mainText).toContain('A synthetic finding');
  });
});

describe('home and projects pages', () => {
  it('lists Featured_Projects in the Project_Order, Withheld ones without link or slug', () => {
    const files = build();
    const home = page(files, 'index.html');
    const entries = findAll(home.main.children, byClass('rf-listing__entry')).map((node) => textOf(node.children));
    expect(entries).toEqual(['WithheldProject · 1960', 'Alpha ProjectA synthetic project.']);
    expect(files.get('index.html')!.content).not.toContain('hidden-slug');
    expect(linkTo(home, '/projects')).toContain('All projects');
    const projects = page(files, 'projects.html');
    expect(findAll(projects.main.children, byClass('rf-listing__entry')).map((node) => textOf(node.children))).toEqual([
      'WithheldProject · 1960', 'Alpha ProjectA synthetic project.', 'Beta ProjectAnother synthetic project.',
    ]);
  });

  it('shows the no-featured notice when no Featured_Project is Public or Withheld', () => {
    const home = page(build(site({ featured: new Set(['p:private']) })), 'index.html');
    expect(home.mainText).toContain('No project is featured at present.');
  });

  it('links the Project page to its listings, log, Withheld listing, search, and form', () => {
    const view = page(build(), 'p/alpha.html');
    const hrefs = view.links.map((link) => link.href);
    for (const href of ['/p/alpha/journal', '/p/alpha/topics', '/p/alpha/log', '/p/alpha/withheld', '/p/alpha/search', '/p/alpha/submit', '/projects']) expect(hrefs).toContain(href);
    expect(view.mainText).toContain(PROJECT.description);
  });
});

describe('listings', () => {
  const many = (count: number): ResearchItemView[] => Array.from({ length: count }, (_, index) => ({
    ...HYPOTHESIS, key: `u:h${String(index).padStart(3, '0')}`, path: `/r/H-${index}`, title: `Hypothesis ${index}`, identifier: `H-${index}`,
  }));

  it('pages 50 entries at a time with previous and next links, newest first with creation-time ties', () => {
    const items = many(51);
    const input = site({
      views: new Map<string, PublicView>([[PROJECT.key, PROJECT], ...items.map((view) => [view.key, view] as const)]),
      createdAt: new Map(items.map((view, index) => [view.key, `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`])),
    });
    const files = build(input);
    const first = page(files, 'p/alpha/hypotheses.html');
    const second = page(files, 'p/alpha/hypotheses/page/2.html');
    const titles = (view: Page): string[] => findAll(view.main.children, byClass('rf-listing__title')).map((node) => textOf(node.children));
    expect(titles(first)).toHaveLength(50);
    expect([...titles(first), ...titles(second)]).toEqual(items.map((view) => view.title).reverse());
    expect(first.links.find((link) => link.text === 'Next')?.href).toBe('/p/alpha/hypotheses/page/2');
    expect(second.links.find((link) => link.text === 'Previous')?.href).toBe('/p/alpha/hypotheses');
    expect(files.has('p/alpha/hypotheses/page/3.html')).toBe(false);
  });

  it('shows the Log_Summary under Full_Content and the Public_Summary under Summary_Only in the Project_Log', () => {
    const log = page(build(), 'p/alpha/log.html');
    const entries = findAll(log.main.children, byClass('rf-listing__entry')).map((node) => textOf(node.children));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toContain('Hypothesis: A synthetic hypothesis');
    expect(entries[1]).toContain('The log summary.');
    expect(entries[1]).toContain('I read the result differently.');
    expect(entries[1]).not.toContain('The public summary.');
  });

  it('lists Disclosure_Lines newest first, each unit with a page of its own linked to it', () => {
    const view = page(build(), 'p/alpha/withheld.html');
    const lines = findAll(view.main.children, byClass('rf-disclosure-line__summary'));
    expect(lines.map((node) => textOf(node.children))).toEqual([
      'Reply · 1955 · A Correspondent', 'Dissent note · 1954 · A Correspondent', 'Letter · March 1950 · A Correspondent', 'Photograph · 1949 · A Correspondent',
    ]);
    expect(lines.map((node) => find(node.children, byTag('a'))?.attributes.get('href'))).toEqual([undefined, undefined, '/r/WWWW-0000-WWWW', '/a/IIII-5555-JJJJ']);
  });
});

describe('policy pages', () => {
  const files = build();

  it('begins the About page with the fixed status section', () => {
    const about = page(files, 'about.html');
    expect(about.mainText.indexOf(ABOUT_STATUS.paragraphs[0]!)).toBeLessThan(about.mainText.indexOf('About the group'));
    expect(about.mainText).toMatch(/Last updated \d{1,2} [A-Z][a-z]+ \d{4}$/u);
    expect(about.links.some((link) => link.href === '/submit/general')).toBe(true);
  });

  it('sorts Public_Profiles ignoring case and diacritics and leaves out an empty optional section', () => {
    const people = page(files, 'people.html');
    expect(findAll(people.main.children, byClass('rf-profile')).map((node) => node.attributes.get('id'))).toEqual(['person-ada-example', 'person-emile-example']);
    expect(people.mainText).not.toContain('Introduction');
    expect(page(build(site({ profiles: [] })), 'people.html').mainText).toContain(PEOPLE_NO_PROFILE_STATEMENT.paragraphs[0]!);
  });

  it('lists Methods_Terms, leaving out retired values that no other page presents', () => {
    const methods = page(files, 'methods.html');
    const ids = findAll(methods.main.children, byTag('dt')).map((node) => node.attributes.get('id'));
    expect(ids).toContain(`value-${VALUES.eliminated.id.toLowerCase()}`);
    expect(ids).not.toContain(`value-${VALUES.retiredUnused.id.toLowerCase()}`);
    expect(ids).toContain('label-kind-source-reported');
  });

  it('places the Retention_Table before “Your requests” and links the removal form', () => {
    const privacy = page(files, 'privacy.html');
    expect(privacy.mainText.indexOf('Rita Responsible')).toBe('Privacy'.length);
    expect(privacy.mainText.indexOf('How long we keep data')).toBeLessThan(privacy.mainText.indexOf('Your requests'));
    expect(privacy.mainText.indexOf('Member data.')).toBeLessThan(privacy.mainText.indexOf('How long we keep data'));
    expect(privacy.links.filter((link) => link.href === '/submit/removal/general')).toHaveLength(2);
  });

  it('dates each page by its latest change, sections or fixed text', () => {
    const later = site({ policy: { ...site().policy, licence: { ...site().policy.licence, changedOn: '2027-05-06' } } });
    expect(page(build(later), 'licence.html').mainText).toContain('Last updated 6 May 2027');
    expect(page(files, 'corrections.html').links.map((link) => link.href)).toEqual(expect.arrayContaining(['/submit/correction', '/submit/removal']));
  });
});

describe('form pages', () => {
  const selected = (view: Page, id: string): string | undefined => {
    const select = find(view.main.children, (node) => node.tag === 'select' && node.attributes.get('id') === id)!;
    return findAll(select.children, (node) => node.tag === 'option' && node.attributes.has('selected'))[0]?.attributes.get('value');
  };

  it('preselects as R31.13, R46.18, and R46.21 require and never checks the licence agreement', () => {
    const files = build();
    const expected: [string, string, string][] = [
      ['submit.html', '', ''], ['submit/general.html', '', 'general'], ['submit/correction.html', 'correction', 'general'],
      ['submit/removal.html', 'removal_request', ''], ['submit/removal/general.html', 'removal_request', 'general'], ['p/alpha/submit.html', '', 'project:alpha'],
    ];
    for (const [file, type, destination] of expected) {
      const view = page(files, file);
      expect([selected(view, 'type'), selected(view, 'destination')]).toEqual([type, destination]);
      expect(find(view.main.children, (node) => node.attributes.get('id') === 'licenceAgreement')!.attributes.has('checked')).toBe(false);
      const offered = findAll(find(view.main.children, (node) => node.attributes.get('id') === 'destination')!.children, byTag('option')).map((node) => node.attributes.get('value'));
      expect(offered).toEqual(['', 'project:alpha', 'project:beta', 'general']);
    }
    expect(files.get('submit.html')!.content).not.toContain(WITHHELD_PROJECT.path!.slice(3));
  });
});

describe('site files', () => {
  it('writes the sitemap without the not-found and response pages, and robots.txt', () => {
    const files = build();
    const sitemap = files.get('sitemap.xml')!.content;
    expect(sitemap).toContain('https://researchforce.org/r/AAAA-1111-BBBB');
    expect(sitemap).toContain('https://researchforce.org/p/hidden-slug');
    expect(sitemap).not.toContain('/404');
    expect(sitemap).not.toContain('/respond');
    expect(files.get('robots.txt')!.content).toContain('Sitemap:');
    expect(page(files, '404.html').mainText).toContain('There is no page at this address.');
  });

  it('refuses two pages at one address', () => {
    const clash = { ...FILE_OLD, key: 'u:clash', path: FINDING.path };
    expect(() => renderSite(site({ views: new Map([...site().views, [clash.key, clash]]) }))).toThrow(/share the address/u);
  });
});
