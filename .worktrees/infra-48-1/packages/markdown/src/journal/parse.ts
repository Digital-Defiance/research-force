import type { Heading, RootContent } from 'mdast';
import { endOf, parseMarkdown, startOf } from '../render';

export interface ParsedSection {
  /** The exact source slice. */
  readonly text: string;
  /** The exact whitespace before the slice. */
  readonly sepBefore: string;
  readonly group?: { readonly kind: 'list' | 'table'; readonly id: number };
  readonly lines: readonly [number, number];
  /** Non-whitespace text outside every block (R27.4). */
  readonly unassigned?: true;
}
export interface ParsedEntry {
  /** "0", "86", "51.12"; null for the front-matter entry. */
  readonly phaseId: string | null;
  readonly headingText: string | null;
  /** The exact heading line. */
  readonly headingRaw: string | null;
  readonly title: string;
  readonly importKey: string;
  /** Whitespace before the first entry's heading when no front matter precedes it, so printing gives back the input. */
  readonly leading: string;
  readonly sections: readonly ParsedSection[];
  /** The whitespace after the last section. */
  readonly trailing: string;
  readonly lines: readonly [number, number];
}

export const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;
export const FRONT_MATTER_KEY = 'front-matter';
export const FRONT_MATTER_TITLE = 'Journal front matter';
const TITLE_LIMIT = 200;
const PHASE = /^\d+(?:\.\d+)*/u;

const cut = (value: string): string => Array.from(value).slice(0, TITLE_LIMIT).join('');
const isBlank = (value: string): boolean => !/\S/u.test(value);

/** One unit the parser assigns: a Phase_Heading or a section. Offsets are half-open and in source order. */
export type Piece =
  | { readonly kind: 'phase'; readonly start: number; readonly end: number; readonly phaseId: string; readonly headingText: string }
  | { readonly kind: 'section'; readonly start: number; readonly end: number; readonly group?: ParsedSection['group']; readonly frontTitle?: string };

function headingText(source: string, heading: Heading): string {
  const first = heading.children[0];
  const last = heading.children.at(-1);
  return first && last ? source.slice(startOf(first), endOf(last)) : '';
}
const isAtx = (source: string, heading: Heading): boolean => source[startOf(heading)] === '#';

/** The offset where the line containing `offset` ends, before its line terminator. */
function lineEnd(source: string, offset: number): number {
  const lf = source.indexOf('\n', offset);
  const cr = source.indexOf('\r', offset);
  const candidates = [lf, cr].filter((index) => index >= 0);
  return candidates.length ? Math.min(...candidates) : source.length;
}
function afterLineBreak(source: string, offset: number): number {
  if (source.startsWith('\r\n', offset)) return offset + 2;
  return offset < source.length ? offset + 1 : offset;
}

/** The top-level pieces of a journal, as R27.1 and R27.3 assign them. */
export function piecesOf(source: string, blocks: readonly RootContent[]): Piece[] {
  const pieces: Piece[] = [];
  let group = 0;
  for (const block of blocks) {
    if (block.type === 'heading' && block.depth === 3 && isAtx(source, block)) {
      const text = headingText(source, block);
      const phase = PHASE.exec(text);
      if (phase) { pieces.push({ kind: 'phase', start: startOf(block), end: endOf(block), phaseId: phase[0], headingText: text }); continue; }
    }
    if (block.type === 'list') {
      const id = ++group;
      for (const item of block.children) pieces.push({ kind: 'section', start: startOf(item), end: endOf(item), group: { kind: 'list', id } });
      continue;
    }
    if (block.type === 'table') {
      const id = ++group;
      const [head, ...rows] = block.children;
      if (head) {
        const delimiterStart = afterLineBreak(source, lineEnd(source, endOf(head)));
        const headerEnd = Math.min(lineEnd(source, delimiterStart), endOf(block));
        pieces.push({ kind: 'section', start: startOf(head), end: Math.max(headerEnd, endOf(head)), group: { kind: 'table', id } });
      }
      for (const row of rows) pieces.push({ kind: 'section', start: startOf(row), end: endOf(row), group: { kind: 'table', id } });
      continue;
    }
    const frontTitle = block.type === 'heading' && block.depth === 1 && isAtx(source, block) ? headingText(source, block) : undefined;
    pieces.push({ kind: 'section', start: startOf(block), end: endOf(block), ...(frontTitle !== undefined && !isBlank(frontTitle) ? { frontTitle } : {}) });
  }
  return pieces;
}

