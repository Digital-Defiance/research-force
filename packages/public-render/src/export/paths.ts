import { FILES_ORIGIN, SITE_ORIGIN, fileFor } from '../paths';

/**
 * The package's folder layout (R35.1, R35.3). Every HTML page is the file a static host would serve for its Public_Site address, so an
 * item at `/r/AAAA` becomes `r/AAAA.html` and a listing at `/p/alpha/journal` becomes `p/alpha/journal.html`. Attachment file copies the
 * job writes (task 38.2) live under `files/`, mirroring the public files host's download path.
 */
export const INDEX_FILE = 'index.html';
export const ASSETS_DIR = 'assets';
export const DATA_DIR = 'data';
export const FILES_DIR = 'files';

/** The package file an HTML page at a Public_Site address is written to. */
export const pageFile = (path: string): string => fileFor(path);

/** The package path of an Attachment file copy, from its download path on the public files host (e.g. `/f/EEEE` → `files/f/EEEE`). */
export const attachmentFile = (download: string): string => {
  if (!download.startsWith('/') || download.includes('..') || download.includes('//')) throw new RangeError(`Not a download path: ${download}`);
  return `${FILES_DIR}${download}`;
};

/**
 * The relative link from one package file to another, so every inter-page link resolves inside the package folder with no network (R35.3).
 * Both arguments are package-relative paths (`index.html`, `r/AAAA.html`, `assets/tokens.css`); the result is relative to the directory of
 * `from`. A link to the file itself becomes its bare name so the href is never empty.
 */
export function relativeLink(from: string, to: string): string {
  const fromParts = from.split('/');
  fromParts.pop(); // drop the file name, keep the directory
  const toParts = to.split('/');
  let shared = 0;
  while (shared < fromParts.length && shared < toParts.length - 1 && fromParts[shared] === toParts[shared]) shared++;
  const up = fromParts.slice(shared).map(() => '..');
  const down = toParts.slice(shared);
  const relative = [...up, ...down].join('/');
  return relative === '' ? (toParts.at(-1) ?? '') : relative;
}

/** The Public_Site address an absolute page URL carries, with the site origin stripped; `https://researchforce.org` → `/`. */
export function sitePath(url: string): string {
  if (url === SITE_ORIGIN) return '/';
  return url.startsWith(SITE_ORIGIN) ? url.slice(SITE_ORIGIN.length) : url;
}

export const FILES_HOST_PREFIX = FILES_ORIGIN;
