import { z } from 'zod';
import { OPERATING_PROFILES } from '@researchforce/domain/resource-profile';
import { assertPublicCopy, type InstallationPublicCopy, type ValidatedInstallationPublicCopy } from '@researchforce/design/installation';

/**
 * Installation bootstrap planning for task 48.4. A pure planner: it validates an installation's
 * bootstrap inputs and produces the ordered bootstrap operations plus the state the site build and
 * publisher need (the recorded public-copy version/digest and the initialized "About the group"
 * Policy_Section). It performs NO network, account, or provider call and never provisions, buys a
 * plan, publishes research, or selects a content licence. `tools/bootstrap.ts` is the CLI wrapper.
 *
 * The task's refusals live here. Bootstrap REFUSES when a required operator input is absent — a
 * missing or partial `Installation_Public_Copy`, a bundle changed without a release, a missing
 * owner-configured Content_Licence (required before publication or licence-agreement collection),
 * a missing approved Operating_Profile/budget, missing independent recovery destination/key custody,
 * or, for a production gate, a missing initial fresh restore or containment capability. Provisioning
 * and bootstrap never INFER those inputs: an absent input is a stop, not a default.
 */

/** A configured, owner-selected Content_Licence. Required before publication or agreement collection. */
export const contentLicenceSchema = z.strictObject({
  name: z.string().min(1),
  url: z.url(),
  exportText: z.string().min(1),
});
export type ContentLicence = z.infer<typeof contentLicenceSchema>;

/** The approved Operating_Profile and the operator's explicit budget approval for a paid profile. */
export const operatingProfileApprovalSchema = z.strictObject({
  operatingProfile: z.enum(OPERATING_PROFILES),
  /** Explicit operator budget approval; required whenever the paid profile is selected (R28.1, R28.4). */
  budgetApproved: z.boolean(),
}).refine((value) => value.operatingProfile !== 'Paid_Standard' || value.budgetApproved, {
  message: 'Paid_Standard requires explicit operator budget approval; bootstrap does not infer permission to buy a plan.',
});
export type OperatingProfileApproval = z.infer<typeof operatingProfileApprovalSchema>;

/** Independent recovery destination and key custody, kept apart from the production application secrets (R36). */
export const recoveryCustodySchema = z.strictObject({
  destination: z.string().min(1),
  /** The custody arrangement for the recovery key, independent of the application's own secrets. */
  keyCustody: z.string().min(1),
  independentOfApplicationSecrets: z.literal(true),
});
export type RecoveryCustody = z.infer<typeof recoveryCustodySchema>;

/** The production readiness inputs that only the applicable production gates require. */
export const productionReadinessSchema = z.strictObject({
  /** A completed initial fresh restore rehearsal in an isolated environment (R36.17, R60.4). */
  freshRestoreCompleted: z.boolean(),
  /** Verified public-containment capability (the precreated edge rule and recovery credential, R60). */
  containmentVerified: z.boolean(),
});
export type ProductionReadiness = z.infer<typeof productionReadinessSchema>;

/** A trusted origin used for URL and origin checks; an explicit absolute origin, never inferred. */
const trustedOrigin = z.url().refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.pathname === '/' && !url.search && !url.hash;
  } catch {
    return false;
  }
}, 'A trusted origin is an absolute scheme://host[:port] with no path, query, or fragment.');

/** The initial Project (the P1030680 Project for ResearchForce.org). Created Not_Published. */
export const initialProjectSchema = z.strictObject({
  slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u, 'A Project_Slug is a lowercase kebab identifier.'),
  name: z.string().min(1),
  description: z.string().min(1),
});
export type InitialProject = z.infer<typeof initialProjectSchema>;

/** The installation identity: the resource/environment name and the explicit trusted origins. */
export const installationIdentitySchema = z.strictObject({
  installationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  environment: z.enum(['rehearsal', 'staging', 'production']),
  trustedOrigins: z.array(trustedOrigin).min(1),
});
export type InstallationIdentity = z.infer<typeof installationIdentitySchema>;

