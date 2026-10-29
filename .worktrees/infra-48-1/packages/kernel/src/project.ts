import { itemDate, logDate } from '@researchforce/domain/dates';
import type { ItemDateInput } from '@researchforce/domain/dates';
import type { RichText } from '@researchforce/domain/richtext';
import type { CreditEntry, DisclosureLine, DocumentDate, Level, Timestamp, UnitType } from '@researchforce/domain/types';
import { BUILT_IN_VALUE_IDS } from '@researchforce/domain/value-sets';
import { effective } from './effective';
import type { DNode } from './effective';
import type { KindRecord, PartyRef, ProjectRecord, ProjectionInput, ResearchItemRecord, UnitRecord, ValueRecord } from './input';
import { emailMatcher, lineView, partyDirectory, partyLabel, prefillAttachmentLine, prefillCorrespondenceLine, publicationBreach, scrubDeep } from './substitute';
import type { BreachCode, EmailMark, InvariantBreach, PartyDirectory } from './substitute';
import { PUBLIC_PATHS, canonicalJson, projectKey, unitKey } from './views';
import type {
  AttachmentView, ChildRef, CreditView, DisclosureLineView, DissentNoteView, EntrySectionView, FieldKey, FieldView, LinkTarget, LinkView, ProjectRef,
  PublicView, ReplyView, ResearchItemView, StatusView, UnitKey, UTCDate, ValueRef, WithdrawalView,
} from './views';

export interface Projection {
  /** One view per Public or Withheld unit and Project; Not_Published units have none (R24.5). */
  readonly views: ReadonlyMap<UnitKey, PublicView>;
  /** Every unit's and Project's level as projected: Effective_Disclosure after the defensive rules. */
  readonly levels: ReadonlyMap<UnitKey, Level>;
  /** States the save path makes impossible, each projected defensively; the Publisher raises a System_Alert for them. */
  readonly invariantBreaches: readonly InvariantBreach[];
  /** Positions of "[email address removed]" in each view, for previews (R46.9). */
  readonly emailMarks: ReadonlyMap<UnitKey, readonly EmailMark[]>;
}

const VALID_PARENTS: Readonly<Record<Exclude<UnitType, 'research_item'>, readonly UnitType[]>> = {
  entry_section: ['research_item'],
  attachment: ['research_item', 'reply'],
  reply: ['research_item', 'attachment', 'reply'],
  dissent_note: ['research_item'],
};

type ItemUnit = Extract<UnitRecord, { type: 'research_item' }>;
type AttachmentUnit = Extract<UnitRecord, { type: 'attachment' }>;

const dateOf = (instant: Timestamp): UTCDate => instant.split('T')[0]!;
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byPosition = (a: UnitRecord, b: UnitRecord): number => a.position - b.position || compareText(a.createdAt, b.createdAt) || compareText(a.id, b.id);
const byPosting = (a: UnitRecord, b: UnitRecord): number => compareText(a.createdAt, b.createdAt)
  || Number(b.type === 'reply' && b.isGroupNote) - Number(a.type === 'reply' && a.isGroupNote) || compareText(a.id, b.id);
const byAttachment = (a: UnitRecord, b: UnitRecord): number => (a.type === 'dissent_note' && b.type === 'dissent_note' ? compareText(a.attachedAt, b.attachedAt) : 0) || compareText(a.id, b.id);

/** Mentions name internal Member and Specialty ids; public text keeps their characters without the reference. */
function publicRich(rich: RichText): RichText {
  return rich.spans.some((span) => span.k === 'mention') ? { text: rich.text, spans: rich.spans.filter((span) => span.k !== 'mention') } : rich;
}
function sameRich(a: RichText | undefined, b: RichText | undefined): boolean {
  return a !== undefined && b !== undefined && a.text === b.text && canonicalJson(a.spans) === canonicalJson(b.spans);
}

function dateInput(item: ResearchItemRecord, createdAt: Timestamp): ItemDateInput {
  switch (item.kind) {
    case 'journal_entry': return item.startDate ? { kind: item.kind, createdAt, startDate: item.startDate } : { kind: item.kind, createdAt };
    case 'source': return item.documentDate ? { kind: item.kind, createdAt, documentDate: item.documentDate } : { kind: item.kind, createdAt };
    case 'run': return { kind: item.kind, createdAt, startTime: item.startTime };
    case 'correspondence': return { kind: item.kind, createdAt, date: item.date };
    case 'archival_request': return item.dateSent ? { kind: item.kind, createdAt, dateSent: item.dateSent } : { kind: item.kind, createdAt };
    default: return { kind: item.kind, createdAt };
  }
}

