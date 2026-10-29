import { emailKey } from '@researchforce/domain/identifiers';
import type { OpsAccess } from '@researchforce/domain/ops';

export type OpsCall = { readonly method: keyof OpsAccess; readonly email: string };

/** An in-memory `rf-ops`: the `rf-members` list, revoked sessions, and every call, with injectable failures. */
export class FakeOps implements OpsAccess {
  readonly list = new Set<string>();
  readonly calls: OpsCall[] = [];
  /** Methods that throw until cleared, as if Cloudflare were unreachable. */
  readonly failing = new Set<keyof OpsAccess>();

  async addMember(email: string): Promise<void> {
    this.#record('addMember', email);
    this.list.add(emailKey(email));
  }
  async removeMember(email: string): Promise<void> {
    this.#record('removeMember', email);
    this.list.delete(emailKey(email));
  }
  async revokeSessions(email: string): Promise<void> {
    this.#record('revokeSessions', email);
  }

  #record(method: keyof OpsAccess, email: string): void {
    if (this.failing.has(method)) throw new Error(`Synthetic rf-ops failure in ${method}.`);
    this.calls.push({ method, email: emailKey(email) });
  }
}
