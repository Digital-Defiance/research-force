/**
 * The narrow RPC surface of `rf-ops` that `rf-app` uses for Access (design "Access configuration").
 * Each method throws when Cloudflare refuses or cannot be reached.
 */
export interface OpsAccess {
  /** Add the address to the `rf-members` Access list, so Access lets the person sign in. */
  addMember(email: string): Promise<void>;
  /** Remove the address from the `rf-members` Access list. */
  removeMember(email: string): Promise<void>;
  /** End every Access session of the address in every application. */
  revokeSessions(email: string): Promise<void>;
}
