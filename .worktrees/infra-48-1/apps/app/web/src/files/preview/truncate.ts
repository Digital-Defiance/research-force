import { TEXT_PREVIEW_BYTES } from '@researchforce/domain/files';

/** Decode only complete UTF-8 characters in the first decimal megabyte. */
export function previewText(bytes: Uint8Array, totalBytes = bytes.byteLength) {
  const shownBytes = Math.min(bytes.byteLength, TEXT_PREVIEW_BYTES);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const text = decoder.decode(bytes.subarray(0, shownBytes), { stream: shownBytes < totalBytes });
  if (text.includes('\0')) throw new Error('The file does not match its recorded text format.');
  return { text, shownBytes, totalBytes };
}
