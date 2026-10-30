import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { compareTexts } from '../src/provenance/model';
import type { DerivationRow, EndpointRow } from '../src/provenance/model';
import { ProvenancePanel } from '../src/provenance/panel';
import { fakeApi, MEMBER_ID, OTHER_ID, renderScreen } from './helpers';
import { makeItem } from './fixtures';

const RECORD = '01J0000000000000000000FN01';
const SCAN = '01J0000000000000000000AT01';
const FIRST = '01J0000000000000000000DR01';
const SECOND = '01J0000000000000000000DR02';
const end = (unitId: string, title: string, type: 'attachment' | 'text' = 'attachment'): EndpointRow => ({ type, unitId, rootId: RECORD, identifier: 'RI-1', title, sha256: 'a'.repeat(64), rev: null, revisedSince: false });
const derivation = (overrides: Partial<DerivationRow> = {}): DerivationRow => ({
  id: FIRST, kind: 'transcription', kindName: 'Transcription', method: 'Hand transcription', methodVersion: null, language: 'de', uncertainty: 'The name is faded.', reviewState: 'unreviewed',
  createdBy: OTHER_ID, createdByName: 'Grace Hopper', createdAt: '2026-10-30T04:00:00.000Z', output: end('01J0000000000000000000AT02', 'Transcript'), inputs: [end(SCAN, 'The scan')],
  text: 'Lieber Karl', correctsId: null, correctedBy: null, reviews: [], ...overrides,
});
const item = makeItem({ id: RECORD, kind: 'finding', title: 'A letter' } as never);
const made = `GET /derivations?outputRootId=${RECORD}`;
const used = `GET /derivations?inputRootId=${RECORD}`;

describe('corrected-text comparison (R55.2)', () => {
  it('shows kept, removed and added words, and falls back for very long texts', () => {
    expect(compareTexts('Lieber Karl, hallo', 'Lieber Carl, hallo')).toEqual([
      { kind: 'same', text: 'Lieber ' }, { kind: 'removed', text: 'Karl,' }, { kind: 'added', text: 'Carl,' }, { kind: 'same', text: ' hallo' },
    ]);
    expect(compareTexts('', 'new')).toEqual([{ kind: 'added', text: 'new' }]);
    const long = Array.from({ length: 1600 }, (_, index) => `w${index}`).join(' ');
    expect(compareTexts(long, `${long} x`).map((piece) => piece.kind)).toEqual(['removed', 'added']);
  });
});

describe('provenance panel (R55.3, R55.4)', () => {
  it('shows the originals, method, uncertainty, reviews and flagged passages, and a comparison with the earlier text', async () => {
    const earlier = derivation({ correctedBy: SECOND, reviews: [{ reviewerId: MEMBER_ID, reviewerName: 'Ada Example', state: 'disputed', note: 'Misread', reviewedAt: '2026-10-30T05:00:00.000Z', passages: [{ start: 7, end: 11, note: 'Karl or Carl' }] }] });
    const later = derivation({ id: SECOND, correctsId: FIRST, method: 'Second pass', text: 'Lieber Carl', output: end('01J0000000000000000000AT03', 'Corrected transcript') });
    const api = fakeApi({ [made]: { derivations: [earlier, later], next: null }, [used]: { derivations: [], next: null } });
    renderScreen(<ProvenancePanel item={item} />, { client: api.client });
    await waitFor(() => expect(screen.getAllByText('The name is faded.')).toHaveLength(2));
    expect(screen.getAllByText('The scan').length).toBeGreaterThan(0);
    expect(screen.getByText(/Method: Second pass; language de/u)).toBeTruthy();
    expect(screen.getByText(/Uncertain: “Karl”/u)).toBeTruthy();
    expect(screen.getByText('Earlier versions that were corrected')).toBeTruthy();
    expect(screen.getByLabelText('Corrected text compared with the earlier text').querySelector('del')?.textContent).toBe('Karl');
    expect(screen.getByRole('link', { name: /Download this record’s derivations/u }).getAttribute('href')).toContain(`/derivations/export?rootId=${RECORD}`);
  });

  it('lets another Member review, and not the Member who made it', async () => {
    const api = fakeApi({
      [made]: { derivations: [derivation()], next: null }, [used]: { derivations: [], next: null },
      [`POST /derivations/${FIRST}/review`]: { derivation: derivation({ reviewState: 'reviewed' }) },
    });
    renderScreen(<ProvenancePanel item={item} />, { client: api.client });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Record my review' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Record my review' }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toEqual({ state: 'reviewed', passages: [] });
  });

  it('offers no review to the Member who made the derivation, and says plainly when nothing is readable', async () => {
    const own = fakeApi({ [made]: { derivations: [derivation({ createdBy: MEMBER_ID })], next: null }, [used]: { derivations: [], next: null } });
    const first = renderScreen(<ProvenancePanel item={item} />, { client: own.client });
    await waitFor(() => expect(screen.getByText('The name is faded.')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Record my review' })).toBeNull();
    first.unmount();
    const none = fakeApi({ [made]: { derivations: [], next: null }, [used]: { derivations: [], next: null } });
    renderScreen(<ProvenancePanel item={item} />, { client: none.client });
    await waitFor(() => expect(screen.getByText(/Nothing on this record is recorded as made from another artifact you can read/u)).toBeTruthy());
  });
});
