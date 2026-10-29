import { newULID } from '@researchforce/domain/identifiers';
import { DEFAULT_RESOURCE_PROFILE, resourceProfileSchema } from '@researchforce/domain/resource-profile';
import type { RichText } from '@researchforce/domain/richtext';
import { fieldFragments, fieldManifest } from '@researchforce/domain/text-fragments';
import { asTimestamp } from '@researchforce/domain/types';
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

/**
 * A request that did not succeed. `network` means no response arrived and the Worker never recorded the operation; `platform_limit` is the Workers daily
 * request limit; `committed` means the write was saved but its response was lost; `unknown` means its outcome could not be established yet.
 */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'network' | 'platform_limit' | 'committed' | 'unknown',
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
  /** Where operation keys are kept across a reload; the tab's session storage unless a test supplies one. */
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'>;
  /** Waits between status polls of a pending operation. */
  readonly wait?: (ms: number) => Promise<void>;
}

/** What the Worker records of a write, from `GET /operations/{key}`. */
export interface OperationView {
  readonly key: string; readonly state: 'pending' | 'committed' | 'refused' | 'unknown'; readonly status?: number; readonly error?: string;
  readonly resource?: Readonly<Record<string, string>>; readonly createdAt: string; readonly completedAt?: string;
}
export interface StoredOperation { readonly key: string; readonly method: string; readonly path: string; readonly startedAt: string }
export interface WriteOptions<T> {
  /** Use this key for a retry of the same logical write. */
  readonly key?: string;
  /** Read the result of a write that committed but whose response was lost, from the IDs the Worker recorded. */
  readonly committed?: (operation: OperationView) => Promise<T>;
}
const OPERATION_KEY_HEADER = 'Idempotency-Key';
const OPERATIONS_STORAGE = 'rf.operations';

export interface StagedSaveTarget { readonly kind?: 'journal_entry'; readonly itemId?: string }
interface Stage { readonly token: string; readonly partBytes: number; readonly maxParts: number }

const byteLength = (value: string): number => new TextEncoder().encode(value).length;
const isWrite = (method: string): boolean => method !== 'GET' && method !== 'HEAD';

export class ApiClient {
  readonly status: StatusStore;
  readonly #fetch: typeof fetch;
  readonly #reload: () => void;
  readonly #storage: Pick<Storage, 'getItem' | 'setItem'> | undefined;
  readonly #wait: (ms: number) => Promise<void>;

  constructor(options: ApiClientOptions = {}) {
    this.#wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#storage = options.storage ?? (() => { try { return globalThis.sessionStorage; } catch { return undefined; } })();
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

  /**
   * One request. A write carries an operation key that is stored before it is sent; when the response is lost, the Worker's record of that key decides
   * whether to send it again (never started), return the saved result (committed), report the refusal, or admit the outcome is unknown (R28.10, R28.13).
   */
  async request<T>(method: string, path: string, body?: unknown, encoded?: string, write: WriteOptions<T> = {}): Promise<T> {
    if (!isWrite(method) || path.startsWith('/operations/')) return this.#send<T>(method, path, body, encoded);
    const key = write.key ?? newULID(asTimestamp(new Date().toISOString()));
    this.#remember({ key, method, path, startedAt: new Date().toISOString() });
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await this.#send<T>(method, path, body, encoded, key);
        this.#forget(key);
        return result;
      } catch (error) {
        if (!(error instanceof ApiFailure)) throw error;
        if (error.code === 'committed') return this.#committed(key, error.details as OperationView, write);
        if (error.code !== 'network') { this.#forget(key); throw error; }
        const operation = await this.operation(key).catch(() => undefined);
        if (operation === null && attempt < 2) continue;
        if (!operation) throw error;
        if (operation.state === 'committed') return this.#committed(key, operation, write);
        if (operation.state === 'refused') { this.#forget(key); throw new ApiFailure(operation.status ?? 422, (operation.error ?? 'rule') as ErrorCode); }
        throw new ApiFailure(0, 'unknown', [], operation);
      }
    }
  }

  /** The Worker's record of a write by this Member, or null when it never started. Polls a pending write briefly. */
  async operation(key: string): Promise<OperationView | null> {
    for (let poll = 0; ; poll++) {
      let view: OperationView;
      try { view = (await this.get<{ operation: OperationView }>(`/operations/${key}`)).operation; }
      catch (error) { if (error instanceof ApiFailure && error.code === 'not_found') return null; throw error; }
      if (view.state !== 'pending' || poll >= 3) return view;
      await this.#wait(500 * (poll + 1));
    }
  }

  /** Writes whose outcome this tab has not yet established, such as after a reload. */
  pendingOperations(): StoredOperation[] {
    try { return JSON.parse(this.#storage?.getItem(OPERATIONS_STORAGE) ?? '[]') as StoredOperation[]; } catch { return []; }
  }

  async #committed<T>(key: string, operation: OperationView, write: WriteOptions<T>): Promise<T> {
    if (!write.committed) throw new ApiFailure(0, 'committed', [], operation);
    const result = await write.committed(operation);
    this.#forget(key);
    return result;
  }
  #remember(operation: StoredOperation): void {
    try { this.#storage?.setItem(OPERATIONS_STORAGE, JSON.stringify([...this.pendingOperations().filter((known) => known.key !== operation.key), operation].slice(-50))); } catch { /* storage is a convenience */ }
  }
  #forget(key: string): void {
    try { this.#storage?.setItem(OPERATIONS_STORAGE, JSON.stringify(this.pendingOperations().filter((known) => known.key !== key))); } catch { /* storage is a convenience */ }
  }

  async #send<T>(method: string, path: string, body?: unknown, encoded?: string, key?: string): Promise<T> {
    const headers = new Headers({ Accept: 'application/json' });
    if (isWrite(method)) headers.set(CSRF_HEADER, '1');
    if (key !== undefined) headers.set(OPERATION_KEY_HEADER, key);
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
      const parsed: unknown = json ? await response.json() : undefined;
      // The Worker answers a replay of a committed write with its record instead of the result.
      if (key !== undefined && (parsed as { replayed?: unknown } | undefined)?.replayed === true) throw new ApiFailure(response.status, 'committed', [], (parsed as { operation: OperationView }).operation);
      return parsed as T;
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
      const committed = (operation: OperationView): Promise<T> => this.#savedItem<T>(operation);
      if ('id' in target) return this.request<T>('PATCH', `/items/${target.id}`, undefined, encoded, { committed });
      return this.request<T>('POST', target.kindPath === 'topic' ? '/topics' : `/items/${target.kindPath}`, undefined, encoded, { committed });
    }
    const token = newULID(asTimestamp(new Date().toISOString()));
    const stage = await this.post<Stage>('/stages', { token, ...('id' in target ? { itemId: target.id } : {}) });
    const parts = stagedPlan(sections, stage.partBytes);
    if (parts.length > stage.maxParts) throw new ApiFailure(413, 'too_large', [], { limitBytes: stage.partBytes * stage.maxParts });
    for (const [index, part] of parts.entries()) {
      const path = `/stages/${stage.token}/parts/${index + 1}`;
      await this.retryPut(path, undefined, part.body);
      // A section above the part size is sent as a logical field: its manifest in the part, then each bounded fragment under it.
      if (part.field) for (const fragment of fieldFragments(part.field)) await this.retryPut(`${path}/sections/0/fragments`, fragment);
    }
    const { sections: _sections, ...rest } = body;
    return this.commitStage<T>(stage.token, rest);
  }

