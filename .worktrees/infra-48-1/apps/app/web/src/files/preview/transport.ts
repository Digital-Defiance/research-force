import { DOWNLOAD_LIFETIME_MS } from '@researchforce/domain/files';
import type { ApiClient } from '../../api';

export type PreviewFailureKind = 'unavailable' | 'mismatch' | 'damaged' | 'password' | 'limit';
/** What a preview could not do, named so the Member can tell a damaged file from one that is merely too large to show. */
export class PreviewError extends Error {
  constructor(readonly kind: PreviewFailureKind, message: string) { super(message); this.name = 'PreviewError'; }
}
export const unavailable = () => new PreviewError('unavailable', 'The file is unavailable from storage.');
export const mismatch = (format: string) => new PreviewError('mismatch', `The file does not match its recorded ${format} format.`);
export const damaged = (what: string) => new PreviewError('damaged', `${what} is damaged.`);
export const limited = (what: string) => new PreviewError('limit', `${what} exceeds the preview limits of this browser tab. The full file can be downloaded.`);

const REFUSED = new Set([401, 403, 404, 410]);
/**
 * A Member-bound Download_Link, fetched again when it nears the end of its life or when storage refuses it mid-preview. Each refused read is retried
 * once with a new link; a second refusal means the file itself is unavailable.
 */
export class DownloadSource {
  #url: string | undefined;
  #issued = 0;
  #pending: Promise<string> | undefined;
  constructor(private readonly client: Pick<ApiClient, 'post'>, private readonly fileId: string, private readonly fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init), private readonly now: () => number = Date.now) {}
  /** How many links this source has requested. */
  links = 0;
  async url(force = false): Promise<string> {
    if (!force && this.#url !== undefined && this.now() - this.#issued < DOWNLOAD_LIFETIME_MS - 60_000) return this.#url;
    this.#pending ??= this.client.post<{ url: string }>(`/files/${this.fileId}/link`).then((link) => { this.#url = link.url; this.#issued = this.now(); this.links += 1; return link.url; }, () => { throw unavailable(); }).finally(() => { this.#pending = undefined; });
    return this.#pending;
  }
  /** A ranged read (`end` inclusive), or the whole file when no range is given. Never sends credentials to storage. */
  async fetch(signal: AbortSignal, range?: { start: number; end: number }): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const url = await this.url(attempt > 0);
      let response: Response;
      try {
        response = await this.fetcher(url, { signal, credentials: 'omit', ...(range ? { headers: { Range: `bytes=${range.start}-${range.end}` } } : {}) });
      } catch (error) { if (signal.aborted) throw error; throw unavailable(); }
      if (response.ok) return response;
      if (attempt === 0 && REFUSED.has(response.status)) continue;
      throw unavailable();
    }
  }
}

/** At most `limit` bytes of a response body. The rest is never read: the request is cancelled as soon as the limit is reached. */
export async function readBounded(response: Response, limit: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    const whole = new Uint8Array(await response.arrayBuffer());
    return { bytes: whole.subarray(0, limit), truncated: whole.byteLength > limit };
  }
  const out = new Uint8Array(limit); let size = 0; let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = limit - size;
    out.set(value.subarray(0, room), size);
    size += Math.min(room, value.byteLength);
    if (value.byteLength > room) { truncated = true; break; }
    if (size === limit) { truncated = !(await reader.read()).done; break; }
  }
  if (truncated) void reader.cancel().catch(() => undefined);
  return { bytes: out.subarray(0, size), truncated };
}

/** The chunks of a response body, for a reader that decides when it has seen enough; leaving the loop cancels the transfer. */
export async function* chunksOf(response: Response): AsyncGenerator<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) { yield new Uint8Array(await response.arrayBuffer()); return; }
  try { for (;;) { const { done, value } = await reader.read(); if (done) return; yield value; } }
  finally { void reader.cancel().catch(() => undefined); }
}
