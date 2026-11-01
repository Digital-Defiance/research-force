import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  comparableCitations, escapeHtml, htmlIsInert, parseReleaseCsl, parseReleaseExport, parseReleaseManifest, releaseCslDocument,
  releaseExportDocument, releaseExportHtml, releasePackageManifest, verifyRoundTrip,
} from '../src/release-export';
import { versionCitation } from '../src/releases';
import type { ReleaseArtifactKind } from '../src/releases';

const hash = (c: string) => c.repeat(64);
const release = { id: 'REL1', name: 'Spring release' };
const cite = (kind: ReleaseArtifactKind, identifier: string | null, revision: number | null, sha: string) =>
  versionCitation(release, { kind, identifier, revision, sha256: sha });
const citations = [
  cite('record', 'RF-7', 3, hash('a')),
  cite('attachment', 'RF-9', null, hash('b')),
  cite('citation', null, 1, hash('c')),
];
const bytes = (text: string) => new TextEncoder().encode(text).length;
const digest = (text: string) => bytesToHex(sha256(new TextEncoder().encode(text)));

describe('the JSON release export (R59.4, R59.5)', () => {
  it('names the release and each readable artifact’s version-specific citation, and parses back to the same data', () => {
    const document = releaseExportDocument(release, '2026-10-30T00:00:00.000Z', citations);
    expect(document.releaseId).toBe('REL1');
    expect(document.citations).toHaveLength(3);
    expect(document.citations[0]).toMatchObject({ kind: 'record', identifier: 'RF-7', revision: 3, sha256: hash('a'), line: citations[0]!.line });
    expect(parseReleaseExport(JSON.parse(JSON.stringify(document)))).toEqual(document);
  });
  it('refuses a document with a stray field or an unknown version', () => {
    const document = releaseExportDocument(release, 'now', citations) as Record<string, unknown>;
    expect(() => parseReleaseExport({ ...document, extra: true })).toThrow();
    expect(() => parseReleaseExport({ ...document, version: 2 })).toThrow();
  });
});

describe('the CSL-JSON release export (R59.4, R59.5)', () => {
  it('maps each citation to a CSL document carrying the release, revision and hash in a note, and parses back faithfully', () => {
    const csl = releaseCslDocument(citations);
    expect(csl[0]).toEqual({ id: 'RF-7', type: 'document', title: citations[0]!.line, note: `Release: Spring release (REL1)\nArtifact kind: record\nRevision: 3\nSHA-256: ${hash('a')}` });
    // The attachment has no revision, so its note carries no Revision line.
    expect(csl[1]!.note).not.toContain('Revision:');
    // An artifact with no identifier gets a release-scoped id.
    expect(csl[2]!.id).toBe(`REL1:${hash('c')}`);
    const back = parseReleaseCsl(JSON.parse(JSON.stringify(csl)));
    expect(back).toEqual(citations.map((c) => ({ releaseId: c.releaseId, releaseName: c.releaseName, kind: c.kind, identifier: c.identifier, revision: c.revision, sha256: c.sha256, line: c.line })));
  });
  it('refuses CSL that does not carry the release facts', () => {
    expect(() => parseReleaseCsl([{ id: 'x', type: 'document', title: 't', note: 'nonsense' }])).toThrow();
    expect(() => parseReleaseCsl([{ id: 'x', type: 'article', title: 't', note: '' }])).toThrow();
    expect(() => parseReleaseCsl('not an array' as unknown)).toThrow();
  });
});

