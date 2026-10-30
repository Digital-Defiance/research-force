import type { ArtifactRole, EnvironmentKind, ReproducibilityState } from '@researchforce/domain/compute';
import type { CoverageState } from '@researchforce/domain/coverage';

export interface ArtifactRow {
  readonly role: ArtifactRole; readonly type: 'attachment' | 'external'; readonly unitId?: string; readonly identifier?: string; readonly title?: string; readonly uri?: string; readonly name?: string;
  readonly sha256?: string; readonly sizeBytes?: number; readonly held: boolean; readonly verified: boolean;
}
export interface Manifest {
  readonly code: { readonly repository?: string; readonly commit?: string; readonly release?: string };
  readonly command?: string; readonly entrypoint?: string; readonly methodVersion?: string; readonly usesRandomness: boolean; readonly configuration?: unknown;
  readonly environment: readonly { readonly kind: EnvironmentKind; readonly name: string; readonly value: string }[];
  readonly artifacts: readonly { readonly role: ArtifactRole; readonly type: 'attachment' | 'external'; readonly unitId?: string; readonly uri?: string; readonly name?: string; readonly sha256?: string }[];
}
export interface PackageView {
  readonly runId: string; readonly version: number; readonly latest: boolean; readonly manifestHash: string; readonly state: ReproducibilityState; readonly stateName: string;
  readonly createdByName: string | null; readonly createdAt: string; readonly manifest: Manifest; readonly artifacts: readonly ArtifactRow[];
  readonly missing: readonly { readonly ingredient: string; readonly name: string }[]; readonly held: number; readonly unverified: number; readonly hashVerifiable: boolean;
  readonly configurationIntact: boolean; readonly versions: readonly { readonly version: number; readonly state: ReproducibilityState; readonly createdAt: string }[];
}
export interface PackageCheck { readonly valid: true; readonly manifestHash: string; readonly stateName: string; readonly missing: readonly { readonly name: string }[] }

export const STATE_MEANING: Readonly<Record<ReproducibilityState, string>> = {
  incomplete: 'Something needed to repeat this Run is still missing.',
  specified: 'Everything needed to repeat this Run is described. No one has yet repeated it independently.',
  reproduced: 'An independent attempt repeated this Run.',
  disputed: 'An independent attempt did not repeat this Run.',
};

/** What the archive can say about one artifact. An external reference is never described as verified (R56.1). */
export function artifactStatus(row: Pick<ArtifactRow, 'type' | 'held' | 'verified'>): string {
  if (row.type === 'external') return 'External reference; the archive does not hold it and has not verified it';
  if (!row.held) return 'Held by the archive, but no longer readable by you';
  return row.verified ? 'Held by the archive; its hash matches the one recorded' : 'Held by the archive; the file has changed since it was recorded';
}

export interface PackageDraft {
  repository: string; commit: string; release: string; command: string; entrypoint: string; methodVersion: string; usesRandomness: boolean; configuration: string;
  environment: { kind: EnvironmentKind; name: string; value: string }[];
  artifacts: { role: ArtifactRole; type: 'attachment' | 'external'; unitId: string; uri: string; name: string; sha256: string }[];
}
export const EMPTY_PACKAGE: PackageDraft = { repository: '', commit: '', release: '', command: '', entrypoint: '', methodVersion: '', usesRandomness: false, configuration: '', environment: [], artifacts: [] };

/** The next version starts from the newest one, so only what changed has to be written again. */
export function draftOf(view: PackageView | undefined): PackageDraft {
  if (view === undefined) return { ...EMPTY_PACKAGE, environment: [], artifacts: [] };
  const { manifest } = view;
  return {
    repository: manifest.code.repository ?? '', commit: manifest.code.commit ?? '', release: manifest.code.release ?? '', command: manifest.command ?? '', entrypoint: manifest.entrypoint ?? '',
    methodVersion: manifest.methodVersion ?? '', usesRandomness: manifest.usesRandomness, configuration: manifest.configuration === undefined ? '' : JSON.stringify(manifest.configuration, null, 2),
    environment: manifest.environment.map((entry) => ({ ...entry })),
    artifacts: manifest.artifacts.map((artifact) => ({ role: artifact.role, type: artifact.type, unitId: artifact.unitId ?? '', uri: artifact.uri ?? '', name: artifact.name ?? '', sha256: artifact.sha256 ?? '' })),
  };
}

const present = (value: string): string | undefined => (value.trim() === '' ? undefined : value.trim());