  /** Parts and fragments are idempotent on the stage, and each upload is a keyed write: a lost response is reconciled, then at most re-sent unchanged. */
  private async retryPut(path: string, body?: unknown, encoded?: string): Promise<void> {
    await this.request<void>('PUT', path, body, encoded, { committed: () => Promise.resolve() });
  }

  /** Commit under a key fixed by the stage, so a lost response is answered from the Worker's record and never saved twice. */
  private commitStage<T>(token: string, rest: Record<string, unknown>): Promise<T> {
    return this.request<T>('POST', `/stages/${token}/commit`, rest, undefined, { key: `commit-${token}`, committed: (operation) => this.#savedItem<T>(operation) });
  }

  /** The saved Research_Item a write named, read again through the ordinary authorized route. */
  async #savedItem<T>(operation: OperationView): Promise<T> {
    const id = operation.resource?.['item.id'];
    if (!id) throw new ApiFailure(0, 'committed', [], operation);
    return this.get<T>(`/items/${id}`);
  }
}

/** The body of one part, and for a section too large for any part the content that goes up as a logical field. */
export interface PlannedPart { readonly body: string; readonly field?: RichText }
export function stagedPlan(sections: readonly unknown[], partBytes: number): PlannedPart[] {
  const budget = partBytes - byteLength('{"sections":[]}');
  const plan: PlannedPart[] = [];
  let inline: unknown[] = [];
  const flush = (): void => { if (inline.length) plan.push(...stagedParts(inline, partBytes).map((body) => ({ body }))); inline = []; };
  for (const section of sections) {
    const candidate = section as { id?: string; content?: RichText };
    if (candidate.content && byteLength(JSON.stringify(section)) > budget) {
      flush();
      plan.push({ body: JSON.stringify({ sections: [{ ...(candidate.id === undefined ? {} : { id: candidate.id }), field: fieldManifest(candidate.content) }] }), field: candidate.content });
    } else inline.push(section);
  }
  flush();
  return plan;
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
    case 'committed': return 'Your input was saved, but the confirmation was lost. Reload to see it.';
    case 'unknown': return 'The Workspace has not confirmed whether your input was saved. It is kept in this tab; check before saving again.';
    case 'validation': return 'Your input was not saved. Correct the fields marked below.';
    case 'conflict': return 'Your input was not saved because someone else saved a change first.';
    case 'forbidden': return 'Your input was not saved because your Role does not permit this change.';
    case 'too_large': return 'Your input was not saved because it is too large.';
    default: return 'Your input was not saved. It is kept in this tab.';
  }
}
