import { z } from 'zod';
import type { ReleaseArtifactKind, VersionCitation } from './releases';
import { RELEASE_ARTIFACT_KINDS } from './releases';

/**
 * The offline, open-format export of a Research_Release's version-specific citations (R59.4, R59.5, R60.9). A release is exported as four files
 * that a reader can open without the Workspace: a JSON document (the structured citations), a CSL-JSON array (for reference managers), an inert
 * HTML list (for reading), and a package manifest naming the three files with their byte lengths and SHA-256 hashes. Every helper here is pure:
 * nothing calls the API, nothing reads the clock, and the HTML carries no script, no event-handler attribute and no unescaped value, so opening
 * it executes no code. The export round-trips: `parseExport` reads the JSON back to the same citations, and the CSL and HTML both carry the
 * release id, revision and hash of every artifact, so a later change to the live record is visible rather than silent.
 *
 * External repository/DOI deposit is deliberately NOT part of this export. Depositing an export into an external archive or minting a DOI is a
 * separate, explicit operator action with permanent-copy implications; creating or publishing a release here deposits nothing externally.
 */
export const RELEASE_EXPORT_FORMAT = 'researchforce-release-citations';
export const RELEASE_EXPORT_VERSION = 1;
export const RELEASE_CSL_FORMAT = 'https://citationstyles.org/schema/latest/csl-data.json';

const HASH = /^[0-9a-f]{64}$/u;

/** One exported citation: the faithful machine form of a `VersionCitation`, with nothing about an artifact the exporter could not read. */
const exportedCitationSchema = z.strictObject({
  releaseId: z.string(),
  releaseName: z.string(),
  kind: z.enum(RELEASE_ARTIFACT_KINDS),
  identifier: z.string().nullable(),
  revision: z.number().int().nullable(),
  sha256: z.string().regex(HASH),
  line: z.string(),
});
export type ExportedCitation = z.output<typeof exportedCitationSchema>;

export const releaseExportSchema = z.strictObject({
  format: z.literal(RELEASE_EXPORT_FORMAT),
  version: z.literal(RELEASE_EXPORT_VERSION),
  releaseId: z.string(),
  releaseName: z.string(),
  exportedAt: z.string(),
  citations: z.array(exportedCitationSchema),
});
export type ReleaseExport = z.output<typeof releaseExportSchema>;

/** A `VersionCitation` as it is exported, dropping only the display `line`'s dependence on the live record (the line is kept verbatim). */
export function exportedCitation(citation: VersionCitation): ExportedCitation {
  return { releaseId: citation.releaseId, releaseName: citation.releaseName, kind: citation.kind, identifier: citation.identifier, revision: citation.revision, sha256: citation.sha256, line: citation.line };
}

/** The structured JSON document: the release's identity and every readable artifact's version-specific citation (R59.4). */
export function releaseExportDocument(release: { readonly id: string; readonly name: string }, exportedAt: string, citations: readonly VersionCitation[]): ReleaseExport {
  return { format: RELEASE_EXPORT_FORMAT, version: RELEASE_EXPORT_VERSION, releaseId: release.id, releaseName: release.name, exportedAt, citations: citations.map(exportedCitation) };
}

/** The JSON document, or the reason it is not one: an unknown version or a stray field is refused rather than guessed at. */
export function parseReleaseExport(raw: unknown): ReleaseExport {
  return releaseExportSchema.parse(raw);
}

/**
 * The CSL-JSON array a reference manager reads (CSL 1.0.2 item format). A release artifact has no author, date or publisher, so each item is a
 * `document` whose `id` is the artifact's identifier or a release-scoped key, whose `title` is the citation line, and whose `note` carries the
 * machine facts CSL has no variable for — the release id, the revision and the full SHA-256 — so nothing is dropped and a later change is visible.
 * This is the faithful standard mapping; CSL offers no field for a content hash, so it lives in `note`, one fact per line, as `cslItem` does.
 */
export interface ReleaseCslItem {
  readonly id: string;
  readonly type: 'document';
  readonly title: string;
  readonly note: string;
}
export function releaseCslItem(citation: ExportedCitation | VersionCitation): ReleaseCslItem {
  const notes = [
    `Release: ${citation.releaseName} (${citation.releaseId})`,
    `Artifact kind: ${citation.kind}`,
    ...(citation.revision === null ? [] : [`Revision: ${citation.revision}`]),
    `SHA-256: ${citation.sha256}`,
  ];
  return { id: citation.identifier ?? `${citation.releaseId}:${citation.sha256}`, type: 'document', title: citation.line, note: notes.join('\n') };
}
export function releaseCslDocument(citations: readonly (ExportedCitation | VersionCitation)[]): readonly ReleaseCslItem[] {
  return citations.map(releaseCslItem);
}

const CSL_NOTE = /^Release: (.*) \((.*)\)\nArtifact kind: (.*)\n(?:Revision: (\d+)\n)?SHA-256: ([0-9a-f]{64})$/u;
/** Read a CSL-JSON array back to the citations it carries, so a round-trip can be proven (R59.5). A stray or malformed item is refused. */
export function parseReleaseCsl(raw: unknown): ExportedCitation[] {
  if (!Array.isArray(raw)) throw new Error('A CSL-JSON release export is an array of items.');
  return raw.map((entry) => {
    const item = entry as Partial<ReleaseCslItem>;
    if (item.type !== 'document' || typeof item.title !== 'string' || typeof item.note !== 'string' || typeof item.id !== 'string') throw new Error('Each CSL item is a document with a title and a note.');
    const match = CSL_NOTE.exec(item.note);
    if (match === null) throw new Error('The CSL note does not carry the release, kind, revision and hash of a release artifact.');
    const [, releaseName, releaseId, kind, revision, sha256] = match;
    if (!(RELEASE_ARTIFACT_KINDS as readonly string[]).includes(kind!)) throw new Error('The CSL note names an unknown artifact kind.');
    const identifier = item.id.startsWith(`${releaseId}:`) ? null : item.id;
    return { releaseId: releaseId!, releaseName: releaseName!, kind: kind as ReleaseArtifactKind, identifier, revision: revision === undefined ? null : Number(revision), sha256: sha256!, line: item.title };
  });
}

