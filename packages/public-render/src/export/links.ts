import { element, fragment, type ViewNode } from '@researchforce/domain/tree';
import { FILES_HOST_PREFIX, attachmentFile, pageFile, relativeLink, sitePath } from './paths';

const URL_ATTRIBUTES: ReadonlySet<string> = new Set(['href', 'src']);
const splitHash = (value: string): [string, string] => {
  const hash = value.indexOf('#');
  return hash === -1 ? [value, ''] : [value.slice(0, hash), value.slice(hash)];
};

/**
 * What a link or resource reference becomes in the package, from the file it sits in (R35.3). An in-package page or file link turns
 * relative; a link to a Public_Site page the export leaves out (search, forms) is dropped so the reader never follows a dead link; a link
 * to another site stays as it is. `inPackage` holds every file the package contains, so only real copies are linked.
 */
function rewrite(value: string, fromFile: string, inPackage: ReadonlySet<string>): string | undefined {
  if (value === '' || value.startsWith('#') || value.startsWith('mailto:')) return value;
  if (value.startsWith(FILES_HOST_PREFIX)) {
    const target = attachmentFile(value.slice(FILES_HOST_PREFIX.length));
    return inPackage.has(target) ? relativeLink(fromFile, target) : undefined;
  }
  // A Public_Site page link is either site-absolute (`https://researchforce.org/…`) or a bare path (`/…`); anything else is external.
  const isSite = value.startsWith('/') && !value.startsWith('//');
  if (!isSite && !value.startsWith('https://researchforce.org')) return value;
  const [path, hash] = splitHash(sitePath(value));
  const target = pageFile(path);
  return inPackage.has(target) ? relativeLink(fromFile, target) + hash : undefined;
}

/**
 * The node with every page/resource link made package-relative (R35.3). A link whose target the package does not hold is unwrapped to its
 * own text, so no dead link survives; a `<link>`/`<img>`/`<script>` whose resource is absent is dropped.
 */
export function relativizeLinks(node: ViewNode, fromFile: string, inPackage: ReadonlySet<string>): ViewNode {
  if (node.kind === 'text') return node;
  if (node.kind === 'fragment') return fragment(node.children.map((child) => relativizeLinks(child, fromFile, inPackage)));
  const children = node.children.map((child) => relativizeLinks(child, fromFile, inPackage));
  const urlAttribute = Object.keys(node.attributes).find((name) => URL_ATTRIBUTES.has(name.toLowerCase()));
  if (urlAttribute === undefined) return element(node.tag, node.attributes, children);
  const original = node.attributes[urlAttribute];
  const rewritten = typeof original === 'string' ? rewrite(original, fromFile, inPackage) : original;
  if (rewritten === undefined) {
    // The target is not in the package: keep an anchor's text, drop a missing resource element.
    return node.tag === 'a' ? fragment(children) : fragment([]);
  }
  return element(node.tag, { ...node.attributes, [urlAttribute]: rewritten }, children);
}
