import { beforeEach, describe, expect, it } from 'vitest';
import { OPERATIONS } from '@researchforce/domain/settings';
import { unitKey } from '@researchforce/kernel/views';
import type { Generation } from '@researchforce/db/publication-epoch';
import type { ULID } from '@researchforce/domain/types';
import { base64Of, directUploadHash, extensionOf, planSite, reachesFileAlert } from '../src/publisher/plan';
import type { ManifestEntry, PlannedFile } from '../src/publisher/plan';
import { headersFile, loadSiteInput, renderSiteBuild } from '../src/publisher/render';
import { runProjectionSlice } from '../src/publisher/projection';
import type { ProjectionDeps } from '../src/publisher/projection';
import { TEST_PUBLIC_COPY, TEST_PUBLIC_COPY_INPUT } from '@researchforce/testing/site';
import { PublicCopyError } from '@researchforce/design/installation';
import { publicCopyOf } from '../src/publisher/public-copy';
import { itemWorld } from './items';

const LICENCE = { name: 'Synthetic Licence 1.0', url: 'https://licence.example.test/1.0' } as const;

// ---------------------------------------------------------------------------
// Pure plan logic: the manifest diff, the Direct Upload hash, and the file-count alert threshold.
// ---------------------------------------------------------------------------

describe('the manifest diff', () => {
  const file = (path: string, hash: string, size = 1): PlannedFile => ({ path, hash, size });
  const entry = (path: string, hash: string, size = 1): ManifestEntry => ({ path, hash, size });

  it('detects added, changed, removed, and unchanged files against the current manifest', () => {
    const rendered = [file('/index.html', 'aaa'), file('/about.html', 'NEW'), file('/new.html', 'ccc')];
    const manifest = [entry('/index.html', 'aaa'), entry('/about.html', 'OLD'), entry('/gone.html', 'ddd')];
    const plan = planSite(rendered, manifest);
    expect(plan.added.map((f) => f.path)).toEqual(['/new.html']);
    expect(plan.changed.map((f) => f.path)).toEqual(['/about.html']);
    expect(plan.unchanged.map((f) => f.path)).toEqual(['/index.html']);
    expect(plan.removed).toEqual(['/gone.html']);
    expect(plan.all).toHaveLength(3);
  });

  it('treats every produced file as added against an empty manifest', () => {
    const plan = planSite([file('/index.html', 'aaa'), file('/404.html', 'bbb')], []);
    expect(plan.added).toHaveLength(2);
    expect(plan.removed).toEqual([]);
  });
});

