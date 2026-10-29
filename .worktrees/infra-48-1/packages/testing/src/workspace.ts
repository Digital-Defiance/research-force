import { partialDate } from '@researchforce/domain/dates';
import type { FileKind } from '@researchforce/domain/file-kinds';
import type { RichText, Span } from '@researchforce/domain/richtext';
import { ITEM_KINDS } from '@researchforce/domain/types';
import type { CreditEntry, DisclosureLine, ItemKind, Level, MemberStatus, PublicPresentation, Timestamp, ULID, UnitType } from '@researchforce/domain/types';
import { BUILT_IN_VALUE_IDS } from '@researchforce/domain/value-sets';
import type {
  ConsentStatus, CorrespondenceParty, ExternalPartyRecord, KindRecord, MemberRecord, PartyRef, ProjectRecord, ProjectionInput, ResearchItemRecord, UnitRecord, ValueRecord,
} from '@researchforce/kernel/input';
import { UNNAMED_PARTY } from '@researchforce/kernel/substitute';
import type { ProfileRecord } from '@researchforce/kernel/substitute';
import { fc } from './fc';

/** Canaries are fixed-width so no token is a prefix of another; searches ignore letter case. */
const CANARY_PATTERN = /zq\d{6}zq/giu;
export function canariesIn(text: string): string[] { return [...text.matchAll(CANARY_PATTERN)].map((match) => match[0].toLowerCase()); }

export const CURRENT_LICENCE = 'Synthetic Content Licence 1.0';

export interface CanaryField { readonly owner: string; readonly field: string; }
export interface OutsideSubmissionRecord {
  readonly id: string; readonly name: string; readonly email: string; readonly affiliation?: string; readonly message: string; readonly pageReference: string;
}
export interface WorkspaceState {
  readonly input: ProjectionInput;
  /** Profiles by Member id. */
  readonly profiles: ReadonlyMap<string, ProfileRecord>;
  readonly outsideSubmissions: readonly OutsideSubmissionRecord[];
  /** Every canary token, lower case, with the field that holds it. */
  readonly canaries: ReadonlyMap<string, CanaryField>;
}

const ulid = (letter: string, n: number): ULID => `01${letter}${String(n).padStart(23, '0')}` as ULID;
const stamp = (minutes: number): Timestamp => new Date(Date.UTC(2026, 0, 1) + minutes * 60_000).toISOString() as Timestamp;

export const TEST_VALUES = Object.freeze({
  campaignComplete: ulid('V', 1), runComplete: ulid('V', 2), runPartial: ulid('V', 3), reliabilityHigh: ulid('V', 4),
  archivalPlanned: ulid('V', 5), rightsPublicDomain: ulid('V', 6), rightsRestricted: ulid('V', 7), relationRelated: ulid('V', 8),
});
const VALUES: readonly ValueRecord[] = [
  { id: TEST_VALUES.campaignComplete, name: 'COMPLETE' },
  { id: BUILT_IN_VALUE_IDS.findingOpen, name: 'Open' }, { id: BUILT_IN_VALUE_IDS.findingConfirmed, name: 'Confirmed' },
  { id: BUILT_IN_VALUE_IDS.findingSuperseded, name: 'Superseded' }, { id: BUILT_IN_VALUE_IDS.findingWithdrawn, name: 'Withdrawn' },
  { id: BUILT_IN_VALUE_IDS.hypothesisOpen, name: 'Open' }, { id: BUILT_IN_VALUE_IDS.hypothesisEliminated, name: 'Eliminated' },
  { id: TEST_VALUES.runComplete, name: 'Complete' }, { id: TEST_VALUES.runPartial, name: 'Partial' }, { id: TEST_VALUES.reliabilityHigh, name: 'High' },
  { id: TEST_VALUES.archivalPlanned, name: 'Planned' }, { id: BUILT_IN_VALUE_IDS.archivalSent, name: 'Sent' },
  { id: BUILT_IN_VALUE_IDS.rightsOwnWork, name: 'Own work', permitsPublication: true },
  { id: TEST_VALUES.rightsPublicDomain, name: 'Public domain', permitsPublication: true },
  { id: BUILT_IN_VALUE_IDS.rightsUnknown, name: 'Unknown', permitsPublication: false },
  { id: TEST_VALUES.rightsRestricted, name: 'Restricted', permitsPublication: false },
  { id: BUILT_IN_VALUE_IDS.relationEvidenceFor, name: 'Evidence for' }, { id: TEST_VALUES.relationRelated, name: 'Related' },
];
const RIGHTS = [BUILT_IN_VALUE_IDS.rightsOwnWork, TEST_VALUES.rightsPublicDomain, BUILT_IN_VALUE_IDS.rightsUnknown, TEST_VALUES.rightsRestricted];
const FILE_KINDS: readonly FileKind[] = ['pdf', 'image', 'csv', 'text_log', 'other'];
const CONSENTS: readonly ConsentStatus[] = ['granted', 'granted', 'granted', 'not_asked', 'requested', 'refused'];

