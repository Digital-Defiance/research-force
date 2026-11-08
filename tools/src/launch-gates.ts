import { z } from 'zod';

/**
 * Runtime launch-gate evaluation for the mandatory R60.4 acceptance matrix (task 68.4).
 *
 * This is the RUNTIME launch-gate checker, distinct from the structural audit in `./specs.ts`
 * (`tools/check-specs.ts`). The structural checker validates release-gate STRUCTURE and scheduling;
 * it explicitly delegates runtime gate evaluation here (see `docs/acceptance/README.md`). This
 * module decides whether a deployment SCOPE — the team archive, the public launch, the dependent
 * outside-services scope, and the final checkpoint — may be ACTIVATED, by enforcing that the
 * mandatory R60.4 acceptance-evidence matrix is satisfied by REAL, recorded infrastructure evidence.
 *
 * Two contracts carry the weight, both mirrored from the 48.5 staging gating contract
 * (`tests/staging/support/gate.ts`):
 *
 *  1. REAL evidence, not substitute. A gate's infrastructure requirement is satisfied ONLY by a
 *     recorded, passing, executed infrastructure suite run against a REAL deployed scope. A source
 *     file, a checked task box, or a unit-only result (a node/component/workerd property or a
 *     `local-synthetic` test receipt) is NOT substitute evidence; such entries are rejected as not
 *     satisfying an infrastructure acceptance requirement.
 *
 *  2. Honest BLOCKED, never a false pass. When the recorded evidence for a requirement is absent,
 *     failed, or only a substitute, the requirement is UNMET and the gate is BLOCKED/UNVERIFIED — a
 *     non-pass status, never a green skip. A prerequisite gate that is not satisfied blocks every
 *     dependent gate. Failure reports and their remediation tasks are retained, not discarded.
 *
 * This checker makes NO network or account call and establishes nothing by itself: it reads the
 * recorded launch-evidence ledger (produced by task 48.12 against the deployed staging versions) and
 * the gate manifest, and reports, per gate, SATISFIED vs BLOCKED with the exact unmet requirements.
 */

/** A task id such as `48.5`, matching the canonical graph's task identities. */
const taskId = z.string().regex(/^\d+\.\d+$/u);

/**
 * The kinds of recorded evidence a ledger entry can carry.
 *
 * Only the `infra-*` kinds are REAL acceptance evidence for an infrastructure requirement. The three
 * substitute kinds are recorded faithfully (an operator may log that a source file or a unit suite
 * exists) but can NEVER satisfy an infrastructure requirement — they are the exact things the task
 * forbids as substitute evidence.
 */