describe('the Direct Upload hash', () => {
  it('is the SHA-256 of base64(content)+extension kept to 32 hex characters', async () => {
    // Matches Cloudflare's Direct Upload guide: createHash('sha256').update(base64 + extension).digest('hex').slice(0, 32).
    const content = new TextEncoder().encode('<!doctype html><title>x</title>');
    const base64 = base64Of(content);
    const expected = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${base64}html`)))]
      .map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 32);
    const hash = await directUploadHash(content, 'html');
    expect(hash).toBe(expected);
    expect(hash).toMatch(/^[0-9a-f]{32}$/u);
  });

  it('changes when the content changes and is stable when it does not', async () => {
    const a = await directUploadHash(new TextEncoder().encode('one'), 'txt');
    const again = await directUploadHash(new TextEncoder().encode('one'), 'txt');
    const b = await directUploadHash(new TextEncoder().encode('two'), 'txt');
    expect(a).toBe(again);
    expect(a).not.toBe(b);
  });

  it('reads the extension from the manifest path, empty for _headers', () => {
    expect(extensionOf('/index.html')).toBe('html');
    expect(extensionOf('/idx/manifest.json')).toBe('json');
    expect(extensionOf('/robots.txt')).toBe('txt');
    expect(extensionOf('/sitemap.xml')).toBe('xml');
    expect(extensionOf('/_headers')).toBe('');
  });
});

describe('the file-count alert threshold', () => {
  it('fires at 16,000 files, not before', () => {
    expect(reachesFileAlert(OPERATIONS.siteFileAlertThreshold - 1)).toBe(false);
    expect(reachesFileAlert(OPERATIONS.siteFileAlertThreshold)).toBe(true);
    expect(OPERATIONS.siteFileAlertThreshold).toBe(16_000);
  });
});

describe('the _headers file', () => {
  it('sets the Public_Site CSP and security headers, widening connect-src on form pages', () => {
    const headers = headersFile();
    expect(headers).toContain('/*');
    expect(headers).toContain("Content-Security-Policy: default-src 'self'; img-src 'self' https://files.researchforce.org data:;");
    expect(headers).toContain('X-Content-Type-Options: nosniff');
    expect(headers).toContain('Strict-Transport-Security: max-age=63072000; includeSubDomains; preload');
    expect(headers).toContain('Referrer-Policy: strict-origin-when-cross-origin');
    // The form pages add the submit origin, R2 S3 endpoint, and Turnstile.
    expect(headers).toContain('/submit/*');
    expect(headers).toContain('https://submit.researchforce.org');
    expect(headers).toContain('https://challenges.cloudflare.com');
  });
});

// ---------------------------------------------------------------------------
// The render + loader + manifest against live rf-public/rf-core and the rf-private bucket.
// ---------------------------------------------------------------------------

const world = itemWorld();
const core = () => world.core();
const pub = () => world.bindings.RF_PUBLIC;
const priv = () => world.bindings.RF_PRIVATE_BUCKET;
const NOW = () => world.at;
const projectionDeps = (): ProjectionDeps => ({ core: core(), public: pub() });
const renderDeps = () => ({ core: core(), public: pub(), privateBucket: priv(), licence: LICENCE, publicCopy: TEST_PUBLIC_COPY, shellAssets: [] });
const gen = (run: string, epoch: number): Generation => ({ run, epoch });

const makePublic = async (id: ULID): Promise<void> => {
  await core().prepare("UPDATE units SET disclosure_level = 'public' WHERE id = ?1").bind(id).run();
  await core().prepare("UPDATE projects SET disclosure_level = 'public'").run();
};
const publishRow = async (scope: string, changeSeq = 1): Promise<void> => {
  await core().prepare("DELETE FROM outbox WHERE topic = 'publish'").run();
  await core().prepare("INSERT INTO outbox (topic, scope, change_seq, created_at) VALUES ('publish', ?1, ?2, ?3)").bind(scope, changeSeq, world.at).run();
};
const manifestPaths = async (): Promise<string[]> =>
  (await pub().prepare('SELECT path FROM site_files ORDER BY path').all<{ path: string }>()).results.map((row) => row.path);
const manifestRow = async (path: string) => pub().prepare('SELECT path, hash, size FROM site_files WHERE path = ?1').bind(path).first<ManifestEntry>();

beforeEach(async () => {
  await core().batch([core().prepare("DELETE FROM outbox WHERE topic = 'publish'"), core().prepare("DELETE FROM counters WHERE k = 'epoch'")]);
  await pub().batch([pub().prepare('DELETE FROM public_views'), pub().prepare('DELETE FROM publish_runs'), pub().prepare('DELETE FROM site_files')]);
});

describe('loadSiteInput', () => {
  it('builds a SiteInput from the current views, the Project_Order, and the policy sections', async () => {
    const finding = await world.created('author', 'finding');
    await makePublic(finding.id);
    await publishRow(`project:${world.projectId}`);
    await runProjectionSlice(projectionDeps(), gen('r1', 0), NOW());

    const input = await loadSiteInput({ core: core(), public: pub(), licence: LICENCE, publicCopy: TEST_PUBLIC_COPY });
    expect(input.views.has(unitKey(finding.id))).toBe(true);
    expect(input.projectOrder).toContain(`p:${world.projectId}`);
    expect(input.licence).toEqual(LICENCE);
    expect(input.publicCopy).toEqual(TEST_PUBLIC_COPY);
    // The seeded Policy_Sections are present for every page.
    expect(input.policy.about.sections.length).toBeGreaterThan(0);
    expect(input.policy.privacy.sections.some((section) => section.key === 'your_requests' || section.required)).toBe(true);
    expect(input.retention.length).toBeGreaterThan(0);
  });
});

describe('publicCopyOf and the Installation_Public_Copy refusal gate (R46.41, R46.42)', () => {
  it('parses and validates a configured PUBLIC_COPY env binding', () => {
    const validated = publicCopyOf({ PUBLIC_COPY: JSON.stringify(TEST_PUBLIC_COPY_INPUT) });
    expect(validated.name).toBe(TEST_PUBLIC_COPY.name);
    expect(validated.digest).toBe(TEST_PUBLIC_COPY.digest);
  });

  it('refuses when PUBLIC_COPY is unset, empty, unparseable, or partial, with no ResearchForce.org fallback', () => {
    for (const env of [{}, { PUBLIC_COPY: '' }, { PUBLIC_COPY: '  ' }, { PUBLIC_COPY: 'not json' }]) {
      expect(() => publicCopyOf(env)).toThrow(PublicCopyError);
    }
    const partial = JSON.stringify({ ...TEST_PUBLIC_COPY_INPUT, name: '', principles: [] });
    expect(() => publicCopyOf({ PUBLIC_COPY: partial })).toThrow(PublicCopyError);
  });

  it('refuses to assemble the render deps when the public copy is unconfigured, rather than falling back silently', async () => {
    const finding = await world.created('author', 'finding');
    await makePublic(finding.id);
    await publishRow(`project:${world.projectId}`);
    await runProjectionSlice(projectionDeps(), gen('r1', 0), NOW());
    // The Publisher DO's #publicCopy() resolves deps.publicCopy through publicCopyOf(env); an unconfigured env throws
    // there, so renderSiteBuild is never reached and no files are produced from a ResearchForce.org fallback.
    expect(() => publicCopyOf({})).toThrow(PublicCopyError);
    // A validated bundle lets the same render proceed and produce files.
    const result = await renderSiteBuild({ ...renderDeps(), publicCopy: publicCopyOf({ PUBLIC_COPY: JSON.stringify(TEST_PUBLIC_COPY_INPUT) }) }, NOW());
    expect(result.fileCount).toBeGreaterThan(0);
  });
});

describe('a full render', () => {
  it('produces the page set, sitemap.xml, robots.txt, _headers, and the search index, and writes the manifest', async () => {
    const finding = await world.created('author', 'finding');
    await makePublic(finding.id);
    await publishRow(`project:${world.projectId}`);
    await runProjectionSlice(projectionDeps(), gen('r1', 0), NOW());

    const result = await renderSiteBuild(renderDeps(), NOW());
    const paths = await manifestPaths();
    // Core fixed files.
    expect(paths).toContain('/index.html');
    expect(paths).toContain('/404.html');
    expect(paths).toContain('/sitemap.xml');
    expect(paths).toContain('/robots.txt');
    expect(paths).toContain('/_headers');
    // The Research_Item's own page.
    expect(paths).toContain(`/r/${finding['identifier']}.html`);
    // The static search index manifest and at least one shard.
    expect(paths).toContain('/idx/manifest.json');
    expect(paths.some((path) => path.startsWith('/idx/d/'))).toBe(true);
    // The manifest holds exactly the produced set.
    expect(result.fileCount).toBe(paths.length);
    expect(result.plan.added).toHaveLength(paths.length);
    expect(result.plan.removed).toHaveLength(0);
  });

  it('stores every produced file at rf-private/build/{hash} with a matching manifest hash', async () => {
    const finding = await world.created('author', 'finding');
    await makePublic(finding.id);
    await publishRow(`project:${world.projectId}`);
    await runProjectionSlice(projectionDeps(), gen('r1', 0), NOW());

    await renderSiteBuild(renderDeps(), NOW());
    const index = await manifestRow('/index.html');
    expect(index).not.toBeNull();
    const stored = await priv().get(`build/${index!.hash}`);
    expect(stored).not.toBeNull();
    const bytes = new Uint8Array(await stored!.arrayBuffer());
    // The stored bytes hash back to the manifest hash (so 32.1's upload and 32.3's manifest agree).
    expect(await directUploadHash(bytes, 'html')).toBe(index!.hash);
    expect(bytes.length).toBe(index!.size);
  });
});

describe('the manifest diff across runs', () => {
  it('re-renders only the affected pages and updates their rows when a view changes', async () => {
    const finding = await world.created('author', 'finding');
    await makePublic(finding.id);
    await publishRow(`project:${world.projectId}`);
    await runProjectionSlice(projectionDeps(), gen('r1', 0), NOW());
    await renderSiteBuild(renderDeps(), NOW());
    const before = await manifestRow(`/r/${finding['identifier']}.html`);

    // Edit the finding's title; reproject and re-render.
    await core().prepare("UPDATE research_items SET title = 'A changed synthetic title' WHERE unit_id = ?1").bind(finding.id).run();
    await publishRow(`root:${finding.id}`, 2);
    await runProjectionSlice(projectionDeps(), gen('r2', 0), NOW());
    const result = await renderSiteBuild(renderDeps(), NOW());

    const after = await manifestRow(`/r/${finding['identifier']}.html`);
    expect(after!.hash).not.toBe(before!.hash);
    expect(result.plan.changed.some((f) => f.path === `/r/${finding['identifier']}.html`)).toBe(true);
    // The only churn beyond the unit page is the content-hashed search index files (their names carry the hash, so a
    // changed title adds the new shard/bucket and removes the old one). No HTML page is added or removed.
    expect(result.plan.added.every((f) => f.path.startsWith('/idx/'))).toBe(true);
    expect(result.plan.removed.every((path) => path.startsWith('/idx/'))).toBe(true);
    // The new unit-page content is stored under the new hash.
    expect(await priv().get(`build/${after!.hash}`)).not.toBeNull();
  });

  it('drops a unit page from the manifest when the unit becomes Not_Published', async () => {
    const finding = await world.created('author', 'finding');
    await makePublic(finding.id);
    await publishRow(`project:${world.projectId}`);
    await runProjectionSlice(projectionDeps(), gen('r1', 0), NOW());
    await renderSiteBuild(renderDeps(), NOW());
    const page = `/r/${finding['identifier']}.html`;
    expect(await manifestPaths()).toContain(page);

    await core().prepare("UPDATE units SET disclosure_level = 'not_published' WHERE id = ?1").bind(finding.id).run();
    await publishRow(`root:${finding.id}`, 2);
    await runProjectionSlice(projectionDeps(), gen('r2', 0), NOW());
    const result = await renderSiteBuild(renderDeps(), NOW());

    expect(await manifestPaths()).not.toContain(page);
    expect(result.plan.removed).toContain(page);
  });

  it('includes injected site-shell assets in the produced set and the manifest', async () => {
    const finding = await world.created('author', 'finding');
    await makePublic(finding.id);
    await publishRow(`project:${world.projectId}`);
    await runProjectionSlice(projectionDeps(), gen('r1', 0), NOW());

    const shellAssets = [{ path: '/assets/search-abc123.js', contentType: 'text/javascript', content: new TextEncoder().encode('export const x = 1;') }];
    await renderSiteBuild({ ...renderDeps(), shellAssets }, NOW());
    const paths = await manifestPaths();
    expect(paths).toContain('/assets/search-abc123.js');
    const row = await manifestRow('/assets/search-abc123.js');
    expect(await priv().get(`build/${row!.hash}`)).not.toBeNull();
  });
});

describe('the 16,000-file alert', () => {
  it('raises a System_Alert for Administrators when the produced set reaches the threshold', async () => {
    // Drive the threshold with a large injected shell-asset set so the render crosses 16,000 files without building
    // 16,000 real pages. A tiny deduplicated body keeps the 16,000 R2 puts and manifest rows cheap.
    const finding = await world.created('author', 'finding');
    await makePublic(finding.id);
    await publishRow(`project:${world.projectId}`);
    await runProjectionSlice(projectionDeps(), gen('r1', 0), NOW());

    const body = new TextEncoder().encode('x');
    const shellAssets = Array.from({ length: OPERATIONS.siteFileAlertThreshold }, (_unused, index) => ({
      path: `/assets/pad-${index}.js`, contentType: 'text/javascript', content: body,
    }));
    const result = await renderSiteBuild({ ...renderDeps(), shellAssets }, NOW());
    expect(result.fileCount).toBeGreaterThanOrEqual(OPERATIONS.siteFileAlertThreshold);
    expect(result.alerted).toBe(true);
    const alerts = await core().prepare("SELECT count(*) AS n FROM notification_events WHERE event_type = 'system_alert' AND alert_key = 'site_file_count'").first<{ n: number }>();
    expect((alerts?.n ?? 0)).toBeGreaterThan(0);
  });
});
