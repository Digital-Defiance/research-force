import type { DraftField } from '@researchforce/domain/ai';
import type { RichText } from '@researchforce/domain/richtext';
import type { LoadedItem } from '../records/items';

/** The editor's unsaved text per field, keyed by field name; a present value is open in the editor (R44.1). */
export type EditorText = Readonly<Record<string, string>>;

/** The metadata of one Attachment the summary may draw on — NEVER its file contents (R44.1). */
export interface AttachmentMeta { readonly title: string; readonly caption: string | null; readonly origin: string }

/**
 * Assemble the text sent to the AI_Service for one AI_Draft, in Workspace display order, preferring the
 * editor's unsaved text where a field is open and the last-saved text elsewhere (R44.1, R44.2, R44.18). The
 * contents of Attachment files are NEVER included; only their metadata (title, caption, Origin) is (R44.1).
 *
 * The order mirrors how the Workspace shows a Research_Item to Members: the title first, then the kind's own
 * text fields in their stored order, then the Log_Summary, then the Entry_Sections in order, then the
 * Group_Note, then each Attachment's metadata. The caller cuts the result to the AI_Input_Limit, so this keeps
 * the whole text in order and leaves the cut to the limit (R44.3).
 */
export function assembleDraftInput(field: DraftField, item: LoadedItem, editor: EditorText, attachments: readonly AttachmentMeta[] = []): string {
  const parts: string[] = [];
  const add = (value: string | undefined | null): void => {
    const text = (value ?? '').trim();
    if (text.length > 0) parts.push(text);
  };

  // 1. The Research_Item's title and its kind's own text fields, in stored order, from the editor where open.
  add(editorOr(editor, 'title', item.base.title));
  for (const [key, value] of Object.entries(item.fields)) {
    if (SKIP_FIELDS.has(key)) continue;
    const text = richTextOf(value);
    if (text === undefined) continue; // scalar/selection fields carry no free text to summarize
    add(editorOr(editor, key, text));
  }

  // 2. The Log_Summary, as the Research_Item's text, from the editor where open. For a Log_Summary draft the
  //    field being drafted is left for the model to produce, so its current text is not fed back as input.
  if (field !== 'logSummary') add(editorOr(editor, 'logSummary', item.base.logSummary?.text));

  // 3. The Entry_Sections in their display order, each from the editor where that section is open.
  for (const section of sectionsOf(item)) {
    add(editorOr(editor, `sections.${section.id}`, section.content.text));
  }

  // 4. The Group_Note, if any (R41.7); its editor key is the Group_Note itself.
  add(editorOr(editor, 'groupNote', item.groupNote?.text.text));

  // 5. Each Attachment's metadata — title, caption, Origin — NEVER its file contents (R44.1).
  for (const attachment of attachments) {
    add(attachment.title);
    add(attachment.caption ?? undefined);
    add(attachment.origin);
  }

  return parts.join('\n\n');
}

/** Fields that carry no free text to summarize, or that are handled in their own ordered step. */
const SKIP_FIELDS: ReadonlySet<string> = new Set([
  'title', 'logSummary', 'sections', 'groupNote',
  // Date, selection, and id-list fields are not free text; they are excluded from the summary input.
  'startDate', 'endDate', 'date', 'statusValueId', 'reliabilityId', 'rightsStatusId', 'outcomeId',
  'phaseId', 'relatedMemberIds', 'parties', 'direction', 'sourceKind', 'leadId', 'groups', 'alternatives',
]);

/** The editor's unsaved text for `key` when open, else the saved `fallback`; a blank editor value counts as open-empty. */
function editorOr(editor: EditorText, key: string, fallback: string | undefined | null): string | undefined {
  if (Object.hasOwn(editor, key)) return editor[key];
  return fallback ?? undefined;
}

/** The `.text` of a RichText-valued field, or undefined when the value is not free text. */
function richTextOf(value: unknown): string | undefined {
  if (value !== null && typeof value === 'object' && typeof (value as RichText).text === 'string' && Array.isArray((value as RichText).spans)) {
    return (value as RichText).text;
  }
  return undefined;
}

/** The Entry_Sections of a Journal_Entry in display order, or none for other kinds. */
function sectionsOf(item: LoadedItem): readonly { readonly id: string; readonly content: RichText }[] {
  const sections = item.fields['sections'];
  return Array.isArray(sections) ? (sections as { id: string; content: RichText }[]) : [];
}
