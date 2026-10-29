import { DEFAULT_RESOURCE_PROFILE, resourceProfileSchema } from '@researchforce/domain/resource-profile';
import type { ResourceProfile } from '@researchforce/domain/resource-profile';
import { createContext, useContext, useSyncExternalStore } from 'react';

/** Matches the Worker's CSRF check: every write carries this header from the Workspace origin. */
export const CSRF_HEADER = 'X-RF-CSRF';
export const API_BASE = '/api/v1';
/** Saves whose JSON is larger go through a staged save (design "Staged commits for large payloads"). */
export const STAGED_SAVE_THRESHOLD_BYTES = DEFAULT_RESOURCE_PROFILE.chosen.bytes.request;

export type ErrorCode =
  | 'unauthenticated' | 'forbidden' | 'profile_incomplete' | 'validation' | 'rule' | 'gate' | 'conflict' | 'preview_stale'
  | 'too_large' | 'daily_limit' | 'frozen' | 'unavailable' | 'rate_limited' | 'not_found' | 'internal';
export interface FieldIssue { readonly field: string; readonly rule: string }

/** A request that did not succeed. `network` means no response arrived; `platform_limit` is the Workers daily request limit. */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'network' | 'platform_limit',
    readonly fields: readonly FieldIssue[] = [],
    readonly details: unknown = undefined,
  ) {
    super(code);
    this.name = 'ApiFailure';
  }
  /** The issues for one field and the fields under it, such as `parties.0.id` under `parties`. */
  issuesFor(field: string): FieldIssue[] {
    return this.fields.filter((issue) => issue.field === field || issue.field.startsWith(`${field}.`));
  }
}

export interface ApiStatus {
  /** A daily limit stopped saving until 00:00 UTC (R28.9). */
  readonly dailyLimit: boolean;
  /** Saving is paused for a backup (R28.10). */
  readonly frozen: boolean;
  /** The Profile fields still missing, while the Profile form must replace every page (R3.6). */
  readonly profileMissing: readonly string[] | null;
}
const INITIAL_STATUS: ApiStatus = { dailyLimit: false, frozen: false, profileMissing: null };