export const EVIDENCE_KINDS = [
  // Real, executed infrastructure acceptance evidence against a deployed scope:
  'infra-staging', // a 48.5 staging verification suite ran against the real deployed install
  'infra-restore', // 58.5 independently keyed encrypted backup and fresh restore rehearsal
  'infra-abuse', // 59.4 distributed Abuse_Profile / failed-removal containment scenario
  'infra-profile', // 46.2 measured operating-profile certification against real provider facts
  'infra-walkthrough', // R60.9 local synthetic team walkthrough / protected staging rehearsal
  'infra-import', // 48.12 protected journal import rehearsal using the operator's source paths
  // Substitute (NON-acceptance) kinds — recorded but never satisfy an infrastructure requirement:
  'source-file', // the existence of a source file
  'checked-box', // a checked task box in tasks.md
  'unit-test', // a node/component/workerd unit or property result, or a local-synthetic receipt
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** The real, executed infrastructure acceptance kinds. Anything else cannot satisfy an infra requirement. */
export const INFRA_KINDS: readonly EvidenceKind[] = ['infra-staging', 'infra-restore', 'infra-abuse', 'infra-profile', 'infra-walkthrough', 'infra-import'];

/** The substitute kinds the checker must reject as NOT satisfying an infrastructure requirement. */
export const SUBSTITUTE_KINDS: readonly EvidenceKind[] = ['source-file', 'checked-box', 'unit-test'];

/** The outcome recorded for a piece of evidence against the deployed scope. */
export const EVIDENCE_RESULTS = ['passed', 'failed', 'blocked'] as const;
export type EvidenceResult = (typeof EVIDENCE_RESULTS)[number];

/**
 * One recorded launch-evidence entry (produced by task 48.12 and read by this checker).
 *
 * An entry names which gate requirement it is evidence for (`gate`, `requirement`), what KIND of
 * evidence it is, the recorded `result`, and — for infrastructure evidence — the deployed scope it
 * was run against (`scope`), the deployed software release id it is bound to (`releaseId`), and the
 * sanitized evidence reference. `scope: 'local-synthetic'` marks evidence that did NOT run against a
 * real deployed install; such an entry can never satisfy an infrastructure requirement regardless of
 * its kind. A failed entry retains its `remediationTasks` so the failure and its correction are not
 * lost. No research, PII, or secret value belongs in a ledger entry.
 */
export const evidenceEntrySchema = z.strictObject({
  gate: z.string().min(1),
  requirement: z.string().min(1),
  kind: z.enum(EVIDENCE_KINDS),
  result: z.enum(EVIDENCE_RESULTS),
  scope: z.enum(['deployed-staging', 'deployed-production', 'local-synthetic']),
  releaseId: z.string().min(1).optional(),
  evidenceRef: z.string().min(1).optional(),
  recordedAt: z.iso.datetime().optional(),
  remediationTasks: z.array(taskId).default([]),
  note: z.string().min(1).optional(),
});
export type EvidenceEntry = z.infer<typeof evidenceEntrySchema>;

/** The recorded launch-evidence ledger that task 48.12 writes and this checker reads. */
export const launchEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  recordedAt: z.iso.datetime().optional(),
  entries: z.array(evidenceEntrySchema),
});
export type LaunchEvidence = z.infer<typeof launchEvidenceSchema>;

/** The empty ledger used when no launch evidence has been recorded yet: every gate is BLOCKED. */
export const EMPTY_LAUNCH_EVIDENCE: LaunchEvidence = { schemaVersion: 1, entries: [] };

/**
 * One concrete required piece of acceptance evidence for a gate.
 *
 * `id` is the stable requirement key a ledger entry references. `description` is the human-readable
 * requirement from the canonical graph's `requiredEvidence` list. `infra` is the real infrastructure
 * evidence kind that satisfies it — a requirement is satisfied ONLY by a recorded, passing entry of
 * this kind run against a real deployed scope. `critical` marks the requirements whose absence or
 * failure the task calls out as hard scope blockers (a missing content licence, independent
 * keys/destination, profile approval, or a failed control path).
 */
export interface GateRequirement {
  readonly id: string;
  readonly description: string;
  readonly infra: EvidenceKind;
  readonly critical?: boolean;
}

/**
 * A runtime gate manifest: the gate's identity, the concrete acceptance-evidence requirements that
 * must all be satisfied by real evidence, and the prerequisite gates that must themselves be
 * satisfied first. Derived from the canonical graph's `gates[]` (the `requiredEvidence`/`requiresGates`
 * lists) plus the mandatory infra suites of the R60.4 matrix.
 */
export interface GateManifest {
  readonly id: string;
  readonly title: string;
  readonly requiresGates: readonly string[];
  readonly requirements: readonly GateRequirement[];
}

/** One requirement's evaluation: which requirement, whether met, and why it is unmet when it is not. */
export interface RequirementStatus {
  readonly requirement: GateRequirement;
  readonly met: boolean;
  readonly reason: string;
}

