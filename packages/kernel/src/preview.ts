import type { RichText } from '@researchforce/domain/richtext';
import { validate } from '@researchforce/domain/schemas/common';
import { disclosureLineSchema } from '@researchforce/domain/schemas/other';
import type { DisclosureLine, Level, PublicPresentation, ULID } from '@researchforce/domain/types';
import type { ProjectRecord, ProjectionInput, UnitRecord } from './input';
import { projectDetailed } from './project';
import type { Projection } from './project';
import type { EmailMark } from './substitute';
import { canonicalJson, projectKey, unitKey } from './views';
import type { PublicView, UnitKey } from './views';

/** One unit's or Project's requested disclosure values; `null` clears a Public_Summary or Disclosure_Line. */
export interface UnitChange {
  readonly key: UnitKey;
  readonly level?: Level;
  readonly presentation?: PublicPresentation;
  readonly publicSummary?: RichText | null;
  readonly disclosureLine?: DisclosureLine | null;
}
export interface ChangeSet {
  readonly units?: readonly UnitChange[];
  readonly moves?: readonly { readonly itemId: string; readonly projectId: string }[];
  /** External_Parties whose Do_Not_Name flag is turned off (R34.9). */
  readonly doNotNameOff?: readonly string[];
}
export const MAX_CHANGE_UNITS = 1000;

function withLine<T extends { readonly disclosureLine?: DisclosureLine }>(record: T, line: DisclosureLine | null | undefined): T {
  if (line === undefined) return record;
  const { disclosureLine: _previous, ...rest } = record;
  return (line === null ? rest : { ...rest, disclosureLine: line }) as T;
}

/** The state after the change; setting a level marks exactly the selected units Classified (R26.6). */
export function applyChange(input: ProjectionInput, change: ChangeSet): ProjectionInput {
  const byKey = new Map((change.units ?? []).map((entry) => [entry.key, entry]));
  const moves = new Map((change.moves ?? []).map((move) => [move.itemId, move.projectId]));
  const unnamedOff = new Set(change.doNotNameOff ?? []);
  const projects = input.projects.map((project): ProjectRecord => {
    const entry = byKey.get(projectKey(project.id));
    return entry ? withLine({ ...project, ...(entry.level ? { level: entry.level } : {}) }, entry.disclosureLine) : project;
  });
  const units = input.units.map((unit): UnitRecord => {
    const entry = byKey.get(unitKey(unit.id));
    const projectId = moves.get(unit.id);
    let next: UnitRecord = unit;
    if (unit.type === 'research_item' && (projectId !== undefined || entry?.presentation !== undefined || entry?.publicSummary !== undefined)) {
      let item = { ...unit.item, ...(projectId === undefined ? {} : { projectId }), ...(entry?.presentation ? { presentation: entry.presentation } : {}) };
      if (entry?.publicSummary === null) { const { publicSummary: _previous, ...rest } = item; item = rest as typeof item; }
      else if (entry?.publicSummary) item = { ...item, publicSummary: entry.publicSummary };
      next = { ...unit, item };
    }
    if (!entry) return next;
    return withLine({ ...next, ...(entry.level ? { level: entry.level, unclassified: false } : {}) }, entry.disclosureLine);
  });
  const parties = input.parties.map((party) => (unnamedOff.has(party.id) ? { ...party, doNotName: false } : party));
  return { ...input, projects, units, parties };
}

/** Party labels shown anywhere in a view: Party fields and the Party labels of Disclosure_Lines, including those of linked units. */
export function partyNamesIn(view: PublicView): string[] {
  const names: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (typeof value !== 'object' || value === null) return;
    const record = value as Record<string, unknown>;
    if (record['t'] === 'parties' && Array.isArray(record['value'])) names.push(...(record['value'] as string[]));
    else if (typeof record['kindOfMaterial'] === 'string' && Array.isArray(record['parties'])) names.push(...(record['parties'] as string[]));
    else Object.values(record).forEach(walk);
  };
  walk(view);
  return names;
}

export interface ChangedView {
  readonly key: UnitKey;
  readonly before?: PublicView;
  /** Absent when the unit will leave no trace on the Public_Site. */
  readonly after?: PublicView;
  readonly emailMarks: readonly EmailMark[];
}
export interface DissentListing {
  readonly itemKey: UnitKey;
  /** Empty states that no such Dissent_Note exists (R23.16). */
  readonly notes: readonly { readonly key: UnitKey; readonly authorId: string; readonly author: string; readonly text: RichText; readonly effective: Level }[];
}
export interface LicenceState { readonly memberId: string; readonly displayName: string; readonly agreed: boolean; }
export interface PreviewDiff {
  readonly changed: readonly ChangedView[];
  readonly partyNames: readonly string[];
  readonly dissent: readonly DissentListing[];
  readonly licences: readonly LicenceState[];
}

const idOf = (key: UnitKey): string => key.slice(2);

