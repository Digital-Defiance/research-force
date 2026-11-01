import { element, text, type ViewNode } from '@researchforce/domain/tree';
import type { PageSpec } from '../frame';
import { formatDay } from '../format';
import { buildPages } from '../render-site';
import type { SiteInput } from '../site';
import { assetFiles } from './assets';
import { archiveJson, attachmentsCsv, licenceText, researchItemsCsv } from './data';
import { renderExportPage } from './frame';
import { exportManifest, manifestJson, sha256Sums, type ExportFile } from './manifest';
import { ASSETS_DIR, DATA_DIR, INDEX_FILE, pageFile, relativeLink } from './paths';

export interface ExportOptions {
  /** The export's start time, shown on the index page, as an ISO 8601 UTC instant (R35.1). */
  readonly startedAt: string;
  /** What the export covers: the whole public archive or one named Project (R35.1). */
  readonly scope: string;
}

/**
 * A page the export leaves out: the site's search pages and its forms have no place in an offline, read-only package, and the home page's
 * address is `index.html`, which the export's own index occupies (R35.1, R35.3).
 */
const isExcluded = (path: string): boolean =>
  path === '/' || path === '/search' || path.endsWith('/search') || path.includes('/submit') || path === '/respond' || path === '/404';

/** Every Public_Site page the export keeps: the home, Project, Research_Item, Attachment, listing, People, and policy pages. */
const exportPages = (site: SiteInput): PageSpec[] => buildPages(site).filter((page) => !isExcluded(page.path));

const DATA_FILES = [
  `${DATA_DIR}/archive.json`, `${DATA_DIR}/research-items.csv`, `${DATA_DIR}/attachments.csv`,
] as const;

/**
 * The index page (R35.1): the export's start time and Export_Scope, then links to every page, data file, and asset in the package, each
 * relative so it opens offline. It is itself a page, so its links are relativised against `index.html`.
 */
function indexFile(site: SiteInput, pages: readonly PageSpec[], assets: readonly ExportFile[], options: ExportOptions, inPackage: ReadonlySet<string>): ExportFile {
  const link = (to: string, label: string): ViewNode => element('li', {}, [element('a', { href: relativeLink(INDEX_FILE, to) }, [text(label)])]);
  const body: ViewNode[] = [
    element('p', {}, [text(`Export started ${formatDay(options.startedAt.slice(0, 10))} (${options.startedAt}).`)]),
    element('p', {}, [text(`Scope: ${options.scope}.`)]),
    element('section', { 'aria-label': 'Pages' }, [
      element('h2', {}, [text('Pages')]),
      element('ul', {}, pages.map((page) => link(pageFile(page.path), page.titleContext === undefined ? page.title : `${page.title} · ${page.titleContext}`))),
    ]),
    element('section', { 'aria-label': 'Data' }, [
      element('h2', {}, [text('Data')]),
      element('ul', {}, [
        ...DATA_FILES.map((path) => link(path, path)),
        link('LICENSE.txt', 'LICENSE.txt'), link('MANIFEST.json', 'MANIFEST.json'), link('SHA256SUMS', 'SHA256SUMS'),
      ]),
    ]),
    element('section', { 'aria-label': 'Assets' }, [
      element('h2', {}, [text('Assets')]),
      element('ul', {}, assets.map((asset) => link(asset.path, asset.path))),
    ]),
  ];
  const spec: PageSpec = { path: '/', title: 'ResearchForce archive export', body, printAddress: false };
  // `renderExportPage` reads the path's file; `/` is `index.html`, so its links resolve from the package root.
  return { path: INDEX_FILE, content: renderExportPage(site, spec, inPackage), contentType: 'text/html; charset=utf-8' };
}

/**
 * The files of a Public_Archive_Export, from the Public_Views valid at the start time (R35.1, R35.3, R35.4, R35.12). Pure: it writes the
 * HTML pages with relative links, the index, the JSON and CSV data, the Content_Licence, the Design_System assets, and the manifest and
 * checksums of those text files. The job (task 38.2) writes these under `rf-private/exports/{id}/`, copies each Public Attachment file under
 * `files/`, and appends those copies to the manifest and `SHA256SUMS`.
 */
export function renderExport(site: SiteInput, options: ExportOptions): ExportFile[] {
  const assets = assetFiles();
  const pages = exportPages(site);
  // Every file the package will hold, so each in-package link resolves to a real copy and dead links are dropped (R35.3).
  const inPackage = new Set<string>([
    INDEX_FILE, ...pages.map((page) => pageFile(page.path)), ...DATA_FILES, 'LICENSE.txt', 'MANIFEST.json', 'SHA256SUMS',
    ...assets.map((asset) => asset.path),
    // `components.css` and the font binaries are files on disk the job copies beside the produced assets; pages link them, so they count as
    // in-package targets even though this pure layer does not hold their bytes (R45.1, R45.20).
    `${ASSETS_DIR}/components.css`,
  ]);
  const files: ExportFile[] = [
    indexFile(site, pages, assets, options, inPackage),
    ...pages.map((page): ExportFile => ({ path: pageFile(page.path), content: renderExportPage(site, page, inPackage), contentType: 'text/html; charset=utf-8' })),
    { path: `${DATA_DIR}/archive.json`, content: archiveJson(site.views, options.startedAt, options.scope), contentType: 'application/json' },
    { path: `${DATA_DIR}/research-items.csv`, content: researchItemsCsv(site.views.values()), contentType: 'text/csv; charset=utf-8' },
    { path: `${DATA_DIR}/attachments.csv`, content: attachmentsCsv(site.views.values()), contentType: 'text/csv; charset=utf-8' },
    { path: 'LICENSE.txt', content: licenceText(site.licence), contentType: 'text/plain; charset=utf-8' },
    ...assets,
  ];
  files.push({ path: 'MANIFEST.json', content: manifestJson(exportManifest(files, options.startedAt, options.scope)), contentType: 'application/json' });
  files.push({ path: 'SHA256SUMS', content: sha256Sums(files), contentType: 'text/plain; charset=utf-8' });
  return files;
}
