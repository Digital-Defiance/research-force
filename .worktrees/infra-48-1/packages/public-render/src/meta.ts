import { element, text, type ElementNode } from '@researchforce/domain/tree';
import type { ResearchItemView } from '@researchforce/kernel/views';
import { SITE_NAME } from './frame';
import { absoluteUrl } from './paths';
import type { SiteInput } from './site';

const property = (name: string, content: string): ElementNode => element('meta', { property: name, content }, []);
const named = (name: string, content: string): ElementNode => element('meta', { name, content }, []);

/** Open Graph link-preview tags; the description is the page's own Public_Summary text, only when one is set (R45.10). */
export function openGraph(spec: { readonly title: string; readonly path: string; readonly type: 'article' | 'website'; readonly description?: string }): ElementNode[] {
  return [
    property('og:title', spec.title),
    ...(spec.description === undefined ? [] : [property('og:description', spec.description)]),
    property('og:url', absoluteUrl(spec.path)),
    property('og:type', spec.type),
    property('og:site_name', SITE_NAME),
  ];
}

/** `<`, `>`, and `&` escaped so the JSON can never end its script element. */
const scriptJson = (value: unknown): string => JSON.stringify(value).replace(/[<>&\u2028\u2029]/gu, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

/**
 * Citation tags, Open Graph tags, and the schema.org description of a Public Research_Item's page (R45.10). Every value is one the page
 * presents: the title, the Credit names in page order, the first-public date, the Public_URL, the Item_Identifier, the Project name, the
 * Public_Summary text, and the Content_Licence address from the footer link (R45.11).
 */
export function itemMeta(site: SiteInput, view: ResearchItemView, summaryText?: string): ElementNode[] {
  const url = absoluteUrl(view.path);
  const authors = view.credit.map((entry) => entry.name);
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CreativeWork',
    name: view.title,
    author: authors.map((name) => ({ '@type': 'Person', name })),
    datePublished: view.firstPublicOn,
    url,
    identifier: view.identifier,
    isPartOf: { '@type': 'CreativeWorkSeries', name: view.project.name },
    license: site.licence.url,
  };
  return [
    named('citation_title', view.title),
    ...authors.map((name) => named('citation_author', name)),
    named('citation_publication_date', view.firstPublicOn.replaceAll('-', '/')),
    ...openGraph({ title: view.title, path: view.path, type: 'article', ...(summaryText === undefined ? {} : { description: summaryText }) }),
    element('script', { type: 'application/ld+json' }, [text(scriptJson(jsonLd))]),
  ];
}
