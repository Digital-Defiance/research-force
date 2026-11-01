import { describe, expect, it } from 'vitest';
import { stableJson } from '@researchforce/domain/history';
import { byTag, findAll, readPage, type Page } from '@researchforce/testing/html';
import { renderExport, type ExportFile } from '../src/export/render-export';
import { exportManifest, sha256Sums } from '../src/export/manifest';
import { relativeLink } from '../src/export/paths';
import type { SiteInput } from '../src/site';
import { FILE_OLD, FINDING, HYPOTHESIS, site } from './fixtures';

const OPTIONS = { startedAt: '2026-05-06T00:07:00.000Z', scope: 'Whole public archive' } as const;

function build(input: SiteInput = site()): Map<string, ExportFile> {
  return new Map(renderExport(input, OPTIONS).map((file) => [file.path, file]));
}
function page(files: Map<string, ExportFile>, path: string): Page {
  const found = files.get(path);
  if (!found) throw new Error(`No file ${path}; have ${[...files.keys()].join(', ')}`);
  return readPage(found.content);
}
/** Resolve a relative package link from the file it sits in, as a browser opening the package offline would. */
function resolve(fromPath: string, href: string): string {
  const base = fromPath.split('/').slice(0, -1);
  for (const part of href.split('#')[0]!.split('/')) {
    if (part === '..') base.pop();
    else if (part !== '.' && part !== '') base.push(part);
  }
  return base.join('/');
}

describe('export package shape', () => {
  const files = build();

  it('produces the index, every exported page, the data files, the licence, the manifest, and the checksums', () => {
    for (const path of [
      'index.html', 'r/AAAA-1111-BBBB.html', 'p/alpha.html', 'p/alpha/journal.html', 'a/EEEE-3333-FFFF.html', 'people.html',
      'data/archive.json', 'data/research-items.csv', 'data/attachments.csv', 'LICENSE.txt', 'MANIFEST.json', 'SHA256SUMS',
      'assets/tokens.css', 'assets/fonts.css', 'assets/fonts/LICENCES.txt',
    ]) {
      expect(files.has(path), path).toBe(true);
    }
  });

  it('leaves out the search pages and every form', () => {
    for (const path of files.keys()) {
      expect(path.endsWith('/search.html')).toBe(false);
      expect(path.includes('submit')).toBe(false);
      expect(path).not.toBe('search.html');
      expect(path).not.toBe('respond.html');
      expect(path).not.toBe('404.html');
    }
  });

  it('shows the ResearchForce name linking to the index and never links to the live site', () => {
    const item = page(files, 'r/AAAA-1111-BBBB.html');
    expect(item.links.some((link) => link.text === 'ResearchForce' && link.href === '../index.html')).toBe(true);
    // No navigable link points at the live site; the Citation_Line may still name the canonical Public_URL as text so the item stays citable.
    for (const [, file] of files) {
      if (!file.path.endsWith('.html')) continue;
      for (const link of readPage(file.content).links) expect(link.href.startsWith('https://researchforce.org'), `${file.path} → ${link.href}`).toBe(false);
      expect(file.content).not.toContain('href="https://researchforce.org');
    }
  });
});

describe('index page (R35.1)', () => {
  const files = build();
  const index = page(files, 'index.html');

  it('states the export start time and the Export_Scope', () => {
    expect(index.mainText).toContain('6 May 2026');
    expect(index.mainText).toContain('2026-05-06T00:07:00.000Z');
    expect(index.mainText).toContain('Whole public archive');
  });

  it('links to every page and data file, each resolving to a copy inside the package', () => {
    const targets = index.links.map((link) => resolve('index.html', link.href));
    for (const path of ['r/AAAA-1111-BBBB.html', 'p/alpha.html', 'data/archive.json', 'data/research-items.csv', 'LICENSE.txt', 'MANIFEST.json', 'SHA256SUMS']) {
      expect(targets, path).toContain(path);
    }
    for (const link of index.links) {
      if (link.href.startsWith('#') || link.href.startsWith('https://')) continue;
      const target = resolve('index.html', link.href);
      expect(files.has(target) || target === 'assets/components.css', link.href).toBe(true);
    }
  });
});

