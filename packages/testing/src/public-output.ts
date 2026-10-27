import { renderSite } from '@researchforce/public-render/render-site';
import { fileFor, paged } from '@researchforce/public-render/paths';
import type { SiteInput } from '@researchforce/public-render/site';
import { buildSearchIndex, type IndexFile, type IndexManifest, type Postings, type SearchDocument } from '@researchforce/search-public/build';
import { isElement, readPage, type HtmlElement, type HtmlNode, type Page } from './html';
import { siteInputFor } from './site';
import type { WorkspaceState } from './workspace';

/** One Public_Site build and public search index of a synthetic workspace, read back the way a reader or crawler sees them. */
export interface PublicOutput {
  readonly site: SiteInput;
  /** Every file the Public_Site build writes, by file name. */
  readonly files: ReadonlyMap<string, string>;
  /** Every HTML file, parsed, by file name. */
  readonly pages: ReadonlyMap<string, Page>;
  pageAt(path: string): Page | undefined;
  /** Every page of a paged listing, first page first. */
  listingPages(base: string): Page[];
  readonly index: readonly IndexFile[];
  /** Search documents by document key. */
  readonly documents: ReadonlyMap<string, SearchDocument>;
  /** The terms the index lists for each document key. */
  readonly terms: ReadonlyMap<string, ReadonlySet<string>>;
}

export function publicOutput(state: WorkspaceState, options: Parameters<typeof siteInputFor>[1] = {}): PublicOutput {
  const site = siteInputFor(state, options);
  const files = new Map(renderSite(site).map((file) => [file.file, file.content]));
  const pages = new Map([...files].filter(([name]) => name.endsWith('.html')).map(([name, html]) => [name, readPage(html)]));
  const pageAt = (path: string): Page | undefined => pages.get(fileFor(path));
  const index = buildSearchIndex(site.views);
  const contents = new Map(index.map((file) => [file.file, file.content]));
  const manifest = JSON.parse(index[0]!.content) as IndexManifest;
  const documents = new Map<string, SearchDocument>();
  for (const shard of manifest.shards) {
    for (const [key, document] of Object.entries(JSON.parse(contents.get(shard)!) as Record<string, SearchDocument>)) documents.set(key, document);
  }
  const terms = new Map<string, Set<string>>();
  for (const bucket of Object.values(manifest.buckets)) {
    for (const [term, postings] of Object.entries(JSON.parse(contents.get(bucket)!) as Record<string, Postings>)) {
      for (const [key] of postings) {
        let set = terms.get(key);
        if (set === undefined) terms.set(key, (set = new Set()));
        set.add(term);
      }
    }
  }
  const listingPages = (base: string): Page[] => {
    const found: Page[] = [];
    for (let page = 1, next = pageAt(base); next !== undefined; next = pageAt(paged(base, ++page))) found.push(next);
    return found;
  };
  return { site, files, pages, pageAt, listingPages, index, documents, terms };
}

/** Every text node under the nodes with the elements that enclose it, outermost first. */
export function* textNodes(nodes: readonly HtmlNode[], ancestors: readonly HtmlElement[] = []): Generator<{ readonly text: string; readonly ancestors: readonly HtmlElement[] }> {
  for (const node of nodes) {
    if (isElement(node)) yield* textNodes(node.children, [...ancestors, node]);
    else yield { text: node, ancestors };
  }
}

/** Every element under the nodes with its parent element, if any. */
export function* elementsWithParents(nodes: readonly HtmlNode[], parent?: HtmlElement): Generator<{ readonly element: HtmlElement; readonly parent: HtmlElement | undefined }> {
  for (const node of nodes) {
    if (!isElement(node)) continue;
    yield { element: node, parent };
    yield* elementsWithParents(node.children, node);
  }
}
