import { attachmentList, disclosureLineBlock, dissentNoteBlock, notice, statusLabel, type Tone } from '@researchforce/design/components/index';
import { licenceLink } from '@researchforce/design/fixed-texts';
import { formatDate, formatEnteredTime } from '@researchforce/domain/dates';
import type { RichText } from '@researchforce/domain/richtext';
import { element, fragment, text, type ElementNode, type ViewNode } from '@researchforce/domain/tree';
import type {
  AttachmentView, ChildRef, CreditView, DisclosureLineView, FieldView, LinkTarget, LinkView, PublicView, StatusView, ValueRef, WithdrawalView,
} from '@researchforce/kernel/views';
import { LabelNotes, renderNotes } from '@researchforce/markdown/overlay';
import { renderRichText } from '@researchforce/markdown/render';
import { FIELD_LABELS, FILE_KIND_NAMES, KIND_NAMES, formatDay, formatSize, profileHref } from './format';
import { SUPERSEDED_HREF, WITHDRAWN_HREF, WITHHELD_HREF, labelKindHref, termHref, valueHref } from './methods';
import { downloadUrl } from './paths';
import type { FixedTermKey, SiteInput } from './site';

/**
 * State shared by the blocks of one page: footnoted labels numbered across the page (R11.5), and the value ids the page presents, which
 * decide which retired values the Methods page lists (R46.11).
 */
export class PageContext {
  readonly notes = new LabelNotes(labelKindHref);
  constructor(readonly site: SiteInput, readonly presented: Set<string>) {}

  view(key: string): PublicView | undefined { return this.site.views.get(key); }

  rich(value: RichText): ViewNode { return renderRichText(value, this.notes).tree; }

  /** A configurable value linked to its Methods page entry (R46.14). */
  value(ref: ValueRef, tone?: Tone): ElementNode {
    this.presented.add(ref.id);
    return statusLabel({ label: ref.name, href: valueHref(ref.id), ...(tone === undefined ? {} : { tone }) });
  }

  footnotes(): ViewNode[] {
    const notes = renderNotes(this.notes);
    return notes === undefined ? [] : [notes];
  }
}

export const termLink = (key: FixedTermKey, label: string): ElementNode => element('a', { href: termHref(key) }, [text(label)]);