/** The request for a draft, or the reason it cannot be sent. Nothing is left out silently: a configuration that is not JSON is refused here, not dropped. */
export function packageBody(draft: PackageDraft, rev: unknown, expectedVersion: number): { readonly body: Record<string, unknown> } | { readonly error: string } {
  let configuration: unknown;
  if (draft.configuration.trim() !== '') {
    try { configuration = JSON.parse(draft.configuration); } catch { return { error: 'The configuration is not valid JSON.' }; }
  }
  const code = Object.fromEntries(([['repository', draft.repository], ['commit', draft.commit], ['release', draft.release]] as const).flatMap(([key, value]) => (present(value) === undefined ? [] : [[key, present(value)]])));
  const optional = Object.fromEntries(([['command', draft.command], ['entrypoint', draft.entrypoint], ['methodVersion', draft.methodVersion]] as const).flatMap(([key, value]) => (present(value) === undefined ? [] : [[key, present(value)]])));
  return {
    body: {
      rev, expectedVersion, code, ...optional, usesRandomness: draft.usesRandomness, ...(configuration === undefined ? {} : { configuration }),
      environment: draft.environment.filter((entry) => entry.name.trim() !== '' || entry.value.trim() !== '').map((entry) => ({ kind: entry.kind, name: entry.name.trim(), value: entry.value.trim() })),
      artifacts: draft.artifacts.filter((artifact) => (artifact.type === 'attachment' ? artifact.unitId.trim() !== '' : artifact.uri.trim() !== '')).map((artifact) => (artifact.type === 'attachment'
        ? { type: 'attachment', role: artifact.role, unitId: artifact.unitId.trim(), ...(present(artifact.sha256) === undefined ? {} : { sha256: present(artifact.sha256) }) }
        : { type: 'external', role: artifact.role, uri: artifact.uri.trim(), ...(present(artifact.name) === undefined ? {} : { name: present(artifact.name) }), ...(present(artifact.sha256) === undefined ? {} : { sha256: present(artifact.sha256) }) })),
    },
  };
}

export interface ScopeEntry { readonly state: CoverageState; readonly stateName: string; readonly region: Readonly<Record<string, unknown>> }
export interface ScopeView {
  readonly id: string; readonly runId: string; readonly runIdentifier: string; readonly runTitle: string; readonly packageVersion: number; readonly manifestHash: string; readonly comparable: boolean;
  readonly label: string | null; readonly schema: { readonly id: string; readonly name: string; readonly version: number } | null; readonly text: string | null; readonly assumptions: readonly string[];
  readonly entries: readonly ScopeEntry[]; readonly counts: Readonly<Partial<Record<CoverageState, string>>> | null; readonly universe: string | null;
  readonly elimination: { readonly counts: boolean; readonly reasons: readonly string[] }; readonly createdAt: string; readonly current: boolean;
}
export interface SchemaDimension { readonly kind: 'integer' | 'set'; readonly name: string; readonly min?: string; readonly max?: string; readonly members?: readonly string[] }
export interface SchemaView { readonly id: string; readonly name: string; readonly version: number; readonly description: string | null; readonly dimensions: readonly SchemaDimension[] }
export const REASON_NAMES: Readonly<Record<string, string>> = {
  run_not_finished: 'The Run is not Complete or a Clean negative.',
  package_incomplete: 'The package still lacks something needed to repeat the Run.',
  package_disputed: 'An independent attempt did not reproduce the package.',
  outputs_unverified: 'The outputs are not all held by the archive with the hashes recorded.',
};
export const STATE_ORDER: readonly CoverageState[] = ['completed', 'attempted', 'excluded', 'unknown'];

/** "0-99, 200" as ranges of whole numbers; anything else is a mistake to show, never a guess. */
export function parseRanges(text: string): { readonly ranges: { from: string; to: string }[] } | { readonly error: string } {
  const ranges: { from: string; to: string }[] = [];
  for (const token of text.split(',').map((part) => part.trim()).filter((part) => part !== '')) {
    const match = /^([0-9]+)(?:\s*-\s*([0-9]+))?$/u.exec(token);
    if (match === null) return { error: `“${token}” is not a whole number or a range such as 0-99.` };
    ranges.push({ from: match[1]!, to: match[2] ?? match[1]! });
  }
  return ranges.length === 0 ? { error: 'Give at least one range.' } : { ranges };
}

export interface ReproductionView {
  readonly id: string; readonly attemptRunId: string; readonly attemptRunIdentifier: string; readonly packageVersion: number; readonly outcome: string; readonly outcomeName: string;
  readonly differences: readonly { readonly kind: string; readonly name: string; readonly original: string; readonly attempt: string }[];
  readonly evidence: readonly string[]; readonly note: string | null; readonly recordedByName: string | null; readonly recordedAt: string;
}
export const DIFFERENCE_KINDS = ['environment', 'configuration', 'code', 'data', 'hardware', 'other'] as const;

export interface CoverageView {
  readonly universe: string; readonly eliminated: string; readonly fullElimination: boolean; readonly truncated: boolean;
  readonly contributions: readonly { readonly scopeId: string; readonly runId: string; readonly runIdentifier: string; readonly runTitle: string; readonly counted: boolean; readonly reasons: readonly string[]; readonly completed: string }[];
  readonly incomparable: readonly { readonly runId: string; readonly runIdentifier: string; readonly runTitle: string; readonly reason: 'generic_text' | 'other_schema_version' }[];
}
