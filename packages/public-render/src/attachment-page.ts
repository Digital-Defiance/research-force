import { element, text, type ElementNode, type ViewNode } from '@researchforce/domain/tree';
import type { AttachmentView } from '@researchforce/kernel/views';
import { PageContext, attachmentDetails, creditNodes, linksSection, replyTree } from './blocks';
import { FILE_KIND_NAMES, formatSize } from './format';
import type { PageSpec } from './frame';
import { metaList } from './item-page';
import { openGraph } from './meta';

/** The Parent named by its own view: a Research_Item or Attachment by title; a Reply has no title of its own. */
function parentName(context: PageContext, view: AttachmentView): string {
  const parent = context.view(view.parent.key);
  return parent?.tag === 'research_item' || parent?.tag === 'attachment' ? parent.title : 'The discussion it belongs to';
}

/** The page at a Public Attachment's Public_URL (R24.3, R24.9, R24.10, R24.15, R29.11, R29.12). */
export function attachmentPage(context: PageContext, view: AttachmentView): PageSpec {
  const replies = replyTree(context, view.replies);
  const links = linksSection(context, view.links);
  const body: ViewNode[] = [
    element('p', { class: 'rf-item-kind' }, [text('Attachment')]),
    metaList([
      ['Project', [element('a', { href: view.project.path }, [text(view.project.name)])]],
      ['Attached to', [element('a', { href: view.parent.path }, [text(parentName(context, view))])]],
      ['File kind', [text(FILE_KIND_NAMES[view.fileKind])]],
      ['Size', [text(formatSize(view.size))]],
      ...(view.caption === undefined ? [] : [['Caption', [text(view.caption)]] as const]),
      ...(view.credit.length === 0 ? [] : [['Credit', creditNodes(view.credit)] as const]),
      ['Origin', [text(view.origin)]],
      ['Identifier', [text(view.identifier)]],
    ]),
    ...attachmentDetails(context, view),
    ...(links === undefined ? [] : [links]),
    ...(replies === undefined ? [] : [element('section', { class: 'rf-item-section', 'aria-labelledby': 'discussion-heading' }, [
      element('h2', { id: 'discussion-heading' }, [text('Discussion')]), replies,
    ]) satisfies ElementNode]),
    ...context.footnotes(),
  ];
  return {
    path: view.path, title: view.title, body, meta: openGraph({ title: view.title, path: view.path, type: 'article' }),
    ...(view.project.accent === undefined ? {} : { accent: view.project.accent }),
  };
}