class Projector {
  private readonly units: ReadonlyMap<string, UnitRecord>;
  private readonly projects: ReadonlyMap<string, ProjectRecord>;
  private readonly values: ReadonlyMap<string, ValueRecord>;
  private readonly directory: PartyDirectory;
  private readonly children = new Map<string, UnitRecord[]>();
  private readonly successors = new Map<string, AttachmentUnit>();
  private readonly links = new Map<string, { id: string; direction: LinkView['direction']; otherId: string; relationValueId?: string }[]>();
  private readonly nodes = new Map<string, DNode | null>();
  private readonly building = new Set<string>();
  private readonly records = new Map<DNode, UnitRecord | ProjectRecord>();
  private readonly memo = new Map<DNode, Level>();
  private readonly defensive = new Set<UnitKey>();
  private readonly breachList: InvariantBreach[] = [];
  private readonly breachSeen = new Set<string>();

  constructor(private readonly input: ProjectionInput) {
    this.units = new Map(input.units.map((unit) => [unit.id, unit]));
    this.projects = new Map(input.projects.map((project) => [project.id, project]));
    this.values = new Map(input.values.map((value) => [value.id, value]));
    this.directory = partyDirectory(input);
    for (const unit of input.units) {
      if (unit.parentId !== undefined) this.children.set(unit.parentId, [...(this.children.get(unit.parentId) ?? []), unit]);
      if (unit.type === 'attachment' && unit.attachment.supersedesId !== undefined) this.successors.set(unit.attachment.supersedesId, unit);
    }
    for (const link of input.links) {
      const relation = link.relationValueId === undefined ? {} : { relationValueId: link.relationValueId };
      this.links.set(link.originId, [...(this.links.get(link.originId) ?? []), { id: link.id, direction: 'outgoing', otherId: link.targetId, ...relation }]);
      this.links.set(link.targetId, [...(this.links.get(link.targetId) ?? []), { id: link.id, direction: 'incoming', otherId: link.originId, ...relation }]);
    }
  }

  private breach(key: UnitKey, code: BreachCode, message: string): void {
    const id = `${key}:${code}`;
    if (this.breachSeen.has(id)) return;
    this.breachSeen.add(id);
    this.breachList.push({ key, code, message });
  }

  private projectNode(id: string): DNode | undefined {
    const key = projectKey(id);
    const cached = this.nodes.get(key);
    if (cached !== undefined) return cached ?? undefined;
    const project = this.projects.get(id);
    if (!project) return undefined;
    const node: DNode = { key, type: 'project', own: project.level, unclassified: false };
    this.nodes.set(key, node);
    this.records.set(node, project);
    return node;
  }

  /** Malformed structure (unknown Parent or Project, a disallowed Parent type, a cycle) leaves the unit without a node: Not_Published. */
  private unitNode(id: string): DNode | undefined {
    const key = unitKey(id);
    const cached = this.nodes.get(key);
    if (cached !== undefined) return cached ?? undefined;
    const unit = this.units.get(id);
    if (!unit) return undefined;
    if (this.building.has(id)) {
      this.breach(key, 'structure', 'The Parent chain is cyclic.');
      this.nodes.set(key, null);
      return undefined;
    }
    this.building.add(id);
    let node: DNode | null = null;
    const base = { key, type: unit.type, own: unit.level, unclassified: unit.unclassified };
    if (unit.type === 'research_item') {
      const project = this.projectNode(unit.item.projectId);
      if (unit.parentId !== undefined) this.breach(key, 'structure', 'A Research_Item cannot have a Parent.');
      else if (!project) this.breach(key, 'structure', 'The Research_Item names no existing Project.');
      else node = { ...base, presentation: unit.item.presentation, project, ...(unit.item.restricted ? { restricted: true } : {}) };
    } else {
      const parentUnit = unit.parentId === undefined ? undefined : this.units.get(unit.parentId);
      const parent = parentUnit && this.unitNode(parentUnit.id);
      if (!parentUnit || !VALID_PARENTS[unit.type].includes(parentUnit.type)) this.breach(key, 'structure', 'The unit has no valid Parent.');
      else if (parent) node = { ...base, parent, root: parent.type === 'research_item' ? parent : parent.root! };
    }
    this.building.delete(id);
    if (this.nodes.get(key) === null) return undefined;
    this.nodes.set(key, node);
    if (node) this.records.set(node, unit);
    return node ?? undefined;
  }

