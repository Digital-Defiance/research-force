/**
 * Generated canary payloads and the in-browser probe that proves a delivered file is inert
 * (task 45.3, R14.6, R60.4). A canary is a file whose only job is to misbehave if the delivery
 * path lets it: it tries to run a script, read the Member's session, and call back to the
 * Workspace origin. Each canary carries a fresh random marker, so a run proves the live path
 * neutralized THIS payload rather than matching a constant the host might special-case — a
 * registered constant refusal is not evidence (R60.4).
 *
 * The probes work by loading a delivered file inside a browsing context and watching for three
 * signals: a global the file's script would set if it ran, a request the file would make to the
 * Workspace origin (which must never be accepted as the Member), and navigation or a popup the
 * file would trigger. The isolation tests assert none of these fire.
 */

/** The file kinds the delivery path must neutralize, each exercised as a canary (R14.6). */
export const CANARY_KINDS = ['html', 'svg', 'pdf', 'polyglot'] as const;
export type CanaryKind = (typeof CANARY_KINDS)[number];

/** A canary payload: its bytes, the content type a naive host might serve it as, and its unique marker. */
export interface Canary {
  readonly kind: CanaryKind;
  readonly marker: string;
  readonly bytes: Uint8Array;
  /** The content type a non-hardened host might apply; the delivery path must override it to octet-stream or sandbox it. */
  readonly naiveContentType: string;
  /** A short description for the test title. */
  readonly description: string;
}

/** A fresh, hard-to-guess marker so each canary is distinct from any constant the host might allow-list. */
export function freshMarker(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `rfcanary_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const encoder = new TextEncoder();

/**
 * The script body every canary runs if the delivery path executes it: set a global flag, try to
 * read the Member's cookies, and fetch the Workspace origin with credentials. The `WORKSPACE`
 * placeholder is filled with the configured Workspace origin so the callback targets the real app.
 */
function hostileScript(marker: string, workspaceOrigin: string): string {
  return [
    `window.__${marker}__ = 'executed';`,
    `try { window.__${marker}_cookies__ = document.cookie; } catch (e) { window.__${marker}_cookies__ = 'blocked'; }`,
    `try {`,
    `  fetch(${JSON.stringify(`${workspaceOrigin}/api/v1/members`)}, { credentials: 'include' })`,
    `    .then(function (r) { window.__${marker}_fetch__ = r.status; })`,
    `    .catch(function () { window.__${marker}_fetch__ = 'error'; });`,
    `} catch (e) { window.__${marker}_fetch__ = 'threw'; }`,
  ].join('\n');
}

/** An HTML canary: an inline script plus an img onerror handler, the two commonest script vectors. */
function htmlCanary(workspaceOrigin: string): Canary {
  const marker = freshMarker();
  const body =
    `<!doctype html><html><head><meta charset="utf-8"></head><body>`
    + `<img src="x" onerror="window.__${marker}_onerror__ = 'ran'">`
    + `<script>${hostileScript(marker, workspaceOrigin)}</script>`
    + `</body></html>`;
  return { kind: 'html', marker, bytes: encoder.encode(body), naiveContentType: 'text/html; charset=utf-8', description: 'HTML with an inline script and an img onerror handler' };
}

/** An SVG canary: SVGs are documents, so an inline script runs when an SVG is treated as a page. */
function svgCanary(workspaceOrigin: string): Canary {
  const marker = freshMarker();
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>`
    + `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">`
    + `<rect width="64" height="64" fill="#888"></rect>`
    + `<script type="application/javascript">${hostileScript(marker, workspaceOrigin)}</script>`
    + `</svg>`;
  return { kind: 'svg', marker, bytes: encoder.encode(body), naiveContentType: 'image/svg+xml', description: 'SVG carrying an inline script element' };
}

/**
 * A minimal, structurally valid one-page PDF that carries an OpenAction JavaScript entry. A viewer
 * that honours document JavaScript would run it; the delivery path must never hand the file to a
 * context that does. The marker rides in the JavaScript string and in a comment so a run is
 * distinct.
 */
function pdfCanary(marker: string): Uint8Array {
  const js = `app.alert('${marker}');`;
  const objects = [
    `1 0 obj<</Type/Catalog/Pages 2 0 R/OpenAction 5 0 R>>endobj`,
    `2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj`,
    `3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R>>endobj`,
    `4 0 obj<</Length 44>>stream\nBT /F1 12 Tf 20 100 Td (${marker}) Tj ET\nendstream endobj`,
    `5 0 obj<</Type/Action/S/JavaScript/JS(${js})>>endobj`,
  ];
  let body = `%PDF-1.7\n%\u00e2\u00e3\u00cf\u00d3\n% ${marker}\n`;
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(encoder.encode(body).length);
    body += `${object}\n`;
  }
  const xrefAt = encoder.encode(body).length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefAt}\n%%EOF`;
  return encoder.encode(body);
}

/** A PDF canary with an OpenAction JavaScript entry. */
function pdfCanaryFile(): Canary {
  const marker = freshMarker();
  return { kind: 'pdf', marker, bytes: pdfCanary(marker), naiveContentType: 'application/pdf', description: 'PDF with an OpenAction JavaScript entry' };
}

/**
 * A polyglot canary: bytes that are simultaneously a valid GIF (so an img-sniffing host might treat
 * them as an image) and carry an HTML script after the image data. A host that sniffs the GIF
 * header but renders the tail as markup would run the script; the delivery path must refuse to
 * sniff (`nosniff`) and never render it as a document.
 */
function polyglotCanary(workspaceOrigin: string): Canary {
  const marker = freshMarker();
  // GIF89a header and a 1x1 logical screen, enough for a sniffer to call it an image.
  const gifHeader = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00]);
  const html = `<!-- GIF/HTML polyglot ${marker} --><script>${hostileScript(marker, workspaceOrigin)}</script>`;
  const tail = encoder.encode(html);
  const bytes = new Uint8Array(gifHeader.length + tail.length);
  bytes.set(gifHeader, 0);
  bytes.set(tail, gifHeader.length);
  return { kind: 'polyglot', marker, bytes, naiveContentType: 'image/gif', description: 'GIF/HTML polyglot: a valid GIF header followed by a script' };
}

/** Every canary for a run, each with a fresh marker and targeting the given Workspace origin. */
export function canaries(workspaceOrigin: string): Canary[] {
  return [htmlCanary(workspaceOrigin), svgCanary(workspaceOrigin), pdfCanaryFile(), polyglotCanary(workspaceOrigin)];
}

/** An oversized payload, larger than any legitimate preview budget, to exercise the resource-limit refusal path (R14.10). */
export function oversizedCanary(bytes: number): Uint8Array {
  return new Uint8Array(bytes);
}
