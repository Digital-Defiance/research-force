import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractAttachmentMetadata, insideRepository, repositoryRoot } from '../export-attachment-metadata';
import { dryRun, formatReport, readMetadata } from '../migration-dry-run';

describe('extractAttachmentMetadata', () => {
  it('reads exported entries statically, maps field names, and resolves asset imports and constants', () => {
    const source = [
      "import scanUrl from '../assets/synthetic-scan.png';",
      "import type { Item } from './types';",
      "const base = '/files';",
      'const shared = { credit: { name: "Ada Example" }, origin: "Synthetic archive" };',
      'export const attachments: Item[] = [',
      "  { title: 'Synthetic ledger', kind: 'PDF', ...shared, creditLine: `Courtesy ${'A. Example'}`, caption: 'A caption', sizeLabel: '1.2 MB', sitePath: `${base}/ledger.pdf` },",
      "  { name: 'Scan', type: 'image', src: scanUrl, icon: () => null, size: 340 } satisfies Item,",
      '];',
      "export default { notes: { title: 'Not an attachment' } };",
    ].join('\n');
    const result = extractAttachmentMetadata(source);
    expect(result.entries).toEqual([
      { sitePath: '/files/ledger.pdf', fileName: 'ledger.pdf', title: 'Synthetic ledger', kind: 'PDF', credit: 'Ada Example', creditLine: 'Courtesy A. Example', caption: 'A caption', sizeLabel: '1.2 MB', origin: 'Synthetic archive' },
      { sitePath: '../assets/synthetic-scan.png', fileName: 'synthetic-scan.png', title: 'Scan', kind: 'image', sizeLabel: '340' },
    ]);
    expect(result.unmappedKeys).toEqual(['icon']);
    expect(result.unevaluatedKeys).toEqual(['icon']);
  });

  it('takes the site path from a record key and falls back to unexported constants', () => {
    const result = extractAttachmentMetadata("const files = { '/attachments/plan.dwg': { title: 'Plan' }, other: 3 };");
    expect(result.entries).toEqual([{ sitePath: '/attachments/plan.dwg', fileName: 'plan.dwg', title: 'Plan' }]);
  });

  it('keeps one entry per site path, filling missing fields from repeated entries', () => {
    const source = [
      "export const plan = { href: '/files/plan.pdf', title: 'Plan' };",
      "export const all = [plan, { href: '/files/plan.pdf', caption: 'Later caption', title: 'Other' }];",
    ].join('\n');
    expect(extractAttachmentMetadata(source).entries).toEqual([{ sitePath: '/files/plan.pdf', fileName: 'plan.pdf', title: 'Plan', caption: 'Later caption' }]);
  });

  it('refuses output paths inside the repository', () => {
    expect(insideRepository(join(repositoryRoot, 'metadata.json'))).toBe(true);
    expect(insideRepository(join(repositoryRoot, 'tools', 'missing-folder', 'metadata.json'))).toBe(true);
    expect(insideRepository(join(tmpdir(), 'metadata.json'))).toBe(false);
  });
});

describe('dryRun', () => {
  const journal = [
    '# Synthetic journal secret-front',
    '',
    '### 1 Phase secret-one',
    '',
    'See `/files/ledger.pdf` and [plan](/files/plan.dwg).',
    '',
    '### 2 Phase secret-two',
    '',
    'Also `/files/ledger.pdf`, `/files/extra.jpg`, and `src/app.tsx`.',
    '',
  ].join('\n');
  const metadata = readMetadata(JSON.stringify([
    { sitePath: '/files/ledger.pdf', fileName: 'ledger.pdf', title: 'secret-title' },
    { sitePath: '/files/plan.dwg' },
    { sitePath: '/files/orphan.txt' },
  ]));

  it('reports counts, parents, unreferenced metadata, and referenced files without metadata', () => {
    const report = dryRun(journal, metadata, ['ledger.pdf', 'nested/extra.jpg', 'plan.dwg', 'loose.bin']);
    expect(report).toMatchObject({
      entries: 2, frontMatter: true, unassigned: [], comparison: { passes: true, mismatches: [] }, metadataEntries: 3,
      parents: [{ fileName: 'ledger.pdf', parent: '1' }, { fileName: 'plan.dwg', parent: '1' }, { fileName: 'orphan.txt', parent: null }],
      unreferenced: ['orphan.txt'],
      referencedWithoutMetadata: [{ fileName: 'extra.jpg', entry: '2' }],
      otherPathReferences: 1,
      folder: { files: 4, withoutMetadata: ['nested/extra.jpg', 'loose.bin'], missing: ['orphan.txt'] },
    });
  });

  it('prints no journal or metadata text', () => {
    const output = formatReport(dryRun(`${journal}\nStray secret-tail\n`, metadata));
    expect(output).not.toMatch(/secret|Synthetic|Phase|See|Also/u);
    expect(output).toContain('Metadata entries that no entry references: 1');
  });
});
