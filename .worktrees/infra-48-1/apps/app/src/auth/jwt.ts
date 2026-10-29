import { createLocalJWKSet, errors, jwtVerify } from 'jose';
import type { FlattenedJWSInput, JSONWebKeySet, JWSHeaderParameters } from 'jose';
import { ApiError } from '../api/errors';

export const ACCESS_ASSERTION_HEADER = 'Cf-Access-Jwt-Assertion';
export const KEY_CACHE_SECONDS = 3600;
/** At most one network refetch for unknown `kid`s in this window, so forged tokens cannot flood the key server. */
const UNKNOWN_KID_COOLDOWN_MS = 30_000;
const FETCHED_AT_HEADER = 'x-rf-fetched-at';

export class KeysUnavailable extends Error {
  constructor(options?: ErrorOptions) {
    super('The Access signing keys could not be obtained.', options);
    this.name = 'KeysUnavailable';
  }
}

export interface AccessKeysOptions {
  readonly fetch?: (url: string) => Promise<Response>;
  /** The Cache API store shared by the isolates of one data centre; null keeps keys in isolate memory only. */
  readonly cache?: Cache | null;
  readonly now?: () => number;
}

interface LoadedKeys { readonly resolve: ReturnType<typeof createLocalJWKSet>; readonly expires: number; readonly fromNetwork: boolean }

/** The Access team key set, cached in isolate memory and the Cache API for an hour (R1.3, R1.5). */
export class AccessKeys {
  readonly #fetch: (url: string) => Promise<Response>;
  readonly #cache: Cache | null;
  readonly #now: () => number;
  #memory: LoadedKeys | undefined;
  #lastNetwork = Number.NEGATIVE_INFINITY;
  #pending: Promise<LoadedKeys> | undefined;

  constructor(readonly certsUrl: string, options: AccessKeysOptions = {}) {
    this.#fetch = options.fetch ?? ((url) => fetch(url));
    this.#cache = options.cache === undefined ? caches.default : options.cache;
    this.#now = options.now ?? Date.now;
  }

  /** A jose key resolver: the key named by the token's `kid`, refetching the set once if the `kid` is unknown. */
  readonly resolve = async (header: JWSHeaderParameters, token: FlattenedJWSInput): Promise<CryptoKey> => {
    const memory = this.#memory;
    const loaded = memory !== undefined && memory.expires > this.#now() ? memory : await this.#once(() => this.#load());
    try {
      return await loaded.resolve(header, token);
    } catch (error) {
      if (!(error instanceof errors.JWKSNoMatchingKey) || loaded.fromNetwork || this.#now() - this.#lastNetwork < UNKNOWN_KID_COOLDOWN_MS) throw error;
    }
    return (await this.#once(() => this.#fromNetwork())).resolve(header, token);
  };

  async #once(load: () => Promise<LoadedKeys>): Promise<LoadedKeys> {
    this.#pending ??= load().finally(() => { this.#pending = undefined; });
    return this.#pending;
  }

  async #load(): Promise<LoadedKeys> {
    const cached = await this.#cache?.match(this.certsUrl).catch(() => undefined);
    const fetchedAt = Number(cached?.headers.get(FETCHED_AT_HEADER));
    if (cached && Number.isFinite(fetchedAt) && fetchedAt + KEY_CACHE_SECONDS * 1000 > this.#now()) {
      try {
        return this.#remember(await cached.json(), fetchedAt, false);
      } catch { /* a damaged cache entry is replaced from the network */ }
    }
    return this.#fromNetwork();
  }

  async #fromNetwork(): Promise<LoadedKeys> {
    this.#lastNetwork = this.#now();
    let body: unknown;
    try {
      const response = await this.#fetch(this.certsUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      body = await response.json();
    } catch (error) {
      throw new KeysUnavailable({ cause: error });
    }
    const fetchedAt = this.#now();
    const loaded = this.#remember(body, fetchedAt, true);
    await this.#cache?.put(this.certsUrl, new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json', 'cache-control': `max-age=${KEY_CACHE_SECONDS}`, [FETCHED_AT_HEADER]: String(fetchedAt) },
    })).catch(() => undefined);
    return loaded;
  }

  #remember(body: unknown, fetchedAt: number, fromNetwork: boolean): LoadedKeys {
    const keys = (body as { keys?: unknown } | null)?.keys;
    let resolve: LoadedKeys['resolve'];
    try {
      resolve = createLocalJWKSet({ keys } as JSONWebKeySet);
    } catch (error) {
      throw new KeysUnavailable({ cause: error });
    }
    this.#memory = { resolve, expires: fetchedAt + KEY_CACHE_SECONDS * 1000, fromNetwork: false };
    return { resolve, expires: this.#memory.expires, fromNetwork };
  }
}

export interface AccessConfig {
  /** `https://<team>.cloudflareaccess.com`, which is also the tokens' `iss`. */
  readonly teamDomain: string;
  /** The Access application's AUD tag. */
  readonly audience: string;
}
export function certsUrl(config: AccessConfig): string {
  return `${config.teamDomain}/cdn-cgi/access/certs`;
}

export interface AccessAssertion {
  readonly token: string;
  readonly email: string;
  /** Seconds since the epoch. */
  readonly issuedAt: number;
}

/** Verify a `Cf-Access-Jwt-Assertion`; every failure is `unauthenticated` and happens before any data access (R1.3, R1.5, R1.8). */
export async function verifyAccessAssertion(token: string | undefined, config: AccessConfig, keys: AccessKeys, now: Date = new Date()): Promise<AccessAssertion> {
  if (!token || !config.teamDomain || !config.audience) throw new ApiError('unauthenticated');
  let payload: { email?: unknown; iat?: number };
  try {
    ({ payload } = await jwtVerify(token, keys.resolve, {
      algorithms: ['RS256'], audience: config.audience, issuer: config.teamDomain, maxTokenAge: '24h', requiredClaims: ['exp'], currentDate: now,
    }));
  } catch (error) {
    throw new ApiError('unauthenticated', {}, { cause: error });
  }
  if (typeof payload.email !== 'string' || payload.email === '' || payload.iat === undefined) throw new ApiError('unauthenticated');
  return { token, email: payload.email, issuedAt: payload.iat };
}
