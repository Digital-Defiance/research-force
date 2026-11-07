import type { ShellAsset } from './render';
interface IndexEntry { readonly path: string; readonly contentType: string; readonly file: string }
const INDEX_URL = 'https://assets.local/_shell/index.json';
function isIndex(value: unknown): value is readonly IndexEntry[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'object' && entry !== null
    && typeof (entry as IndexEntry).path === 'string' && typeof (entry as IndexEntry).contentType === 'string' && typeof (entry as IndexEntry).file === 'string');
}
/**
 * Loads the staged site-shell / Design_System assets (scripts/stage-shell-assets.ts) through the ASSETS binding.
 * No binding, or no readable index, ships none (the earlier behaviour). A file the index lists but the binding cannot
 * return throws, so a run fails rather than publishing a half-styled site.
 */
export async function loadShellAssets(assets: Fetcher | undefined): Promise<readonly ShellAsset[]> {
  if (!assets) return [];
  let index: unknown;
  try {
    const response = await assets.fetch(INDEX_URL);
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes('json')) return [];
    index = await response.json();
  } catch {
    return [];
  }
  if (!isIndex(index)) return [];
  const loaded: ShellAsset[] = [];
  for (const entry of index) {
    const response = await assets.fetch(`https://assets.local/_shell/${entry.file}`);
    // The asset directory falls back to the Workspace index.html for unknown paths, which answers 200 with HTML.
    if (!response.ok || (response.headers.get('content-type') ?? '').includes('text/html')) throw new Error(`shell asset ${entry.path} is listed but could not be read (${response.status})`);
    loaded.push({ path: entry.path, contentType: entry.contentType, content: new Uint8Array(await response.arrayBuffer()) });
  }
  return loaded;
}