  private readonly adjust = (node: DNode, level: Level): Level => {
    const record = this.records.get(node)!;
    if (node.type === 'project') {
      if (level === 'withheld' && !(record as ProjectRecord).disclosureLine) {
        this.breach(node.key, 'missing_line', 'A Withheld Project has no Disclosure_Line.');
        return 'not_published';
      }
      return level;
    }
    const unit = record as UnitRecord;
    if (unit.type === 'dissent_note' && unit.withdrawal) return 'not_published'; // R42.8
    let adjusted = level;
    if (adjusted === 'public') {
      const code = publicationBreach(unit, this.values);
      if (code) {
        this.breach(node.key, code, code === 'consent'
          ? 'A Public Correspondence has an External_Party whose consent is not Granted.'
          : 'A Public Attachment has a Rights_Status that does not permit publication.');
        this.defensive.add(node.key);
        adjusted = 'withheld';
      }
    }
    if (adjusted === 'withheld' && !this.withheldLine(unit)) {
      this.breach(node.key, 'missing_line', 'A Withheld unit has no Disclosure_Line.');
      return 'not_published';
    }
    return adjusted;
  };

  private withheldLine(unit: UnitRecord): DisclosureLine | undefined {
    if (unit.disclosureLine) return unit.disclosureLine;
    if (!this.defensive.has(unitKey(unit.id))) return undefined;
    if (unit.type === 'research_item' && unit.item.kind === 'correspondence') return prefillCorrespondenceLine(unit.item, this.directory).line;
    if (unit.type === 'attachment') return prefillAttachmentLine(unit.attachment);
    return undefined;
  }

  levelOfProject(id: string): Level {
    const node = this.projectNode(id);
    return node ? effective(node, this.adjust, this.memo) : 'not_published';
  }
  levelOf(id: string): Level {
    const node = this.unitNode(id);
    return node ? effective(node, this.adjust, this.memo) : 'not_published';
  }

  private rootOf(unit: UnitRecord): ItemUnit {
    const node = this.unitNode(unit.id)!;
    return this.records.get(node.type === 'research_item' ? node : node.root!) as ItemUnit;
  }
  /** The page that presents the unit: an Entry_Section, Reply, or Dissent_Note is on the page of its nearest Research_Item or Attachment ancestor (R24.8). */
  private pathOf(unit: UnitRecord): string {
    if (unit.type === 'research_item') return PUBLIC_PATHS.item(unit.item.identifier);
    if (unit.type === 'attachment') return PUBLIC_PATHS.attachment(unit.attachment.identifier);
    return this.pathOf(this.units.get(unit.parentId!)!);
  }
  private titleOf(unit: UnitRecord): string {
    if (unit.type === 'research_item') return unit.item.title;
    if (unit.type === 'attachment') return unit.attachment.title;
    return this.rootOf(unit).item.title;
  }
  private visibleChildren(id: string, type: UnitType, order: (a: UnitRecord, b: UnitRecord) => number): ChildRef[] {
    return (this.children.get(id) ?? []).filter((child) => child.type === type && this.levelOf(child.id) !== 'not_published').sort(order).map((child) => ({ key: unitKey(child.id) }));
  }

  private valueRef(id: string | undefined): ValueRef | undefined {
    const value = id === undefined ? undefined : this.values.get(id);
    return value && { id: value.id, name: value.name };
  }
  private memberName(id: string): string | undefined { return this.directory.members.get(id)?.displayName; }
  private credits(entries: readonly CreditEntry[]): CreditView[] {
    return entries.flatMap((entry): CreditView[] => {
      if ('member' in entry) {
        const member = this.directory.members.get(entry.member);
        if (!member) return [];
        return [{ name: member.displayName, ...(member.publicProfile && member.status === 'active' ? { profiled: true as const } : {}) }];
      }
      if ('outside' in entry) return [{ name: entry.outside.name, ...(entry.outside.affiliation === undefined ? {} : { affiliation: entry.outside.affiliation }) }];
      return [{ name: entry.imported }];
    });
  }
  private withdrawal(unit: UnitRecord): { withdrawal?: WithdrawalView } {
    return unit.withdrawal ? { withdrawal: { date: dateOf(unit.withdrawal.at), reason: unit.withdrawal.reason } } : {};
  }
  private line(unit: UnitRecord): DisclosureLineView { return lineView(this.withheldLine(unit)!, this.directory); }
  private projectRef(project: ProjectRecord): ProjectRef {
    return { key: projectKey(project.id), name: project.name, slug: project.slug, path: PUBLIC_PATHS.project(project.slug), ...(project.accent === undefined ? {} : { accent: project.accent }) };
  }