interface Draft {
  phaseId: string | null; headingText: string | null; headingRaw: string | null; title: string; leading: string;
  sections: ParsedSection[]; trailing: string; first: number; last: number;
}

/** Builds entries from pieces; every character of `source` lands in exactly one heading line, separator, or slice. */
export function assemble(source: string, pieces: readonly Piece[]): ParsedEntry[] {
  const lineStarts = [0];
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '\n' || (char === '\r' && source[index + 1] !== '\n')) lineStarts.push(index + 1);
  }
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (lineStarts[mid]! <= offset) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
  const linesOf = (start: number, end: number): [number, number] => [lineOf(start), lineOf(Math.max(start, end - 1))];

  const drafts: Draft[] = [];
  let current: Draft | undefined;
  let frontTitle: string | undefined;
  const front = (at: number): Draft => {
    current = { phaseId: null, headingText: null, headingRaw: null, title: FRONT_MATTER_TITLE, leading: '', sections: [], trailing: '', first: at, last: at };
    drafts.push(current);
    return current;
  };
  /** Returns the whitespace that separates what comes next, after recording any unassigned text in the gap. */
  const gap = (from: number, to: number): string => {
    const text = source.slice(from, to);
    if (isBlank(text)) return text;
    const head = text.length - text.trimStart().length;
    const tail = text.length - text.trimEnd().length;
    const start = from + head;
    const end = to - tail;
    const entry = current ?? front(start);
    entry.sections.push({ text: source.slice(start, end), sepBefore: source.slice(from, start), lines: linesOf(start, end), unassigned: true });
    entry.last = end;
    return source.slice(end, to);
  };

  let cursor = 0;
  for (const piece of pieces) {
    const separator = gap(cursor, piece.start);
    if (piece.kind === 'phase') {
      const leading = current ? '' : separator;
      if (current) current.trailing = separator;
      current = {
        phaseId: piece.phaseId, headingText: piece.headingText, headingRaw: source.slice(piece.start, piece.end), title: cut(piece.headingText),
        leading, sections: [], trailing: '', first: piece.start, last: piece.end,
      };
      drafts.push(current);
    } else {
      const entry = current ?? front(piece.start);
      if (entry.phaseId === null && frontTitle === undefined && piece.frontTitle !== undefined) frontTitle = piece.frontTitle;
      entry.sections.push({ text: source.slice(piece.start, piece.end), sepBefore: separator, lines: linesOf(piece.start, piece.end), ...(piece.group ? { group: piece.group } : {}) });
      entry.last = piece.end;
    }
    cursor = piece.end;
  }
  const rest = gap(cursor, source.length);
  if (current) current.trailing = rest;

  return drafts.map((draft) => ({
    phaseId: draft.phaseId, headingText: draft.headingText, headingRaw: draft.headingRaw,
    title: draft.phaseId === null && frontTitle !== undefined ? cut(frontTitle) : draft.title,
    importKey: draft.phaseId ?? FRONT_MATTER_KEY, leading: draft.leading, sections: draft.sections, trailing: draft.trailing,
    lines: linesOf(draft.first, draft.last),
  }));
}

function utf8Length(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** Journal_Parser (R27.1 to R27.4). Whitespace-only input has no blocks and yields no entries. */
export function parseJournal(source: string): ParsedEntry[] {
  if (utf8Length(source) > MAX_JOURNAL_BYTES) throw new RangeError(`Journal Markdown is limited to ${MAX_JOURNAL_BYTES} bytes.`);
  return assemble(source, piecesOf(source, parseMarkdown(source).children));
}
