import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { JournalImportScreen } from '../src/imports/journal';
import { computeImportPreview, readEntryDates, readImportEntries } from '../src/imports/preview';
import { fakeApi, json, renderScreen } from './helpers';

const JOURNAL = `# The P1030680 journal

A summary paragraph before the first phase.

### 0 First steps

We began with the intercept and a ledger.

- one item
- two item

### 86 A later phase

The later work, referencing [a file](/attachments/ledger-1943.pdf).
`;

const METADATA = JSON.stringify([
  { sitePath: '/attachments/ledger-1943.pdf', fileName: 'ledger-1943.pdf', title: 'The 1943 ledger', sizeBytes: 3, sha256: 'a'.repeat(64), creditingContributor: '01J00000000000000000000001', origin: 'The county archive' },
  { sitePath: '/attachments/unused.pdf', fileName: 'unused.pdf', title: 'An unused scan', sizeBytes: 3, sha256: 'b'.repeat(64), creditingContributor: '01J00000000000000000000001' },
]);

const baseHandlers = () => ({
  'GET /projects': json({ projects: [{ id: '01J0000000000000000000PR01', name: 'A synthetic Project' }] }),
  'GET /members': json({ members: [] }),
});

const jsonFile = (text: string, name: string): File => new File([text], name, { type: 'application/json' });

describe('the journal import preview computation', () => {
  it('counts entries, sections, and unassigned attachments, and resolves each attachment parent (R27.7, R26.15)', () => {
    const preview = computeImportPreview(JOURNAL, readImportEntries(METADATA));
    expect(preview.entries).toBe(2);
    expect(preview.frontMatter).toBe(true);
    expect(preview.comparison.passes).toBe(true);
    expect(preview.parents).toEqual([{ fileName: 'ledger-1943.pdf', parent: '86' }, { fileName: 'unused.pdf', parent: null }]);
    expect(preview.unassignedAttachments).toEqual(['unused.pdf']);
  });
});

