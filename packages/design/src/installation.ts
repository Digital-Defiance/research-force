import { fragmentDigest } from '@researchforce/domain/text-fragments';

/**
 * `Installation_Public_Copy` (design "Site display name…", R46.41, R46.42). One versioned, digest-addressed
 * configuration object that carries the installation-specific public identity and editorial copy: the masthead name
 * and strapline, the Mission statement (heading and paragraphs), the About prose, and the ordered Principles. It is
 * validated installation configuration consumed by `packages/design`, the public renderers, the Publisher, and
 * bootstrap. ResearchForce.org supplies its values from `docs/instance/researchforce-org-content.md` verbatim; every
 * other installation supplies its own complete bundle. There is no ResearchForce.org fallback: a missing or partial
 * bundle refuses site generation, publication, and licence-agreement collection rather than borrowing those claims.
 *
 * Changing the copy is a release/configuration change: the `version` date and the content `digest` feed the affected
 * pages' last-updated dates and the Publisher's invalidation of the home page, About page, header/footer derivatives,
 * metadata that names the site, print output, and exports that include policy pages (R40.12).
 */
export interface MissionStatement {
  /** The heading shown above the Mission paragraphs on the home page. */
  readonly heading: string;
  /** One or more Mission paragraphs, in order. */
  readonly paragraphs: readonly string[];
}

/** One ordered Principle: a short lead word or phrase and the sentence(s) that follow it. */
export interface Principle {
  /** The bold lead word or phrase, unique within the bundle (e.g. "Independence"). */
  readonly name: string;
  readonly text: string;
}

export interface InstallationPublicCopy {
  /** UTC date (`YYYY-MM-DD`) of the last change to any field, like the fixed texts' versions (R46.29). */
  readonly version: string;
  /** The masthead display name shown in the header and at the start of the home page. */
  readonly name: string;
  /** The masthead strapline shown with the name. */
  readonly strapline: string;
  readonly mission: MissionStatement;
  /** The About prose paragraphs; bootstrap copies these into the required "About the group" Policy_Section. */
  readonly about: readonly string[];
  /** The Principles in the order the About page presents them. */
  readonly principles: readonly Principle[];
}

/** The validated bundle: the exact same fields plus the content `digest` of its canonical serialization. */
export interface ValidatedInstallationPublicCopy extends InstallationPublicCopy {
  /** SHA-256 (lowercase hex) of the canonical serialization of the bundle's content (R40.12). */
  readonly digest: string;
}

/** One reason a bundle is rejected, naming the field and giving actionable guidance. */
export interface PublicCopyIssue { readonly field: string; readonly rule: string }

const VERSION_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const isBlank = (value: unknown): value is undefined => typeof value !== 'string' || !/\S/u.test(value);

/**
 * The canonical serialization the digest hashes: every content field in a fixed order, with keys sorted by
 * `fragmentDigest`'s `stableJson`, so an equal bundle hashes identically regardless of object key order. The version
 * is part of the identity so a copy-only republish changes the digest even when only the date moves.
 */
function canonicalCopy(copy: InstallationPublicCopy): unknown {
  return {
    format: 'installation-public-copy-v1',
    version: copy.version,
    name: copy.name,
    strapline: copy.strapline,
    mission: { heading: copy.mission.heading, paragraphs: [...copy.mission.paragraphs] },
    about: [...copy.about],
    principles: copy.principles.map((principle) => ({ name: principle.name, text: principle.text })),
  };
}

/** The content digest of a bundle, computed from its canonical serialization (R40.12). */
export const publicCopyDigest = (copy: InstallationPublicCopy): string => fragmentDigest(canonicalCopy(copy));

/**
 * Validate a candidate `Installation_Public_Copy`. Validation is total: it returns every reason the bundle is
 * rejected rather than throwing. It rejects a missing or blank version/name/strapline, a missing or blank mission
 * heading, an empty mission or an empty mission paragraph, empty or blank About prose, an empty principle list, and a
 * principle with a missing or blank name or text or a duplicate name (compared case-insensitively on the trimmed
 * name). A valid bundle returns no issues.
 */
