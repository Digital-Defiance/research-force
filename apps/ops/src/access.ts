import { emailKey } from '@researchforce/domain/identifiers';
import type { OpsAccess } from '@researchforce/domain/ops';

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';

export interface AccessSyncConfig {
  readonly accountId: string;
  /** The Zero Trust email list `rf-members` that the Access allow policy refers to. */
  readonly memberListId: string;
  /** Access Apps and Policies Edit, and Zero Trust list edit, for this account only. */
  readonly apiToken: string;
}

export class CloudflareApiError extends Error {
  constructor(readonly status: number, readonly codes: readonly number[]) {
    super(`Cloudflare API request failed with HTTP ${status}${codes.length ? ` (codes ${codes.join(', ')})` : ''}.`);
    this.name = 'CloudflareApiError';
  }
}

/** Keeps the `rf-members` Access list and Access sessions in step with Member_Status (R2.1, R2.9). */
export class AccessSync implements OpsAccess {
  readonly #fetch: typeof fetch;
  constructor(readonly config: AccessSyncConfig, fetcher: typeof fetch = fetch) {
    this.#fetch = fetcher;
  }

  async addMember(email: string): Promise<void> {
    await this.#call('PATCH', this.#listPath(), { append: [{ value: emailKey(email) }] });
  }

  async removeMember(email: string): Promise<void> {
    await this.#call('PATCH', this.#listPath(), { remove: [emailKey(email)] });
  }

  async revokeSessions(email: string): Promise<void> {
    await this.#call('POST', `/accounts/${this.config.accountId}/access/organizations/revoke_user`, { email: emailKey(email) });
  }

  #listPath(): string {
    return `/accounts/${this.config.accountId}/gateway/lists/${this.config.memberListId}`;
  }

  async #call(method: string, path: string, body: unknown): Promise<void> {
    if (!this.config.accountId || !this.config.memberListId || !this.config.apiToken) throw new Error('Access sync is not configured.');
    const response = await this.#fetch(`${CLOUDFLARE_API}${path}`, {
      method, body: JSON.stringify(body), headers: { authorization: `Bearer ${this.config.apiToken}`, 'content-type': 'application/json' },
    });
    const result = await response.json<{ success?: boolean; errors?: { code?: number }[] }>().catch(() => ({ success: false, errors: [] }));
    if (!response.ok || result.success !== true) throw new CloudflareApiError(response.status, (result.errors ?? []).flatMap((error) => (typeof error.code === 'number' ? [error.code] : [])));
  }
}
