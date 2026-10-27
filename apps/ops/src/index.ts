import { WorkerEntrypoint } from 'cloudflare:workers';
import type { OpsAccess } from '@researchforce/domain/ops';
import { AccessSync } from './access';

export interface OpsEnv {
  CF_ACCOUNT_ID: string;
  ACCESS_MEMBER_LIST_ID: string;
  /** Secret. */
  CF_ACCESS_API_TOKEN: string;
}

/** Reachable only through service bindings: no fetch handler and no route. */
export default class Ops extends WorkerEntrypoint<OpsEnv> implements OpsAccess {
  #access(): AccessSync {
    return new AccessSync({ accountId: this.env.CF_ACCOUNT_ID, memberListId: this.env.ACCESS_MEMBER_LIST_ID, apiToken: this.env.CF_ACCESS_API_TOKEN });
  }

  async addMember(email: string): Promise<void> { await this.#access().addMember(email); }
  async removeMember(email: string): Promise<void> { await this.#access().removeMember(email); }
  async revokeSessions(email: string): Promise<void> { await this.#access().revokeSessions(email); }
}