  private target(unit: UnitRecord): LinkTarget | undefined {
    const level = this.levelOf(unit.id);
    const key = unitKey(unit.id);
    if (level === 'withheld') return { tag: 'withheld', key, path: this.pathOf(unit), line: this.line(unit) };
    if (level !== 'public') return undefined;
    const item = unit.type === 'research_item' ? unit.item : undefined;
    const status = item && this.status(item, false);
    return { tag: 'link', key, path: this.pathOf(unit), type: unit.type, title: this.titleOf(unit), ...(item ? { kind: item.kind } : {}), ...(status ? { status } : {}) };
  }
  private linkViews(unit: UnitRecord): LinkView[] {
    const rank = { outgoing: 0, incoming: 1 } as const;
    const entries = [...(this.links.get(unit.id) ?? [])].sort((a, b) => rank[a.direction] - rank[b.direction] || compareText(a.id, b.id));
    return entries.flatMap((entry): LinkView[] => {
      const other = this.units.get(entry.otherId);
      const target = other && this.target(other);
      if (!target) return [];
      const relation = this.valueRef(entry.relationValueId);
      return [{ direction: entry.direction, ...(relation ? { relation } : {}), target }];
    });
  }

  /** Superseding-Finding targets are left out of nested statuses, so mutual supersession cannot recurse. */
  private status(item: ResearchItemRecord, withSupersession: boolean): StatusView | undefined {
    switch (item.kind) {
      case 'journal_entry': {
        const status = this.valueRef(item.statusValueId);
        return { kind: item.kind, ...(status ? { status } : {}) };
      }
      case 'finding': {
        const status = this.valueRef(item.statusValueId);
        if (!status) return undefined;
        const superseding = withSupersession && item.statusValueId === BUILT_IN_VALUE_IDS.findingSuperseded && item.supersededById !== undefined ? this.units.get(item.supersededById) : undefined;
        const supersededBy = superseding && this.target(superseding);
        return { kind: item.kind, status, scopeCaveat: publicRich(item.scopeCaveat), ...(supersededBy ? { supersededBy } : {}) };
      }
      case 'source': {
        const reliability = this.valueRef(item.reliabilityId);
        return reliability && { kind: item.kind, sourceKind: item.sourceKind, reliability };
      }
      case 'run': {
        const outcome = this.valueRef(item.outcomeId);
        return outcome && { kind: item.kind, outcome, toolName: item.toolName, toolVersion: item.toolVersion };
      }
      case 'hypothesis': {
        const status = this.valueRef(item.statusValueId);
        const eliminated = item.statusValueId === BUILT_IN_VALUE_IDS.hypothesisEliminated && item.eliminationScope !== undefined;
        return status && { kind: item.kind, status, ...(eliminated ? { eliminationScope: publicRich(item.eliminationScope!) } : {}) };
      }
      case 'archival_request': {
        const status = this.valueRef(item.statusValueId);
        return status && { kind: item.kind, status };
      }
      default: return undefined;
    }
  }