/** A gate's evaluation: SATISFIED only when every requirement is met and every prerequisite is satisfied. */
export interface GateStatus {
  readonly id: string;
  readonly title: string;
  readonly satisfied: boolean;
  readonly requirements: readonly RequirementStatus[];
  /** Prerequisite gates that are not satisfied (blocking this gate regardless of its own evidence). */
  readonly unsatisfiedPrerequisites: readonly string[];
  /** The exact unmet requirement descriptions and unsatisfied prerequisites, for an actionable report. */
  readonly unmet: readonly string[];
  /** Retained failure reports: entries recorded as failed/blocked for this gate and their remediation. */
  readonly failures: readonly FailureReport[];
}

/** A retained failure: a recorded non-passing entry and the remediation tasks that must close it. */
export interface FailureReport {
  readonly requirement: string;
  readonly kind: EvidenceKind;
  readonly result: EvidenceResult;
  readonly remediationTasks: readonly string[];
  readonly note?: string;
}

/**
 * Decide whether a single ledger entry is REAL acceptance evidence for a requirement.
 *
 * It must reference the requirement, be of the requirement's required infrastructure kind (so a
 * source file, checked box, or unit-only result is rejected), have passed, and have run against a
 * REAL deployed scope (not `local-synthetic`). This is the single place the "real-evidence-not-
 * substitute" rule lives.
 */
export function isRealAcceptance(entry: EvidenceEntry, requirement: GateRequirement, gateId: string): boolean {
  return (
    entry.gate === gateId &&
    entry.requirement === requirement.id &&
    entry.kind === requirement.infra &&
    INFRA_KINDS.includes(entry.kind) &&
    entry.result === 'passed' &&
    entry.scope !== 'local-synthetic'
  );
}

/** Why a requirement is unmet, naming the specific missing/invalid evidence for an actionable report. */
function unmetReason(entries: readonly EvidenceEntry[], requirement: GateRequirement, gateId: string): string {
  const relevant = entries.filter((entry) => entry.gate === gateId && entry.requirement === requirement.id);
  if (!relevant.length) return `no recorded evidence (requires a passing ${requirement.infra} against a real deployed scope)`;
  const substitute = relevant.find((entry) => SUBSTITUTE_KINDS.includes(entry.kind));
  if (substitute && !relevant.some((entry) => INFRA_KINDS.includes(entry.kind))) {
    return `only substitute evidence recorded (${substitute.kind}); a source file, checked box or unit-only result is not infrastructure acceptance`;
  }
  const localOnly = relevant.find((entry) => INFRA_KINDS.includes(entry.kind) && entry.scope === 'local-synthetic');
  if (localOnly && !relevant.some((entry) => INFRA_KINDS.includes(entry.kind) && entry.scope !== 'local-synthetic')) {
    return `${requirement.infra} recorded only against a local-synthetic scope; real acceptance must run against a deployed install`;
  }
  const failed = relevant.find((entry) => entry.kind === requirement.infra && entry.result !== 'passed');
  if (failed) return `${requirement.infra} recorded as ${failed.result}; a failed or blocked control path blocks this scope`;
  const wrongKind = relevant.find((entry) => INFRA_KINDS.includes(entry.kind) && entry.kind !== requirement.infra);
  if (wrongKind) return `recorded ${wrongKind.kind} does not satisfy the required ${requirement.infra} acceptance`;
  return `no passing ${requirement.infra} against a real deployed scope`;
}

/**
 * Evaluate every gate manifest against the recorded launch evidence.
 *
 * Gates are resolved so a dependent gate can never be SATISFIED before its prerequisite gate: a gate
 * is SATISFIED only when every one of its requirements is met by real acceptance evidence AND every
 * prerequisite gate is itself satisfied. Unknown or cyclic prerequisite references are treated as
 * unsatisfied (they block), so a malformed manifest fails closed rather than passing. Failure reports
 * are retained on each gate.
 */