/** Escape the five characters that could end an attribute or an element, so no exported value can introduce markup (R59.5). */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (ch) => (ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;'));
}

/**
 * The inert HTML citation list (R59.5). It is a static document: no `<script>`, no `javascript:`/`data:` URL, no `on*` handler attribute, every
 * value escaped. Opening it in any browser executes nothing. The release id, each artifact's revision and its full hash are written out, so the
 * reader sees exactly what was cited.
 */
export function releaseExportHtml(release: { readonly id: string; readonly name: string }, exportedAt: string, citations: readonly (ExportedCitation | VersionCitation)[]): string {
  const rows = citations.map((citation) => {
    const facts = [
      `Release ${escapeHtml(citation.releaseId)}`,
      ...(citation.revision === null ? [] : [`revision ${citation.revision}`]),
      `SHA-256 ${escapeHtml(citation.sha256)}`,
    ].join(', ');
    return `    <li>\n      <p class="rf-citation-line">${escapeHtml(citation.line)}</p>\n      <p class="rf-citation-facts">${facts}</p>\n    </li>`;
  }).join('\n');
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    `  <title>Citations for ${escapeHtml(release.name)}</title>`,
    '</head>',
    '<body>',
    `  <h1>Citations for ${escapeHtml(release.name)} (release ${escapeHtml(release.id)})</h1>`,
    `  <p>Exported ${escapeHtml(exportedAt)}. This is a static citation list; it runs no code.</p>`,
    `  <ol class="rf-citations">`,
    rows,
    '  </ol>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** Whether exported HTML is inert: no script element, no event-handler attribute, no script-capable URL scheme (R59.5, R60.9). */
export function htmlIsInert(html: string): boolean {
  const lower = html.toLowerCase();
  if (lower.includes('<script')) return false;
  // A live handler attribute is `on…="…"` with a raw quote. Data is escaped (every quote becomes `&quot;`), so a quoted handler can only come from
  // markup, never from an exported value; a bare `onx=a` inside escaped text forms no attribute because the surrounding `<`/`>` are entities.
  if (/\son[a-z]+\s*=\s*["'][^&]/u.test(lower)) return false;
  if (/(?:href|src)\s*=\s*["']\s*(?:javascript|data|vbscript):/u.test(lower)) return false;
  return true;
}

const SHA256_HEX = HASH;
/** One file of the package: its path, its byte length, and the SHA-256 of its bytes, so a reader can verify each copy it received (R59.5). */
export interface ManifestEntry {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}
export const releaseManifestEntrySchema = z.strictObject({ path: z.string(), bytes: z.number().int().min(0), sha256: z.string().regex(SHA256_HEX) });
export const releaseManifestSchema = z.strictObject({
  format: z.literal(RELEASE_EXPORT_FORMAT),
  version: z.literal(RELEASE_EXPORT_VERSION),
  releaseId: z.string(),
  files: z.array(releaseManifestEntrySchema),
});
export type ReleaseExportManifest = z.output<typeof releaseManifestSchema>;

/** The package manifest naming each exported file with its byte length and content hash. `hash` is injected so the module stays pure and sync. */
export function releasePackageManifest(release: { readonly id: string }, files: readonly { readonly path: string; readonly text: string }[], hash: (text: string) => string, byteLength: (text: string) => number): ReleaseExportManifest {
  return {
    format: RELEASE_EXPORT_FORMAT,
    version: RELEASE_EXPORT_VERSION,
    releaseId: release.id,
    files: files.map((file) => ({ path: file.path, bytes: byteLength(file.text), sha256: hash(file.text) })),
  };
}
export function parseReleaseManifest(raw: unknown): ReleaseExportManifest {
  return releaseManifestSchema.parse(raw);
}

/** The citations two exports must agree on to be the same release, in a fixed order, ignoring when each was made. */
export function comparableCitations(document: ReleaseExport): readonly ExportedCitation[] {
  return [...document.citations].sort((a, b) => (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0));
}

/**
 * Prove an offline round-trip (R59.5): the JSON parses back to the citations it was built from, the CSL array parses back to the same citations,
 * and the HTML is inert and names every hash. Returns the parsed-back citations so a caller can compare them with the originals; throws with a
 * reason if any format fails to round-trip.
 */
export function verifyRoundTrip(parts: { readonly json: string; readonly csl: string; readonly html: string; readonly citations: readonly VersionCitation[] }): { readonly json: readonly ExportedCitation[]; readonly csl: readonly ExportedCitation[] } {
  const fromJson = parseReleaseExport(JSON.parse(parts.json)).citations;
  const fromCsl = parseReleaseCsl(JSON.parse(parts.csl));
  if (!htmlIsInert(parts.html)) throw new Error('The exported HTML is not inert.');
  for (const citation of parts.citations) {
    if (!parts.html.includes(citation.sha256)) throw new Error('The exported HTML omits an artifact hash.');
  }
  const expected = parts.citations.map(exportedCitation);
  if (JSON.stringify(fromJson) !== JSON.stringify(expected)) throw new Error('The JSON export did not round-trip.');
  if (JSON.stringify(fromCsl) !== JSON.stringify(expected)) throw new Error('The CSL export did not round-trip.');
  return { json: fromJson, csl: fromCsl };
}
