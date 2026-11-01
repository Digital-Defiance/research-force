import type { AttachmentFile } from '@researchforce/markdown/journal/attachments';
import { computeImportPreview } from './preview';
import type { ImportPreview } from './preview';

/** What the screen posts to the worker: the journal text, the attachment metadata, and the chosen folder's file names. */
export interface PreviewRequest { readonly journal: string; readonly metadata: readonly AttachmentFile[]; readonly folderNames?: readonly string[] }
/** What the worker posts back: the computed preview or the reason it could not be computed. */
export type PreviewResult = { readonly preview: ImportPreview } | { readonly error: string };

/** A large journal is parsed, printed, and compared here so the UI thread never blocks on it (R27.7). */
globalThis.onmessage = (event: MessageEvent<PreviewRequest>) => {
  try {
    const { journal, metadata, folderNames } = event.data;
    globalThis.postMessage({ preview: computeImportPreview(journal, metadata, folderNames) } satisfies PreviewResult);
  } catch (error) {
    globalThis.postMessage({ error: error instanceof Error ? error.message : 'The journal could not be parsed.' } satisfies PreviewResult);
  }
};
