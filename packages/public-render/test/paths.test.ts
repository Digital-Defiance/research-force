import { describe, expect, it } from 'vitest';
import { RESERVED_PROJECT_SLUGS } from '@researchforce/domain/schemas/people';
import { checkedSlug, fileFor, paged, projectPaths, robotsTxt, sitemapXml } from '../src/paths';

describe('public paths', () => {
  it('forms Project_Section addresses from the slug and fixed text only', () => {
    const paths = projectPaths('alpha');
    expect([paths.page, paths.listing('archival_request'), paths.listing('finding', 3), paths.log(), paths.log(2), paths.withheld(), paths.search, paths.submit]).toEqual([
      '/p/alpha', '/p/alpha/archival-requests', '/p/alpha/findings/page/3', '/p/alpha/log', '/p/alpha/log/page/2', '/p/alpha/withheld', '/p/alpha/search', '/p/alpha/submit',
    ]);
  });

  it('refuses reserved names and slugs that break the Project_Slug rule', () => {
    for (const slug of RESERVED_PROJECT_SLUGS) expect(() => checkedSlug(slug)).toThrow(RangeError);
    for (const slug of ['', 'Upper', '-lead', 'has space', 'a/b', 'x'.repeat(41)]) expect(() => checkedSlug(slug)).toThrow(RangeError);
    expect(checkedSlug('p1030-test')).toBe('p1030-test');
  });

  it('numbers listing pages from 1', () => {
    expect(paged('/projects', 1)).toBe('/projects');
    expect(paged('/projects', 2)).toBe('/projects/page/2');
    for (const page of [0, -1, 1.5, Number.NaN]) expect(() => paged('/projects', page)).toThrow(RangeError);
  });

  it('maps addresses to static files', () => {
    expect([fileFor('/'), fileFor('/404'), fileFor('/r/AAAA-1111-BBBB'), fileFor('/p/alpha/log/page/2')]).toEqual(['index.html', '404.html', 'r/AAAA-1111-BBBB.html', 'p/alpha/log/page/2.html']);
    for (const path of ['', 'relative', '/a/../b', '//host']) expect(() => fileFor(path)).toThrow(RangeError);
  });

  it('writes a sitemap of absolute addresses and a robots file that points to it', () => {
    const xml = sitemapXml(['/r/B', '/', '/r/B', '/a?x=1&y=2']);
    expect(xml).toContain('<loc>https://researchforce.org</loc>');
    expect(xml.match(/<loc>https:\/\/researchforce\.org\/r\/B<\/loc>/gu)).toHaveLength(1);
    expect(xml).toContain('/a?x=1&#38;y=2');
    expect(robotsTxt()).toContain('Sitemap: https://researchforce.org/sitemap.xml');
  });
});