/** Biased towards Public so that deep descendants often have an all-Public ancestor chain. */
const levelArb = fc.constantFrom<Level>('public', 'public', 'public', 'public', 'withheld', 'not_published');
const unitPlanArb = fc.record({
  type: fc.constantFrom<UnitType>('research_item', 'research_item', 'entry_section', 'attachment', 'reply', 'dissent_note'),
  kind: fc.constantFrom<ItemKind>(...ITEM_KINDS),
  level: levelArb,
  unclassified: fc.constantFrom(false, false, false, false, false, true),
  presentation: fc.constantFrom<PublicPresentation>('summary_only', 'full_content', 'full_content'),
  line: fc.constantFrom(true, true, false),
  withdrawn: fc.constantFrom(false, false, false, true),
  pick: fc.nat(), seed: fc.nat(), flags: fc.nat(),
});
const memberPlanArb = fc.record({
  status: fc.constantFrom<MemberStatus>('active', 'active', 'pending', 'revoked'), publicProfile: fc.boolean(),
  licence: fc.constantFrom('current', 'other', 'none'), upperEmail: fc.boolean(),
});
const statePlanArb = fc.record({
  projects: fc.array(fc.record({ level: levelArb, line: fc.constantFrom(true, true, false), accent: fc.boolean(), seed: fc.nat() }), { minLength: 1, maxLength: 3 }),
  members: fc.array(memberPlanArb, { minLength: 1, maxLength: 4 }),
  parties: fc.array(fc.record({ doNotName: fc.boolean(), label: fc.constantFrom(true, true, true, false) }), { maxLength: 4 }),
  units: fc.array(unitPlanArb, { minLength: 4, maxLength: 20 }),
  links: fc.array(fc.record({ from: fc.nat(), to: fc.nat(), relation: fc.boolean() }), { maxLength: 6 }),
  outside: fc.array(fc.record({ affiliation: fc.boolean() }), { maxLength: 2 }),
});
type StatePlan = typeof statePlanArb extends fc.Arbitrary<infer T> ? T : never;
type UnitPlan = StatePlan['units'][number];

class Builder {
  private counter = 0;
  private clock = 0;
  readonly canaries = new Map<string, CanaryField>();
  emails: readonly string[] = [];
  memberIds: readonly string[] = [];

  token(owner: string, field: string): string {
    const token = `zq${String(++this.counter).padStart(6, '0')}zq`;
    this.canaries.set(token, { owner, field });
    return token;
  }
  tick(): Timestamp { return stamp(++this.clock); }
  /** Some text values carry a registered Member address in varied letter case. */
  private embedded(seed: number): string {
    if (seed % 4 !== 0 || !this.emails.length) return '';
    const email = this.emails[seed % this.emails.length]!;
    const variants = [email.toLowerCase(), email.toUpperCase(), email.charAt(0).toUpperCase() + email.slice(1)];
    return ` write to ${variants[seed % 3]} today`;
  }
  text(owner: string, field: string, seed: number): string { return `${this.token(owner, field)}${this.embedded(seed)}`; }
  rich(owner: string, field: string, seed: number): RichText {
    const token = this.token(owner, field);
    const text = `${token} note${this.embedded(seed)}`;
    const spans: Span[] = [];
    if (seed % 3 === 0) spans.push({ k: 'quote', s: 0, e: text.length, source: this.token(owner, `${field}.source`) });
    if (seed % 5 === 1) spans.push({ k: 'lang', s: 0, e: token.length, lang: 'de' });
    if (seed % 4 === 1 && this.memberIds.length) spans.push({ k: 'mention', s: token.length + 1, e: token.length + 5, member: this.memberIds[seed % this.memberIds.length]! });
    return { text, spans };
  }
}

