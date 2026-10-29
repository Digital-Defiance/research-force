import { asULID } from '@researchforce/domain/types';
import type { ULID } from '@researchforce/domain/types';
import { BUILT_IN_VALUE_IDS, LOCKED_VALUE_IDS } from '@researchforce/domain/value-sets';
import type { ValueSetKind } from '@researchforce/domain/value-sets';
import { VALUE_DESCRIPTIONS } from './methods-descriptions';

export interface SeedValue {
  readonly id: ULID;
  readonly setKey: ValueSetKind;
  readonly name: string;
  readonly position: number;
  readonly locked: boolean;
  readonly permitsPublication: boolean | null;
  readonly publicDescription: string | null;
}

/** Fixed IDs for seeded values without a semantic role in code; a set letter and a number keep them readable. */
const seedId = (letter: string, number: number): ULID => asULID(`0000000000000000000000${letter}${String(number).padStart(3, '0')}`);
const ids = BUILT_IN_VALUE_IDS;
const locked: ReadonlySet<ULID> = new Set(Object.values(LOCKED_VALUE_IDS));
const PUBLISHABLE_RIGHTS = new Set(['Own work', 'Public domain', 'Licensed', 'Permission granted']);

/** Initial values in display order. Multi-word glossary values are shown in sentence case; Campaign_Statuses keep the journal’s spelling. */
const INITIAL: Readonly<Record<ValueSetKind, readonly (readonly [ULID, string])[]>> = {
  specialty: [[seedId('S', 1), 'Historian'], [seedId('S', 2), 'Archival research'], [seedId('S', 3), 'Cryptanalysis'], [seedId('S', 4), 'Computer science'], [seedId('S', 5), 'Computer engineering']],
  campaign_status: ['COMPLETE', 'SUSPENDED', 'PARTIAL', 'STOPPED', 'OPEN', 'ELIMINATED', 'CLEAN_NEGATIVE'].map((name, index) => [seedId('C', index + 1), name] as const),
  finding_status: [[ids.findingConfirmed, 'Confirmed'], [ids.findingOpen, 'Open'], [ids.findingWithdrawn, 'Withdrawn'], [ids.findingSuperseded, 'Superseded']],
  run_outcome: ['In progress', 'Complete', 'Clean negative', 'Partial', 'Suspended', 'Stopped'].map((name, index) => [seedId('R', index + 1), name] as const),
  hypothesis_status: [[ids.hypothesisOpen, 'Open'], [ids.hypothesisEliminated, 'Eliminated']],
  archival_request_status: [[seedId('A', 1), 'Planned'], [ids.archivalSent, 'Sent'], [ids.archivalReplied, 'Replied'], [seedId('A', 2), 'Closed']],
  reliability: ['High', 'Medium', 'Low', 'Unknown'].map((name, index) => [seedId('Q', index + 1), name] as const),
  rights_status: [[ids.rightsOwnWork, 'Own work'], [seedId('P', 2), 'Public domain'], [seedId('P', 3), 'Licensed'], [seedId('P', 4), 'Permission granted'], [ids.rightsUnknown, 'Unknown'], [seedId('P', 5), 'Restricted']],
  relation: [[ids.relationEvidenceFor, 'Evidence for'], [seedId('X', 1), 'Based on'], [seedId('X', 2), 'Produced by'], [seedId('X', 3), 'Discusses'], [seedId('X', 4), 'Related']],
};

export const SEED_VALUES: readonly SeedValue[] = Object.freeze(Object.entries(INITIAL).flatMap(([setKey, values]) => values.map(([id, name], position): SeedValue => {
  const descriptions = setKey === 'specialty' ? undefined : (VALUE_DESCRIPTIONS as Readonly<Record<string, Readonly<Record<string, string>>>>)[setKey];
  const publicDescription = descriptions?.[name];
  if (descriptions && publicDescription === undefined) throw new Error(`Missing Public_Description for ${setKey} ${name}.`);
  return Object.freeze({
    id, setKey: setKey as ValueSetKind, name, position, locked: locked.has(id),
    permitsPublication: setKey === 'rights_status' ? PUBLISHABLE_RIGHTS.has(name) : null,
    publicDescription: publicDescription ?? null,
  });
})));