/**
 * The full bootstrap input. The `publicCopy` is validated by `assertPublicCopy` (so a partial bundle
 * is refused there). `releasedPublicCopyDigest` is the digest the current release recorded for the
 * bundle; a mismatch means the copy was changed without a release and bootstrap refuses it. The
 * `contentLicence`, `operatingProfile`, and `recovery` inputs are optional in the schema only so the
 * planner can report a precise refusal for each absent input rather than a generic parse error.
 */
export const bootstrapInputSchema = z.strictObject({
  identity: installationIdentitySchema,
  responsiblePerson: z.strictObject({ displayName: z.string().min(1), memberEmail: z.email() }),
  initialProject: initialProjectSchema,
  publicCopy: z.unknown(),
  /** The public-copy digest the current software release recorded; a change without a release is refused. */
  releasedPublicCopyDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  contentLicence: contentLicenceSchema.optional(),
  operatingProfile: operatingProfileApprovalSchema.optional(),
  recovery: recoveryCustodySchema.optional(),
  productionReadiness: productionReadinessSchema.optional(),
});
export type BootstrapInput = z.input<typeof bootstrapInputSchema>;

/** The refusal raised when a required operator bootstrap input is absent or inconsistent. */
export class BootstrapRefusal extends Error {
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super(`Bootstrap is refused until these operator inputs are provided or corrected: ${reasons.join('; ')}`);
    this.name = 'BootstrapRefusal';
    this.reasons = reasons;
  }
}

/** The initialized "About the group" Policy_Section, copied from the validated bundle's About prose. */
export interface AboutTheGroupSection {
  readonly pageKey: 'about';
  readonly sectionKey: 'about_the_group';
  readonly title: 'About the group';
  readonly required: true;
  /** The About paragraphs joined into the section text, from the validated Installation_Public_Copy. */
  readonly text: string;
}

/** The public-copy identity recorded in bootstrap and in the site-build state (R40.12, R46.41). */
export interface RecordedPublicCopy {
  readonly version: string;
  readonly digest: string;
}

export interface BootstrapPlan {
  readonly mode: 'dry-run';
  readonly installationId: string;
  readonly environment: InstallationIdentity['environment'];
  readonly trustedOrigins: readonly string[];
  readonly responsiblePerson: { readonly displayName: string; readonly memberEmail: string };
  readonly initialProject: InitialProject & { readonly published: false };
  /** The validated public-copy version/digest recorded in bootstrap and site-build state. */
  readonly publicCopy: RecordedPublicCopy;
  /** The initialized "About the group" Policy_Section from the configured About prose. */
  readonly aboutTheGroup: AboutTheGroupSection;
  readonly contentLicence: ContentLicence;
  readonly operatingProfile: OperatingProfileApproval;
  readonly recovery: RecoveryCustody;
  /** The ordered bootstrap operations, reported for the dry run; none performs a network/account call. */
  readonly steps: readonly string[];
  /** Bootstrap authorizes no provisioning, purchase, publication, or licence selection by itself. */
  readonly provisioningAuthorized: false;
  readonly publicationAuthorized: false;
}

/**
 * Validate the bootstrap inputs and build the dry-run bootstrap plan. The order of refusals is: first
 * the installation identity/project/responsible-person shape; then the public copy (validated and
 * digest-checked against the release); then the operator inputs that gate publication and operation.
 * A single `BootstrapRefusal` collects every missing/inconsistent input so the operator sees them all.
 */
