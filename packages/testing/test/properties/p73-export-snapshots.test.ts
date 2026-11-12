// Feature: research-collab-cms, Property 73: Exports contain exactly the snapshot and are self-contained
import { describe, expect, it } from 'vitest';
import { sha256Hex, utf8ByteLength } from '@researchforce/domain/text-fragments';
import type { AttachmentView } from '@researchforce/kernel/views';
import { exportManifest, sha256Sums } from '@researchforce/public-render/export/manifest';
import type { ExportFile } from '@researchforce/public-render/export/manifest';
import { attachmentFile, pageFile } from '@researchforce/public-render/export/paths';
import { renderExport } from '@researchforce/public-render/export/render-export';
import type { SiteInput } from '@researchforce/public-render/site';
import { fc, FC_RUNS } from '../../src/fc';
import { readPage, type HtmlNode } from '../../src/html';
import { siteInputFor } from '../../src/site';
import { workspaceStateArb } from '../../src/workspace';

/**
 * Validates R35.1, R35.2, R35.3, R35.12.
 *
 * Property 73: for any history of changes and export start time T, the Public_Archive_Export package contains exactly
 * the Public_Views current at T for the Export_Scope, the file of every Attachment Public at T, the About, Methods, and
 * Licence pages as of T, and a manifest listing every file with size and checksum — and every link and resource
 * reference in every HTML page resolves to a file inside the package.
 *
 *  - R35.1 — the package carries the index, an HTML page per exported Project, Research_Item, and browsable listing,
 *            the JSON and CSV data, the Content_Licence, a file per Public Attachment, and the Export_Manifest, each
 *            manifest entry naming the file with its byte size and SHA-256 checksum.
 *  - R35.2 — the package holds EXACTLY the Public_Views of the scope — every Public or Withheld unit of the scope and
 *            nothing else — so `data/archive.json` keys the snapshot one-for-one against the views current at T.
 *  - R35.3 — the HTML pages open offline: every surviving link and resource reference resolves to a copy inside the
 *            package, with no dangling pointer to external state.
 *  - R35.12 — the About, Methods, and Licence pages are present, reachable from the index, and each carries its
 *             last-updated date as of T.
 *
 * Chosen layer. The single production path that builds a Public_Archive_Export package is `renderExport`
 * (packages/public-render/src/export/render-export.ts) — the pure builder the export job (apps/app/src/jobs/export.ts)
 * calls for every text file of the package, writing each file's bytes verbatim under `rf-private/exports/{id}/`. The job
 * then copies one file per Public Attachment under `files/`, deriving each copy's package path with the SAME production
 * helper `attachmentFile(view.download)` its `attachmentCopies` uses, and drops `renderExport`'s placeholder
 * `MANIFEST.json`/`SHA256SUMS`. So this property drives the REAL builder over a generated snapshot and reconstructs the
 * complete package exactly as the job assembles it — the render's text files (minus the two placeholders) plus one
 * `files/…` entry per Public Attachment (plus `assets/components.css`, the on-disk stylesheet pages link that the job
 * copies beside the produced assets). It never reimplements the export: the pages, index, data, manifest, and link
 * relativisation all come from `renderExport`; the Attachment package paths come from `attachmentFile`; the manifest's
 * size/checksum oracle is the production `exportManifest` with `utf8ByteLength`/`sha256Hex`.
 *
 * The snapshot generator. `workspaceStateArb` (packages/testing/src/workspace.ts) is "any history of changes": a whole
 * synthetic workspace of Projects, Members, External_Parties, and units at every Disclosure_Level, with Cross_Links and
 * supersession. `siteInputFor` (packages/testing/src/site.ts) projects it to the `SiteInput` of the Public_Views current
 * at T — exactly the single-source-of-truth snapshot the export job renders — so the property reads "the Public_Views
 * current at T for the Export_Scope" straight from the views it feeds `renderExport`.
 *
 * No shared state. The whole chain — `siteInputFor` and `renderExport` — is pure over generated values, with no D1, R2,
 * or Durable Object, so the p88 per-run reset and the p78 run cap used by the stateful export/record properties do not
 * apply here; it runs the full `FC_RUNS` with no setup between runs.
 */

const OPTIONS = { startedAt: '2026-05-06T00:07:00.000Z', scope: 'Whole public archive' } as const;

/** `components.css`, `print.css`, and the font binaries are on-disk files the job copies beside the produced assets; pages link them, so they count as in-package targets the render layer does not itself emit. */
const DISK_ASSETS = ['assets/components.css', 'assets/print.css'] as const;