function pickOf<T>(list: readonly T[], n: number): T | undefined { return list.length ? list[n % list.length] : undefined; }

function buildState(plan: StatePlan): WorkspaceState {
  const b = new Builder();
  const members: MemberRecord[] = plan.members.map((entry, index) => {
    const id = ulid('M', index);
    const owner = `member:${id}`;
    const email = `${b.token(owner, 'email')}@example.test`;
    return {
      id, displayName: b.token(owner, 'displayName'), email: entry.upperEmail ? email.toUpperCase() : email, status: entry.status, publicProfile: entry.publicProfile,
      ...(entry.licence === 'none' ? {} : { licenceName: entry.licence === 'current' ? CURRENT_LICENCE : 'An earlier licence' }),
    };
  });
  b.emails = members.map((member) => member.email);
  b.memberIds = members.map((member) => member.id);
  const profiles = new Map(members.map((member, index): [string, ProfileRecord] => {
    const owner = `member:${member.id}`;
    return [member.id, {
      displayName: member.displayName, specialties: [b.token(owner, 'specialty')], affiliations: [b.token(owner, 'affiliation'), b.token(owner, 'affiliation')],
      biography: b.text(owner, 'biography', index * 4), publicProfile: member.publicProfile, status: member.status,
    }];
  }));
  const parties: ExternalPartyRecord[] = plan.parties.map((entry, index) => {
    const id = ulid('E', index);
    const owner = `party:${id}`;
    return { id, name: b.token(owner, 'name'), doNotName: entry.doNotName, ...(entry.label ? { genericLabel: b.token(owner, 'genericLabel') } : {}) };
  });
  const partyIds = [...members.map((member) => member.id), ...parties.map((party) => party.id)] as ULID[];
  const line = (owner: string, seed: number): DisclosureLine => ({
    kindOfMaterial: b.token(owner, 'line.kindOfMaterial'), date: partialDate('1943-05'),
    partyIds: partyIds.length ? [...new Set([pickOf(partyIds, seed)!, pickOf(partyIds, seed >> 2)!])].slice(0, seed % 3) : [],
    ...(seed % 2 ? { note: b.token(owner, 'line.note') } : {}),
  });
  const projects: ProjectRecord[] = plan.projects.map((entry, index) => {
    const id = ulid('P', index);
    const owner = `p:${id}`;
    return {
      id, name: b.token(owner, 'name'), description: b.text(owner, 'description', entry.seed), slug: b.token(owner, 'slug'),
      ...(entry.accent ? { accent: b.token(owner, 'accent') } : {}), level: entry.level, ...(entry.line ? { disclosureLine: line(owner, entry.seed) } : {}),
    };
  });

  const units: UnitRecord[] = [];
  const memberRef = (n: number): PartyRef => ({ kind: 'member', id: pickOf(members, n)!.id });
  const anyParty = (n: number): PartyRef => (parties.length && n % 2 ? { kind: 'external', id: pickOf(parties, n)!.id } : memberRef(n));
  const credit = (owner: string, n: number): CreditEntry[] => {
    switch (n % 3) {
      case 0: return [{ member: pickOf(members, n)!.id as ULID }];
      case 1: return [{ outside: { name: b.token(owner, 'credit.name'), ...(n % 2 ? { affiliation: b.token(owner, 'credit.affiliation') } : {}) } }];
      default: return [{ imported: b.token(owner, 'credit.imported') }];
    }
  };

  const kindRecord = (kind: ItemKind, owner: string, unitPlan: UnitPlan): KindRecord => {
    const { seed, flags, pick } = unitPlan;
    const opt = <T>(bit: number, make: () => T): T | undefined => ((flags >> bit) & 1 ? make() : undefined);
    const strip = (record: Record<string, unknown>): KindRecord => Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as unknown as KindRecord;
    switch (kind) {
      case 'journal_entry': return strip({
        kind, phaseId: b.text(owner, 'phaseId', seed), statusValueId: opt(0, () => TEST_VALUES.campaignComplete),
        startDate: partialDate('1943-05-05'), endDate: opt(1, () => partialDate('1943-06')), relatedMemberIds: opt(2, () => [pickOf(members, seed)!.id]),
      });
      case 'finding': return strip({
        kind, statusValueId: pickOf([BUILT_IN_VALUE_IDS.findingOpen, BUILT_IN_VALUE_IDS.findingConfirmed, BUILT_IN_VALUE_IDS.findingSuperseded, BUILT_IN_VALUE_IDS.findingWithdrawn], pick)!,
        claim: b.rich(owner, 'claim', seed), scopeCaveat: b.rich(owner, 'scopeCaveat', seed + 1),
      });
      case 'source': return strip({
        kind, sourceKind: flags % 2 ? 'primary' as const : 'secondary' as const, reliabilityId: TEST_VALUES.reliabilityHigh, documentDate: partialDate('1942'),
        archiveOrCollection: b.text(owner, 'archiveOrCollection', seed), archivalReference: opt(0, () => b.text(owner, 'archivalReference', seed + 1)),
        recoverer: opt(1, () => anyParty(seed)), reliabilityNote: opt(2, () => b.rich(owner, 'reliabilityNote', seed + 2)),
        rightsStatusId: pickOf(RIGHTS, pick)!, rightsHolder: opt(3, () => b.text(owner, 'rightsHolder', seed + 3)), rightsTerms: opt(4, () => b.text(owner, 'rightsTerms', seed)),
      });
      case 'run': return strip({
        kind, scope: b.rich(owner, 'scope', seed), parameters: b.rich(owner, 'parameters', seed + 1), toolName: b.token(owner, 'toolName'), toolVersion: b.token(owner, 'toolVersion'),
        computeResource: b.text(owner, 'computeResource', seed + 2), startTime: '1943-05-05T10:00:00+02:00', endTime: opt(0, () => '1943-05-06T11:30:15+02:00'),
        outcomeId: pick % 2 ? TEST_VALUES.runPartial : TEST_VALUES.runComplete, resumePoint: opt(1, () => b.text(owner, 'resumePoint', seed + 3)),
        notes: opt(2, () => b.rich(owner, 'notes', seed)), counts: opt(3, () => [{ name: b.token(owner, 'counts.name'), value: '000123456789012345678901234567' }]),
      });
      case 'hypothesis': {
        const eliminated = pick % 2 === 1;
        return strip({
          kind, statusValueId: eliminated ? BUILT_IN_VALUE_IDS.hypothesisEliminated : BUILT_IN_VALUE_IDS.hypothesisOpen, statement: b.rich(owner, 'statement', seed),
          eliminationScope: eliminated || (flags & 1) ? b.rich(owner, 'eliminationScope', seed + 1) : undefined,
        });
      }
      case 'correspondence': {
        const count = 2 + (flags % 2);
        const chosen: CorrespondenceParty[] = [];
        for (let index = 0; index < count; index++) {
          const ref = anyParty(seed + index);
          if (!chosen.some((party) => party.id === ref.id)) chosen.push(ref.kind === 'external' ? { ...ref, consent: pickOf(CONSENTS, (seed >> 1) + index)! } : ref);
        }
        return { kind, date: partialDate('1943-05-06'), channel: b.text(owner, 'channel', seed), direction: flags & 2 ? 'sent' : 'received', content: b.rich(owner, 'content', seed + 1), parties: chosen };
      }
      case 'archival_request': return strip({
        kind, archiveOrDesk: anyParty(seed + 1), contact: opt(0, () => anyParty(seed)), channel: opt(1, () => b.text(owner, 'channel', seed)),
        requestText: b.rich(owner, 'requestText', seed + 1), statusValueId: pick % 2 ? BUILT_IN_VALUE_IDS.archivalSent : TEST_VALUES.archivalPlanned,
        dateSent: opt(2, () => partialDate('1943-07-01')), replyDate: opt(3, () => partialDate('1943-07-09')), replyContent: opt(4, () => b.rich(owner, 'replyContent', seed + 2)),
      });
      case 'topic': return { kind, body: b.rich(owner, 'body', seed) };
    }
  };

  const supersededFindings: { unit: Extract<UnitRecord, { type: 'research_item' }>; pick: number }[] = [];
  for (const [index, u] of plan.units.entries()) {
    const { pick } = u;
    const id = ulid('N', index);
    const owner = `u:${id}`;
    const items = units.filter((unit): unit is Extract<UnitRecord, { type: 'research_item' }> => unit.type === 'research_item');
    const parentsByType: Record<Exclude<UnitType, 'research_item'>, UnitRecord[]> = {
      entry_section: items.filter((unit) => unit.item.kind === 'journal_entry'),
      attachment: units.filter((unit) => unit.type === 'research_item' || unit.type === 'reply'),
      reply: units.filter((unit) => unit.type === 'research_item' || unit.type === 'attachment' || unit.type === 'reply'),
      dissent_note: items.filter((unit) => unit.item.logSummary !== undefined),
    };
    const parent = u.type === 'research_item' ? undefined : pickOf(parentsByType[u.type], pick);
    const type: UnitType = parent ? u.type : 'research_item';
    const base = {
      id, position: index, ownerId: pickOf(members, u.seed)!.id, credit: credit(owner, u.seed + u.flags), createdAt: b.tick(),
      level: u.level, unclassified: u.unclassified, ...(u.line ? { disclosureLine: line(owner, u.seed) } : {}),
      ...(u.withdrawn && type !== 'entry_section' ? { withdrawal: { at: b.tick(), reason: b.text(owner, 'withdrawal.reason', u.seed) } } : {}),
      ...(parent ? { parentId: parent.id } : {}),
    };
    if (type === 'research_item') {
      const kind = u.kind;
      const summaryOptional = kind === 'journal_entry' || kind === 'topic';
      const item = {
        ...kindRecord(kind, owner, u), projectId: pickOf(projects, pick)!.id, identifier: b.token(owner, 'identifier'), title: b.text(owner, 'title', u.seed + 1),
        presentation: u.presentation, ...((u.flags >> 5) & 1 ? { publicSummary: b.rich(owner, 'publicSummary', u.seed + 2) } : {}),
        ...(!summaryOptional || (u.flags >> 6) & 1 ? { logSummary: b.rich(owner, 'logSummary', u.seed + 3) } : {}),
        ...((u.flags >> 7) & 1 ? { firstPublicAt: stamp(1) } : {}),
      } as ResearchItemRecord;
      const unit = { ...base, type, item } as Extract<UnitRecord, { type: 'research_item' }>;
      units.push(unit);
      if (item.kind === 'finding' && item.statusValueId === BUILT_IN_VALUE_IDS.findingSuperseded) supersededFindings.push({ unit, pick: u.seed });
    } else if (type === 'attachment') {
      const earlier = units.filter((unit): unit is Extract<UnitRecord, { type: 'attachment' }> => unit.type === 'attachment' && unit.parentId === parent!.id
        && !units.some((other) => other.type === 'attachment' && other.attachment.supersedesId === unit.id));
      const supersedes = u.flags % 3 === 0 ? pickOf(earlier, pick) : undefined;
      units.push({ ...base, type, attachment: {
        identifier: b.token(owner, 'identifier'), title: b.text(owner, 'title', u.seed), fileKind: pickOf(FILE_KINDS, u.flags)!, sizeBytes: 1024 + u.seed,
        ...((u.flags >> 1) & 1 ? { caption: b.text(owner, 'caption', u.seed + 1) } : {}), origin: b.text(owner, 'origin', u.seed + 2), uploadedAt: base.createdAt,
        rightsStatusId: pickOf(RIGHTS, pick >> 1)!, ...((u.flags >> 2) & 1 ? { rightsHolder: b.text(owner, 'rightsHolder', u.seed) } : {}),
        ...((u.flags >> 3) & 1 ? { rightsTerms: b.text(owner, 'rightsTerms', u.seed + 3) } : {}), ...(supersedes ? { supersedesId: supersedes.id } : {}),
      } });
    } else if (type === 'entry_section') {
      units.push({ ...base, type, text: b.rich(owner, 'text', u.seed) });
    } else if (type === 'reply') {
      units.push({ ...base, type, text: b.rich(owner, 'text', u.seed), isGroupNote: u.flags % 5 === 0 });
    } else {
      const item = parent as Extract<UnitRecord, { type: 'research_item' }>;
      units.push({
        ...base, type, text: b.rich(owner, 'text', u.seed), authorId: pickOf(members, u.flags)!.id, attachedAt: base.createdAt, lastSavedAt: b.tick(),
        concernedSummary: u.flags % 2 ? item.item.logSummary! : b.rich(owner, 'concernedSummary', u.seed),
      });
    }
  }
  const findings = units.filter((unit) => unit.type === 'research_item' && unit.item.kind === 'finding');
  for (const { unit, pick } of supersededFindings) {
    const target = pickOf(findings.filter((finding) => finding.id !== unit.id), pick);
    if (target) units[units.indexOf(unit)] = { ...unit, item: { ...unit.item, supersededById: target.id } as ResearchItemRecord };
  }
  const links = units.length ? plan.links.map((entry, index) => ({
    id: ulid('K', index), originId: pickOf(units, entry.from)!.id, targetId: pickOf(units, entry.to)!.id,
    ...(entry.relation ? { relationValueId: index % 2 ? BUILT_IN_VALUE_IDS.relationEvidenceFor : TEST_VALUES.relationRelated } : {}),
  })) : [];
  const outsideSubmissions = plan.outside.map((entry, index): OutsideSubmissionRecord => {
    const id = ulid('S', index);
    const owner = `outside:${id}`;
    return {
      id, name: b.token(owner, 'name'), email: `${b.token(owner, 'email')}@outside.test`, ...(entry.affiliation ? { affiliation: b.token(owner, 'affiliation') } : {}),
      message: b.token(owner, 'message'), pageReference: b.token(owner, 'pageReference'),
    };
  });
  return {
    input: { now: stamp(10_000), projects, units, members, parties, values: VALUES, links },
    profiles, outsideSubmissions, canaries: b.canaries,
  };
}
/** Projects, Members, External_Parties, units, Cross_Links, and Outside_Submissions with a unique canary in every text field. */
export const workspaceStateArb: fc.Arbitrary<WorkspaceState> = statePlanArb.map(buildState);

