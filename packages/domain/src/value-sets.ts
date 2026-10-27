import { asULID } from './types';
import type { ULID } from './types';
import { cpLength, isBlank } from './text';
import { accepted, refused } from './rules';
import type { RuleResult } from './rules';

export const VALUE_SET_KINDS = ['specialty', 'campaign_status', 'finding_status', 'run_outcome', 'hypothesis_status', 'archival_request_status', 'reliability', 'rights_status', 'relation'] as const;
export type ValueSetKind = typeof VALUE_SET_KINDS[number];
/** Seeds use these fixed IDs. Protection follows identity even when a displayed name changes. */
export const LOCKED_VALUE_IDS = Object.freeze({
  hypothesisOpen: asULID('00000000000000000000000001'),
  hypothesisEliminated: asULID('00000000000000000000000002'),
  archivalSent: asULID('00000000000000000000000003'),
  archivalReplied: asULID('00000000000000000000000004'),
  rightsUnknown: asULID('00000000000000000000000005'),
});
/** Semantic identities stay stable when an Administrator renames a status. Seeds share these IDs. */
export const BUILT_IN_VALUE_IDS = Object.freeze({
  ...LOCKED_VALUE_IDS,
  findingOpen: asULID('00000000000000000000000020'),
  findingConfirmed: asULID('00000000000000000000000021'),
  findingWithdrawn: asULID('00000000000000000000000022'),
  findingSuperseded: asULID('00000000000000000000000023'),
  // Evidence_Links are Cross_Links with this relation label (R5.2, R8.2).
  relationEvidenceFor: asULID('00000000000000000000000024'),
  // The Content_Licence covers only Own_Work Attachments (R29.12).
  rightsOwnWork: asULID('0000000000000000000000P001'),
});
const protectedIds: ReadonlySet<ULID> = new Set(Object.values(LOCKED_VALUE_IDS));
const reservedIds: ReadonlySet<ULID> = new Set(Object.values(BUILT_IN_VALUE_IDS));
export interface ConfigValue {
  readonly id: ULID;
  readonly name: string;
  readonly retired: boolean;
  readonly publicDescription?: string;
  readonly permitsPublication?: boolean;
}
export interface ValueSet { readonly kind: ValueSetKind; readonly values: readonly ConfigValue[]; }
export type ValueSetOperation =
  | { readonly kind: 'add'; readonly value: ConfigValue }
  | { readonly kind: 'rename'; readonly id: ULID; readonly name: string }
  | { readonly kind: 'retire'; readonly id: ULID }
  | { readonly kind: 'mark_publication'; readonly id: ULID; readonly permits: boolean };

export function isMethodsTermSet(kind: ValueSetKind): boolean { return kind !== 'specialty'; }
export function acceptsNewlySet(value: ConfigValue | undefined): boolean { return value !== undefined && !value.retired; }
export function offeredValues(set: ValueSet): readonly ConfigValue[] { return set.values.filter(acceptsNewlySet); }

function nameError(set: ValueSet, name: string, excluding?: ULID): RuleResult<ValueSet> | undefined {
  if (isBlank(name) || cpLength(name) > 50) return refused('name_length', 'name', 'Use a non-blank name of 1 to 50 Unicode code points.');
  if (set.values.some((value) => value.id !== excluding && value.name.toLowerCase() === name.toLowerCase())) return refused('duplicate_name', 'name', 'Names must be unique ignoring letter case, including retired values.');
  return undefined;
}

export function changeValueSet(set: ValueSet, operation: ValueSetOperation): RuleResult<ValueSet> {
  if (operation.kind === 'add') {
    const value = operation.value;
    if (set.values.some((existing) => existing.id === value.id) || reservedIds.has(value.id)) return refused('duplicate_or_reserved_id', 'id', 'Use a new value id; built-in IDs are reserved for seeds.');
    const invalidName = nameError(set, value.name);
    if (invalidName) return invalidName;
    if (value.retired) return refused('new_value_retired', 'retired', 'A new value must be available for selection.');
    if (isMethodsTermSet(set.kind) && (value.publicDescription === undefined || isBlank(value.publicDescription) || cpLength(value.publicDescription) > 500)) return refused('public_description', 'publicDescription', 'A Methods term needs a Public Description of 1 to 500 Unicode code points.');
    if (value.publicDescription !== undefined && (isBlank(value.publicDescription) || cpLength(value.publicDescription) > 500)) return refused('public_description', 'publicDescription', 'Use a Public Description of 1 to 500 Unicode code points.');
    if (set.kind !== 'rights_status' && value.permitsPublication !== undefined) return refused('publication_not_applicable', 'permitsPublication', 'Only Rights Status values carry a publication flag.');
    return accepted({ ...set, values: [...set.values, { ...value, ...(set.kind === 'rights_status' ? { permitsPublication: value.permitsPublication ?? false } : {}) }] });
  }
  const value = set.values.find((entry) => entry.id === operation.id);
  if (!value) return refused('unknown_value', 'id', 'The selected value does not exist in this set.');
  let changed: ConfigValue;
  switch (operation.kind) {
    case 'rename': {
      if (value.id === LOCKED_VALUE_IDS.rightsUnknown && value.name !== operation.name) return refused('locked_name', 'name', 'Unknown cannot be renamed.');
      const invalidName = nameError(set, operation.name, value.id);
      if (invalidName) return invalidName;
      changed = { ...value, name: operation.name };
      break;
    }
    case 'retire':
      if (protectedIds.has(value.id)) return refused('locked_value', 'id', 'This built-in value cannot be retired.');
      if (!value.retired && set.values.filter(acceptsNewlySet).length <= 1) return refused('last_active_value', 'id', 'At least one value must remain available for selection.');
      changed = { ...value, retired: true };
      break;
    case 'mark_publication':
      if (set.kind !== 'rights_status') return refused('publication_not_applicable', 'permitsPublication', 'Only Rights Status values carry a publication flag.');
      if (value.id === LOCKED_VALUE_IDS.rightsUnknown && operation.permits) return refused('unknown_rights', 'permitsPublication', 'Unknown cannot permit publication.');
      changed = { ...value, permitsPublication: operation.permits };
      break;
  }
  return accepted({ ...set, values: set.values.map((entry) => entry.id === value.id ? changed : entry) });
}

export function addValue(set: ValueSet, value: ConfigValue): RuleResult<ValueSet> { return changeValueSet(set, { kind: 'add', value }); }
export function renameValue(set: ValueSet, id: ULID, name: string): RuleResult<ValueSet> { return changeValueSet(set, { kind: 'rename', id, name }); }
export function retireValue(set: ValueSet, id: ULID): RuleResult<ValueSet> { return changeValueSet(set, { kind: 'retire', id }); }
export function markPublication(set: ValueSet, id: ULID, permits: boolean): RuleResult<ValueSet> { return changeValueSet(set, { kind: 'mark_publication', id, permits }); }