/** Workspace-wide request outcomes that every page shows. */
export class StatusStore {
  #status: ApiStatus = INITIAL_STATUS;
  readonly #listeners = new Set<() => void>();
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  readonly get = (): ApiStatus => this.#status;
  update(change: Partial<ApiStatus>): void {
    const next = { ...this.#status, ...change };
    if (Object.entries(change).every(([key, value]) => this.#status[key as keyof ApiStatus] === value)) return;
    this.#status = next;
    for (const listener of this.#listeners) listener();
  }
}

export interface ApiClientOptions {
  readonly fetch?: typeof fetch;
  /** Reloads the page, so Access sends the person through its login and back to the same page (R1.1). */
  readonly reload?: () => void;
  readonly status?: StatusStore;
}

export interface StagedSaveTarget { readonly kind?: 'journal_entry'; readonly itemId?: string }
interface Stage { readonly token: string; readonly partBytes: number; readonly maxParts: number }

const byteLength = (value: string): number => new TextEncoder().encode(value).length;
const isWrite = (method: string): boolean => method !== 'GET' && method !== 'HEAD';

export class ApiClient {
  readonly status: StatusStore;
  readonly #fetch: typeof fetch;
  readonly #reload: () => void;

  constructor(options: ApiClientOptions = {}) {
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#reload = options.reload ?? (() => globalThis.location.reload());
    this.status = options.status ?? new StatusStore();
  }

  /** Deployment-selected limits, validated before any editor/preview uses them. No certification is inferred. */
  async resourceProfile(): Promise<ResourceProfile> {
    const response = await this.get<{ profile: unknown }>('/resource-profile');
    return resourceProfileSchema.parse(response.profile);
  }

  get<T>(path: string): Promise<T> { return this.request<T>('GET', path); }
  post<T>(path: string, body?: unknown): Promise<T> { return this.request<T>('POST', path, body); }
  put<T>(path: string, body?: unknown): Promise<T> { return this.request<T>('PUT', path, body); }
  patch<T>(path: string, body?: unknown): Promise<T> { return this.request<T>('PATCH', path, body); }
  delete<T>(path: string): Promise<T> { return this.request<T>('DELETE', path); }

  async request<T>(method: string, path: string, body?: unknown, encoded?: string): Promise<T> {
    const headers = new Headers({ Accept: 'application/json' });
    if (isWrite(method)) headers.set(CSRF_HEADER, '1');
    const payload = encoded ?? (body === undefined ? undefined : JSON.stringify(body));
    if (payload !== undefined) headers.set('Content-Type', 'application/json');
    let response: Response;
    try {
      response = await this.#fetch(`${API_BASE}${path}`, { method, headers, credentials: 'same-origin', ...(payload === undefined ? {} : { body: payload }) });
    } catch {
      throw new ApiFailure(0, 'network');
    }
    const json = (response.headers.get('Content-Type') ?? '').includes('application/json');
    if (response.ok) {
      if (isWrite(method)) this.status.update({ frozen: false });
      return (json ? await response.json() : undefined) as T;
    }
    if (!json) {
      // The Workers daily request limit answers 429 from the platform, before any Worker runs, with an HTML page (R28.9).
      if (response.status === 429) {
        this.status.update({ dailyLimit: true });
        throw new ApiFailure(429, 'platform_limit');
      }
      throw new ApiFailure(response.status, 'internal');
    }
    const error = await response.json() as { error: ErrorCode; fields?: FieldIssue[]; details?: unknown };
    const failure = new ApiFailure(response.status, error.error, error.fields ?? [], error.details);
    if (failure.code === 'unauthenticated') this.#reload();
    if (failure.code === 'daily_limit') this.status.update({ dailyLimit: true });
    if (failure.code === 'frozen') this.status.update({ frozen: true });
    if (failure.code === 'profile_incomplete') {
      const missing = (error.details as { missing?: string[] } | undefined)?.missing ?? [];
      this.status.update({ profileMissing: missing });
    }
    throw failure;
  }

  /**
   * Save a Research_Item: `POST /items/{kind}` (`POST /topics` for a Topic) for a new one or `PATCH /items/{id}` for an edit. A Journal_Entry whose
   * JSON exceeds 512 KB is sent as a staged save, with its Entry_Sections in parts and the rest in the commit (R4.4).
   */
  async saveItem<T>(target: { readonly kindPath: string } | { readonly id: string }, body: Record<string, unknown>): Promise<T> {
    const encoded = JSON.stringify(body);
    const sections = body['sections'];
    if (byteLength(encoded) <= STAGED_SAVE_THRESHOLD_BYTES || !Array.isArray(sections)) {
      if ('id' in target) return this.request<T>('PATCH', `/items/${target.id}`, undefined, encoded);
      return this.request<T>('POST', target.kindPath === 'topic' ? '/topics' : `/items/${target.kindPath}`, undefined, encoded);
    }
    const stage = await this.post<Stage>('/stages', 'id' in target ? { itemId: target.id } : {});
    const parts = stagedParts(sections, stage.partBytes);
    if (parts.length > stage.maxParts) throw new ApiFailure(413, 'too_large', [], { limitBytes: stage.partBytes * stage.maxParts });
    for (const [index, part] of parts.entries()) await this.request('PUT', `/stages/${stage.token}/parts/${index + 1}`, undefined, part);
    const { sections: _sections, ...rest } = body;
    return this.post<T>(`/stages/${stage.token}/commit`, rest);
  }
}

/** Entry_Sections grouped into part bodies that each stay within the part size; a single larger section gets a part of its own. */
export function stagedParts(sections: readonly unknown[], partBytes: number): string[] {
  const budget = partBytes - byteLength('{"sections":[]}');
  const parts: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const section of sections) {
    const encoded = JSON.stringify(section);
    const length = byteLength(encoded);
    if (current.length > 0 && size + 1 + length > budget) {
      parts.push(`{"sections":[${current.join(',')}]}`);
      current = [];
      size = 0;
    }
    size += (current.length > 0 ? 1 : 0) + length;
    current.push(encoded);
  }
  if (current.length > 0) parts.push(`{"sections":[${current.join(',')}]}`);
  return parts;
}

export const api = new ApiClient();
export const ApiContext = createContext<ApiClient>(api);
export const useApi = (): ApiClient => useContext(ApiContext);

export function useApiStatus(): ApiStatus {
  const client = useApi();
  return useSyncExternalStore(client.status.subscribe, client.status.get);
}

/** What a failed save tells the Member, apart from field errors (R28.9, R28.10, R28.13). */
export function failureMessage(failure: unknown): string {
  if (!(failure instanceof ApiFailure)) return 'Your input was not saved. It is kept in this tab.';
  switch (failure.code) {
    case 'daily_limit':
    case 'platform_limit': return 'Saving is unavailable until 00:00 UTC. Your input was not saved; it is kept in this tab.';
    case 'frozen': return 'Saving is paused for a backup (about a minute). Your input was not saved; it is kept in this tab.';
    case 'network': return 'The Workspace could not be reached. Your input was not saved; it is kept in this tab.';
    case 'validation': return 'Your input was not saved. Correct the fields marked below.';
    case 'conflict': return 'Your input was not saved because someone else saved a change first.';
    case 'forbidden': return 'Your input was not saved because your Role does not permit this change.';
    case 'too_large': return 'Your input was not saved because it is too large.';
    default: return 'Your input was not saved. It is kept in this tab.';
  }
}
