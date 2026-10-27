import type { Nodes } from 'mdast';
import { parseMarkdown, startOf } from '../render';
import type { ParsedEntry } from './parse';

export interface AttachmentFile {
  /** The original file name, such as `ledger-1943.pdf`. */
  readonly fileName: string;
  /** The file's path on the current site, such as `/attachments/ledger-1943.pdf`. */
  readonly sitePath: string;
}

const OPENING = /^[([{<"'‘“]+/u;
const CLOSING = /[)\]}>"'’”.,;:!?]+$/u;
const DEFINITION_LIKE = /^ {0,3}\[[^\]]+\]:/mu;

function decoded(value: string): string[] {
  try {
    const plain = decodeURI(value);
    return plain === value ? [value] : [value, plain];
  } catch {
    return [value];
  }
}
function pathTokens(value: string): string[] {
  return value.split(/\s+/u).map((token) => token.replace(OPENING, '').replace(CLOSING, '')).filter((token) => token !== '');
}

/** Link and image destinations, autolinks, and path tokens in text and code spans of one section. */
function sectionTokens(text: string, definitions: string): string[] {
  const appended = definitions && text.includes('[') ? `${text}\n\n${definitions}` : text;
  const root = parseMarkdown(appended);
  const urls = new Map<string, string>();
  const visitDefinitions = (node: Nodes): void => {
    if (node.type === 'definition') urls.set(node.identifier, node.url);
    if ('children' in node) node.children.forEach(visitDefinitions);
  };
  visitDefinitions(root);
  const tokens: string[] = [];
  const visit = (node: Nodes): void => {
    if (node.type !== 'root' && startOf(node) >= text.length) return;
    switch (node.type) {
      case 'link': case 'image': case 'definition': tokens.push(...decoded(node.url)); break;
      case 'linkReference': case 'imageReference': { const url = urls.get(node.identifier); if (url !== undefined) tokens.push(...decoded(url)); break; }
      case 'text': case 'inlineCode': tokens.push(...pathTokens(node.value)); break;
      default: break;
    }
    if ('children' in node) node.children.forEach(visit);
  };
  visit(root);
  return tokens;
}

const indexes = new WeakMap<readonly ParsedEntry[], readonly ReadonlySet<string>[]>();
function referenceIndex(entries: readonly ParsedEntry[]): readonly ReadonlySet<string>[] {
  const known = indexes.get(entries);
  if (known) return known;
  const definitions = entries.flatMap((entry) => entry.sections).filter((section) => DEFINITION_LIKE.test(section.text)).map((section) => section.text).join('\n\n');
  const index = entries.map((entry) => new Set(entry.sections.flatMap((section) => sectionTokens(section.text, definitions))));
  indexes.set(entries, index);
  return index;
}

const references = (tokens: ReadonlySet<string>, file: AttachmentFile): boolean => {
  if (tokens.has(file.sitePath)) return true;
  const suffix = `/${file.fileName}`;
  for (const token of tokens) if (token.endsWith(suffix)) return true;
  return false;
};

/**
 * The attachment's Parent: the first entry in source order whose content references the file by a link or image destination, an autolink, or a path
 * token in text or a code span that equals the site path or ends with `/{file name}` (R26.2). This is the only place the rule is defined.
 */
export function resolveAttachmentParent(entries: readonly ParsedEntry[], file: AttachmentFile): ParsedEntry | undefined {
  const index = referenceIndex(entries);
  return entries.find((_, position) => references(index[position]!, file));
}

const FILE_LIKE = /^[^\s:]*\/[^/\s]*[^/\s.]\.[A-Za-z0-9]{1,8}$/u;

/** Reference tokens that look like file paths (a `/` and a final segment with an extension), each with the first entry that holds it. */
export function referencedPaths(entries: readonly ParsedEntry[]): Map<string, ParsedEntry> {
  const index = referenceIndex(entries);
  const paths = new Map<string, ParsedEntry>();
  entries.forEach((entry, position) => {
    for (const token of index[position]!) if (FILE_LIKE.test(token) && !paths.has(token)) paths.set(token, entry);
  });
  return paths;
}

/** Files that no entry references; the import refuses them (R26.12). */
export function unreferencedFiles<T extends AttachmentFile>(entries: readonly ParsedEntry[], files: readonly T[]): T[] {
  return files.filter((file) => resolveAttachmentParent(entries, file) === undefined);
}
