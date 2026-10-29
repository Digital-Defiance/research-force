/** Only these raster signatures may become image blob URLs. SVG and HTML never do. */
export function imageMime(bytes: Uint8Array): string | null {
  const prefix = Array.from(bytes.subarray(0, 12), (b) => String.fromCharCode(b)).join('');
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)) return 'image/png';
  if (prefix.startsWith('GIF87a') || prefix.startsWith('GIF89a')) return 'image/gif';
  if (prefix.startsWith('RIFF') && prefix.slice(8, 12) === 'WEBP') return 'image/webp';
  return null;
}
export function isPdf(bytes: Uint8Array): boolean { return String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-'; }
/** Pixel size read from the header of a verified raster image, so that its decoded size is known before the browser decodes it. */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const mime = imageMime(bytes);
  if (mime === 'image/png') return bytes.byteLength >= 24 ? { width: view.getUint32(16), height: view.getUint32(20) } : null;
  if (mime === 'image/gif') return bytes.byteLength >= 10 ? { width: view.getUint16(6, true), height: view.getUint16(8, true) } : null;
  if (mime === 'image/webp') {
    const kind = String.fromCharCode(...bytes.subarray(12, 16));
    if (kind === 'VP8X' && bytes.byteLength >= 30) return { width: 1 + (view.getUint8(24) | view.getUint8(25) << 8 | view.getUint8(26) << 16), height: 1 + (view.getUint8(27) | view.getUint8(28) << 8 | view.getUint8(29) << 16) };
    if (kind === 'VP8L' && bytes.byteLength >= 25) { const bits = view.getUint32(21, true); return { width: 1 + (bits & 0x3fff), height: 1 + (bits >> 14 & 0x3fff) }; }
    if (kind === 'VP8 ' && bytes.byteLength >= 30) return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    return null;
  }
  if (mime === 'image/jpeg') {
    let at = 2;
    while (at + 9 < bytes.byteLength) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1]!;
      if (marker === 0xff) { at += 1; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: view.getUint16(at + 5), width: view.getUint16(at + 7) };
      at += 2 + view.getUint16(at + 2);
    }
  }
  return null;
}