export function validatePublicCopy(copy: InstallationPublicCopy | undefined | null): PublicCopyIssue[] {
  const issues: PublicCopyIssue[] = [];
  const add = (field: string, rule: string): void => { issues.push({ field, rule }); };
  if (copy === undefined || copy === null || typeof copy !== 'object') {
    return [{ field: 'publicCopy', rule: 'The installation public copy is required; configure a complete bundle before generating or publishing the site.' }];
  }
  if (isBlank(copy.version)) add('version', 'Give the bundle a version date.');
  else if (!VERSION_DATE.test(copy.version)) add('version', 'The version must be a UTC date in the form YYYY-MM-DD.');
  if (isBlank(copy.name)) add('name', 'Give the installation a masthead name.');
  if (isBlank(copy.strapline)) add('strapline', 'Give the installation a masthead strapline.');

  if (copy.mission === undefined || copy.mission === null || typeof copy.mission !== 'object') add('mission', 'Give the installation a Mission statement.');
  else {
    if (isBlank(copy.mission.heading)) add('mission.heading', 'Give the Mission statement a heading.');
    if (!Array.isArray(copy.mission.paragraphs) || copy.mission.paragraphs.length === 0) add('mission.paragraphs', 'The Mission statement needs at least one paragraph.');
    else copy.mission.paragraphs.forEach((paragraph, index) => { if (isBlank(paragraph)) add(`mission.paragraphs.${index}`, 'A Mission paragraph cannot be blank.'); });
  }

  if (!Array.isArray(copy.about) || copy.about.length === 0) add('about', 'The About prose needs at least one paragraph.');
  else copy.about.forEach((paragraph, index) => { if (isBlank(paragraph)) add(`about.${index}`, 'An About paragraph cannot be blank.'); });

  if (!Array.isArray(copy.principles) || copy.principles.length === 0) add('principles', 'The Principles list cannot be empty; give at least one Principle.');
  else {
    const seen = new Set<string>();
    copy.principles.forEach((principle, index) => {
      if (principle === undefined || principle === null || typeof principle !== 'object') { add(`principles.${index}`, 'Each Principle needs a lead word and its text.'); return; }
      if (isBlank(principle.name)) add(`principles.${index}.name`, 'Each Principle needs a lead word or phrase.');
      else {
        const key = principle.name.trim().toLowerCase();
        if (seen.has(key)) add(`principles.${index}.name`, `The Principle name ${principle.name.trim()} is used more than once; each must be unique.`);
        seen.add(key);
      }
      if (isBlank(principle.text)) add(`principles.${index}.text`, 'Each Principle needs its text.');
    });
  }
  return issues;
}

/**
 * Validate a bundle and attach its content digest, or throw a single error that names every issue. Used where a
 * validated bundle is required before the renderers, Publisher, or export may proceed (R46.41, R46.42). The thrown
 * error is the refusal: there is never a silent fallback.
 */
export function assertPublicCopy(copy: InstallationPublicCopy | undefined | null): ValidatedInstallationPublicCopy {
  const issues = validatePublicCopy(copy);
  if (issues.length > 0) {
    throw new PublicCopyError(issues);
  }
  const valid = copy as InstallationPublicCopy;
  return { ...valid, digest: publicCopyDigest(valid) };
}

/** The refusal raised when an installation's public copy is missing or incomplete; it lists every unmet rule. */
export class PublicCopyError extends Error {
  readonly issues: readonly PublicCopyIssue[];
  constructor(issues: readonly PublicCopyIssue[]) {
    super(`The installation public copy is not configured completely: ${issues.map((issue) => `${issue.field}: ${issue.rule}`).join('; ')}`);
    this.name = 'PublicCopyError';
    this.issues = issues;
  }
}