const BLOCK_TAGS: ReadonlySet<string> = new Set(['p', 'div', 'ul', 'ol', 'dl', 'pre', 'blockquote', 'table', 'section', 'aside', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const isInline = (node: ViewNode): boolean =>
  node.kind === 'text' || (node.kind === 'fragment' ? node.children.every(isInline) : !BLOCK_TAGS.has(node.tag));

/** The nodes to show inside a paragraph: a lone paragraph's content, inline nodes as they are, or undefined for block content. */
function inlineContent(value: ViewNode): readonly ViewNode[] | undefined {
  const nodes = value.kind === 'fragment' ? value.children : [value];
  const [first] = nodes;
  if (nodes.length === 1 && first!.kind === 'element' && first!.tag === 'p') return first!.children;
  return nodes.every(isInline) ? nodes : undefined;
}

/** A labelled value; rich text that renders as one paragraph stays inline, longer text becomes a block. */
export function companion(label: ViewNode, value: ViewNode): ElementNode {
  const labelNode = element('span', { class: 'rf-companion__label' }, [label, text(':')]);
  const inline = inlineContent(value);
  return inline === undefined
    ? element('div', { class: 'rf-companion' }, [labelNode, element('div', { class: 'rf-companion__value' }, [value])])
    : element('p', { class: 'rf-companion' }, [labelNode, text(' '), element('span', { class: 'rf-companion__value' }, inline)]);
}

const withheldLabel = (): ElementNode => element('a', { class: 'rf-status rf-status--withheld', href: WITHHELD_HREF }, [text('Withheld')]);

export function creditNodes(credit: readonly CreditView[]): ViewNode[] {
  return credit.flatMap((entry, index) => [
    ...(index > 0 ? [text(', ')] : []),
    entry.profiled ? element('a', { href: profileHref(entry.name) }, [text(entry.name)]) : text(entry.name),
    ...(entry.affiliation === undefined ? [] : [text(` (${entry.affiliation})`)]),
  ]);
}

export function disclosureLine(line: DisclosureLineView, href?: string): ElementNode {
  return disclosureLineBlock({
    kindOfMaterial: line.kindOfMaterial, date: formatDate(line.date), parties: line.parties, methodsHref: WITHHELD_HREF,
    ...(line.note === undefined ? {} : { note: line.note }), ...(href === undefined ? {} : { href }),
  });
}

export function withdrawalNotice(withdrawal: WithdrawalView): ElementNode {
  return notice({ tone: 'warning', body: [element('p', {}, [
    element('a', { href: WITHDRAWN_HREF }, [text('Withdrawn')]), text(` on ${formatDay(withdrawal.date)}: ${withdrawal.reason}`),
  ])] });
}

export const withdrawalMark = (): ElementNode => statusLabel({ label: 'Withdrawn', href: WITHDRAWN_HREF, tone: 'danger' });

/** The main status of a view, without its companion fields, as listings and Cross_Links show it. */
export function statusValue(context: PageContext, status: StatusView): ElementNode[] {
  switch (status.kind) {
    case 'journal_entry': return status.status === undefined ? [] : [context.value(status.status)];
    case 'source': return [sourceKindLabel(status.sourceKind), context.value(status.reliability)];
    case 'run': return [context.value(status.outcome)];
    default: return [context.value(status.status)];
  }
}

const sourceKindLabel = (kind: 'primary' | 'secondary'): ElementNode =>
  statusLabel({ label: kind === 'primary' ? 'Primary source' : 'Secondary source', href: termHref(`source_kind.${kind}`) });

/** The status with every companion field in one block (R5.6, R6.3, R7.4, R8.3, R29.2–R29.4). */
export function statusBlockFor(context: PageContext, status: StatusView | undefined): ElementNode | undefined {
  if (status === undefined) return undefined;
  const block = (labels: readonly ElementNode[], companions: readonly ElementNode[]): ElementNode | undefined =>
    labels.length === 0 && companions.length === 0 ? undefined : element('div', { class: 'rf-status-block' }, [...labels, ...companions]);
  switch (status.kind) {
    case 'journal_entry': return block(statusValue(context, status), []);
    case 'finding': return block(statusValue(context, status), [
      companion(termLink('term.scope_caveat', 'Scope caveat'), context.rich(status.scopeCaveat)),
      ...(status.supersededBy === undefined ? [] : [companion(element('a', { href: SUPERSEDED_HREF }, [text('Superseded by')]), fragment(inlineTarget(context, status.supersededBy)))]),
    ]);
    case 'source': return block([sourceKindLabel(status.sourceKind)], [companion(text('Reliability'), context.value(status.reliability))]);
    case 'run': return block(statusValue(context, status), [companion(text('Tool name'), text(status.toolName)), companion(text('Tool version'), text(status.toolVersion))]);
    case 'hypothesis': return block(statusValue(context, status), status.eliminationScope === undefined ? [] : [
      companion(termLink('term.elimination_scope', 'Elimination scope'), context.rich(status.eliminationScope)),
    ]);
    case 'archival_request': return block(statusValue(context, status), []);
  }
}

const TYPE_NAMES = { project: 'Project', research_item: 'Research item', attachment: 'Attachment', entry_section: 'Entry section', reply: 'Reply', dissent_note: 'Dissent note' } as const;

/** The other end of a Cross_Link or supersession, as its own view presents it (R24.8). */
export function inlineTarget(context: PageContext, target: LinkTarget): ViewNode[] {
  if (target.tag === 'withheld') {
    const { line } = target;
    const summary = [line.kindOfMaterial, formatDate(line.date), ...(line.parties.length > 0 ? [line.parties.join(', ')] : [])].join(' · ');
    return [withheldLabel(), text(' '), target.path === undefined ? text(summary) : element('a', { href: target.path }, [text(summary)])];
  }
  const status = target.status === undefined ? [] : statusValue(context, target.status);
  return [
    element('a', { href: target.path }, [text(target.title)]),
    text(` (${target.kind === undefined ? TYPE_NAMES[target.type] : KIND_NAMES[target.kind]})`),
    ...status.flatMap((label) => [text(' '), label]),
  ];
}

export function linksSection(context: PageContext, links: readonly LinkView[], id = 'links'): ElementNode | undefined {
  if (links.length === 0) return undefined;
  return element('section', { class: 'rf-links', 'aria-labelledby': `${id}-heading` }, [
    element('h2', { id: `${id}-heading` }, [text('Links')]),
    element('ul', {}, links.map((link) => element('li', {}, [
      text(link.direction === 'outgoing' ? 'Links to ' : 'Linked from '),
      ...(link.relation === undefined ? [] : [context.value(link.relation), text(' ')]),
      ...(link.target.tag === 'withheld' ? [disclosureLine(link.target.line, link.target.path)] : inlineTarget(context, link.target)),
    ]))),
  ]);
}

function fieldValue(context: PageContext, field: FieldView): ViewNode {
  const { value } = field;
  switch (value.t) {
    case 'text': return text(field.key === 'direction' ? (value.value === 'sent' ? 'Sent' : value.value === 'received' ? 'Received' : value.value) : value.value);
    case 'rich': return context.rich(value.value);
    case 'date': return text(formatDate(value.value));
    case 'time': return text(formatEnteredTime(value.value));
    case 'parties':
    case 'members': return text(value.value.join(', '));
    case 'value': return context.value(value.value);
    case 'counts': return element('ul', {}, value.value.map((count) => element('li', {}, [text(`${count.name}: ${count.value}`)])));
  }
}

/** Every recorded field of the kind (R24.2), with the Resume_Point label linked to its Methods page entry. */
export function fieldList(context: PageContext, fields: readonly FieldView[]): ElementNode | undefined {
  if (fields.length === 0) return undefined;
  return element('dl', { class: 'rf-fields' }, fields.flatMap((field) => [
    element('dt', {}, [field.key === 'resumePoint' ? termLink('term.resume_point', FIELD_LABELS.resumePoint) : text(FIELD_LABELS[field.key])]),
    element('dd', {}, [fieldValue(context, field)]),
  ]));
}

/** Rights, licence coverage, and the download link, wherever a file is offered (R29.11, R29.12). */
function rightsBlock(context: PageContext, view: AttachmentView): ElementNode {
  const { rights } = view;
  const licence = licenceLink(context.site.licence);
  return element('div', { class: 'rf-attachment__rights' }, [
    element('p', {}, [
      text('Rights status: '), context.value(rights.status),
      ...(rights.holder === undefined ? [] : [text(` · Rights holder: ${rights.holder}`)]),
      ...(rights.terms === undefined ? [] : [text(` · Rights terms: ${rights.terms}`)]),
    ]),
    element('p', {}, rights.licenceCovers
      ? [text('This file is licensed under the '), licence, text('.')]
      : [text('The '), licence, text(' does not cover this file; its rights status and terms apply instead.')]),
    element('p', {}, [element('a', { href: downloadUrl(view.download) }, [text(`Download (${FILE_KIND_NAMES[view.fileKind]}, ${formatSize(view.size)})`)])]),
  ]);
}

export function supersessionNotice(superseded: NonNullable<AttachmentView['supersededBy']>): ElementNode {
  return notice({ tone: 'info', body: [element('p', {}, [
    element('a', { href: SUPERSEDED_HREF }, [text('Superseded')]), text(`: a later version was uploaded on ${formatDay(superseded.uploadedOn)}. `),
    element('a', { href: superseded.path }, [text('Open the later version')]),
  ])] });
}

/** An Attachment's notices and download details, as both its own page and its Parent's page show them. */
export function attachmentDetails(context: PageContext, view: AttachmentView): ViewNode[] {
  return [
    ...(view.withdrawal === undefined ? [] : [withdrawalNotice(view.withdrawal)]),
    ...(view.supersededBy === undefined ? [] : [supersessionNotice(view.supersededBy)]),
    rightsBlock(context, view),
  ];
}

/** Child Attachments in order: Public ones with their download details, Withheld ones as Disclosure_Lines in their position (R24.3, R24.4). */
export function attachmentsSection(context: PageContext, refs: readonly ChildRef[], id: string): ElementNode | undefined {
  const entries = refs.flatMap((ref): readonly ViewNode[] => {
    const view = context.view(ref.key);
    if (view?.tag === 'withheld') return [element('li', { class: 'rf-attachment' }, [disclosureLine(view.line)])];
    if (view?.tag !== 'attachment') return [];
    const list = attachmentList([{
      title: view.title, href: view.path, kind: FILE_KIND_NAMES[view.fileKind], sizeLabel: formatSize(view.size),
      ...(view.credit.length === 0 ? {} : { credit: fragment(creditNodes(view.credit)) }), ...(view.caption === undefined ? {} : { caption: view.caption }),
      notices: attachmentDetails(context, view),
    }]);
    return list.children;
  });
  if (entries.length === 0) return undefined;
  return element('section', { class: 'rf-attachments-section', 'aria-labelledby': `${id}-heading` }, [
    element('h2', { id: `${id}-heading` }, [text('Attachments')]),
    element('ul', { class: 'rf-attachments', 'aria-label': 'Attachments' }, entries),
  ]);
}

/** The Thread as a tree ordered by posting time, each Reply by its own view (R24.2). */
export function replyTree(context: PageContext, refs: readonly ChildRef[], depth = 0): ElementNode | undefined {
  const entries = refs.flatMap((ref): ElementNode[] => {
    const view = context.view(ref.key);
    if (view?.tag === 'withheld') return [element('li', { class: 'rf-reply' }, [disclosureLine(view.line)])];
    if (view?.tag !== 'reply') return [];
    const nested = replyTree(context, view.replies, depth + 1);
    const attachments = attachmentsSection(context, view.attachments, `${view.key.replace(':', '-')}-attachments`);
    const links = linksSection(context, view.links, `${view.key.replace(':', '-')}-links`);
    return [element('li', { class: 'rf-reply' }, [element('article', { class: 'rf-reply__body' }, [
      element('p', { class: 'rf-reply__meta' }, [text(`${view.author} · ${formatDay(view.postedOn)}`)]),
      ...(view.withdrawal === undefined ? [] : [withdrawalNotice(view.withdrawal)]),
      context.rich(view.text),
      ...(attachments === undefined ? [] : [attachments]),
      ...(links === undefined ? [] : [links]),
      ...(nested === undefined ? [] : [nested]),
    ])])];
  });
  if (entries.length === 0) return undefined;
  return element('ul', { class: `rf-replies${depth > 0 ? ' rf-replies--nested' : ''}` }, entries);
}

/** Dissent_Notes directly after the Log_Summary, oldest first, as their views present them (R42.14). */
export function dissentNotes(context: PageContext, refs: readonly ChildRef[]): ElementNode[] {
  return refs.flatMap((ref): ElementNode[] => {
    const view = context.view(ref.key);
    if (view?.tag === 'withheld') return [disclosureLine(view.line)];
    if (view?.tag !== 'dissent_note') return [];
    return [dissentNoteBlock({
      authorName: view.author, savedAt: formatDay(view.savedOn), body: [context.rich(view.text)],
      ...(view.authorProfiled ? { authorHref: profileHref(view.author) } : {}), ...(view.earlierWording ? { earlierWording: {} } : {}),
    })];
  });
}

export function entrySections(context: PageContext, refs: readonly ChildRef[]): ElementNode[] {
  return refs.flatMap((ref): ElementNode[] => {
    const view = context.view(ref.key);
    if (view?.tag === 'withheld') return [disclosureLine(view.line)];
    if (view?.tag !== 'entry_section') return [];
    const links = linksSection(context, view.links, `${view.key.replace(':', '-')}-links`);
    return [element('section', { class: 'rf-entry-section' }, [context.rich(view.text), ...(links === undefined ? [] : [links])])];
  });
}