export function evaluateGates(manifests: readonly GateManifest[], evidence: LaunchEvidence): GateStatus[] {
  const byId = new Map(manifests.map((manifest) => [manifest.id, manifest]));
  const cache = new Map<string, GateStatus>();

  const evaluate = (id: string, stack: readonly string[]): GateStatus => {
    const cached = cache.get(id);
    if (cached) return cached;
    const manifest = byId.get(id)!;

    const requirements: RequirementStatus[] = manifest.requirements.map((requirement) => {
      const met = evidence.entries.some((entry) => isRealAcceptance(entry, requirement, id));
      return { requirement, met, reason: met ? 'satisfied by real deployed-scope acceptance' : unmetReason(evidence.entries, requirement, id) };
    });

    const unsatisfiedPrerequisites: string[] = [];
    for (const dependency of manifest.requiresGates) {
      if (stack.includes(dependency) || !byId.has(dependency)) {
        unsatisfiedPrerequisites.push(dependency); // cyclic or unknown prerequisite fails closed
        continue;
      }
      if (!evaluate(dependency, [...stack, id]).satisfied) unsatisfiedPrerequisites.push(dependency);
    }

    const failures: FailureReport[] = evidence.entries
      .filter((entry) => entry.gate === id && entry.result !== 'passed')
      .map((entry) => ({ requirement: entry.requirement, kind: entry.kind, result: entry.result, remediationTasks: entry.remediationTasks, ...(entry.note === undefined ? {} : { note: entry.note }) }));

    const unmet = [
      ...requirements.filter((status) => !status.met).map((status) => `${status.requirement.description}: ${status.reason}`),
      ...unsatisfiedPrerequisites.map((dependency) => `prerequisite gate "${dependency}" is not satisfied`),
    ];
    const satisfied = unmet.length === 0;
    const status: GateStatus = { id, title: manifest.title, satisfied, requirements, unsatisfiedPrerequisites, unmet, failures };
    cache.set(id, status);
    return status;
  };

  return manifests.map((manifest) => evaluate(manifest.id, []));
}

/** The result of certifying one or more requested scopes: the evaluated gates and whether all pass. */
export interface CertificationResult {
  readonly requested: readonly string[];
  readonly gates: readonly GateStatus[];
  readonly certified: boolean;
}

/**
 * Certify the requested scopes (gate ids). Every requested gate — and, transitively, every gate it
 * depends on — must be SATISFIED. An unknown requested gate id is a hard failure. The caller exits
 * non-zero when `certified` is false. With no recorded infrastructure evidence, no scope certifies.
 */
export function certifyScopes(manifests: readonly GateManifest[], evidence: LaunchEvidence, requested: readonly string[]): CertificationResult {
  const statuses = evaluateGates(manifests, evidence);
  const byId = new Map(statuses.map((status) => [status.id, status]));
  const manifestsById = new Map(manifests.map((manifest) => [manifest.id, manifest]));

  const closure = new Set<string>();
  const unknown: string[] = [];
  const add = (id: string): void => {
    if (closure.has(id)) return;
    const manifest = manifestsById.get(id);
    if (!manifest) { unknown.push(id); return; }
    closure.add(id);
    for (const dependency of manifest.requiresGates) add(dependency);
  };
  for (const id of requested) add(id);

  const certified = unknown.length === 0 && [...closure].every((id) => byId.get(id)?.satisfied === true);
  return { requested, gates: statuses, certified };
}

/**
 * Render a per-gate, human-readable report. Each gate prints SATISFIED or BLOCKED, the exact unmet
 * requirements, and any retained failure reports with their remediation tasks. Unknown requested
 * gates are reported explicitly. The report never asserts a pass it cannot back with real evidence.
 */
