import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// The screen's file hashing uses the uploads Worker; stub it so the test needs no real Worker and gets a stable digest.
vi.mock('../src/files/upload', () => ({
  hashFile: () => Promise.resolve({ sha256: 'c'.repeat(64), parts: ['c'.repeat(64)] }),
}));

import { BulkImportScreen } from '../src/imports/bulk';
import { computeBulkPreview } from '../src/imports/bulk-preview';
import type { BulkPreview, BulkPreviewRequest } from '../src/imports/bulk-preview';
import { fakeApi, json, renderScreen } from './helpers';

const HEADER = 'row_key,kind,title,files,origin';
const MANIFEST = `${HEADER}\nr1,topic,A topic,\nr2,source,A source,ledger.pdf,The county archive`;
const BAD_MANIFEST = 'kind,title\nsource,Missing the row key column';

const baseHandlers = () => ({
  'GET /projects': json({ projects: [{ id: '01J0000000000000000000PR01', name: 'A synthetic Project' }] }),
  'GET /value-sets': json({ valueSets: { rights_status: [{ id: '0000000000000000000000R001', set: 'rights_status', name: 'Unknown', retired: false, locked: true, position: 0, publicDescription: null, rev: 1 }] } }),
});

const csvFile = (text: string, name = 'manifest.csv'): File => new File([text], name, { type: 'text/csv' });

/** The injected compute: run the pure parser synchronously, as 36.3's test injects `computeImportPreview`. */
const compute = (request: BulkPreviewRequest): Promise<BulkPreview> => Promise.resolve(computeBulkPreview(request));

describe('the bulk import preview computation', () => {
  it('parses a CSV manifest, counts rows, and lists files no row names (R37.3, R37.4)', () => {
    const preview = computeBulkPreview({ format: 'csv', manifest: new TextEncoder().encode(MANIFEST), folderNames: ['ledger.pdf', 'unused.pdf'], currentRightsStatuses: [] });
    expect(preview.parsed).toBe(true);
    expect(preview.errors).toEqual([]);
    expect(preview.rows).toBe(2);
    expect(preview.notImported).toEqual(['unused.pdf']);
  });

  it('reports the parser errors for a manifest missing a required column (R37.3)', () => {
    const preview = computeBulkPreview({ format: 'csv', manifest: new TextEncoder().encode(BAD_MANIFEST), folderNames: [], currentRightsStatuses: [] });
    expect(preview.parsed).toBe(true);
    expect(preview.errors.length).toBeGreaterThan(0);
  });
});