  /** Every field of the kind not already in the status block (R24.2). */
  private fields(item: KindRecord): FieldView[] {
    const fields: FieldView[] = [];
    const text = (key: FieldKey, value: string | undefined): void => { if (value !== undefined) fields.push({ key, value: { t: 'text', value } }); };
    const rich = (key: FieldKey, value: RichText | undefined): void => { if (value !== undefined) fields.push({ key, value: { t: 'rich', value: publicRich(value) } }); };
    const date = (key: FieldKey, value: DocumentDate | undefined): void => { if (value !== undefined) fields.push({ key, value: { t: 'date', value } }); };
    const parties = (key: FieldKey, refs: readonly PartyRef[]): void => {
      if (refs.length) fields.push({ key, value: { t: 'parties', value: refs.flatMap((ref) => partyLabel(ref, this.directory) ?? []) } });
    };
    switch (item.kind) {
      case 'journal_entry':
        text('phaseId', item.phaseId); date('startDate', item.startDate); date('endDate', item.endDate);
        if (item.relatedMemberIds?.length) fields.push({ key: 'relatedMembers', value: { t: 'members', value: item.relatedMemberIds.flatMap((id) => this.memberName(id) ?? []) } });
        break;
      case 'finding': rich('claim', item.claim); break;
      case 'source': {
        date('documentDate', item.documentDate); text('archiveOrCollection', item.archiveOrCollection); text('archivalReference', item.archivalReference);
        parties('recoverer', item.recoverer ? [item.recoverer] : []); rich('reliabilityNote', item.reliabilityNote);
        const rights = this.valueRef(item.rightsStatusId);
        if (rights) fields.push({ key: 'rightsStatus', value: { t: 'value', value: rights } });
        text('rightsHolder', item.rightsHolder); text('rightsTerms', item.rightsTerms);
        break;
      }
      case 'run':
        rich('scope', item.scope); rich('parameters', item.parameters); text('computeResource', item.computeResource);
        fields.push({ key: 'startTime', value: { t: 'time', value: item.startTime } });
        if (item.endTime !== undefined) fields.push({ key: 'endTime', value: { t: 'time', value: item.endTime } });
        text('resumePoint', item.resumePoint); rich('notes', item.notes);
        if (item.counts?.length) fields.push({ key: 'counts', value: { t: 'counts', value: item.counts.map((count) => ({ name: count.name, value: count.value })) } });
        break;
      case 'hypothesis': rich('statement', item.statement); break;
      case 'correspondence':
        date('date', item.date); text('channel', item.channel); text('direction', item.direction); rich('content', item.content);
        parties('parties', item.parties);
        break;
      case 'archival_request':
        parties('archiveOrDesk', [item.archiveOrDesk]); parties('contact', item.contact ? [item.contact] : []); text('channel', item.channel);
        rich('requestText', item.requestText); date('dateSent', item.dateSent); date('replyDate', item.replyDate); rich('replyContent', item.replyContent);
        break;
      case 'topic': rich('body', item.body); break;
    }
    return fields;
  }

  private researchItemView(unit: ItemUnit): ResearchItemView {
    const item = unit.item;
    const project = this.projects.get(item.projectId)!;
    const status = this.status(item, true);
    const full = item.presentation === 'full_content' ? {
      fields: this.fields(item),
      ...(item.logSummary ? { logSummary: publicRich(item.logSummary) } : {}),
      sections: this.visibleChildren(unit.id, 'entry_section', byPosition),
      replies: this.visibleChildren(unit.id, 'reply', byPosting),
      dissent: this.visibleChildren(unit.id, 'dissent_note', byAttachment),
    } : undefined;
    const dates = dateInput(item, unit.createdAt);
    return {
      tag: 'research_item', key: unitKey(unit.id), path: this.pathOf(unit), kind: item.kind, title: item.title,
      ...(item.publicSummary ? { publicSummary: publicRich(item.publicSummary) } : {}),
      itemDate: itemDate(dates, 'UTC'), logDate: logDate(dates, 'UTC'), credit: this.credits(unit.credit), identifier: item.identifier,
      ...(status ? { status } : {}), ...this.withdrawal(unit), project: this.projectRef(project),
      firstPublicOn: dateOf(item.firstPublicAt ?? this.input.now),
      attachments: this.visibleChildren(unit.id, 'attachment', byPosition), links: this.linkViews(unit), ...(full ? { full } : {}),
    };
  }

