import type { RuleIssue } from '@researchforce/domain/rules';
import { validateSearchQuery, type QueryTerm } from '@researchforce/domain/search-text';
import { MANIFEST_FILE, ONE_CHARACTER_BUCKET, prefixOf, type IndexManifest, type Postings, type ResultKind, type SearchDocument } from './build';
import { shardOf } from './hash';

export const RESULTS_PER_PAGE = 20;

/** Reads one index file by its site path, such as `idx/manifest.json`. */
export type FetchJson = (file: string) => Promise<unknown>;

export interface SearchRequest {
  readonly query: string;
  /** No kinds means every kind (R30.4). */
  readonly kinds?: readonly ResultKind[];
  /** Inclusive `YYYY-MM-DD` bounds on the date each result shows (R30.4). */
  readonly from?: string;
  readonly to?: string;
  /** A Project_Slug, or none for every Public Project (R30.12). */
  readonly project?: string;
  /** 1-based. */
  readonly page?: number;
}
export interface SearchResult extends SearchDocument { readonly key: string; }
export type SearchResponse =
  | { readonly ok: false; readonly issues: readonly RuleIssue[] }
  | { readonly ok: true; readonly terms: readonly QueryTerm[]; readonly total: number; readonly page: number; readonly pageCount: number; readonly results: readonly SearchResult[] };

type TermPostings = ReadonlyMap<string, readonly number[]>;
const codePointLength = (term: string): number => Array.from(term).length;

/** Whether an indexed token satisfies a query word: whole word, or for words of two or more characters a word start (R30.2). */
export const wordMatches = (token: string, word: string): boolean => token === word || (codePointLength(word) >= 2 && token.startsWith(word));

/** Positions at which the terms all match in a token list: each word anywhere, each phrase as consecutive whole words (R30.3). */
export function tokensMatch(tokens: readonly string[], terms: readonly QueryTerm[]): boolean {
  return terms.every((term) => term.kind === 'word'
    ? tokens.some((token) => wordMatches(token, term.value))
    : tokens.some((_, start) => term.words.every((word, offset) => tokens[start + offset] === word)));
}

/** The browser query engine over the static index; caches every file it reads. */
export function createSearchEngine(fetchJson: FetchJson) {
  const cache = new Map<string, Promise<unknown>>();
  const read = <T>(file: string): Promise<T> => {
    let found = cache.get(file);
    if (found === undefined) {
      found = fetchJson(file);
      cache.set(file, found);
      found.catch(() => cache.delete(file));
    }
    return found as Promise<T>;
  };
  const manifest = (): Promise<IndexManifest> => read<IndexManifest>(MANIFEST_FILE);

  /**
   * The buckets that can hold the word or, unless `exact`, the terms it starts. A 2-character bucket holds every term with that prefix, or after a
   * split only the 2-character term itself, with longer terms in 3-character buckets.
   */
  function bucketsFor(index: IndexManifest, word: string, exact: boolean): string[] {
    const has = (prefix: string): boolean => index.buckets[prefix] !== undefined;
    const length = codePointLength(word);
    if (length === 1) return [ONE_CHARACTER_BUCKET].filter(has);
    if (length === 2) return exact ? [word].filter(has) : Object.keys(index.buckets).filter((prefix) => prefix.startsWith(word));
    return [prefixOf(word, 2), prefixOf(word, 3)].filter(has);
  }

  /** Document to positions for every indexed term the word matches; whole words only when `exact`. */
  async function postingsFor(index: IndexManifest, word: string, exact: boolean): Promise<TermPostings> {
    const merged = new Map<string, number[]>();
    const buckets = await Promise.all(bucketsFor(index, word, exact).map((prefix) => read<Record<string, Postings>>(index.buckets[prefix]!)));
    for (const bucket of buckets) {
      for (const [term, postings] of Object.entries(bucket)) {
        if (exact ? term !== word : !wordMatches(term, word)) continue;
        for (const [key, positions] of postings) {
          const list = merged.get(key);
          if (list === undefined) merged.set(key, [...positions]);
          else list.push(...positions);
        }
      }
    }
    return merged;
  }

  /** Documents containing the term: a word as whole word or word start, a phrase as consecutive whole words. */
  async function documentsFor(index: IndexManifest, term: QueryTerm): Promise<Set<string>> {
    if (term.kind === 'word') return new Set((await postingsFor(index, term.value, false)).keys());
    const lists = await Promise.all(term.words.map((word) => postingsFor(index, word, true)));
    const result = new Set<string>();
    for (const [key, first] of lists[0]!) {
      const sets = lists.map((list) => new Set(list.get(key) ?? []));
      if (first.some((start) => sets.every((positions, offset) => positions.has(start + offset)))) result.add(key);
    }
    return result;
  }

  async function documents(index: IndexManifest, keys: Iterable<string>): Promise<SearchResult[]> {
    const byShard = new Map<number, string[]>();
    for (const key of keys) {
      const shard = shardOf(key, index.shards.length);
      byShard.set(shard, [...(byShard.get(shard) ?? []), key]);
    }
    const loaded = await Promise.all([...byShard].map(async ([shard, wanted]) => {
      const content = await read<Record<string, SearchDocument>>(index.shards[shard]!);
      return wanted.flatMap((key) => (content[key] === undefined ? [] : [{ key, ...content[key] }]));
    }));
    return loaded.flat();
  }

  async function search(request: SearchRequest): Promise<SearchResponse> {
    const range = {
      ...(request.from ? { start: { value: request.from, approx: false } } : {}),
      ...(request.to ? { end: { value: request.to, approx: false } } : {}),
    };
    const validated = validateSearchQuery(request.query, range);
    if (!validated.ok) return { ok: false, issues: validated.issues };
    const terms = validated.value;
    const index = await manifest();
    const sets = await Promise.all(terms.map((term) => documentsFor(index, term)));
    const [first, ...rest] = sets;
    const keys = [...(first ?? [])].filter((key) => rest.every((set) => set.has(key)));
    const kinds = new Set(request.kinds ?? []);
    const matching = (await documents(index, keys)).filter((result) =>
      (kinds.size === 0 || kinds.has(result.kind))
      && (request.project === undefined || request.project === '' || result.project.slug === request.project)
      && (!request.from || (result.to !== undefined && result.to >= request.from))
      && (!request.to || (result.from !== undefined && result.from <= request.to)));
    const ranked = rankResults(matching, terms);
    const pageCount = Math.max(1, Math.ceil(ranked.length / RESULTS_PER_PAGE));
    const page = Math.max(1, Math.floor(request.page ?? 1));
    return { ok: true, terms, total: ranked.length, page, pageCount, results: ranked.slice((page - 1) * RESULTS_PER_PAGE, page * RESULTS_PER_PAGE) };
  }

  return { search };
}

/** Results whose title contains every term first, then newest first by the shown date, then by address (R30.1). */
export function rankResults(results: readonly SearchResult[], terms: readonly QueryTerm[]): SearchResult[] {
  const titled = new Map(results.map((result) => [result.key, tokensMatch(result.titleTokens, terms)]));
  return [...results].sort((a, b) => Number(titled.get(b.key)) - Number(titled.get(a.key)) || b.sort.localeCompare(a.sort) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
