import { z } from 'zod';
import { idSchema, textField } from './schemas/common';
import { fragmentDigest } from './text-fragments';
import { utf8Bytes } from './resource-profile';
import { stableJson } from './history';

/**
 * R56.1, R56.2, R56.6: the bounds of a Compute_Package, which records a Run's exact inputs, code, parameters and outputs. A package is only a
 * description; nothing in it is ever executed or fetched.
 */
export const COMPUTE_LIMITS = Object.freeze({
  artifacts: 1000, configurationBytes: 262_144, configurationChunkUnits: 20_000, configurationDepth: 8, configurationEntries: 5000, configurationKeyCodePoints: 200,
  environment: 200, nameCodePoints: 200, valueCodePoints: 2000, commandCodePoints: 2000, repositoryCodePoints: 500, releaseCodePoints: 200,
  methodVersionCodePoints: 100, uriCodePoints: 2000, versions: 1000,
});
export const COMPUTE_FORMAT = 'researchforce-compute-package';

export const ARTIFACT_ROLES = ['input', 'output', 'checkpoint'] as const;
export type ArtifactRole = typeof ARTIFACT_ROLES[number];
export const ENVIRONMENT_KINDS = ['toolchain', 'hardware', 'os', 'dependency', 'seed'] as const;
export type EnvironmentKind = typeof ENVIRONMENT_KINDS[number];
export const REPRODUCIBILITY_STATES = ['incomplete', 'specified', 'reproduced', 'disputed'] as const;
export type ReproducibilityState = typeof REPRODUCIBILITY_STATES[number];
export const REPRODUCIBILITY_NAMES: Readonly<Record<ReproducibilityState, string>> = Object.freeze({
  incomplete: 'Incomplete', specified: 'Specified', reproduced: 'Reproduced', disputed: 'Disputed',
});

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/u, 'Use 64 lowercase hexadecimal digits.');
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export const artifactSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('attachment'), role: z.enum(ARTIFACT_ROLES), unitId: idSchema, sha256: sha256Hex.optional() }),
  z.strictObject({
    type: z.literal('external'), role: z.enum(ARTIFACT_ROLES), uri: textField(COMPUTE_LIMITS.uriCodePoints, true), name: textField(COMPUTE_LIMITS.nameCodePoints, true).optional(),
    sha256: sha256Hex.optional(), sizeBytes: z.int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  }),
]);
export type ArtifactInput = z.output<typeof artifactSchema>;

export const environmentEntrySchema = z.strictObject({
  kind: z.enum(ENVIRONMENT_KINDS), name: textField(COMPUTE_LIMITS.nameCodePoints, true), value: textField(COMPUTE_LIMITS.valueCodePoints, true),
});
export type EnvironmentEntry = z.output<typeof environmentEntrySchema>;

export const codeSchema = z.strictObject({
  repository: textField(COMPUTE_LIMITS.repositoryCodePoints, true).optional(),
  commit: z.string().regex(COMMIT, 'Use the full 40 or 64 hexadecimal digits of the commit.').optional(),
  release: textField(COMPUTE_LIMITS.releaseCodePoints, true).optional(),
});

/** The description of a package, which is also what its manifest hash covers: nothing about who recorded it, when, or as which version. */
export const manifestSchema = z.strictObject({
  code: codeSchema.default({}),
  command: textField(COMPUTE_LIMITS.commandCodePoints, true).optional(),
  entrypoint: textField(COMPUTE_LIMITS.commandCodePoints, true).optional(),
  methodVersion: textField(COMPUTE_LIMITS.methodVersionCodePoints, true).optional(),
  usesRandomness: z.boolean().default(false),
  configuration: z.unknown().optional(),
  environment: z.array(environmentEntrySchema).max(COMPUTE_LIMITS.environment).default([]),
  artifacts: z.array(artifactSchema).max(COMPUTE_LIMITS.artifacts).default([]),
});
export type ManifestInput = z.output<typeof manifestSchema>;

/** A new version names the Run revision it was written against and the package version it follows, so a stale page cannot overwrite a newer one. */
export const packageInputSchema = manifestSchema.extend({ rev: z.int().min(1), expectedVersion: z.int().min(0) });
export type PackageInput = z.output<typeof packageInputSchema>;

export interface Issue { readonly field: string; readonly rule: string }

const SECRET_KEY = /(?:password|passwd|secret|apikey|privatekey|accesstoken|authtoken|bearertoken|refreshtoken|sessiontoken|apitoken|credential|authorization)/u;
const SECRET_VALUE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bBearer [A-Za-z0-9._~+/=-]{20,}/u;
const SECRET_QUERY = /^(?:token|access_token|auth|key|apikey|api_key|secret|signature|sig|password|x-amz-signature|x-amz-credential|x-goog-signature)$/iu;