export function formatReport(manifests: readonly GateManifest[], evidence: LaunchEvidence, requested: readonly string[]): string {
  const result = certifyScopes(manifests, evidence, requested);
  const byId = new Map(result.gates.map((status) => [status.id, status]));
  const lines: string[] = [];
  lines.push('Launch-gate acceptance evaluation (task 68.4) — recorded evidence only; no network or account access.');
  lines.push('');
  for (const status of result.gates) {
    lines.push(`${status.satisfied ? 'SATISFIED' : 'BLOCKED  '} ${status.id} — ${status.title}`);
    for (const requirement of status.requirements) {
      lines.push(`    ${requirement.met ? '[met]  ' : '[unmet]'} ${requirement.requirement.description}${requirement.met ? '' : ` — ${requirement.reason}`}`);
    }
    for (const dependency of status.unsatisfiedPrerequisites) lines.push(`    [unmet] prerequisite gate "${dependency}" is not satisfied`);
    for (const failure of status.failures) {
      const remediation = failure.remediationTasks.length ? ` remediation: ${failure.remediationTasks.join(', ')}` : ' remediation: none recorded';
      lines.push(`    (retained failure) ${failure.requirement} [${failure.kind}] = ${failure.result};${remediation}${failure.note ? ` — ${failure.note}` : ''}`);
    }
  }
  lines.push('');
  const unknown = requested.filter((id) => !byId.has(id));
  if (unknown.length) lines.push(`Unknown requested gate(s): ${unknown.join(', ')}.`);
  if (requested.length) {
    lines.push(result.certified
      ? `Requested scope(s) CERTIFIED: ${requested.join(', ')}.`
      : `Requested scope(s) BLOCKED: ${requested.join(', ')}. Scope activation is refused until every unmet requirement above is satisfied by real deployed-scope acceptance evidence.`);
  } else {
    lines.push('No scope requested; reported gate status only (no certification attempted).');
  }
  return lines.join('\n');
}

/**
 * Build the concrete R60.4 gate manifests from the canonical graph's `gates[]`.
 *
 * The graph provides, per gate, a human-readable `requiredEvidence[]` list and a `requiresGates[]`
 * dependency list. This function maps each gate id to its concrete acceptance requirements — each
 * bound to the real infrastructure evidence kind that can satisfy it — and preserves the graph's gate
 * dependencies so a dependent scope cannot pass before its prerequisite. The mapping is the
 * executable form of the mandatory matrix; unrecognized gate ids are rejected so the manifest cannot
 * silently omit a gate the graph defines.
 */
export function manifestsForGraph(graphGates: readonly GraphGate[]): GateManifest[] {
  const defined = new Map(graphGates.map((gate) => [gate.id, gate]));
  const requiresGates = (id: string): readonly string[] => defined.get(id)?.requiresGates ?? [];
  const manifests: GateManifest[] = [];

  for (const gate of graphGates) {
    const builder = GATE_BUILDERS[gate.id];
    if (!builder) throw new Error(`No runtime gate manifest is defined for graph gate "${gate.id}".`);
    manifests.push({ id: gate.id, title: builder.title, requiresGates: requiresGates(gate.id), requirements: builder.requirements });
  }
  return manifests;
}

/** The minimal shape of a canonical-graph gate this checker consumes. */
export interface GraphGate {
  readonly id: string;
  readonly requiresGates?: readonly string[];
  readonly requiredEvidence: readonly string[];
}

export interface GateBuilder {
  readonly title: string;
  readonly requirements: readonly GateRequirement[];
}

const requirement = (id: string, description: string, infra: EvidenceKind, critical = false): GateRequirement => ({ id, description, infra, critical });

/**
 * The concrete R60.4 acceptance matrix, per gate id.
 *
 * team_archive: independent encrypted recovery + fresh restore, exact privacy, drafts/files, text,
 * concurrency/lost-response, keyboard/capacity, the R60.9 team walkthroughs and a certified operating
 * profile. public_archive ADDITIONALLY requires real rights/consent/holds/dual approvals,
 * public-channel canaries (real rf-dl / delivery adapters, not constant refusal stand-ins), browser
 * file safety, presentation/accessibility, static index/removal/containment, provider setup and the
 * distributed Abuse_Profile — with the hard scope blockers marked critical. outside_services covers
 * the least-privilege provider and consent/moderation/AI checks. final_checkpoint_49 requires the
 * full mandatory suites with no required acceptance suite skipped.
 */