describe('the bulk import screen', () => {
  it('is hidden from a Member without import.run (R37.1)', () => {
    const api = fakeApi(baseHandlers());
    renderScreen(<BulkImportScreen />, { client: api.client });
    expect(screen.getByText('This page does not exist, or you cannot see it.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start the import' })).toBeNull();
  });

  it('preselects Restricted and states who can read a Restricted import (R47.13)', async () => {
    const api = fakeApi(baseHandlers());
    renderScreen(<BulkImportScreen />, { client: api.client, administrator: true });
    const select = await screen.findByLabelText('Access level') as HTMLSelectElement;
    expect(select.value).toBe('restricted');
    expect(screen.getByText(/The importing Administrator, as Owner, and every Administrator can read Restricted items/u)).toBeTruthy();
  });

  it('computes and shows the browser-side validation report (R37.3)', async () => {
    const api = fakeApi(baseHandlers());
    renderScreen(<BulkImportScreen compute={compute} />, { client: api.client, administrator: true });
    fireEvent.change(await screen.findByLabelText('Manifest file'), { target: { files: [csvFile(MANIFEST)] } });
    fireEvent.change(screen.getByLabelText('Attachment folder'), { target: { files: [csvFile('x', 'ledger.pdf'), csvFile('y', 'unused.pdf')] } });
    await screen.findByText('Files chosen: 2');
    fireEvent.click(screen.getByRole('button', { name: 'Check the manifest' }));
    const report = await screen.findByRole('region', { name: 'Validation preview' });
    expect(report.textContent).toContain('The manifest reads cleanly: 2 rows.');
    const noName = screen.getByRole('region', { name: 'Files no row names' });
    expect(noName.textContent).toContain('unused.pdf');
  });

  it('starts the job with the chosen access, manifest, and files, then shows the stored report (R37.11, R47.13)', async () => {
    const report = {
      counts: { created: 2, skipped: 0, failed: 0, attachments: 1 },
      accessChoice: 'restricted',
      rows: { created: [{ row: 2, rowKey: 'r1' }, { row: 3, rowKey: 'r2' }], skipped: [], failed: [] },
      files: { created: [{ row: 3, rowKey: 'r2', fileName: 'ledger.pdf' }], failed: [] },
    };
    const api = fakeApi({
      ...baseHandlers(),
      'POST /imports/bulk': json({ jobId: '01J0000000000000000000JB01', errors: [], notImported: ['unused.pdf'] }, 202),
      'GET /imports/bulk/01J0000000000000000000JB01': json({ state: 'complete', progress: { created: 2, attachments: 1 }, report }),
    });
    renderScreen(<BulkImportScreen compute={compute} />, { client: api.client, administrator: true });

    fireEvent.change(await screen.findByLabelText('Manifest file'), { target: { files: [csvFile(MANIFEST)] } });
    fireEvent.change(screen.getByLabelText('Project (required)'), { target: { value: '01J0000000000000000000PR01' } });
    fireEvent.change(screen.getByLabelText('Attachment folder'), { target: { files: [csvFile('ledger bytes', 'ledger.pdf')] } });
    await screen.findByText('Manifest: manifest.csv');
    fireEvent.click(screen.getByRole('button', { name: 'Start the import' }));

    await screen.findByRole('region', { name: 'Import report' });
    expect(screen.getByText('Access level for rows that set none: Restricted.')).toBeTruthy();
    expect(screen.getByText('Rows created: 2')).toBeTruthy();
    expect(screen.getByText('Attachments created: 1')).toBeTruthy();

    const posted = api.calls.find((call) => call.method === 'POST' && call.path === '/imports/bulk');
    expect(posted).toBeDefined();
    const body = posted!.body as { projectId: string; accessLevel: string; manifestFormat: string; manifest: string; files?: { fileName: string; sizeBytes: number; sha256: string; content: string }[] };
    expect(body).toMatchObject({ projectId: '01J0000000000000000000PR01', accessLevel: 'restricted', manifestFormat: 'csv' });
    // The manifest is carried as base64; decoding it gives back the chosen CSV text (R38.1).
    expect(atob(body.manifest)).toContain('row_key,kind,title');
    expect(body.files).toHaveLength(1);
    expect(body.files![0]).toMatchObject({ fileName: 'ledger.pdf', sha256: 'c'.repeat(64) });
    expect(atob(body.files![0]!.content)).toBe('ledger bytes');
  });

  it('shows the validation-error report the server returns, and that nothing was created (R37.3, R37.11)', async () => {
    const report = {
      counts: { created: 0, skipped: 0, failed: 0, attachments: 0 },
      accessChoice: 'restricted',
      rows: { created: [], skipped: [], failed: [] },
      files: { created: [], failed: [] },
      validation: { errors: [{ row: 2, column: 'files', fileName: 'ledger.pdf', reason: 'The file is not in the uploaded folder.' }], notImported: ['stray.pdf'] },
    };
    const api = fakeApi({
      ...baseHandlers(),
      'POST /imports/bulk': json({ jobId: '01J0000000000000000000JB02', errors: report.validation.errors, notImported: report.validation.notImported }, 202),
      'GET /imports/bulk/01J0000000000000000000JB02': json({ state: 'complete', progress: null, report }),
    });
    renderScreen(<BulkImportScreen compute={compute} />, { client: api.client, administrator: true });

    fireEvent.change(await screen.findByLabelText('Manifest file'), { target: { files: [csvFile(MANIFEST)] } });
    fireEvent.change(screen.getByLabelText('Project (required)'), { target: { value: '01J0000000000000000000PR01' } });
    await screen.findByText('Manifest: manifest.csv');
    fireEvent.click(screen.getByRole('button', { name: 'Start the import' }));

    await screen.findByRole('region', { name: 'Import report' });
    expect(screen.getByText('The manifest did not validate, so nothing was created.')).toBeTruthy();
    const errors = screen.getByRole('region', { name: 'Validation errors' });
    expect(errors.textContent).toContain('ledger.pdf');
    expect(errors.textContent).toContain('The file is not in the uploaded folder.');
    const notImported = screen.getByRole('region', { name: 'Files not imported' });
    expect(notImported.textContent).toContain('stray.pdf');
  });
});