/** Secrets stay outside packages (R56.6): a key that names one, a value that looks like one, or a link that carries one is refused. A guard, not a promise to find every secret. */
export function secretIssues(field: string, text: string): Issue[] {
  return SECRET_VALUE.test(text) ? [{ field, rule: 'This looks like a secret or credential. Keep secrets outside the package and name where they are kept instead.' }] : [];
}

/** A reference that is a link carries no credentials in it. Only its shape is checked; the address is never visited (R56.6). */
export function uriIssues(field: string, uri: string): Issue[] {
  const doi = /^doi:10\.\S+$/u.test(uri);
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#\s]+)([^?#\s]*)(?:\?([^#\s]*))?(?:#\S*)?$/u.exec(uri);
  if (!doi && !match) return [{ field, rule: 'Use an absolute address such as https://example.org/data.tar or s3://bucket/key.' }];
  if (match && !/^(?:https?|s3|gs|git|ssh|ipfs)$/u.test(match[1]!)) return [{ field, rule: 'Use an https, http, s3, gs, git, ssh, ipfs or doi address.' }];
  const userinfo = match === null ? '' : match[2]!.includes('@') ? match[2]!.slice(0, match[2]!.lastIndexOf('@')) : '';
  if (userinfo.includes(':')) return [{ field, rule: 'The address carries a password. Keep credentials outside the package.' }];
  for (const pair of (match?.[4] ?? '').split('&')) {
    const key = pair.split('=')[0]!;
    if (key !== '' && SECRET_QUERY.test(key)) return [{ field, rule: `The address carries “${key}”, which looks like a credential. Keep credentials outside the package.` }];
  }
  return secretIssues(field, uri);
}

/**
 * The structured configuration is stored exactly as given (R56.1). JSON numbers are accepted only as safe integers: a decimal or a very large
 * integer would already have been rounded on its way in, so it is written as text, which keeps every digit.
 */
export function configurationIssues(value: unknown): Issue[] {
  const issues: Issue[] = [];
  let entries = 0;
  const walk = (node: unknown, path: string, depth: number): void => {
    if (issues.length >= 20) return;
    entries += 1;
    if (entries > COMPUTE_LIMITS.configurationEntries) { issues.push({ field: 'configuration', rule: `A configuration has at most ${COMPUTE_LIMITS.configurationEntries} entries.` }); return; }
    if (depth > COMPUTE_LIMITS.configurationDepth) { issues.push({ field: path, rule: `A configuration nests at most ${COMPUTE_LIMITS.configurationDepth} levels.` }); return; }
    if (node === null || typeof node === 'boolean') return;
    if (typeof node === 'string') { issues.push(...secretIssues(path, node)); return; }
    if (typeof node === 'number') {
      if (!Number.isSafeInteger(node) || Object.is(node, -0)) issues.push({ field: path, rule: 'Write a number that is not a whole number, or is larger than 9007199254740991, as text so that every digit is kept.' });
      return;
    }
    if (Array.isArray(node)) { node.forEach((entry, index) => walk(entry, `${path}.${index}`, depth + 1)); return; }
    if (typeof node === 'object') {
      for (const [key, entry] of Object.entries(node)) {
        if ([...key].length === 0 || [...key].length > COMPUTE_LIMITS.configurationKeyCodePoints) { issues.push({ field: path, rule: `A key has 1 to ${COMPUTE_LIMITS.configurationKeyCodePoints} characters.` }); continue; }
        if (SECRET_KEY.test(key.toLowerCase().replace(/[^a-z0-9]/gu, ''))) issues.push({ field: `${path}.${key}`, rule: 'This key names a secret. Keep secrets outside the package and name where they are kept instead.' });
        walk(entry, `${path}.${key}`, depth + 1);
      }
      return;
    }
    issues.push({ field: path, rule: 'A configuration holds only text, whole numbers, true or false, null, lists and objects.' });
  };
  walk(value, 'configuration', 1);
  if (issues.length === 0 && utf8Bytes(stableJson(value)) > COMPUTE_LIMITS.configurationBytes) issues.push({ field: 'configuration', rule: `A configuration is at most ${COMPUTE_LIMITS.configurationBytes} bytes.` });
  return issues;
}