/** Members credited with the work a unit's view presents: its Credit (an Entry_Section's Journal_Entry's), or a Dissent_Note's author (R46.16). */
function creditedMembers(unit: UnitRecord, units: ReadonlyMap<string, UnitRecord>): string[] {
  if (unit.type === 'dissent_note') return [unit.authorId];
  const credited = unit.type === 'entry_section' && unit.parentId !== undefined ? units.get(unit.parentId) ?? unit : unit;
  return credited.credit.flatMap((entry) => ('member' in entry ? [entry.member] : []));
}

interface Compared { readonly before: Projection; readonly after: Projection; readonly changed: readonly ChangedView[]; }
function compare(before: ProjectionInput, after: ProjectionInput): Compared {
  const projectedBefore = projectDetailed(before);
  const projectedAfter = projectDetailed(after);
  const keys = [...new Set([...projectedAfter.views.keys(), ...projectedBefore.views.keys()])];
  const changed = keys.flatMap((key): ChangedView[] => {
    const previous = projectedBefore.views.get(key);
    const next = projectedAfter.views.get(key);
    if (previous !== undefined && next !== undefined && canonicalJson(previous) === canonicalJson(next)) return [];
    return [{ key, ...(previous ? { before: previous } : {}), ...(next ? { after: next } : {}), emailMarks: projectedAfter.emailMarks.get(key) ?? [] }];
  });
  return { before: projectedBefore, after: projectedAfter, changed };
}

function describe(compared: Compared, after: ProjectionInput, contentLicence: string): PreviewDiff {
  const units = new Map(after.units.map((unit) => [unit.id, unit]));
  const members = new Map(after.members.map((member) => [member.id, member]));
  const partyNames = [...new Set(compared.changed.flatMap((entry) => (entry.after ? partyNamesIn(entry.after) : [])))].sort();
  const dissent = compared.changed.flatMap((entry): DissentListing[] => {
    const view = entry.after;
    if (view?.tag !== 'research_item' || (view.publicSummary === undefined && view.full?.logSummary === undefined)) return [];
    const notes = after.units
      .filter((unit): unit is Extract<UnitRecord, { type: 'dissent_note' }> => unit.type === 'dissent_note' && unit.parentId === idOf(entry.key) && !unit.withdrawal)
      .map((note) => ({ note, effective: compared.after.levels.get(unitKey(note.id)) ?? 'private' }))
      .filter(({ effective }) => effective !== 'public')
      .sort((a, b) => (a.note.attachedAt < b.note.attachedAt ? -1 : a.note.attachedAt > b.note.attachedAt ? 1 : 0))
      .map(({ note, effective }) => ({ key: unitKey(note.id), authorId: note.authorId, author: members.get(note.authorId)?.displayName ?? '', text: note.text, effective }));
    return [{ itemKey: entry.key, notes }];
  });
  const credited = new Set(compared.changed.flatMap((entry) => {
    const unit = entry.after && entry.after.tag !== 'withheld' && entry.after.tag !== 'project' ? units.get(idOf(entry.key)) : undefined;
    return unit ? creditedMembers(unit, units) : [];
  }));
  const licences = [...credited].sort().flatMap((id): LicenceState[] => {
    const member = members.get(id);
    return member ? [{ memberId: id, displayName: member.displayName, agreed: member.licenceName === contentLicence }] : [];
  });
  return { changed: compared.changed, partyNames, dissent, licences };
}

/** Exactly the units whose Public_View differs, with the Party names, Dissent_Notes, and Licence_Agreements the preview shows (R23.6, R23.16, R34.9, R46.16). */
export function diffViews(before: ProjectionInput, after: ProjectionInput, options: { readonly contentLicence: string }): PreviewDiff {
  return describe(compare(before, after), after, options.contentLicence);
}

export type GateReason = 'unit_limit' | 'unknown_unit' | 'rights' | 'consent' | 'licence' | 'requester_licence' | 'disclosure_line';
export interface GateFailure {
  readonly key?: UnitKey;
  readonly reason: GateReason;
  readonly message: string;
  readonly offerWithheld: boolean;
  /** The Member without a Licence_Agreement for the current Content_Licence. */
  readonly memberId?: string;
  readonly details?: readonly string[];
}
export interface GateState {
  readonly input: ProjectionInput;
  readonly requesterId: string;
  readonly contentLicence: string;
}