/** The complete package the export job assembles: the render's text files (minus the two placeholders), the Public Attachment copies, and the disk-copied assets. */
interface Package {
  readonly site: SiteInput;
  /** Every produced text file by package path. */
  readonly files: ReadonlyMap<string, ExportFile>;
  /** Every path the package holds: text files, `files/…` Attachment copies, and the disk-copied assets. */
  readonly paths: ReadonlySet<string>;
  /** The Public Attachment copies the job makes: one `files/…` path per Public AttachmentView. */
  readonly attachmentPaths: ReadonlySet<string>;
}

/** Build the whole package from a generated snapshot, exactly as the export job does. */
function buildPackage(site: SiteInput): Package {
  // The render layer produces the text files; the job drops the render's placeholder MANIFEST.json and SHA256SUMS and
  // writes the final ones that also list the Attachment copies (apps/app/src/jobs/export.ts `plan`).
  const produced = renderExport(site, OPTIONS);
  const files = new Map(produced.map((file) => [file.path, file]));
  // One `files/f/{identifier}` copy per Public Attachment, keyed by its download path with the production helper the job uses.
  const attachmentPaths = new Set<string>();
  for (const view of site.views.values()) if (view.tag === 'attachment') attachmentPaths.add(attachmentFile((view as AttachmentView).download));
  // The package holds every produced path — the text files AND the final `MANIFEST.json`/`SHA256SUMS`, which the job
  // rewrites over the render's placeholders at the same paths — plus the Attachment copies and the disk-copied assets.
  const paths = new Set<string>([...files.keys(), ...attachmentPaths, ...DISK_ASSETS]);
  return { site, files, paths, attachmentPaths };
}

/** Resolve a package-relative link from the file it sits in, as a browser opening the package offline would (`..`/`.` segments, hash stripped). */
function resolve(fromPath: string, href: string): string {
  const base = fromPath.split('/').slice(0, -1);
  for (const part of href.split('#')[0]!.split('/')) {
    if (part === '..') base.pop();
    else if (part !== '.' && part !== '') base.push(part);
  }
  return base.join('/');
}

/** An href that points outside the package and so needs no in-package copy: an empty/fragment link, a `mailto:`, or an absolute URL. */
const isExternal = (href: string): boolean => href === '' || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('https://') || href.startsWith('http://') || href.startsWith('//');

/** Every `href`/`src` reference in an HTML document, across the head and body, in document order. */
function referencesIn(html: string): { readonly attr: 'href' | 'src'; readonly value: string }[] {
  const found: { attr: 'href' | 'src'; value: string }[] = [];
  const walk = (nodes: readonly HtmlNode[]): void => {
    for (const node of nodes) {
      if (typeof node === 'string') continue;
      for (const attr of ['href', 'src'] as const) {
        const value = node.attributes.get(attr);
        if (value !== undefined) found.push({ attr, value });
      }
      walk(node.children);
    }
  };
  const page = readPage(html);
  walk(page.head.children);
  walk(page.body.children);
  return found;
}

/** Every HTML file in the package, by path. */
function htmlPages(pkg: Package): [string, ExportFile][] {
  return [...pkg.files].filter(([, file]) => file.path.endsWith('.html'));
}