/** Everything else a package says that could hold a secret or a bad link. */
export function manifestIssues(manifest: ManifestInput): Issue[] {
  const issues: Issue[] = [];
  const { code } = manifest;
  if (code.repository !== undefined) {
    issues.push(...uriIssues('code.repository', code.repository));
  }
  if (manifest.command !== undefined) issues.push(...secretIssues('command', manifest.command));
  if (manifest.entrypoint !== undefined) issues.push(...secretIssues('entrypoint', manifest.entrypoint));
  manifest.environment.forEach((entry, index) => issues.push(...secretIssues(`environment.${index}.value`, entry.value)));
  const seen = new Set<string>();
  manifest.artifacts.forEach((artifact, index) => {
    if (artifact.type === 'external') issues.push(...uriIssues(`artifacts.${index}.uri`, artifact.uri));
    const key = `${artifact.role}|${artifact.type === 'attachment' ? artifact.unitId : artifact.uri}`;
    if (seen.has(key)) issues.push({ field: `artifacts.${index}`, rule: 'Name each artifact once for each role.' });
    seen.add(key);
  });
  if (manifest.configuration !== undefined) issues.push(...configurationIssues(manifest.configuration));
  return issues;
}

/** The canonical configuration split so that no row is larger than a fragment and no surrogate pair is cut (R56.1). */
export function configurationChunks(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + COMPUTE_LIMITS.configurationChunkUnits);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

/** The manifest as it is hashed and exported: only what the package says, in a fixed shape. */
export interface StoredArtifact {
  readonly role: ArtifactRole; readonly type: 'attachment' | 'external'; readonly unitId?: string; readonly uri?: string; readonly name?: string; readonly sha256?: string; readonly sizeBytes?: number;
}
export interface Manifest {
  readonly code: { readonly repository?: string; readonly commit?: string; readonly release?: string };
  readonly command?: string; readonly entrypoint?: string; readonly methodVersion?: string; readonly usesRandomness: boolean; readonly configuration?: unknown;
  readonly environment: readonly EnvironmentEntry[]; readonly artifacts: readonly StoredArtifact[];
}
/** The identity of a package version: the same description always has the same hash, whoever recorded it and whenever (R56.1, R56.6). */
export const manifestHash = (manifest: Manifest): string => fragmentDigest({ format: COMPUTE_FORMAT, version: 1, manifest });

export interface Ingredient { readonly ingredient: MissingIngredient; readonly position?: number }
export const MISSING_INGREDIENTS = ['code_identity', 'command', 'inputs', 'outputs', 'toolchain', 'hardware', 'method_version', 'seeds'] as const;
export type MissingIngredient = typeof MISSING_INGREDIENTS[number];
export const INGREDIENT_NAMES: Readonly<Record<MissingIngredient, string>> = Object.freeze({
  code_identity: 'The code repository and the exact commit or release', command: 'The command or entrypoint', inputs: 'At least one input', outputs: 'At least one output',
  toolchain: 'The toolchain', hardware: 'The hardware', method_version: 'The method version', seeds: 'The random seeds, since randomness is used',
});

/**
 * What a package still lacks to be repeated, listed by name; a tool version string never makes up for any of it (R56.2). Held bytes do not
 * change this list: whether an artifact is held and verified is reported beside it, per artifact.
 */
export function missingIngredients(manifest: Manifest): MissingIngredient[] {
  const missing: MissingIngredient[] = [];
  if (manifest.code.repository === undefined || (manifest.code.commit === undefined && manifest.code.release === undefined)) missing.push('code_identity');
  if (manifest.command === undefined && manifest.entrypoint === undefined) missing.push('command');
  if (!manifest.artifacts.some((artifact) => artifact.role === 'input')) missing.push('inputs');
  if (!manifest.artifacts.some((artifact) => artifact.role === 'output')) missing.push('outputs');
  if (!manifest.environment.some((entry) => entry.kind === 'toolchain')) missing.push('toolchain');
  if (!manifest.environment.some((entry) => entry.kind === 'hardware')) missing.push('hardware');
  if (manifest.methodVersion === undefined) missing.push('method_version');
  if (manifest.usesRandomness && !manifest.environment.some((entry) => entry.kind === 'seed')) missing.push('seeds');
  return missing;
}

/**
 * The reproducibility state of a package. Without independent attempts it is Incomplete or Specified; an attempt that reproduced it makes it
 * Reproduced, and any attempt that disputes it makes it Disputed (R56.2, R56.5).
 */
export function reproducibilityState(missing: readonly unknown[], attempts: { readonly reproduced: number; readonly disputed: number } = { reproduced: 0, disputed: 0 }): ReproducibilityState {
  if (missing.length > 0) return 'incomplete';
  if (attempts.disputed > 0) return 'disputed';
  return attempts.reproduced > 0 ? 'reproduced' : 'specified';
}
