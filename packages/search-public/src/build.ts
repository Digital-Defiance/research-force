import { dateBounds, dateSortKey, formatDate, formatEnteredTime } from '@researchforce/domain/dates';
import { SOURCE_KIND_LABELS, termHref, valueHref } from '@researchforce/domain/methods-anchors';
import type { RichText } from '@researchforce/domain/richtext';
import { SEARCH_NORMALIZATION_VERSION, searchTokens } from '@researchforce/domain/search-text';
import type { DocumentDate, ItemKind, PartialDate } from '@researchforce/domain/types';
import type {
  AttachmentView, ChildRef, DisclosureLineView, FieldView, PublicView, ResearchItemView, StatusView, UnitKey, WithheldView,
} from '@researchforce/kernel/views';
import { contentHash, shardOf } from './hash';

export const INDEX_DIR = 'idx';
export const MANIFEST_FILE = `${INDEX_DIR}/manifest.json`;
export const SHARD_COUNT = 64;
/** A 2-character bucket larger than this splits into 3-character buckets. */
export const BUCKET_LIMIT = 256 * 1024;
/** Bucket of the 1-character terms, which match only whole words. */
export const ONE_CHARACTER_BUCKET = '_1';
export const INDEX_FORMAT = 1;

export type ResultKind = ItemKind | 'attachment' | 'withheld';
export interface StatusLabel { readonly name: string; readonly href: string; }
export interface ProjectLabel { readonly name: string; readonly slug: string; readonly path: string; }

/** What a result shows and what the filters and ranking read; everything here is on the result's own page (R30.5, R30.9). */
export interface SearchDocument {
  readonly kind: ResultKind;
  /** The title, or for a Withheld unit its Disclosure_Line. */
  readonly title: string;
  readonly path: string;
  /** The date the result shows (a Research_Item's Item_Date, a Withheld unit's Disclosure_Line date); Attachments show none. */
  readonly date?: string;
  readonly sort: string;
  /** First and last day the shown date covers, as `YYYY-MM-DD`, for the inclusive date filter. */
  readonly from?: string;
  readonly to?: string;
  readonly project: ProjectLabel;
  readonly status?: readonly StatusLabel[];
  readonly withdrawn?: true;
  readonly titleTokens: readonly string[];
}

/** Postings of one term: document key and token positions, both ascending. */
export type Postings = readonly (readonly [string, readonly number[]])[];
export interface IndexManifest {
  readonly format: number;
  readonly version: string;
  /** Term prefix (`_1`, 2 characters, or 3 characters after a split) to bucket file. */
  readonly buckets: Readonly<Record<string, string>>;
  readonly shards: readonly string[];
}
export interface IndexFile { readonly file: string; readonly contentType: string; readonly content: string; }

/** A document's text: segments in display order. Phrases never span two segments. */
export interface IndexedDocument { readonly key: string; readonly document: SearchDocument; readonly segments: readonly string[]; }

const ISO_DAY = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
function dateFields(date: DocumentDate): Pick<SearchDocument, 'date' | 'sort' | 'from' | 'to'> {
  const start: PartialDate = 'start' in date ? date.start : date;
  const end: PartialDate = 'start' in date ? date.end : date;
  return { date: formatDate(date), sort: dateSortKey(date), from: ISO_DAY(dateBounds(start).start), to: ISO_DAY(dateBounds(end).endExclusive - 86_400_000) };
}

/** The summary line of a Disclosure_Line as pages show it. */
export const disclosureSummary = (line: DisclosureLineView): string =>
  [line.kindOfMaterial, formatDate(line.date), ...(line.parties.length > 0 ? [line.parties.join(', ')] : [])].join(' · ');
const lineSegments = (line: DisclosureLineView): string[] => [disclosureSummary(line), ...(line.note === undefined ? [] : [line.note])];

const projectLabel = (ref: { readonly name: string; readonly slug: string; readonly path: string }): ProjectLabel => ({ name: ref.name, slug: ref.slug, path: ref.path });

function statusLabels(status: StatusView | undefined): StatusLabel[] {
  if (status === undefined) return [];
  const value = (ref: { readonly id: string; readonly name: string }): StatusLabel => ({ name: ref.name, href: valueHref(ref.id) });
  switch (status.kind) {
    case 'journal_entry': return status.status === undefined ? [] : [value(status.status)];
    case 'source': return [{ name: SOURCE_KIND_LABELS[status.sourceKind], href: termHref(`source_kind.${status.sourceKind}`) }, value(status.reliability)];
    case 'run': return [value(status.outcome)];
    case 'finding': case 'hypothesis': case 'archival_request': return [value(status.status)];
  }
}