function gates(change: ChangeSet, state: GateState, after: ProjectionInput, compared: Compared): GateFailure[] {
  const failures: GateFailure[] = [];
  const entries = change.units ?? [];
  const beforeUnits = new Map(state.input.units.map((unit) => [unit.id, unit]));
  const afterUnits = new Map(after.units.map((unit) => [unit.id, unit]));
  const afterProjects = new Map(after.projects.map((project) => [project.id, project]));
  const members = new Map(after.members.map((member) => [member.id, member]));
  const values = new Map(after.values.map((value) => [value.id, value]));
  const parties = new Map(after.parties.map((party) => [party.id, party]));
  const agreed = (id: string): boolean => members.get(id)?.licenceName === state.contentLicence;
  const lineContext = {
    now: after.now, valueSets: {}, roleIds: [], projects: [],
    members: after.members.map((member) => ({ id: member.id as ULID, status: member.status })),
    externalPartyIds: after.parties.map((party) => party.id as ULID),
  };

  const keys = new Set(entries.map((entry) => entry.key));
  if (keys.size > MAX_CHANGE_UNITS) failures.push({ reason: 'unit_limit', message: `A change can include at most ${MAX_CHANGE_UNITS} units; this one has ${keys.size}.`, offerWithheld: false });

  for (const entry of entries) {
    const id = idOf(entry.key);
    const record = entry.key.startsWith('p:') ? afterProjects.get(id) : entry.key.startsWith('u:') ? afterUnits.get(id) : undefined;
    if (!record) {
      failures.push({ key: entry.key, reason: 'unknown_unit', message: 'The change names a unit that does not exist.', offerWithheld: false });
      continue;
    }
    const unit = 'type' in record ? record : undefined;
    if (entry.level === 'public' && unit?.type === 'attachment') {
      const rights = values.get(unit.attachment.rightsStatusId);
      if (rights?.permitsPublication !== true) failures.push({ key: entry.key, reason: 'rights', message: `The Rights_Status ${rights?.name ?? 'of this Attachment'} does not permit publication.`, offerWithheld: true, details: [rights?.name ?? ''] });
    }
    if (entry.level === 'public' && unit?.type === 'research_item' && unit.item.kind === 'correspondence') {
      const missing = unit.item.parties.filter((party) => party.kind === 'external' && party.consent !== 'granted');
      if (missing.length) failures.push({
        key: entry.key, reason: 'consent', message: 'Every External_Party must have Granted consent before a Correspondence becomes Public.',
        offerWithheld: beforeUnits.get(id)?.level === 'private',
        details: missing.map((party) => `${parties.get(party.id)?.name ?? party.id}: ${party.consent ?? 'not_asked'}`),
      });
    }
    const lineRequired = record.level === 'withheld' && (entry.level === 'withheld' || entry.disclosureLine !== undefined);
    if (lineRequired || entry.disclosureLine) {
      if (!record.disclosureLine) failures.push({ key: entry.key, reason: 'disclosure_line', message: 'A Withheld unit needs a Disclosure_Line with a kind of material and a date.', offerWithheld: false });
      else {
        const result = validate(disclosureLineSchema(lineContext), record.disclosureLine);
        if (!result.ok) failures.push({ key: entry.key, reason: 'disclosure_line', message: 'The Disclosure_Line is not valid.', offerWithheld: false, details: result.issues.map((issue) => `${issue.field}: ${issue.message}`) });
      }
    }
    if ((entry.publicSummary || entry.disclosureLine) && !agreed(state.requesterId)) {
      failures.push({ key: entry.key, reason: 'requester_licence', message: 'Give a Licence_Agreement for the current Content_Licence before setting a Public_Summary or Disclosure_Line.', offerWithheld: false, memberId: state.requesterId });
    }
  }

  // R46.17: work newly presented under Effective_Disclosure Public needs its credited Members' agreements.
  for (const entry of compared.changed) {
    const { before, after: next } = entry;
    if (!next || next.tag === 'withheld' || next.tag === 'project') continue;
    const newlyPresented = !before || before.tag === 'withheld'
      || (before.tag === 'research_item' && next.tag === 'research_item' && before.full === undefined && next.full !== undefined);
    const unit = afterUnits.get(idOf(entry.key));
    if (!newlyPresented || !unit) continue;
    for (const memberId of new Set(creditedMembers(unit, afterUnits))) {
      if (!agreed(memberId)) failures.push({
        key: entry.key, reason: 'licence', memberId, offerWithheld: true,
        message: `${members.get(memberId)?.displayName ?? 'A credited Member'} has no Licence_Agreement for the current Content_Licence.`,
      });
    }
  }
  return failures;
}

/** Every reason to refuse the whole change; an empty list means it may be applied (R23.5, R23.14, R26.14, R33.4, R34.2, R46.17). */
export function checkGates(change: ChangeSet, state: GateState): GateFailure[] {
  const after = applyChange(state.input, change);
  return gates(change, state, after, compare(state.input, after));
}

/** The preview and its gate failures from one pair of projections. */
export function previewChange(change: ChangeSet, state: GateState): { readonly after: ProjectionInput; readonly diff: PreviewDiff; readonly failures: readonly GateFailure[] } {
  const after = applyChange(state.input, change);
  const compared = compare(state.input, after);
  return { after, diff: describe(compared, after, state.contentLicence), failures: gates(change, state, after, compared) };
}