describe('relative links resolve inside the package (R35.3)', () => {
  const files = build();

  it('rewrites every page/resource link to an in-package relative path', () => {
    for (const [, file] of files) {
      if (!file.path.endsWith('.html')) continue;
      const view = readPage(file.content);
      for (const link of view.links) {
        if (link.href.startsWith('#') || link.href.startsWith('https://licence.example.test')) continue;
        expect(link.href.startsWith('/'), `${file.path} → ${link.href}`).toBe(false);
        expect(files.has(resolve(file.path, link.href)), `${file.path} → ${link.href}`).toBe(true);
      }
      for (const style of findAll(view.head.children, byTag('link'))) {
        const target = resolve(file.path, style.attributes.get('href')!);
        // `components.css` is a disk file the job copies beside the produced assets; the rest are produced here.
        expect(files.has(target) || target === 'assets/components.css', `${file.path} → ${target}`).toBe(true);
      }
    }
  });

  it('computes relative paths between package files', () => {
    expect(relativeLink('index.html', 'r/AAAA.html')).toBe('r/AAAA.html');
    expect(relativeLink('r/AAAA.html', 'index.html')).toBe('../index.html');
    expect(relativeLink('p/alpha/journal.html', 'r/AAAA.html')).toBe('../../r/AAAA.html');
    expect(relativeLink('p/alpha.html', 'p/alpha.html')).toBe('alpha.html');
    expect(relativeLink('r/AAAA.html', 'assets/tokens.css')).toBe('../assets/tokens.css');
  });
});

describe('policy pages carry last-updated dates (R35.12)', () => {
  it('shows the About, Methods, and Licence pages with their last-updated dates', () => {
    const files = build();
    for (const path of ['about.html', 'methods.html', 'licence.html']) {
      expect(page(files, path).mainText).toMatch(/Last updated \d{1,2} [A-Z][a-z]+ \d{4}/u);
    }
    const later = site({ policy: { ...site().policy, licence: { ...site().policy.licence, changedOn: '2027-05-06' } } });
    expect(page(build(later), 'licence.html').mainText).toContain('Last updated 6 May 2027');
  });
});

describe('data/archive.json round-trips the view values char-for-char (R35.4)', () => {
  const files = build();
  const archive = JSON.parse(files.get('data/archive.json')!.content) as { exportedAt: string; scope: string; units: Record<string, unknown> };

  it('carries the export metadata and every exported unit', () => {
    expect(archive.exportedAt).toBe(OPTIONS.startedAt);
    expect(archive.scope).toBe(OPTIONS.scope);
    for (const key of site().views.keys()) expect(Object.hasOwn(archive.units, key)).toBe(true);
  });

  it('serialises each unit exactly as its Public_View, including dates at recorded precision, its Project, Cross_Links, and children', () => {
    for (const [key, view] of site().views) {
      // The archive value is the canonical Public_View itself: same characters, same dates (PartialDate.value), same links and child refs.
      expect(stableJson(archive.units[key])).toBe(stableJson(view));
    }
    // A month-precision date stays a month; a day-precision date keeps its day (R45.12).
    expect(stableJson(archive.units[FINDING.key])).toContain('"1951-04-02"');
    expect(stableJson(archive.units[HYPOTHESIS.key])).toContain('"1952"');
    // The Finding's presented Cross_Links and its Project travel with it.
    expect(stableJson(archive.units[FINDING.key])).toContain('"A synthetic hypothesis"');
    expect((archive.units[FINDING.key] as { project: { name: string } }).project.name).toBe('Alpha Project');
  });
});