const VALID_PARENTS: Readonly<Record<Exclude<UnitType, 'research_item'>, readonly UnitType[]>> = {
  entry_section: ['research_item'], attachment: ['research_item', 'reply'], reply: ['research_item', 'attachment', 'reply'], dissent_note: ['research_item'],
};

export interface ReferenceModel {
  /** Level by `p:`/`u:` key as the Public_Site presents it, read directly from the requirements. */
  readonly levels: ReadonlyMap<string, Level>;
  /** The Disclosure_Line a Withheld unit or Project shows. */
  lineOf(key: string): DisclosureLine | undefined;
  /** The label a Party id shows publicly. */
  partyLabel(id: string): string | undefined;
}

/** A deliberately direct model of Effective_Disclosure with the kernel's defensive rules (R23, R26.5, R33.4, R34.2, R42.8). */
export function referenceModel(input: ProjectionInput): ReferenceModel {
  const units = new Map(input.units.map((unit) => [unit.id, unit]));
  const projects = new Map(input.projects.map((project) => [project.id, project]));
  const values = new Map(input.values.map((value) => [value.id, value]));
  const membersById = new Map(input.members.map((member) => [member.id, member]));
  const partiesById = new Map(input.parties.map((party) => [party.id, party]));
  const levels = new Map<string, Level>();
  const defensive = new Set<string>();

  const partyLabel = (id: string): string | undefined => {
    const member = membersById.get(id);
    if (member) return member.displayName;
    const party = partiesById.get(id);
    if (!party) return undefined;
    return party.doNotName ? (party.genericLabel?.trim() ? party.genericLabel : UNNAMED_PARTY) : party.name;
  };
  const lineOfUnit = (unit: UnitRecord): DisclosureLine | undefined => {
    if (unit.disclosureLine) return unit.disclosureLine;
    if (!defensive.has(`u:${unit.id}`)) return undefined;
    if (unit.type === 'research_item' && unit.item.kind === 'correspondence') {
      return { kindOfMaterial: 'correspondence', date: unit.item.date, partyIds: unit.item.parties.slice(0, 20).map((party) => party.id as ULID) };
    }
    if (unit.type === 'attachment') return { kindOfMaterial: 'file kind', date: partialDate(unit.attachment.uploadedAt.slice(0, 10)), partyIds: [] };
    return undefined;
  };
  const projectLevel = (project: ProjectRecord): Level => (project.level === 'withheld' && !project.disclosureLine ? 'not_published' : project.level);
  const rootOf = (unit: UnitRecord, seen = new Set<string>()): Extract<UnitRecord, { type: 'research_item' }> | undefined => {
    if (seen.has(unit.id)) return undefined;
    seen.add(unit.id);
    if (unit.type === 'research_item') return unit;
    const parent = unit.parentId === undefined ? undefined : units.get(unit.parentId);
    return parent && rootOf(parent, seen);
  };
  const unitLevel = (unit: UnitRecord, seen: Set<string>): Level => {
    const known = levels.get(`u:${unit.id}`);
    if (known) return known;
    if (seen.has(unit.id)) return 'not_published';
    seen.add(unit.id);
    let ancestorsPublic: boolean;
    if (unit.type === 'research_item') {
      const project = projects.get(unit.item.projectId);
      ancestorsPublic = unit.parentId === undefined && project !== undefined && projectLevel(project) === 'public';
    } else {
      const parent = unit.parentId === undefined ? undefined : units.get(unit.parentId);
      ancestorsPublic = parent !== undefined && VALID_PARENTS[unit.type].includes(parent.type) && unitLevel(parent, seen) === 'public';
    }
    const root = rootOf(unit);
    const needsFull = unit.type === 'entry_section' || unit.type === 'reply' || unit.type === 'dissent_note';
    let level: Level = unit.level;
    if (!ancestorsPublic || !root || (needsFull && root.item.presentation !== 'full_content') || unit.unclassified) level = 'not_published';
    if (unit.type === 'dissent_note' && unit.withdrawal) level = 'not_published';
    const consentMissing = unit.type === 'research_item' && unit.item.kind === 'correspondence' && unit.item.parties.some((party) => party.kind === 'external' && party.consent !== 'granted');
    const rightsMissing = unit.type === 'attachment' && values.get(unit.attachment.rightsStatusId)?.permitsPublication !== true;
    if (level === 'public' && (consentMissing || rightsMissing)) { defensive.add(`u:${unit.id}`); level = 'withheld'; }
    if (level === 'withheld' && !lineOfUnit(unit)) level = 'not_published';
    levels.set(`u:${unit.id}`, level);
    return level;
  };
  for (const project of input.projects) levels.set(`p:${project.id}`, projectLevel(project));
  for (const unit of input.units) unitLevel(unit, new Set());
  return {
    levels, partyLabel,
    lineOf: (key) => (key.startsWith('p:') ? projects.get(key.slice(2))?.disclosureLine : (() => { const unit = units.get(key.slice(2)); return unit && lineOfUnit(unit); })()),
  };
}

