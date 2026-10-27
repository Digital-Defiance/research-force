import { partialDate } from '@researchforce/domain/dates';
import type { RichText } from '@researchforce/domain/richtext';
import type { CreditEntry, Timestamp, ULID } from '@researchforce/domain/types';
import { BUILT_IN_VALUE_IDS } from '@researchforce/domain/value-sets';
import type { ProjectRecord, ProjectionInput, ResearchItemRecord, UnitRecord } from '../src/input';

export const LICENCE = 'Synthetic Content Licence 1.0';
export const at = (day: number): Timestamp => `2026-02-${String(day).padStart(2, '0')}T12:00:00.000Z` as Timestamp;
export const rich = (text: string): RichText => ({ text, spans: [] });
export const RESTRICTED = 'value-restricted';

export const project: ProjectRecord = { id: 'project-1', name: 'Synthetic project', description: 'About the work', slug: 'synthetic', level: 'public' };

type Unit<T extends UnitRecord['type']> = Extract<UnitRecord, { type: T }>;
/** Fixture ids are readable names rather than ULIDs; the kernel treats them as opaque. */
export const id = (value: string): ULID => value as ULID;
const credit: readonly CreditEntry[] = [{ member: id('member-1') }];
const base = { position: 0, ownerId: 'member-1', credit, createdAt: at(1), level: 'public', unclassified: false } as const;

export function item(id: string, record: Partial<ResearchItemRecord> & Pick<ResearchItemRecord, 'kind'>, unit: Partial<Unit<'research_item'>> = {}): Unit<'research_item'> {
  const defaults = record.kind === 'finding' ? { statusValueId: BUILT_IN_VALUE_IDS.findingOpen, claim: rich('The claim'), scopeCaveat: rich('Within limits') } : {};
  return {
    ...base, id, type: 'research_item', ...unit,
    item: { projectId: project.id, identifier: `RI-${id}`, title: `Title ${id}`, presentation: 'full_content', ...defaults, ...record } as ResearchItemRecord,
  } as Unit<'research_item'>;
}
export function attachment(id: string, parentId: string, record: Partial<Unit<'attachment'>['attachment']> = {}, unit: Partial<Unit<'attachment'>> = {}): Unit<'attachment'> {
  return {
    ...base, id, parentId, type: 'attachment', ...unit,
    attachment: { identifier: `AT-${id}`, title: `File ${id}`, fileKind: 'pdf', sizeBytes: 2048, origin: 'Scanned', uploadedAt: at(3), rightsStatusId: BUILT_IN_VALUE_IDS.rightsOwnWork, ...record },
  };
}
export function section(id: string, parentId: string, text: string, unit: Partial<Unit<'entry_section'>> = {}): Unit<'entry_section'> {
  return { ...base, id, parentId, type: 'entry_section', text: rich(text), ...unit };
}
export function dissent(id: string, parentId: string, text: string, unit: Partial<Unit<'dissent_note'>> = {}): Unit<'dissent_note'> {
  return { ...base, id, parentId, type: 'dissent_note', text: rich(text), authorId: 'member-2', attachedAt: at(4), lastSavedAt: at(5), concernedSummary: rich('Log summary'), ...unit };
}

export const LINE = { kindOfMaterial: 'letters', date: partialDate('1944-02'), partyIds: [] };

export function state(units: readonly UnitRecord[], extra: Partial<ProjectionInput> = {}): ProjectionInput {
  return {
    now: at(20), projects: [project], units,
    members: [
      { id: 'member-1', displayName: 'Ada Example', email: 'ada@example.test', status: 'active', publicProfile: true, licenceName: LICENCE },
      { id: 'member-2', displayName: 'Ben Example', email: 'Ben@Example.test', status: 'active', publicProfile: false },
    ],
    parties: [
      { id: 'party-1', name: 'Hidden Person', doNotName: true, genericLabel: 'a private correspondent' },
      { id: 'party-2', name: 'Open Archive', doNotName: false },
    ],
    values: [
      { id: BUILT_IN_VALUE_IDS.findingOpen, name: 'Open' }, { id: BUILT_IN_VALUE_IDS.findingSuperseded, name: 'Superseded' },
      { id: BUILT_IN_VALUE_IDS.rightsOwnWork, name: 'Own work', permitsPublication: true },
      { id: RESTRICTED, name: 'Restricted', permitsPublication: false },
    ],
    links: [],
    ...extra,
  };
}
