import { decodeShellBundle } from '@researchforce/public-render/shell-bundle';
import type { ShellAsset } from './render';
const BUNDLE_URL = 'https://assets.local/_shell/bundle.bin';
/**
 * Loads the staged site-shell / Design_System assets (scripts/stage-shell-assets.ts) through the ASSETS binding with
 * ONE fetch of the bundle object (the Workers Free plan allows 50 external subrequests per invocation, so one fetch
 * per file would not fit). No binding, or no bundle (the Workspace asset directory answers a missing path with its
 * HTML fallback), ships none (the earlier behaviour). A bundle that is present but malformed or truncated throws, so
 * a run fails rather than publishing a half-styled site.
 */
export async function loadShellAssets(assets: Fetcher | undefined): Promise<readonly ShellAsset[]> {
  if (!assets) return [];
  let response: Response;
  try {
    response = await assets.fetch(BUNDLE_URL);
  } catch {
    return [];
  }
  if (!response.ok || (response.headers.get('content-type') ?? '').includes('text/html')) return [];
  return decodeShellBundle(new Uint8Array(await response.arrayBuffer()));
}