describe('the entry dates file', () => {
  it('keeps only the four date fields of each entry and refuses a malformed date or shape', () => {
    expect(readEntryDates(JSON.stringify({ '0': { startDate: '2026-01-02', startDateApprox: true, basis: 'ignored' }, 'front-matter': { startDate: '2026-01-01', endDate: '2026-01-03' } })))
      .toEqual({ '0': { startDate: '2026-01-02', startDateApprox: true }, 'front-matter': { startDate: '2026-01-01', endDate: '2026-01-03' } });
    expect(() => readEntryDates('[]')).toThrow(/object keyed/u);
    expect(() => readEntryDates(JSON.stringify({ '0': { startDate: '2 Jan 2026' } }))).toThrow(/YYYY-MM-DD/u);
    expect(() => readEntryDates(JSON.stringify({ '0': { startDateApprox: 'yes' } }))).toThrow(/true or false/u);
  });
});
describe('the journal import screen', () => {
  it('is hidden from a Member without import.run (R26.1)', () => {
    const api = fakeApi(baseHandlers());
    renderScreen(<JournalImportScreen />, { client: api.client });
    expect(screen.getByText('This page does not exist, or you cannot see it.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start the import' })).toBeNull();
  });

  it('preselects Restricted and states who can read a Restricted import (R47.13)', async () => {
    const api = fakeApi(baseHandlers());
    renderScreen(<JournalImportScreen />, { client: api.client, administrator: true });
    const select = await screen.findByLabelText('Access level') as HTMLSelectElement;
    expect(select.value).toBe('restricted');
    expect(screen.getByText(/The importing Administrator, as Owner, and every Administrator can read Restricted items/u)).toBeTruthy();
  });

  it('computes and shows the report preview (R27.7, R27.8, R26.15)', async () => {
    const api = fakeApi(baseHandlers());
    const compute = (request: { journal: string; metadata: readonly { sitePath: string; fileName: string }[] }) => Promise.resolve(computeImportPreview(request.journal, request.metadata));
    renderScreen(<JournalImportScreen compute={compute} />, { client: api.client, administrator: true });
    fireEvent.change(await screen.findByLabelText('Journal file'), { target: { files: [new File([JOURNAL], 'journal.md', { type: 'text/markdown' })] } });
    fireEvent.change(screen.getByLabelText('Attachment metadata (JSON)'), { target: { files: [jsonFile(METADATA, 'meta.json')] } });
    await screen.findByText('Metadata entries: 2');
    fireEvent.click(screen.getByRole('button', { name: 'Preview the import' }));
    const report = await screen.findByRole('region', { name: 'Import preview' });
    expect(report.textContent).toContain('Entries with a phase heading: 2');
    expect(report.textContent).toContain('Printer comparison: passes');
    const unassigned = screen.getByRole('region', { name: 'Files sent to the Unassigned Attachments Source' });
    expect(unassigned.textContent).toContain('unused.pdf');
  });

  it('starts the job with the chosen access and shows the stored report (R26.11, R27.8, R47.13)', async () => {
    const report = {
      counts: { entries: 2, sections: 4, attachments: 1 },
      entries: { created: [{ importKey: '0', title: 'First steps', lines: [5, 11] }], skipped: [], failed: [] },
      files: { created: [{ fileName: 'ledger-1943.pdf' }], unassigned: [{ fileName: 'unused.pdf' }], skipped: [], failed: [] },
      comparison: { passes: true, mismatches: [] },
      printed: 'rf-private/imports/JOB/journal.md',
    };
    const api = fakeApi({
      ...baseHandlers(),
      'POST /imports/journal': json({ jobId: '01J0000000000000000000JB01' }, 202),
      'GET /imports/journal/01J0000000000000000000JB01': json({ state: 'complete', progress: { entries: 2 }, report, printedUrl: '/imports/journal/01J0000000000000000000JB01/printed' }),
    });
    const compute = (request: { journal: string; metadata: readonly { sitePath: string; fileName: string }[] }) => Promise.resolve(computeImportPreview(request.journal, request.metadata));
    renderScreen(<JournalImportScreen compute={compute} />, { client: api.client, administrator: true });

    fireEvent.change(await screen.findByLabelText('Journal file'), { target: { files: [new File([JOURNAL], 'journal.md', { type: 'text/markdown' })] } });
    fireEvent.change(screen.getByLabelText('Project (required)'), { target: { value: '01J0000000000000000000PR01' } });
    await screen.findByText('Journal: journal.md');
    fireEvent.click(screen.getByRole('button', { name: 'Start the import' }));

    await screen.findByRole('region', { name: 'Import report' });
    expect(screen.getByText('Access level for this import: Restricted.')).toBeTruthy();
    expect(screen.getByText('Entries created: 1')).toBeTruthy();
    expect(screen.getByText('Download the printed Journal (Markdown)')).toBeTruthy();

    const posted = api.calls.find((call) => call.method === 'POST' && call.path === '/imports/journal');
    expect(posted).toBeDefined();
    const body = posted!.body as { projectId: string; accessLevel: string; journal: string; attachments?: unknown };
    expect(body).toMatchObject({ projectId: '01J0000000000000000000PR01', accessLevel: 'restricted' });
    expect(body.journal).toContain('P1030680');
    expect(body.attachments).toBeUndefined();
    expect((body as { meta?: unknown }).meta).toBeUndefined();
  });
  it('sends the chosen entry dates as `meta` (R26.1)', async () => {
    const api = fakeApi({ ...baseHandlers(), 'POST /imports/journal': json({ jobId: '01J0000000000000000000JB01' }, 202), 'GET /imports/journal/01J0000000000000000000JB01': json({ state: 'queued' }) });
    renderScreen(<JournalImportScreen />, { client: api.client, administrator: true });
    fireEvent.change(await screen.findByLabelText('Journal file'), { target: { files: [new File([JOURNAL], 'journal.md', { type: 'text/markdown' })] } });
    fireEvent.change(screen.getByLabelText('Project (required)'), { target: { value: '01J0000000000000000000PR01' } });
    fireEvent.change(screen.getByLabelText('Entry dates (JSON, optional)'), { target: { files: [jsonFile(JSON.stringify({ '86': { startDate: '2026-02-03', startDateApprox: true } }), 'dates.json')] } });
    await screen.findByText('Entry dates for 1 entries');
    fireEvent.click(screen.getByRole('button', { name: 'Start the import' }));
    await screen.findByText('The import is running.');
    const posted = api.calls.find((call) => call.method === 'POST' && call.path === '/imports/journal');
    expect((posted!.body as { meta?: unknown }).meta).toEqual({ '86': { startDate: '2026-02-03', startDateApprox: true } });
  });
});