function fieldText(field: FieldView): string {
  const { value } = field;
  switch (value.t) {
    case 'text': return field.key === 'direction' ? (value.value === 'sent' ? 'Sent' : value.value === 'received' ? 'Received' : value.value) : value.value;
    case 'rich': return value.value.text;
    case 'date': return formatDate(value.value);
    case 'time': return formatEnteredTime(value.value);
    case 'parties': case 'members': return value.value.join(', ');
    case 'value': return value.value.name;
    case 'counts': return value.value.map((count) => `${count.name}: ${count.value}`).join('\n');
  }
}

/**
 * Everything a Research_Item's page shows of its content, in display order (R30.1): title, Public_Summary, the Scope_Caveat or Elimination_Scope
 * beside its status, and under Full_Content the fields, Log_Summary, Entry_Sections, Replies, and Dissent_Notes, with the Disclosure_Lines of
 * Withheld children. Withdrawn Dissent_Notes have no view, so they add nothing (R42.8).
 */
function itemSegments(views: ReadonlyMap<UnitKey, PublicView>, view: ResearchItemView): string[] {
  const segments: string[] = [view.title];
  const rich = (value: RichText | undefined): void => { if (value !== undefined) segments.push(value.text); };
  rich(view.publicSummary);
  if (view.status?.kind === 'finding') rich(view.status.scopeCaveat);
  if (view.status?.kind === 'hypothesis') rich(view.status.eliminationScope);
  if (view.full === undefined) return segments;
  for (const field of view.full.fields) segments.push(fieldText(field));
  rich(view.full.logSummary);
  const child = (ref: ChildRef): void => {
    const found = views.get(ref.key);
    if (found === undefined) return;
    if (found.tag === 'withheld') segments.push(...lineSegments(found.line));
    else if (found.tag === 'entry_section' || found.tag === 'dissent_note') rich(found.text);
    else if (found.tag === 'reply') { rich(found.text); found.replies.forEach(child); }
  };
  view.full.sections.forEach(child);
  view.full.replies.forEach(child);
  view.full.dissent.forEach(child);
  return segments;
}

/** An Attachment's title, caption, Origin, and Credit, never the file's contents (R30.1). */
const attachmentSegments = (view: AttachmentView): string[] =>
  [view.title, ...(view.caption === undefined ? [] : [view.caption]), view.origin, ...view.credit.map((entry) => entry.name)];

const keyOf = (path: string): string => path.slice(1);

