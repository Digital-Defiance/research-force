/** Limits count Unicode code points, never UTF-16 code units or grapheme clusters. */
export function cpLength(text: string): number {
  let length = 0;
  for (const _character of text) length++;
  return length;
}

export function isBlank(text: string): boolean { return /^[\p{White_Space}\uFEFF]*$/u.test(text); }

export function isCodePointBoundary(text: string, offset: number): boolean {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) return false;
  if (offset === 0 || offset === text.length) return true;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}

/** A code-point slice with the same indexing semantics as Array.slice; no normalization. */
export function cpSlice(text: string, start: number, end?: number): string {
  return Array.from(text).slice(start, end).join('');
}
