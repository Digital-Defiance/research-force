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

/**
 * Whether the configured platform plan can actually deny traffic on the public research hosts. The Publisher
 * relies on precreated edge Containment as the fallback when a removal is not verified in time (design
 * "Publisher" step 7, R24.16); if the plan cannot carry the required deny rules this is a public-launch
 * blocker, not a runtime surprise (R60.4). `verifiable` is whether an out-of-band probe can confirm a denial
 * is in force, which the five-minute verification step needs (R24.16).
 */
export interface ContainmentCapabilities {
  /** Whether the plan can enable the precreated deny rule(s) that block the public research hosts. */
  readonly canDeny: boolean;
  /** Whether an out-of-band probe can verify a denial is actually in force. */
  readonly verifiable: boolean;
  /** Whether an independent alert channel is configured, so an incident can be declared off the primary path. */
  readonly canAlert: boolean;
  /** When `canDeny` is false, the plan-level reason, so the launch gate can report why Containment is unavailable. */
  readonly blockingReason: string | null;
}

/**
 * The state of edge Containment on the public research hosts, as a fresh out-of-band read reports it. The app
 * host is never part of Containment: Containment denies the public research hosts only, leaving the app
 * reachable (R24.16).
 */
export interface ContainmentState {
  /** Whether the precreated public-host deny rule(s) are currently enabled. */
  readonly active: boolean;
  /** Whether an out-of-band probe confirmed the denial is actually serving (not just configured). */
  readonly verified: boolean;
}

/**
 * The narrow RPC surface of `rf-ops` for edge Containment, health probing, and incident alerting that the
 * Publisher (tasks 32.1 to 32.5) drives when an urgent removal is not verified in time (design "Publisher"
 * step 7, R24.16, R24.17). Like {@link OpsAccess}, every method throws when Cloudflare refuses or cannot be
 * reached. This surface is deliberately asymmetric: Containment can be ENABLED freely (confidentiality must
 * always be allowed to proceed), but it can only be CLEARED by presenting the authorized new generation that
 * supersedes the removal — a plain reset or retry cannot clear active Containment (R24.17, R60.6).
 */
export interface OpsContainment {
  /** Report whether the configured plan can actually deny and verify on the public research hosts (R24.16, R60.4). */
  containmentCapabilities(): Promise<ContainmentCapabilities>;
  /**
   * Enable the precreated public-host deny rule(s), denying the public research hosts while leaving the app
   * host available (R24.16). Idempotent: enabling an already-enabled rule is not an error. This is the
   * four-minute fallback; it never touches the app host.
   */
  containPublicHosts(): Promise<void>;
  /**
   * Clear Containment, but only under an authorized new generation. `authorizedGeneration` is the run id of
   * the latest authorized Publisher generation that has verified the real public state; a reset/retry has no
   * such token and so cannot clear Containment (R24.17). Throws when the token is missing or not the current
   * authorized generation.
   */
  releaseContainment(authorizedGeneration: string): Promise<void>;
  /** Out-of-band read of whether Containment is enabled and actually serving on the public research hosts (R24.16). */
  verifyContainment(): Promise<ContainmentState>;
  /**
   * Out-of-band HEAD probe of a public address, independent of the primary app's health, returning whether
   * the address is served ("present"), not found ("absent"), or unreachable ("unknown"). Used to verify a
   * removal took effect (design "Publisher" step 7).
   */
  probePublicAddress(url: string): Promise<'present' | 'absent' | 'unknown'>;
  /**
   * Declare a confidentiality incident through the independently operated alert channel, recording the last
   * verified public state and the failed actions (R24.17, R60.6). Never asserts success; it is only called
   * when neither removal nor Containment could be confirmed. The payload carries no research body, only the
   * operation identities and states (R28.6, R60.6).
   */
  declareIncident(incident: ConfidentialityIncident): Promise<void>;
}

/**
 * The content-free record of a confidentiality incident sent to the independent alert channel. It names what
 * failed and the last verified public state, never any research body, bearer link, or recovery secret (R28.6,
 * R60.6).
 */
export interface ConfidentialityIncident {
  /** The Publisher generation that was attempting the removal. */
  readonly generation: string;
  /** The epoch under which the removal was authorized. */
  readonly epoch: number;
  /** The public addresses whose removal could not be confirmed. */
  readonly unverifiedTargets: readonly string[];
  /** Which control paths failed: removal verification, Containment, or both. */
  readonly failedActions: readonly ('removal' | 'containment')[];
  /** A short, content-free description of the last public state actually verified. */
  readonly lastVerifiedState: string;
}