/** One document per Public or Withheld Research_Item and Attachment, read only from views (R30.1, R30.9, R30.10). */
export function searchDocuments(views: ReadonlyMap<UnitKey, PublicView>): IndexedDocument[] {
  const documents: IndexedDocument[] = [];
  for (const view of views.values()) {
    if (view.tag === 'research_item') {
      documents.push({
        key: keyOf(view.path), segments: itemSegments(views, view),
        document: {
          kind: view.kind, title: view.title, path: view.path, ...dateFields(view.itemDate), project: projectLabel(view.project),
          ...(statusLabels(view.status).length === 0 ? {} : { status: statusLabels(view.status) }), ...(view.withdrawal === undefined ? {} : { withdrawn: true }),
          titleTokens: searchTokens(view.title),
        },
      });
    } else if (view.tag === 'attachment') {
      documents.push({
        key: keyOf(view.path), segments: attachmentSegments(view),
        document: {
          kind: 'attachment', title: view.title, path: view.path, sort: '', project: projectLabel(view.project),
          ...(view.withdrawal === undefined ? {} : { withdrawn: true }), titleTokens: searchTokens(view.title),
        },
      });
    } else if (isWithheldPage(view)) {
      const title = disclosureSummary(view.line);
      documents.push({
        key: keyOf(view.path), segments: lineSegments(view.line),
        document: { kind: 'withheld', title, path: view.path, ...dateFields(view.line.date), project: projectLabel(view.project), titleTokens: searchTokens(title) },
      });
    }
  }
  return documents.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** A Withheld Research_Item or Attachment: Withheld Projects have no `project`, and Withheld children no page of their own. */
const isWithheldPage = (view: PublicView): view is WithheldView & { readonly path: string; readonly project: NonNullable<WithheldView['project']> } =>
  view.tag === 'withheld' && view.path !== undefined && view.project !== undefined;

/** Token positions of a document's segments, with a gap between segments so a phrase cannot join two of them. */
export function documentTokens(segments: readonly string[]): { readonly token: string; readonly position: number }[] {
  const tokens: { token: string; position: number }[] = [];
  let position = 0;
  for (const segment of segments) {
    for (const token of searchTokens(segment)) tokens.push({ token, position: position++ });
    position++;
  }
  return tokens;
}

const codePoints = (term: string): string[] => Array.from(term);
/** The 2-character bucket of a term of two or more characters. */
export const prefixOf = (term: string, length: number): string => codePoints(term).slice(0, length).join('');
/** File-name-safe form of a prefix: its code points in hex. */
const prefixName = (prefix: string): string => (prefix === ONE_CHARACTER_BUCKET ? prefix : codePoints(prefix).map((char) => char.codePointAt(0)!.toString(16)).join('-'));
const utf8Length = (text: string): number => {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
};

function bucketJson(terms: readonly (readonly [string, Map<string, number[]>])[]): string {
  return JSON.stringify(Object.fromEntries(terms.map(([term, postings]) => [term, [...postings]])));
}

/** The `/idx` files of one Public_Site build: manifest, term buckets, and 64 document shards, with content-hashed names (R30.1). */
export function buildSearchIndex(views: ReadonlyMap<UnitKey, PublicView>): IndexFile[] {
  const documents = searchDocuments(views);
  const postings = new Map<string, Map<string, number[]>>();
  for (const { key, segments } of documents) {
    for (const { token, position } of documentTokens(segments)) {
      let byDocument = postings.get(token);
      if (byDocument === undefined) postings.set(token, (byDocument = new Map()));
      let positions = byDocument.get(key);
      if (positions === undefined) byDocument.set(key, (positions = []));
      positions.push(position);
    }
  }
  const sortedTerms = [...postings.keys()].sort();
  const groups = new Map<string, [string, Map<string, number[]>][]>();
  const add = (prefix: string, term: string): void => {
    let group = groups.get(prefix);
    if (group === undefined) groups.set(prefix, (group = []));
    group.push([term, postings.get(term)!]);
  };
  for (const term of sortedTerms) add(codePoints(term).length === 1 ? ONE_CHARACTER_BUCKET : prefixOf(term, 2), term);
  const buckets: [string, string][] = [];
  for (const [prefix, terms] of groups) {
    const json = bucketJson(terms);
    if (prefix === ONE_CHARACTER_BUCKET || utf8Length(json) <= BUCKET_LIMIT) { buckets.push([prefix, json]); continue; }
    // A split keeps the 2-character term itself under the 2-character prefix; longer terms go under their first three characters.
    const split = new Map<string, [string, Map<string, number[]>][]>();
    for (const entry of terms) {
      const sub = codePoints(entry[0]).length === 2 ? prefix : prefixOf(entry[0], 3);
      let group = split.get(sub);
      if (group === undefined) split.set(sub, (group = []));
      group.push(entry);
    }
    for (const [sub, subTerms] of split) buckets.push([sub, bucketJson(subTerms)]);
  }
  const files: IndexFile[] = [];
  const json = (name: string, content: string): string => {
    const file = `${INDEX_DIR}/${name}.${contentHash(content)}.json`;
    files.push({ file, contentType: 'application/json', content });
    return file;
  };
  const bucketFiles = Object.fromEntries(buckets.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([prefix, content]) => [prefix, json(`t/${prefixName(prefix)}`, content)]));
  const shards = Array.from({ length: SHARD_COUNT }, () => [] as [string, SearchDocument][]);
  for (const { key, document } of documents) shards[shardOf(key, SHARD_COUNT)]!.push([key, document]);
  const shardFiles = shards.map((entries, index) => json(`d/${String(index).padStart(2, '0')}`, JSON.stringify(Object.fromEntries(entries))));
  const manifest: IndexManifest = { format: INDEX_FORMAT, version: SEARCH_NORMALIZATION_VERSION, buckets: bucketFiles, shards: shardFiles };
  return [{ file: MANIFEST_FILE, contentType: 'application/json', content: JSON.stringify(manifest) }, ...files];
}
