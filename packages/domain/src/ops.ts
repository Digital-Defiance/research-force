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

/**
 * The narrow RPC surface of `rf-ops` for the single precreated WAF custom rule that blocks
 * `submit.researchforce.org` when the Public_Traffic_Budget is reached (task 34.1/34.2, design "Capacity,
 * cost, and public abuse budgets", R28.5, R28.6, R28.11). The `Budget` Durable Object (task 34.1) calls this
 * when a public counter crosses the Public_Traffic_Budget-minus-2%-margin threshold, and again at the 00:00
 * UTC reset to lift it. Like {@link OpsAccess}, the method throws when Cloudflare refuses or cannot be
 * reached. This is ordinary edge shedding, NOT confidentiality Containment ({@link OpsContainment}): it only
 * turns the optional, invocation-costing public submit API on or off; it never denies the static public
 * research hosts, their stored pages, file copies, or static search.
 */
export interface OpsWaf {
  /**
   * Enable (`true`) or disable (`false`) the precreated WAF custom rule that blocks the public submit host.
   * Idempotent: toggling the rule to the state it already holds is not an error. 34.2 implements the rf-ops
   * side (`apps/ops/src/waf.ts`); 34.1 only calls this.
   */
  setSubmitBlock(enabled: boolean): Promise<void>;
}

/**
 * The narrow RPC surface of `rf-ops` for deploying the assets-only `rf-site` Worker through the Cloudflare
 * Workers Static Assets Direct Upload API, under the serialized publication-epoch fence (task 32.1, design
 * "Public pages" + "Workers Static Assets", R24.7, R24.11, R24.12, R24.16, R24.17, R28.6, R60.2). `rf-site`
 * is deployed ONLY by the Publisher through rf-ops. rf-ops serializes promotion and rechecks the authoritative
 * publication epoch immediately before AND after it; a stale or raced promotion does not stand and any
 * independent containment stays in force — an obsolete operation can never reopen a contained host. For an
 * ambiguous answer the operation identity, exact version/manifest, and verified status are recorded so a later
 * reconciliation against actual provider state decides before any retry; rf-ops never blind-retries.
 */
export interface OpsDeploy {
  /**
   * Deploy `manifest` (path -> {hash, size}) as a new `rf-site` version, fenced by `epoch` under the durable
   * `operationId`. `run` is the Publisher generation id; `missing` supplies the base64 bytes and content type
   * for each file hash the platform reports missing (only missing files are uploaded); `containmentActive` is
   * whether independent containment is currently in force. Returns the live result the 32.5 orchestrator acts
   * on: whether the version was promoted, whether containment must remain, the created version id, and the
   * settled operation state. Throws only on a definite Cloudflare refusal; a lost/uncertain answer is returned
   * as an `uncertain` outcome, never a blind retry.
   */
  deploySite(input: {
    readonly manifest: Readonly<Record<string, { readonly hash: string; readonly size: number }>>;
    readonly run: string;
    readonly epoch: number;
    readonly operationId: string;
    readonly missing: Readonly<Record<string, { readonly base64: string; readonly contentType: string }>>;
    readonly containmentActive: boolean;
  }): Promise<OpsDeployResult>;
}

/** The content-free result of an `rf-site` deploy attempt (R28.6): identities and states only, no research body. */
export interface OpsDeployResult {
  /** Whether the version was promoted to 100% and stands. False means stale/raced/uncertain or a refusal. */
  readonly promoted: boolean;
  /** Whether containment must remain in force after this operation. Never cleared on a stale/raced deploy. */
  readonly keepContainment: boolean;
  /** The created Worker version id, once the platform returned one (recorded even when not promoted). */
  readonly versionId: string | null;
  /** The durable operation identity this deploy ran under. */
  readonly operationId: string;
  /** The settled durable state: `confirmed`, `failed`, or `uncertain`. */
  readonly operationState: 'confirmed' | 'failed' | 'uncertain';
  /** Why the deploy ended the way it did. */
  readonly reason: 'promoted' | 'stale_before' | 'raced_after' | 'uncertain' | 'created_not_promoted';
}
