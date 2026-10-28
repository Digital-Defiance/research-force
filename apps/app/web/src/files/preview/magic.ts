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
