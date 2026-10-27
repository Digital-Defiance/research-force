import { citationBlock } from '@researchforce/design/components/index';
import { formatDate } from '@researchforce/domain/dates';
import { element, text, type ElementNode, type ViewNode } from '@researchforce/domain/tree';
import type { ResearchItemView, WithheldView } from '@researchforce/kernel/views';
import {
  PageContext, attachmentsSection, creditNodes, disclosureLine, dissentNotes, entrySections, fieldList, linksSection, replyTree, statusBlockFor, withdrawalNotice,
} from './blocks';
import { KIND_NAMES, formatDay, plainText } from './format';
import type { PageSpec } from './frame';
import { itemMeta, openGraph } from './meta';
import { absoluteUrl } from './paths';

const optional = (node: ElementNode | undefined): ElementNode[] => (node === undefined ? [] : [node]);

export function metaList(rows: readonly (readonly [string, readonly ViewNode[]])[]): ElementNode {
  return element('dl', { class: 'rf-item-meta' }, rows.flatMap(([label, value]) => [element('dt', {}, [text(label)]), element('dd', {}, value)]));
}

/** Title, Credit, Project, first-public date, Item_Identifier, and Public_URL; the citation script adds the access date (R29.9). */
export function citationLine(view: ResearchItemView): ViewNode[] {
  const authors = view.credit.map((entry) => entry.name).join(', ');
  const url = absoluteUrl(view.path);
  return [
    text(`${authors === '' ? '' : `${authors}. `}“${view.title}.” ${view.project.name}, ResearchForce, ${formatDay(view.firstPublicOn)}. ${view.identifier}. `),
    element('a', { href: url }, [text(url)]), text(','),
  ];
}

function section(id: string, heading: string, children: readonly ViewNode[]): ElementNode {
  return element('section', { class: 'rf-item-section', 'aria-labelledby': `${id}-heading` }, [element('h2', { id: `${id}-heading` }, [text(heading)]), ...children]);
}

/** The page at a Public Research_Item's Public_URL (R24.1, R24.2, R24.13, R24.15, R29.9, R42.14). */
export function itemPage(context: PageContext, view: ResearchItemView, citationScript: string): PageSpec {
  const status = statusBlockFor(context, view.status);
  const summary = view.publicSummary === undefined ? undefined : context.rich(view.publicSummary);
  const { full } = view;
  const body: ViewNode[] = [
    element('p', { class: 'rf-item-kind' }, [text(KIND_NAMES[view.kind])]),
    ...(view.withdrawal === undefined ? [] : [withdrawalNotice(view.withdrawal)]),
    ...optional(status),
    metaList([
      ['Project', [element('a', { href: view.project.path }, [text(view.project.name)])]],
      ['Date', [text(formatDate(view.itemDate))]],
      ...(view.credit.length === 0 ? [] : [['Credit', creditNodes(view.credit)] as const]),
      ['Identifier', [text(view.identifier)]],
      ['First published', [text(formatDay(view.firstPublicOn))]],
    ]),
    ...(summary === undefined ? [] : [section('summary', 'Summary', [summary])]),
  ];
  if (full !== undefined) {
    const fields = fieldList(context, full.fields);
    if (fields !== undefined) body.push(section('details', 'Details', [fields]));
    if (full.logSummary !== undefined) body.push(section('log-summary', 'Log summary', [context.rich(full.logSummary), ...dissentNotes(context, full.dissent)]));
    const sections = entrySections(context, full.sections);
    if (sections.length > 0) body.push(section('entries', 'Entries', sections));
    const replies = replyTree(context, full.replies);
    if (replies !== undefined) body.push(section('discussion', 'Discussion', [replies]));
  }
  body.push(...optional(attachmentsSection(context, view.attachments, 'attachments')), ...optional(linksSection(context, view.links)));
  body.push(citationBlock(citationLine(view)), ...context.footnotes());
  return {
    path: view.path, title: view.title, body, meta: itemMeta(context.site, view, summary === undefined ? undefined : plainText(summary)),
    scripts: [citationScript], ...(view.project.accent === undefined ? {} : { accent: view.project.accent }),
  };
}

export const WITHHELD_TITLE = 'Withheld material';

/** A Withheld unit's page shows its Disclosure_Line and nothing else: no Project, no citation tags, no JSON-LD (R24.4, R45.11). */
export function withheldPage(view: WithheldView & { readonly path: string }): PageSpec {
  return { path: view.path, title: WITHHELD_TITLE, body: [disclosureLine(view.line)], meta: openGraph({ title: WITHHELD_TITLE, path: view.path, type: 'website' }) };
}