describe('the inert HTML citation list (R59.5, R60.9)', () => {
  const html = releaseExportHtml(release, '2026-10-30T00:00:00.000Z', citations);
  it('writes every citation line and hash and no script-capable content', () => {
    expect(html).toContain(citations[0]!.line);
    for (const c of citations) expect(html).toContain(c.sha256);
    expect(htmlIsInert(html)).toBe(true);
  });
  it('escapes every value so an artifact title can introduce no markup', () => {
    const nasty = versionCitation({ id: 'R<1>', name: '<script>alert(1)</script>' }, { kind: 'record', identifier: 'a"b', revision: 1, sha256: hash('d') });
    const dangerous = releaseExportHtml({ id: 'R<1>', name: '<img src=x onerror="alert(1)">' }, 'now', [nasty]);
    // No raw markup survives: the angle brackets and quotes are all escaped, so no handler attribute or element is formed.
    expect(dangerous).not.toContain('<script>');
    expect(dangerous).not.toContain('onerror="');
    expect(dangerous).toContain('&lt;script&gt;');
    expect(dangerous).toContain('onerror=&quot;');
    expect(htmlIsInert(dangerous)).toBe(true);
  });
  it('flags script, handler and scheme as not inert', () => {
    expect(htmlIsInert('<p>ok</p>')).toBe(true);
    expect(htmlIsInert('<script>x()</script>')).toBe(false);
    expect(htmlIsInert('<a onclick="x()">')).toBe(false);
    expect(htmlIsInert('<a href="javascript:x()">')).toBe(false);
  });
  it('escapeHtml maps the five markup characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});

describe('the package manifest (R59.5)', () => {
  it('names each file with its byte length and content hash, and parses back', () => {
    const json = JSON.stringify(releaseExportDocument(release, 'now', citations));
    const csl = JSON.stringify(releaseCslDocument(citations));
    const html = releaseExportHtml(release, 'now', citations);
    const files = [{ path: 'citations.json', text: json }, { path: 'citations.csl.json', text: csl }, { path: 'citations.html', text: html }];
    const manifest = releasePackageManifest(release, files, digest, bytes);
    expect(manifest.files).toHaveLength(3);
    expect(manifest.files[0]).toEqual({ path: 'citations.json', bytes: bytes(json), sha256: digest(json) });
    expect(parseReleaseManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
  });
});

describe('offline round-trip without executing code (R59.5, R60.9)', () => {
  it('reads the JSON and CSL back to the originals and confirms the HTML is inert', () => {
    const json = JSON.stringify(releaseExportDocument(release, 'now', citations));
    const csl = JSON.stringify(releaseCslDocument(citations));
    const html = releaseExportHtml(release, 'now', citations);
    const { json: backJson, csl: backCsl } = verifyRoundTrip({ json, csl, html, citations });
    const expected = citations.map((c) => ({ releaseId: c.releaseId, releaseName: c.releaseName, kind: c.kind, identifier: c.identifier, revision: c.revision, sha256: c.sha256, line: c.line }));
    expect(backJson).toEqual(expected);
    expect(backCsl).toEqual(expected);
  });
  it('throws when the HTML carries a script', () => {
    const json = JSON.stringify(releaseExportDocument(release, 'now', citations));
    const csl = JSON.stringify(releaseCslDocument(citations));
    expect(() => verifyRoundTrip({ json, csl, html: '<script>x()</script>', citations })).toThrow();
  });
});

describe('any readable release round-trips through every format (R59.5)', () => {
  const kinds: readonly ReleaseArtifactKind[] = ['record', 'attachment', 'citation', 'package', 'provenance'];
  const artifact = fc.record({
    kind: fc.constantFrom(...kinds),
    identifier: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: null }),
    revision: fc.option(fc.integer({ min: 0, max: 10_000 }), { nil: null }),
    sha256: fc.array(fc.integer({ min: 0, max: 15 }), { minLength: 64, maxLength: 64 }).map((ns) => ns.map((n) => n.toString(16)).join('')),
  });
  it('JSON, CSL and HTML preserve every citation', () => {
    fc.assert(fc.property(fc.array(artifact, { maxLength: 8 }), fc.string(), (artifacts, name) => {
      const rel = { id: 'REL1', name };
      const cites = artifacts.map((a) => versionCitation(rel, a));
      const json = JSON.stringify(releaseExportDocument(rel, 'now', cites));
      const csl = JSON.stringify(releaseCslDocument(cites));
      const html = releaseExportHtml(rel, 'now', cites);
      const { json: backJson } = verifyRoundTrip({ json, csl, html, citations: cites });
      expect(comparableCitations(parseReleaseExport(JSON.parse(json)))).toEqual([...backJson].sort((a, b) => (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0)));
    }));
  });
});