export function buildBootstrapPlan(rawInput: unknown): BootstrapPlan {
  const input = bootstrapInputSchema.parse(rawInput);
  const reasons: string[] = [];

  // The validated Installation_Public_Copy. assertPublicCopy refuses a missing or partial bundle.
  let validated: ValidatedInstallationPublicCopy | undefined;
  try {
    validated = assertPublicCopy(input.publicCopy as InstallationPublicCopy | undefined | null);
  } catch (error) {
    reasons.push(error instanceof Error ? error.message : String(error));
  }
  // A bundle changed without a matching release is refused: its digest must equal the released digest.
  if (validated && input.releasedPublicCopyDigest !== undefined && validated.digest !== input.releasedPublicCopyDigest) {
    reasons.push('The installation public copy was changed without a release; its content digest does not match the released digest. Cut a release before bootstrapping the changed copy.');
  }

  // The owner-configured Content_Licence is required before any publication or licence-agreement collection.
  if (!input.contentLicence) reasons.push('No owner-configured Content_Licence is present; configure its name, URL, and export text before publication or licence-agreement collection. Bootstrap does not select a content licence.');

  // An approved Operating_Profile and, for the paid profile, explicit budget approval are required.
  if (!input.operatingProfile) reasons.push('No approved Operating_Profile/budget is present; select and approve an operating profile. Bootstrap does not infer permission to buy a plan.');

  // Independent recovery destination and key custody, held apart from the production application secrets.
  if (!input.recovery) reasons.push('No independent recovery destination/key custody is configured; recovery custody must be independent of the production application secrets.');

  // For a production environment, the applicable production gates also require fresh restore and containment.
  if (input.identity.environment === 'production') {
    if (!input.productionReadiness) reasons.push('Production bootstrap requires a completed initial fresh restore and verified containment capability; none is recorded.');
    else {
      if (!input.productionReadiness.freshRestoreCompleted) reasons.push('Production bootstrap requires a completed initial fresh restore rehearsal; it is not recorded.');
      if (!input.productionReadiness.containmentVerified) reasons.push('Production bootstrap requires verified public-containment capability; it is not verified.');
    }
  }

  if (reasons.length > 0) throw new BootstrapRefusal(reasons);

  // Every input is present and consistent; `validated` and the operator inputs are now known-good.
  const copy = validated!;
  const aboutText = copy.about.join('\n\n');
  const steps = [
    `Record installation identity ${input.identity.installationId} and ${input.identity.trustedOrigins.length} trusted origin(s).`,
    `Record the first Responsible_Person ${input.responsiblePerson.displayName}.`,
    `Create the initial Project ${input.initialProject.slug} (Not_Published).`,
    `Record the Installation_Public_Copy version ${copy.version} and digest ${copy.digest} in bootstrap and site-build state.`,
    'Initialize the required "About the group" Policy_Section from the configured About prose.',
    `Record the configured Content_Licence ${input.contentLicence!.name}.`,
    `Record the approved Operating_Profile ${input.operatingProfile!.operatingProfile}.`,
    'Record the independent recovery destination and key custody.',
  ];

  return {
    mode: 'dry-run',
    installationId: input.identity.installationId,
    environment: input.identity.environment,
    trustedOrigins: input.identity.trustedOrigins,
    responsiblePerson: input.responsiblePerson,
    initialProject: { ...input.initialProject, published: false },
    publicCopy: { version: copy.version, digest: copy.digest },
    aboutTheGroup: { pageKey: 'about', sectionKey: 'about_the_group', title: 'About the group', required: true, text: aboutText },
    contentLicence: input.contentLicence!,
    operatingProfile: input.operatingProfile!,
    recovery: input.recovery!,
    steps,
    provisioningAuthorized: false,
    publicationAuthorized: false,
  };
}

/** Render a human-readable summary of a dry-run bootstrap plan. */
export function formatBootstrapPlan(plan: BootstrapPlan): string {
  const lines: string[] = [];
  lines.push(`Installation bootstrap dry run (task 48.4) for ${plan.installationId} / ${plan.environment}.`);
  lines.push('No network or account access; nothing was provisioned, purchased, or published.');
  lines.push('');
  for (const step of plan.steps) lines.push(`  - ${step}`);
  lines.push('');
  lines.push(`Public copy recorded: version ${plan.publicCopy.version}, digest ${plan.publicCopy.digest}.`);
  lines.push(`"About the group" initialized with ${plan.aboutTheGroup.text.length} characters of About prose.`);
  return lines.join('\n');
}
