import { describe, expect, it } from 'vitest';
import { decodeShellBundle, encodeShellBundle } from '../src/shell-bundle';
const enc = (text: string) => new TextEncoder().encode(text);
describe('shell bundle codec', () => {
  const entries = [
    { path: '/assets/form.js', contentType: 'text/javascript', content: enc('console.log(1)') },
    { path: '/fonts/a.woff2', contentType: 'font/woff2', content: new Uint8Array([0, 255, 1, 2]) },
    { path: '/assets/empty.css', contentType: 'text/css', content: new Uint8Array() },
  ];
  it('round-trips paths, content types and bytes in order', () => {
    expect(decodeShellBundle(encodeShellBundle(entries))).toEqual(entries);
  });
  it('round-trips an empty bundle', () => { expect(decodeShellBundle(encodeShellBundle([]))).toEqual([]); });
  it('throws on a truncated bundle rather than returning a partial set', () => {
    const bytes = encodeShellBundle(entries);
    for (const cut of [0, 3, 10, bytes.length - 5, bytes.length - 1]) expect(() => decodeShellBundle(bytes.slice(0, cut))).toThrow();
  });
  it('throws on a bundle that is not the layout (HTML fallback) and on trailing bytes', () => {
    expect(() => decodeShellBundle(enc('<!doctype html><html></html>'))).toThrow();
    const bytes = encodeShellBundle(entries);
    const extra = new Uint8Array(bytes.length + 1); extra.set(bytes);
    expect(() => decodeShellBundle(extra)).toThrow(/trailing/);
  });
});
