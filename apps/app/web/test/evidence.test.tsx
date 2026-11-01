import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CurationQueueScreen } from '../src/evidence/queue';
import { EvidenceEditorScreen } from '../src/evidence/editor';
import type { CurationQueueView, EvidenceGrantView, UnitEvidenceView } from '../src/types';
import { fakeApi, json, renderScreen } from './helpers';

const UNIT_ID = '01J0000000000000000000EV01';
const ROOT_ID = '01J0000000000000000000RT01';

const queue = (items: CurationQueueView['items']): CurationQueueView => ({ items, next: null });
const emptyUnit = (overrides: Partial<UnitEvidenceView['unit']> = {}): UnitEvidenceView => ({
  unit: { id: UNIT_ID, kind: 'source', identifier: 'RF-0001', title: 'A synthetic source', contentRev: 1, fileHash: null, fileSize: null, ...overrides },
  grants: [],
});

describe('the evidence curation queue', () => {
  it('lists units that still need a grant, naming the reason, with a link to record one', async () => {
    const api = fakeApi({
      'GET /projects': json({ projects: [] }),
      'GET /disclosure/evidence-queue': json(queue([
        { id: UNIT_ID, kind: 'source', identifier: 'RF-0001', title: 'A synthetic source', rootItem: { id: ROOT_ID, identifier: 'RF-0001', title: 'A root' }, project: { id: 'P1', name: 'Project one' }, reason: 'no_grant' },
      ])),
    });
    renderScreen(<CurationQueueScreen />, { client: api.client, administrator: true });
    expect((await screen.findByText(/A synthetic source/)).textContent).toContain('A synthetic source');
    expect(screen.getByText(/No permission evidence recorded/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Record a grant' }).getAttribute('href')).toContain(`/evidence/units/${UNIT_ID}`);
  });

  it('says the queue is clear when nothing needs a grant', async () => {
    const api = fakeApi({ 'GET /projects': json({ projects: [] }), 'GET /disclosure/evidence-queue': json(queue([])) });
    renderScreen(<CurationQueueScreen />, { client: api.client, administrator: true });
    expect(await screen.findByText(/has a verified grant/)).toBeTruthy();
  });
});

describe('the manual evidence editor', () => {
  it('says that recording a grant is not publishing and does not share a file', async () => {
    const api = fakeApi({ [`GET /units/${UNIT_ID}/evidence`]: json(emptyUnit()) });
    renderScreen(<EvidenceEditorScreen id={UNIT_ID} />, { client: api.client, administrator: true });
    expect(await screen.findByText(/Recording a grant is not publishing/)).toBeTruthy();
    expect(screen.getByText(/separately authorized feature, never an arbitrary download/)).toBeTruthy();
  });

  it('records a grant and shows the saved notice', async () => {
    let recorded: unknown;
    const grant: EvidenceGrantView = {
      id: 'G1', unitId: UNIT_ID, rootId: ROOT_ID, partyId: null, grantorName: 'Jane Writer', claimedAuthority: 'The writer',
      source: 'letter', evidenceReference: 'box 4', snapshotHash: 'a'.repeat(64), naming: 'unnamed', label: null, licence: null,
      expiresAt: null, verified: true, supersedesId: null, supersededById: null, recordedBy: 'M', recordedAt: '2026-10-31T00:00:00.000Z',
      reason: null, uses: ['publication'], covered: [{ unitId: UNIT_ID, contentRev: 1 }], withdrawnAt: null,
    };
    const api = fakeApi({
      [`GET /units/${UNIT_ID}/evidence`]: json(emptyUnit()),
      'POST /evidence': (call) => { recorded = call.body; return json(grant, 201); },
    });
    renderScreen(<EvidenceEditorScreen id={UNIT_ID} />, { client: api.client, administrator: true });
    fireEvent.change(await screen.findByLabelText(/Granting party/), { target: { value: 'Jane Writer' } });
    fireEvent.change(screen.getByLabelText(/Claimed authority/), { target: { value: 'The writer' } });
    fireEvent.change(screen.getByLabelText(/Evidence reference/), { target: { value: 'box 4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record this grant' }));
    await waitFor(() => expect(screen.getByText(/permission evidence was recorded/)).toBeTruthy());
    expect((recorded as { unitId: string }).unitId).toBe(UNIT_ID);
    expect((recorded as { uses: string[] }).uses).toEqual(['publication']);
  });

  it('shows the live status and asserted authority of a recorded grant', async () => {
    const grant: EvidenceGrantView = {
      id: 'G1', unitId: UNIT_ID, rootId: ROOT_ID, partyId: null, grantorName: 'Jane Writer', claimedAuthority: 'The writer of the letter',
      source: 'letter', evidenceReference: 'box 4, folder 2', snapshotHash: 'a'.repeat(64), naming: 'named', label: 'a correspondent', licence: null,
      expiresAt: null, verified: true, supersedesId: null, supersededById: null, recordedBy: 'M', recordedAt: '2026-10-31T00:00:00.000Z',
      reason: null, uses: ['publication', 'file_share'], covered: [{ unitId: UNIT_ID, contentRev: 1, fileHash: 'c'.repeat(64), fileSize: 2048 }], withdrawnAt: null,
    };
    const api = fakeApi({ [`GET /units/${UNIT_ID}/evidence`]: json({ ...emptyUnit(), grants: [grant] }) });
    renderScreen(<EvidenceEditorScreen id={UNIT_ID} />, { client: api.client, administrator: true });
    const card = await screen.findByRole('article', { name: /Permission evidence G1/ });
    expect(card.textContent).toContain('Granted by Jane Writer');
    expect(card.textContent).toContain('The writer of the letter');
    expect(card.textContent).toContain('Live');
    // The file-sharing reminder is present, since the grant permits file_share.
    expect(card.textContent).toContain('separately authorized');
  });
});