describe('CSV data (RFC 4180, R35.1)', () => {
  const files = build();
  const records = (csv: string): string[][] => {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < csv.length; i++) {
      const ch = csv[i]!;
      if (quoted) {
        if (ch === '"') { if (csv[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\r' && csv[i + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; }
      else field += ch;
    }
    if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
    return rows;
  };

  it('writes one research-item row per exported Research_Item with its shown values', () => {
    const rows = records(files.get('data/research-items.csv')!.content);
    expect(rows[0]).toEqual(['identifier', 'kind', 'project', 'title', 'first_public', 'date', 'url']);
    const finding = rows.find((r) => r[0] === FINDING.identifier)!;
    expect(finding).toEqual([FINDING.identifier, 'finding', 'Alpha Project', 'A synthetic finding', '2026-01-05', '1951-04-02', 'r/AAAA-1111-BBBB.html']);
    expect(rows.slice(1)).toHaveLength([...site().views.values()].filter((v) => v.tag === 'research_item').length);
  });

  it('writes one attachment row per exported Attachment and quotes fields that need it', () => {
    const rows = records(files.get('data/attachments.csv')!.content);
    expect(rows[0]![0]).toBe('identifier');
    const old = rows.find((r) => r[0] === FILE_OLD.identifier)!;
    expect(old).toEqual([FILE_OLD.identifier, FINDING.path, 'Scan, first version', 'PDF', '2500000', 'Licensed', 'An Archive', 'a/EEEE-3333-FFFF.html']);
  });

  it('quotes a value that contains a comma', () => {
    const commaFinding = { ...FINDING, title: 'A finding, with a comma' };
    const rows = records(build(site({ views: new Map([...site().views, [commaFinding.key, commaFinding]]) })).get('data/research-items.csv')!.content);
    expect(rows.find((r) => r[0] === FINDING.identifier)![3]).toBe('A finding, with a comma');
  });
});

describe('LICENSE.txt, MANIFEST.json, and SHA256SUMS (R35.1)', () => {
  const files = build();

  it('writes the Content_Licence name and URL, never the software licence', () => {
    const licence = files.get('LICENSE.txt')!.content;
    expect(licence).toContain('Synthetic Licence 1.0');
    expect(licence).toContain('https://licence.example.test/1.0');
    expect(licence).not.toContain('MIT');
  });

  it('lists every produced text file in the manifest with its byte length and checksum, leaving the Attachment copies for the job', () => {
    const manifest = JSON.parse(files.get('MANIFEST.json')!.content) as { files: { path: string; bytes: number | null; sha256: string | null }[] };
    const paths = manifest.files.map((entry) => entry.path);
    expect(paths).toContain('index.html');
    expect(paths).toContain('data/archive.json');
    for (const entry of manifest.files) {
      expect(entry.bytes).toBeGreaterThan(0);
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/u);
    }
    // The job appends an entry per copied Attachment file; the render layer lists only the files it produced.
    expect(paths.some((path) => path.startsWith('files/'))).toBe(false);
  });

  it('writes SHA256SUMS lines that match the bytes of each text file', () => {
    const sums = files.get('SHA256SUMS')!.content;
    for (const line of sums.trimEnd().split('\n')) {
      const [hash, path] = [line.slice(0, 64), line.slice(66)];
      expect(line[64]).toBe(' ');
      const file = files.get(path);
      expect(file, path).toBeDefined();
      expect(sha256Sums([file!])).toBe(`${hash}  ${path}\n`);
    }
  });

  it('keeps the manifest and checksums of the same text files consistent', () => {
    const produced = renderExport(site(), OPTIONS).filter((file) => file.path !== 'MANIFEST.json' && file.path !== 'SHA256SUMS');
    const manifest = exportManifest(produced, OPTIONS.startedAt, OPTIONS.scope);
    const sumPaths = new Set(sha256Sums(produced).trimEnd().split('\n').map((line) => line.slice(66)));
    for (const entry of manifest.files) expect(sumPaths.has(entry.path), entry.path).toBe(true);
  });
});