export const GATE_BUILDERS: Readonly<Record<string, GateBuilder>> = {
  team_archive: {
    title: 'Team-archive gate (custodial team use)',
    requirements: [
      requirement('independent_recovery', 'R36 independent encrypted recovery and fresh restore (independent keys/destination)', 'infra-restore', true),
      requirement('exact_privacy', 'exact current-access privacy checks on the deployed install', 'infra-staging'),
      requirement('drafts_files', 'draft and file workflows (reload, reselection, R2 upload checksums)', 'infra-staging'),
      requirement('large_text', 'large-text boundary behaviour on the deployed install', 'infra-staging'),
      requirement('concurrency_lost_response', 'concurrency and lost-response / crash reconciliation', 'infra-staging'),
      requirement('keyboard_capacity', 'keyboard/accessibility checks on used screens and certified capacity', 'infra-profile'),
      requirement('operating_profile', 'R28 certified selected operating profile (measured provider facts)', 'infra-profile', true),
      requirement('team_walkthroughs', 'R60.9 team walkthroughs recorded against the deployed versions', 'infra-walkthrough'),
      requirement('protected_import', '48.12 protected journal import rehearsal using the operator source paths', 'infra-import'),
    ],
  },
  public_archive: {
    title: 'Public-launch gate (public research hosts)',
    requirements: [
      requirement('content_licence', 'current operator-selected content licence present', 'infra-staging', true),
      requirement('rights_consent_holds', 'real rights, consent, confidentiality holds and dual approvals', 'infra-staging', true),
      requirement('owner_permission_coverage', 'exact snapshot Owner/external permission coverage', 'infra-staging'),
      requirement('public_channel_canaries', 'public-channel canaries through real rf-dl/delivery adapters (not constant refusal stand-ins)', 'infra-staging', true),
      requirement('browser_file_safety', 'public browser file safety on the deployed install', 'infra-staging'),
      requirement('presentation_accessibility', 'public presentation and accessibility (WCAG) on the deployed site', 'infra-staging'),
      requirement('static_index_removal', 'static index, urgent removal and independently verified containment', 'infra-staging', true),
      requirement('provider_setup', 'provider setup (Access/Turnstile/R2/Graph) on the deployed scope', 'infra-staging', true),
      requirement('distributed_abuse', 'R28 distributed Abuse_Profile and spend reserve vs certified profile', 'infra-abuse', true),
    ],
  },
  outside_services: {
    title: 'Outside-services gate (external submissions, consent, AI)',
    requirements: [
      requirement('provider_least_privilege', 'Access/Turnstile/R2/Graph least privilege and delivery/retention verification', 'infra-staging', true),
      requirement('consent_bearer_eligibility', 'consent snapshot and bearer-link current eligibility', 'infra-staging'),
      requirement('moderation_privacy', 'moderation/contact-review privacy and retention', 'infra-staging'),
      requirement('ai_isolation', 'AI allow-list/input isolation and configured allocation when AI enabled', 'infra-staging'),
    ],
  },
  final_checkpoint_49: {
    title: 'Final checkpoint (no required acceptance suite skipped)',
    requirements: [
      requirement('all_mandatory_suites', 'full mandatory suites and traceability/graph validation for the enabled scope', 'infra-staging', true),
      requirement('no_unresolved_failures', 'no unresolved acceptance failures for the enabled scope', 'infra-staging', true),
      requirement('final_restore', 'independently keyed fresh restore rehearsal retained', 'infra-restore', true),
      requirement('final_abuse', 'distributed abuse / failed-removal containment retained', 'infra-abuse', true),
      requirement('final_profile', 'measured operating-profile certification retained', 'infra-profile', true),
      requirement('final_walkthroughs', 'R60.9 team walkthroughs retained; none skipped', 'infra-walkthrough', true),
      requirement('final_import', 'protected import rehearsal retained', 'infra-import', true),
    ],
  },
};

/** The gate ids this runtime checker knows how to evaluate, in dependency order. */
export const KNOWN_GATES: readonly string[] = Object.keys(GATE_BUILDERS);
