import type { RichText } from '@researchforce/domain/richtext';
import { validate } from '@researchforce/domain/schemas/common';
import { disclosureLineSchema } from '@researchforce/domain/schemas/other';
import type { DisclosureLine, Level, PublicPresentation, ULID } from '@researchforce/domain/types';
import { approvedSnapshot, coverWidening, widens } from './consent';
import type { ConsentRow, ConsentValues, HoldCoverage, SnapshotDependency } from './consent';
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
  /**
   * Attachments moved to another Parent (R12.12). Each entry names a unit and its new Parent id; the unit's Root_Item,
   * Project, and Effective_Disclosure are re-derived from the new Parent chain. The caller lists every Attachment of
   * the moved Version_Chain, each of which carries the Parent; units nested under them follow through their own Parent.
   */
  readonly attachmentMoves?: readonly { readonly unitId: string; readonly parentId: string }[];
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
  const reparent = new Map((change.attachmentMoves ?? []).map((move) => [move.unitId, move.parentId]));
  const unnamedOff = new Set(change.doNotNameOff ?? []);
  const projects = input.projects.map((project): ProjectRecord => {
    const entry = byKey.get(projectKey(project.id));
    return entry ? withLine({ ...project, ...(entry.level ? { level: entry.level } : {}) }, entry.disclosureLine) : project;
  });
  const units = input.units.map((unit): UnitRecord => {
    const entry = byKey.get(unitKey(unit.id));
    const projectId = moves.get(unit.id);
    const newParentId = reparent.get(unit.id);
    let next: UnitRecord = newParentId === undefined ? unit : { ...unit, parentId: newParentId };
    if (next.type === 'research_item' && (projectId !== undefined || entry?.presentation !== undefined || entry?.publicSummary !== undefined)) {
      const unit = next;
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
      .map((note) => ({ note, effective: compared.after.levels.get(unitKey(note.id)) ?? 'not_published' }))
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

export type GateReason =
  | 'unit_limit' | 'unknown_unit' | 'rights' | 'consent' | 'licence' | 'requester_licence' | 'disclosure_line' | 'restricted'
  | 'owner_consent' | 'hold';
export interface GateFailure {
  readonly key?: UnitKey;
  readonly reason: GateReason;
  readonly message: string;
  readonly offerWithheld: boolean;
  /** The Member without a Licence_Agreement for the current Content_Licence, or the Consenting_Member whose consent is missing. */
  readonly memberId?: string;
  readonly details?: readonly string[];
}

/**
 * The consent and hold data `loadProjectionInput` supplies for the Owner-consent and Confidentiality_Hold
 * gates (R23.17, R48.2, R48.4). A unit's Consenting_Member is resolved from the stored Owner/author; the
 * Publication_Consents are that Member's rows for the unit; the hold coverage lists the active holds over
 * each covered unit; and the dependency manifest is the loaded rows the resulting snapshot binds to, so a
 * consent whose manifest digest no longer matches no longer covers the change.
 */
export interface ConsentState {
  /** The Consenting_Member of a Disclosure_Unit, or undefined for a Project (which needs no consent). */
  consentingMember(key: UnitKey): string | undefined;
  /** The Publication_Consents on hand, with their exact values and snapshot digests. */
  readonly consents: readonly ConsentRow[];
  /** Active Confidentiality_Hold coverage per unit key (R48.2). */
  readonly holds: readonly HoldCoverage[];
  /** The loaded dependency rows the resulting snapshot binds to (R23.23). */
  readonly dependencies: readonly SnapshotDependency[];
}

export interface GateState {
  readonly input: ProjectionInput;
  readonly requesterId: string;
  readonly contentLicence: string;
  /** Present once the consent, hold, and dependency data are loaded; absent in paths that only run the ordinary gates. */
  readonly consent?: ConsentState;
}

/** The Research_Item a unit belongs to, through its Parent chain. */
function rootItem(unit: UnitRecord, units: ReadonlyMap<string, UnitRecord>): Extract<UnitRecord, { type: 'research_item' }> | undefined {
  const seen = new Set<string>();
  for (let current: UnitRecord | undefined = unit; current && !seen.has(current.id); current = current.parentId === undefined ? undefined : units.get(current.parentId)) {
    if (current.type === 'research_item') return current;
    seen.add(current.id);
  }
  return undefined;
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
    const root = unit && rootItem(unit, afterUnits);
    if (root?.item.restricted && (entry.level === 'public' || entry.level === 'withheld' || entry.presentation !== undefined || entry.publicSummary || entry.disclosureLine)) {
      failures.push({ key: entry.key, reason: 'restricted', message: `${root.item.identifier} is Restricted, so nothing in it can be published; widen its access first.`, offerWithheld: false, details: [root.item.identifier] });
      continue;
    }
    if (entry.level === 'public' && unit?.type === 'attachment') {
      const rights = values.get(unit.attachment.rightsStatusId);
      if (rights?.permitsPublication !== true) failures.push({ key: entry.key, reason: 'rights', message: `The Rights_Status ${rights?.name ?? 'of this Attachment'} does not permit publication.`, offerWithheld: true, details: [rights?.name ?? ''] });
    }
    if (entry.level === 'public' && unit?.type === 'research_item' && unit.item.kind === 'correspondence') {
      const missing = unit.item.parties.filter((party) => party.kind === 'external' && party.consent !== 'granted');
      if (missing.length) failures.push({
        key: entry.key, reason: 'consent', message: 'Every External_Party must have Granted consent before a Correspondence becomes Public.',
        offerWithheld: beforeUnits.get(id)?.level === 'not_published',
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

  // R23.17, R48.2, R48.4: a hold blocks any widening of a covered unit, and a widening of a Consenting_Member's
  // view needs that Member's unused, unwithdrawn consent covering the exact proposed snapshot.
  failures.push(...consentAndHoldGates(change, state, after));
  return failures;
}

const presentationOf = (key: UnitKey, input: ProjectionInput): 'summary_only' | 'full_content' | undefined => {
  const unit = input.units.find((candidate) => unitKey(candidate.id) === key);
  return unit?.type === 'research_item' ? unit.item.presentation : undefined;
};

/** The exact values applied to a unit, read from the projected state, for the consent snapshot (R23.20). */
function appliedValues(key: UnitKey, after: ProjectionInput): ConsentValues {
  const id = idOf(key);
  const unit = after.units.find((candidate) => candidate.id === id);
  const project = after.projects.find((candidate) => projectKey(candidate.id) === key);
  const line = unit?.disclosureLine ?? project?.disclosureLine;
  const summary = unit?.type === 'research_item' ? unit.item.publicSummary : undefined;
  return {
    level: unit?.level ?? project?.level ?? 'not_published',
    ...(presentationOf(key, after) === undefined ? {} : { presentation: presentationOf(key, after)! }),
    ...(summary === undefined ? {} : { publicSummary: summary }),
    ...(line === undefined ? {} : { disclosureLine: line }),
  };
}

/** The keys a change touches, as unit or Project keys. */
function touchedKeys(change: ChangeSet): UnitKey[] {
  return [...new Set([
    ...(change.units ?? []).map((entry) => entry.key),
    ...(change.moves ?? []).map((move) => unitKey(move.itemId)),
    ...(change.attachmentMoves ?? []).map((move) => unitKey(move.unitId)),
  ])];
}

function consentAndHoldGates(change: ChangeSet, state: GateState, after: ProjectionInput): GateFailure[] {
  const failures: GateFailure[] = [];
  const consent = state.consent;
  if (!consent) return failures;
  const members = new Map(after.members.map((member) => [member.id, member]));
  const holdFor = new Map(consent.holds.map((coverage) => [coverage.key, coverage.holds]));

  for (const key of touchedKeys(change)) {
    if (!widens(state.input, after, key)) continue;

    // R48.4: a Confidentiality_Hold covering the unit blocks any widening until lifted or overridden.
    const holds = holdFor.get(key) ?? [];
    if (holds.length > 0) {
      failures.push({
        key, reason: 'hold', offerWithheld: false,
        message: 'A Confidentiality_Hold covers this unit; nothing it covers may be published until the hold is lifted or overridden.',
        details: holds.map((hold) => `${members.get(hold.memberId)?.displayName ?? hold.memberId}: ${hold.note}`),
      });
      continue;
    }

    // R23.17: a change to a Project's level needs no consent; a unit's widening needs its Consenting_Member's consent.
    const consentingMember = consent.consentingMember(key);
    if (consentingMember === undefined || consentingMember === state.requesterId) continue;

    const values = appliedValues(key, after);
    // The current dependency manifest binds the snapshot; a consent signed against a stale manifest will not match.
    const snapshot = approvedSnapshot(after, key, values, consent.dependencies);
    const result = coverWidening(consent.consents, snapshot);
    if (!result.covered) {
      failures.push({
        key, reason: 'owner_consent', memberId: consentingMember, offerWithheld: false,
        message: `${members.get(consentingMember)?.displayName ?? 'The Consenting_Member'} has given no Publication_Consent covering this change; offer a Publication_Proposal.`,
        details: result.consideredIds,
      });
    }
  }
  return failures;
}

/** One widening unit the apply must account for: the Consenting_Member's live consent it spends, and the keys. */
export interface WideningConsent {
  readonly key: UnitKey;
  /** The Consenting_Member whose consent covers the widening. */
  readonly memberId: string;
  /** The live consent the apply spends (marks `used_at`); it covered the resulting snapshot at gate time. */
  readonly consentId: string;
}

/**
 * The widening units whose Consenting_Member is another Member, each with the consent that covers the widening,
 * for the apply to recheck and spend (R23.17, R23.23, R23.24). The caller first runs `checkGates`; when it passes,
 * every such widening is covered, so each entry here carries a covering consent id. A Project change and a widening
 * the acting Member consents to for their own unit need no consent and are not returned.
 */
export function wideningConsents(change: ChangeSet, state: GateState): readonly WideningConsent[] {
  const consent = state.consent;
  if (!consent) return [];
  const after = applyChange(state.input, change);
  const entries: WideningConsent[] = [];
  for (const key of touchedKeys(change)) {
    if (!widens(state.input, after, key)) continue;
    const consentingMember = consent.consentingMember(key);
    if (consentingMember === undefined || consentingMember === state.requesterId) continue;
    const snapshot = approvedSnapshot(after, key, appliedValues(key, after), consent.dependencies);
    const result = coverWidening(consent.consents, snapshot);
    if (result.covered) entries.push({ key, memberId: consentingMember, consentId: result.consentId });
  }
  return entries;
}

/** Every reason to refuse the whole change; an empty list means it may be applied (R23.5, R23.14, R26.14, R33.4, R34.2, R46.17, R47.9). */
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