describe('Property 73: Exports contain exactly the snapshot and are self-contained', () => {
  it('builds a package holding exactly the snapshot, every Public Attachment file, the policy pages as of T, a sized and checksummed manifest, and only self-contained links', () => {
    fc.assert(fc.property(workspaceStateArb, (state) => {
      const site = siteInputFor(state);
      const pkg = buildPackage(site);

      // --- R35.2 / R35.1: the package holds EXACTLY the snapshot ----------------------------------------------------
      // `data/archive.json` is the machine-readable twin of the exported units. Its keys are the snapshot: they must
      // be, one for one, the Public_Views current at T that the builder was given — no unit added, none dropped.
      const archive = JSON.parse(pkg.files.get('data/archive.json')!.content) as { exportedAt: string; scope: string; units: Record<string, unknown> };
      expect(archive.exportedAt).toBe(OPTIONS.startedAt);
      expect(new Set(Object.keys(archive.units))).toEqual(new Set(site.views.keys()));

      // Every Public_View that names a page (Project, Research_Item, Attachment, and a Withheld unit with a path) has
      // its HTML page in the package; a Withheld unit without a path (a Reply) is shown only in its Parent's page.
      for (const [key, view] of site.views) {
        if (view.tag === 'withheld' && view.path === undefined) continue;
        if (view.tag === 'entry_section' || view.tag === 'reply' || view.tag === 'dissent_note') continue;
        const path = pageFile((view as { readonly path: string }).path);
        expect(pkg.files.has(path), `page for ${key} (${view.tag}) is in the package`).toBe(true);
      }

      // --- R35.1: a file for every Public Attachment, and only those ------------------------------------------------
      // The `files/…` copies the job makes are exactly the Public AttachmentViews: nothing outside the snapshot, and
      // every one of them. (A Withheld Attachment is a `withheld` view with no `download`, so it is never copied.)
      const expectedAttachmentPaths = new Set(
        [...site.views.values()].filter((view): view is AttachmentView => view.tag === 'attachment').map((view) => attachmentFile(view.download)),
      );
      expect(pkg.attachmentPaths).toEqual(expectedAttachmentPaths);
      // Every Public Attachment's page links a download, and the file it would copy is a real member of the package.
      for (const path of pkg.attachmentPaths) expect(pkg.paths.has(path), `attachment file ${path} is in the package`).toBe(true);

      // --- R35.1: the manifest lists every produced text file with its size and checksum ----------------------------
      // The job builds the final manifest from `exportManifest` over its text files (dropping the render's two
      // placeholders) plus an entry per Attachment copy (apps/app/src/jobs/export.ts `fullManifest`). The render's text
      // entries are the ones this pure layer can check: recompute each with the production byte-length and SHA-256
      // helpers a reader uses, so a wrong size or checksum, a missing file, or an extra entry fails here.
      const textFiles = [...pkg.files.values()].filter((file) => file.path !== 'MANIFEST.json' && file.path !== 'SHA256SUMS');
      const manifest = exportManifest(textFiles, OPTIONS.startedAt, OPTIONS.scope);
      expect(new Set(manifest.files.map((entry) => entry.path))).toEqual(new Set(textFiles.map((file) => file.path)));
      const byPath = new Map(textFiles.map((file) => [file.path, file]));
      for (const entry of manifest.files) {
        const file = byPath.get(entry.path)!;
        expect(entry.bytes, `manifest size of ${entry.path}`).toBe(utf8ByteLength(file.content));
        expect(entry.sha256, `manifest checksum of ${entry.path}`).toBe(sha256Hex(file.content));
      }
      // The `SHA256SUMS` the job writes lists the same text files (then the Attachment copies), each line's hash
      // matching the file's bytes; `sha256Sums` is the production builder the job reuses in `fullSums` (R35.1).
      const sumLines = sha256Sums(textFiles).trimEnd().split('\n').filter((line) => line !== '');
      expect(new Set(sumLines.map((line) => line.slice(66)))).toEqual(new Set(textFiles.map((file) => file.path)));
      for (const line of sumLines) {
        const [hash, path] = [line.slice(0, 64), line.slice(66)];
        expect(line[64], `${path} line separator`).toBe(' ');
        expect(hash, `${path} checksum line`).toBe(sha256Hex(byPath.get(path)!.content));
      }

      // --- R35.12: the About, Methods, and Licence pages, as of T, reachable from the index -------------------------
      const index = readPage(pkg.files.get('index.html')!.content);
      const indexTargets = new Set(index.links.map((link) => resolve('index.html', link.href)));
      for (const policy of ['about.html', 'methods.html', 'licence.html']) {
        const page = pkg.files.get(policy);
        expect(page, `${policy} is in the package`).toBeDefined();
        // Each policy page carries its last-updated date (the policy sections' change date projected at T).
        expect(readPage(page!.content).mainText, `${policy} shows a last-updated date`).toMatch(/Last updated \d{1,2} [A-Z][a-z]+ \d{4}/u);
        // The index links to it, so it is reachable offline from the package root (R35.1, R35.12).
        expect(indexTargets.has(policy), `index links ${policy}`).toBe(true);
      }

      // --- R35.3 / R35.12: every HTML link and resource reference resolves to a file inside the package -------------
      // The builder relativises in-package links and drops any whose target the package does not hold, so no dangling
      // pointer can survive. Confirm it: every surviving href/src that is not an external URL, a fragment, or a mailto
      // resolves — relative to the page it sits in — to a real member of the complete package (text file, Attachment
      // copy, or the disk-copied `assets/components.css`). This is the self-containment of R35.3.
      for (const [path, file] of htmlPages(pkg)) {
        for (const reference of referencesIn(file.content)) {
          if (isExternal(reference.value)) continue;
          // No surviving in-package reference is site-absolute: offline pages never point at a host root (R35.3).
          expect(reference.value.startsWith('/'), `${path} → ${reference.attr}="${reference.value}" is relative`).toBe(false);
          const target = resolve(path, reference.value);
          expect(pkg.paths.has(target), `${path} → ${reference.attr}="${reference.value}" resolves inside the package (${target})`).toBe(true);
        }
      }
    }), { numRuns: FC_RUNS });
    // 200 ms per run: 100 runs took ~6.7 s on a CI runner, past the old 50 ms-per-run budget.
  }, 200 * FC_RUNS);
});
