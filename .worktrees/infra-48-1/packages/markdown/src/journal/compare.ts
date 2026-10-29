import { renderHtml } from '../render';
import type { ParsedEntry } from './parse';
import { printJournal } from './print';

const CODE = /<pre\b[^>]*>[\s\S]*?<\/pre>|<code\b[^>]*>[\s\S]*?<\/code>/gu;

/** Each whitespace run outside code blocks and code spans becomes one space; leading and trailing whitespace is ignored (R27.7). */
export function normalizeHtml(html: string): string {
  let output = '';
  let cursor = 0;
  for (const match of html.matchAll(CODE)) {
    output += html.slice(cursor, match.index).replace(/\s+/gu, ' ') + match[0];
    cursor = match.index + match[0].length;
  }
  return (output + html.slice(cursor).replace(/\s+/gu, ' ')).trim();
}

/** Whether two Markdown texts render to the same HTML with the same renderer and settings. */
export function compareRendered(a: string, b: string): boolean { return normalizeHtml(renderHtml(a)) === normalizeHtml(renderHtml(b)); }

export interface EntryMismatch { readonly title: string; readonly importKey: string; readonly lines: readonly [number, number]; }
export interface JournalComparison {
  readonly printed: string;
  /** Whether the whole printed journal renders as the source does (R27.7). */
  readonly passes: boolean;
  /** Entries whose printed Markdown renders differently from their own source lines (R27.8). */
  readonly mismatches: readonly EntryMismatch[];
}

export function compareJournal(source: string, entries: readonly ParsedEntry[]): JournalComparison {
  const printed = printJournal(entries);
  const lines = source.split(/\r\n|\n|\r/u);
  const mismatches = entries.flatMap((entry): EntryMismatch[] => {
    const own = lines.slice(entry.lines[0] - 1, entry.lines[1]).join('\n');
    return compareRendered(own, printJournal([entry])) ? [] : [{ title: entry.title, importKey: entry.importKey, lines: entry.lines }];
  });
  return { printed, passes: compareRendered(source, printed), mismatches };
}
