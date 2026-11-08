/**
 * The staged site-shell / Design_System assets as ONE object (`_shell/bundle.bin`), so the Publisher reads them
 * with a single ASSETS fetch instead of one per file (Workers Free plan subrequest limits).
 *
 * Layout: [uint32 big-endian header byte length][UTF-8 JSON header: [{path, contentType, length}]][bodies, concatenated
 * in header order]. A truncated or malformed bundle throws, so a partial set can never be returned.
 */
export interface ShellBundleEntry { readonly path: string; readonly contentType: string; readonly content: Uint8Array }
interface HeaderEntry { readonly path: string; readonly contentType: string; readonly length: number }
export function encodeShellBundle(entries: readonly ShellBundleEntry[]): Uint8Array {
  const header = new TextEncoder().encode(JSON.stringify(entries.map((e): HeaderEntry => ({ path: e.path, contentType: e.contentType, length: e.content.length }))));
  const total = 4 + header.length + entries.reduce((sum, e) => sum + e.content.length, 0);
  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, header.length, false);
  out.set(header, 4);
  let at = 4 + header.length;
  for (const entry of entries) { out.set(entry.content, at); at += entry.content.length; }
  return out;
}
const isHeader = (value: unknown): value is readonly HeaderEntry[] =>
  Array.isArray(value) && value.every((e) => typeof e === 'object' && e !== null
    && typeof (e as HeaderEntry).path === 'string' && typeof (e as HeaderEntry).contentType === 'string'
    && Number.isInteger((e as HeaderEntry).length) && (e as HeaderEntry).length >= 0);
export function decodeShellBundle(bytes: Uint8Array): ShellBundleEntry[] {
  if (bytes.length < 4) throw new Error('shell bundle is truncated (no header length)');
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
  if (4 + headerLength > bytes.length) throw new Error('shell bundle is truncated (header)');
  let header: unknown;
  try { header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headerLength))); } catch { throw new Error('shell bundle header is not valid JSON'); }
  if (!isHeader(header)) throw new Error('shell bundle header is malformed');
  const entries: ShellBundleEntry[] = [];
  let at = 4 + headerLength;
  for (const entry of header) {
    if (at + entry.length > bytes.length) throw new Error(`shell bundle is truncated (${entry.path})`);
    entries.push({ path: entry.path, contentType: entry.contentType, content: bytes.slice(at, at + entry.length) });
    at += entry.length;
  }
  if (at !== bytes.length) throw new Error('shell bundle has trailing bytes');
  return entries;
}
