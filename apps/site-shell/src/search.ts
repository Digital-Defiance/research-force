import { renderToString } from '@researchforce/design/render-string';
import type { ResultKind } from '@researchforce/search-public/build';
import { createSearchEngine, type SearchRequest, type SearchResponse } from '@researchforce/search-public/engine';
import { excerpt, highlight, pageRuns, type Excerpt, type ExcerptNode, type ExcerptPiece } from '@researchforce/search-public/excerpt';
import { issuesView, resultsView, unavailableView } from '@researchforce/search-public/results';
import { fetchIndexFile, type WorkerReply, type WorkerRequest } from './search-protocol';

/** The engine runs in a Web Worker, or on the page where workers are unavailable (R30.6). */
function searcher(): (request: SearchRequest) => Promise<SearchResponse> {
  if (typeof Worker !== 'function') return createSearchEngine(fetchIndexFile).search;
  const worker = new Worker(new URL('./search-worker.ts', import.meta.url), { type: 'module' });
  const waiting = new Map<number, { resolve: (response: SearchResponse) => void; reject: (error: Error) => void }>();
  let next = 0;
  worker.onmessage = (event: MessageEvent<WorkerReply>) => {
    const entry = waiting.get(event.data.id);
    waiting.delete(event.data.id);
    if ('response' in event.data) entry?.resolve(event.data.response);
    else entry?.reject(new Error('The search worker failed.'));
  };
  return (request) => new Promise((resolve, reject) => {
    const id = next++;
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, request } satisfies WorkerRequest);
  });
}

function excerptNode(node: Node): ExcerptNode | undefined {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (!(node instanceof Element)) return undefined;
  return {
    tag: node.localName, attributes: new Map([...node.attributes].map((attribute) => [attribute.name, attribute.value])),
    children: [...node.childNodes].flatMap((child) => excerptNode(child) ?? []),
  };
}

/** Excerpts come from the result pages themselves, which are same-origin static files (R30.5). */
async function pageExcerpt(path: string, terms: Extract<SearchResponse, { ok: true }>['terms']): Promise<Excerpt | undefined> {
  try {
    const response = await fetch(path);
    if (!response.ok) return undefined;
    const main = new DOMParser().parseFromString(await response.text(), 'text/html').querySelector('main');
    const node = main === null ? undefined : excerptNode(main);
    return node === undefined ? undefined : excerpt(pageRuns(node), terms);
  } catch {
    return undefined;
  }
}

function start(form: HTMLFormElement, results: HTMLElement): void {
  const search = searcher();
  const field = (name: string): HTMLInputElement | HTMLSelectElement | null => form.querySelector(`[name="${name}"]`);
  let latest = 0;

  const params = (page: number): URLSearchParams => {
    const values = new URLSearchParams([...new FormData(form)].map(([key, value]) => [key, String(value)]));
    for (const key of new Set(values.keys())) if (values.get(key) === '' && key !== 'project') values.delete(key);
    if (page > 1) values.set('page', String(page));
    return values;
  };
  const request = (page: number): SearchRequest => {
    const data = new FormData(form);
    const value = (name: string): string => String(data.get(name) ?? '');
    return {
      query: value('q'), kinds: data.getAll('kind').map(String) as ResultKind[], page,
      ...(value('from') ? { from: value('from') } : {}), ...(value('to') ? { to: value('to') } : {}), ...(value('project') ? { project: value('project') } : {}),
    };
  };

  async function run(page: number): Promise<void> {
    const id = ++latest;
    results.setAttribute('aria-busy', 'true');
    try {
      const response = await search(request(page));
      if (id !== latest) return;
      if (!response.ok) { results.innerHTML = renderToString(issuesView(response.issues)); return; }
      const excerpts = new Map<string, Excerpt>();
      const lines = new Map<string, readonly ExcerptPiece[]>();
      await Promise.all(response.results.map(async (result) => {
        if (result.kind === 'withheld') lines.set(result.key, highlight(result.title, response.terms));
        else {
          const found = await pageExcerpt(result.path, response.terms);
          if (found !== undefined) excerpts.set(result.key, found);
        }
      }));
      if (id !== latest) return;
      const view = resultsView(response, { origin: location.origin, excerpts, lines, pageHref: (target) => `?${params(target).toString()}` });
      results.innerHTML = view.map(renderToString).join('');
    } catch {
      if (id === latest) results.innerHTML = renderToString(unavailableView());
    } finally {
      if (id === latest) results.removeAttribute('aria-busy');
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    history.pushState(null, '', `?${params(1).toString()}`);
    void run(1);
  });
  results.addEventListener('click', (event) => {
    const link = (event.target as Element | null)?.closest('a[data-page]');
    if (link === null || link === undefined) return;
    event.preventDefault();
    const page = Number(link.getAttribute('data-page'));
    history.pushState(null, '', `?${params(page).toString()}`);
    void run(page);
  });

  // A shared or reloaded address fills the form and runs its search; without one, the Project chosen by the page stays selected (R30.12).
  const fromAddress = (): void => {
    const query = new URLSearchParams(location.search);
    if (!query.has('q')) return;
    for (const name of ['q', 'project', 'from', 'to']) {
      const control = field(name);
      if (control !== null && query.has(name)) control.value = query.get(name) ?? '';
    }
    const kinds = new Set(query.getAll('kind'));
    for (const box of form.querySelectorAll<HTMLInputElement>('input[name="kind"]')) box.checked = kinds.has(box.value);
    void run(Math.max(1, Number(query.get('page') ?? '1') || 1));
  };
  window.addEventListener('popstate', fromAddress);
  fromAddress();
}

const form = document.querySelector<HTMLFormElement>('form[data-search-form]');
const results = document.querySelector<HTMLElement>('[data-search-results]');
if (form !== null && results !== null) start(form, results);