/** Canaries that may appear publicly: fields of the Public_View of Public units, and Disclosure_Lines of Withheld units (Property 5). */
export function allowedCanaries(state: WorkspaceState): Set<string> {
  const { input } = state;
  const model = referenceModel(input);
  const allowed = new Set<string>();
  const add = (value: string | undefined): void => { if (value !== undefined) for (const token of canariesIn(value)) allowed.add(token); };
  const addRich = (value: RichText | undefined): void => {
    if (!value) return;
    add(value.text);
    for (const span of value.spans) if ('source' in span) add(span.source);
  };
  const addLine = (line: DisclosureLine | undefined): void => {
    if (!line) return;
    add(line.kindOfMaterial); add(line.note);
    for (const id of line.partyIds) add(model.partyLabel(id));
  };
  const addParty = (ref: PartyRef | undefined): void => { if (ref) add(model.partyLabel(ref.id)); };
  const members = new Map(input.members.map((member) => [member.id, member]));
  const addCredit = (credit: readonly CreditEntry[]): void => {
    for (const entry of credit) {
      if ('member' in entry) add(members.get(entry.member)?.displayName);
      else if ('outside' in entry) { add(entry.outside.name); add(entry.outside.affiliation); }
      else add(entry.imported);
    }
  };
  const addFields = (item: ResearchItemRecord): void => {
    switch (item.kind) {
      case 'journal_entry': add(item.phaseId); for (const id of item.relatedMemberIds ?? []) add(members.get(id)?.displayName); break;
      case 'finding': addRich(item.claim); break;
      case 'source': add(item.archiveOrCollection); add(item.archivalReference); addParty(item.recoverer); addRich(item.reliabilityNote); add(item.rightsHolder); add(item.rightsTerms); break;
      case 'run': addRich(item.scope); addRich(item.parameters); add(item.computeResource); add(item.resumePoint); addRich(item.notes); for (const count of item.counts ?? []) add(count.name); break;
      case 'hypothesis': addRich(item.statement); break;
      case 'correspondence': add(item.channel); addRich(item.content); for (const party of item.parties) addParty(party); break;
      case 'archival_request': addParty(item.archiveOrDesk); addParty(item.contact); add(item.channel); addRich(item.requestText); addRich(item.replyContent); break;
      case 'topic': addRich(item.body); break;
    }
  };

  for (const project of input.projects) {
    const level = model.levels.get(`p:${project.id}`);
    if (level === 'public') { add(project.name); add(project.description); add(project.slug); add(project.accent); }
    if (level === 'withheld') { add(project.slug); addLine(project.disclosureLine); }
  }
  for (const unit of input.units) {
    const level = model.levels.get(`u:${unit.id}`);
    if (level === 'withheld') {
      if (unit.type === 'research_item') add(unit.item.identifier);
      if (unit.type === 'attachment') add(unit.attachment.identifier);
      addLine(model.lineOf(`u:${unit.id}`));
    }
    if (level !== 'public') continue;
    add(unit.withdrawal?.reason);
    switch (unit.type) {
      case 'research_item': {
        const item = unit.item;
        add(item.identifier); add(item.title); addRich(item.publicSummary); addCredit(unit.credit);
        if (item.kind === 'finding') addRich(item.scopeCaveat);
        if (item.kind === 'hypothesis' && item.statusValueId === BUILT_IN_VALUE_IDS.hypothesisEliminated) addRich(item.eliminationScope);
        if (item.kind === 'run') { add(item.toolName); add(item.toolVersion); }
        if (item.presentation === 'full_content') { addFields(item); addRich(item.logSummary); }
        break;
      }
      case 'attachment': {
        const file = unit.attachment;
        add(file.identifier); add(file.title); add(file.caption); add(file.origin); add(file.rightsHolder); add(file.rightsTerms); addCredit(unit.credit);
        break;
      }
      case 'entry_section': addRich(unit.text); break;
      case 'reply': addRich(unit.text); add(members.get(unit.ownerId)?.displayName); break;
      case 'dissent_note': addRich(unit.text); addRich(unit.concernedSummary); add(members.get(unit.authorId)?.displayName); break;
    }
  }
  for (const [id, profile] of state.profiles) {
    if (!profile.publicProfile || profile.status !== 'active' || !members.has(id)) continue;
    add(profile.displayName); add(profile.biography);
    for (const value of [...profile.specialties, ...profile.affiliations]) add(value);
  }
  // Registered addresses never appear publicly, even inside otherwise public text (R46.9).
  for (const member of input.members) for (const token of canariesIn(member.email)) allowed.delete(token);
  return allowed;
}