  private attachmentView(unit: AttachmentUnit): AttachmentView {
    const file = unit.attachment;
    const root = this.rootOf(unit);
    const rightsStatus = this.valueRef(file.rightsStatusId)!;
    let supersededBy: AttachmentView['supersededBy'];
    const seen = new Set<string>([unit.id]);
    for (let later = this.successors.get(unit.id); later && !seen.has(later.id); later = this.successors.get(later.id)) {
      seen.add(later.id);
      if (this.levelOf(later.id) === 'public') supersededBy = { key: unitKey(later.id), path: this.pathOf(later), uploadedOn: dateOf(later.attachment.uploadedAt) };
    }
    const parent = this.units.get(unit.parentId!)!;
    return {
      tag: 'attachment', key: unitKey(unit.id), path: this.pathOf(unit), title: file.title, fileKind: file.fileKind, size: file.sizeBytes,
      ...(file.caption === undefined ? {} : { caption: file.caption }), credit: this.credits(unit.credit), origin: file.origin, identifier: file.identifier,
      rights: {
        status: rightsStatus, ...(file.rightsHolder === undefined ? {} : { holder: file.rightsHolder }), ...(file.rightsTerms === undefined ? {} : { terms: file.rightsTerms }),
        licenceCovers: file.rightsStatusId === BUILT_IN_VALUE_IDS.rightsOwnWork,
      },
      download: PUBLIC_PATHS.file(file.identifier), ...(supersededBy ? { supersededBy } : {}),
      parent: { key: unitKey(parent.id), path: this.pathOf(parent) }, project: this.projectRef(this.projects.get(root.item.projectId)!),
      ...this.withdrawal(unit), links: this.linkViews(unit), replies: this.visibleChildren(unit.id, 'reply', byPosting),
    };
  }

  private unitView(unit: UnitRecord): PublicView {
    const key = unitKey(unit.id);
    if (this.levelOf(unit.id) === 'withheld') {
      const ownPage = unit.type === 'research_item' || unit.type === 'attachment';
      return { tag: 'withheld', key, ...(ownPage ? { path: this.pathOf(unit) } : {}), line: this.line(unit), project: this.projectRef(this.projects.get(this.rootOf(unit).item.projectId)!) };
    }
    switch (unit.type) {
      case 'research_item': return this.researchItemView(unit);
      case 'attachment': return this.attachmentView(unit);
      case 'entry_section': return { tag: 'entry_section', key, text: publicRich(unit.text), links: this.linkViews(unit) } satisfies EntrySectionView;
      case 'reply': return {
        tag: 'reply', key, text: publicRich(unit.text), author: this.memberName(unit.ownerId) ?? '', postedOn: dateOf(unit.createdAt), ...this.withdrawal(unit),
        attachments: this.visibleChildren(unit.id, 'attachment', byPosition), replies: this.visibleChildren(unit.id, 'reply', byPosting), links: this.linkViews(unit),
      } satisfies ReplyView;
      case 'dissent_note': {
        const author = this.directory.members.get(unit.authorId);
        return {
          tag: 'dissent_note', key, text: publicRich(unit.text), author: author?.displayName ?? '', savedOn: dateOf(unit.lastSavedAt),
          earlierWording: !sameRich(unit.concernedSummary, this.rootOf(unit).item.logSummary),
          ...(author?.publicProfile && author.status === 'active' ? { authorProfiled: true as const } : {}),
        } satisfies DissentNoteView;
      }
    }
  }

  run(): Projection {
    const levels = new Map<UnitKey, Level>();
    for (const project of this.input.projects) levels.set(projectKey(project.id), this.levelOfProject(project.id));
    for (const unit of this.input.units) levels.set(unitKey(unit.id), this.levelOf(unit.id));
    const matcher = emailMatcher(this.input.members.map((member) => member.email));
    const views = new Map<UnitKey, PublicView>();
    const emailMarks = new Map<UnitKey, readonly EmailMark[]>();
    const add = (key: UnitKey, view: PublicView): void => {
      const scrubbed = scrubDeep(view, matcher);
      views.set(key, scrubbed.value);
      if (scrubbed.marks.length) emailMarks.set(key, scrubbed.marks);
    };
    for (const project of this.input.projects) {
      const key = projectKey(project.id);
      const level = levels.get(key);
      if (level === 'public') add(key, { tag: 'project', key, path: PUBLIC_PATHS.project(project.slug), name: project.name, description: project.description, slug: project.slug, ...(project.accent === undefined ? {} : { accent: project.accent }) });
      else if (level === 'withheld') add(key, { tag: 'withheld', key, path: PUBLIC_PATHS.project(project.slug), line: lineView(project.disclosureLine!, this.directory) });
    }
    for (const unit of this.input.units) if (levels.get(unitKey(unit.id)) !== 'not_published') add(unitKey(unit.id), this.unitView(unit));
    return { views, levels, invariantBreaches: [...this.breachList], emailMarks };
  }
}

export function projectDetailed(input: ProjectionInput): Projection { return new Projector(input).run(); }

/** The Public_View of every Public or Withheld unit (R24, R29, R40). */
export function project(input: ProjectionInput): Map<UnitKey, PublicView> { return new Map(projectDetailed(input).views); }
