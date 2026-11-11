import { useSyncExternalStore } from 'react';
/** `stale`: the server has a newer build. `current`: it is the same build. `unknown`: it could not be told (offline, no build.json). */
export type BuildCheck = 'stale' | 'current' | 'unknown';
export interface CheckOptions { readonly fetch: typeof fetch; readonly runningId: string | null }
const RUNNING_ID: string | null = typeof __RF_BUILD_ID__ === 'undefined' ? null : __RF_BUILD_ID__;
const VISIBLE_CHECK_INTERVAL_MS = 5 * 60_000;
/** Asks the same origin for `/build.json` and compares its id with the running bundle's. Only a readable, different id counts as stale. */
export async function checkBuild({ fetch: request, runningId }: CheckOptions): Promise<BuildCheck> {
  if (runningId === null) return 'unknown';
  try {
    const response = await request('/build.json', { cache: 'no-store', headers: { accept: 'application/json' } });
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes('json')) return 'unknown';
    const body = await response.json() as { id?: unknown };
    if (typeof body.id !== 'string') return 'unknown';
    return body.id === runningId ? 'current' : 'stale';
  } catch {
    return 'unknown';
  }
}
export interface StaleBuildState { readonly stale: boolean; readonly held: boolean }
export interface StaleBuildOptions { readonly fetch?: typeof fetch; readonly runningId?: string | null; readonly reload?: () => void }
/** Whether this tab runs an older build than the server, and whether something (an upload) asks not to be interrupted. */
export class StaleBuildStore {
  #state: StaleBuildState = { stale: false, held: false };
  #holds = 0;
  readonly #listeners = new Set<() => void>();
  readonly #options: StaleBuildOptions;
  constructor(options: StaleBuildOptions = {}) { this.#options = options; }
  readonly subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => this.#listeners.delete(listener); };
  readonly get = (): StaleBuildState => this.#state;
  #set(change: Partial<StaleBuildState>): void {
    const next = { ...this.#state, ...change };
    if (next.stale === this.#state.stale && next.held === this.#state.held) return;
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }
  /** Checks the build and remembers a stale answer. Nothing here reloads the page. */
  check(): Promise<BuildCheck> {
    const runningId = this.#options.runningId === undefined ? RUNNING_ID : this.#options.runningId;
    const request = this.#options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    return checkBuild({ fetch: request, runningId }).then((result) => { if (result === 'stale') this.#set({ stale: true }); return result; });
  }
  /** A lazy chunk or Web Worker failed to load: the likely cause is a newer deploy, so check. */
  noteLoadFailure(_kind: 'chunk' | 'worker'): Promise<BuildCheck> { return this.check(); }
  /** Ask that the Member's choice, not a deploy, decides when to reload (a running upload). Returns the release function. */
  hold(): () => void {
    this.#holds += 1; this.#set({ held: true });
    let released = false;
    return () => { if (released) return; released = true; this.#holds -= 1; this.#set({ held: this.#holds > 0 }); };
  }
  reload(): void { (this.#options.reload ?? (() => globalThis.location.reload()))(); }
}
export const staleBuild = new StaleBuildStore();
export const noteLoadFailure = (kind: 'chunk' | 'worker'): Promise<BuildCheck> => staleBuild.noteLoadFailure(kind);
export const holdReload = (): (() => void) => staleBuild.hold();
export function useStaleBuild(store: StaleBuildStore = staleBuild): StaleBuildState { return useSyncExternalStore(store.subscribe, store.get); }
const LOAD_FAILURE = /dynamically imported module|importing a module script failed|failed to fetch/iu;
/** Listens for failed chunk loads and returning to the tab. Returns a function that removes the listeners. */
export function installStaleBuildDetection(store: StaleBuildStore = staleBuild, target: Window = window, now: () => number = Date.now): () => void {
  let last = now();
  const onPreload = () => { void store.noteLoadFailure('chunk'); };
  const onRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason as { message?: unknown } | undefined;
    if (typeof reason?.message === 'string' && LOAD_FAILURE.test(reason.message)) void store.noteLoadFailure('chunk');
  };
  const onVisible = () => {
    if (target.document.visibilityState !== 'visible' || now() - last < VISIBLE_CHECK_INTERVAL_MS) return;
    last = now(); void store.check();
  };
  target.addEventListener('vite:preloadError', onPreload);
  target.addEventListener('unhandledrejection', onRejection);
  target.document.addEventListener('visibilitychange', onVisible);
  void store.check();
  return () => {
    target.removeEventListener('vite:preloadError', onPreload);
    target.removeEventListener('unhandledrejection', onRejection);
    target.document.removeEventListener('visibilitychange', onVisible);
  };
}
