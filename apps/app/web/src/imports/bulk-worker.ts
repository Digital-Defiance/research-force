import { computeBulkPreview } from './bulk-preview';
import type { BulkPreview, BulkPreviewRequest } from './bulk-preview';

/** What the worker posts back: the computed preview or the reason it could not be computed. */
export type BulkPreviewResult = { readonly preview: BulkPreview } | { readonly error: string };

/** The manifest is parsed off the UI thread so a large CSV never blocks it (R37.3). The compute stays pure in `bulk-preview`. */
globalThis.onmessage = (event: MessageEvent<BulkPreviewRequest>) => {
  try {
    globalThis.postMessage({ preview: computeBulkPreview(event.data) } satisfies BulkPreviewResult);
  } catch (error) {
    globalThis.postMessage({ error: error instanceof Error ? error.message : 'The manifest could not be parsed.' } satisfies BulkPreviewResult);
  }
};
