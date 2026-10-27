// Feature: research-collab-cms, Property 44: File kind is a total function of the extension
import { expect, it } from 'vitest';
import { fc } from '@researchforce/testing/fc';
import { scalarTextArb } from '../arbitraries';
import { fileKind } from '../../src/file-kinds';

// Independent extension table from the design, without importing the implementation's registry.
const extensions = new Map<string, string>([
  ...['pdf'].map((key) => [key, 'pdf'] as const),
  ...['jpg', 'jpeg', 'png', 'gif', 'webp', 'tif', 'tiff', 'bmp', 'heic', 'svg'].map((key) => [key, 'image'] as const),
  ...['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar'].map((key) => [key, 'archive'] as const),
  ...['xlsx', 'xls', 'ods'].map((key) => [key, 'spreadsheet'] as const),
  ['csv', 'csv'],
  ...['json', 'jsonl', 'ndjson', 'xml', 'yaml', 'yml'].map((key) => [key, 'structured_data'] as const),
  ...['log', 'txt'].map((key) => [key, 'text_log'] as const),
  ...['mp4', 'mov', 'webm', 'mkv', 'avi'].map((key) => [key, 'video'] as const),
]);

it('depends only on the lower-cased final extension for arbitrary Unicode file names', () => {
  const names = fc.oneof(scalarTextArb, fc.tuple(scalarTextArb, fc.constantFrom(...extensions.keys()), fc.boolean()).map(([prefix, extension, upper]) => `${prefix}.${upper ? extension.toUpperCase() : extension}`));
  fc.assert(fc.property(names, scalarTextArb, (name, replacementPrefix) => {
    const pieces = name.split('.');
    const expected = pieces.length === 1 ? 'other' : extensions.get(pieces.at(-1)!.toLowerCase()) ?? 'other';
    expect(fileKind(name)).toBe(expected);
    if (pieces.length > 1) expect(fileKind(`${replacementPrefix}.${pieces.at(-1)!}`)).toBe(expected);
    expect(['pdf', 'image', 'archive', 'spreadsheet', 'csv', 'structured_data', 'text_log', 'video', 'other']).toContain(fileKind(name));
  }));
});
