import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { versionCitation } from '@researchforce/domain/releases';
import { NewReleasePage, ReleasePage, ReleasesListPage } from '../src/releases/releases';
import type { ReleaseArtifactView, ReleaseView } from '../src/types';
import { fakeApi, json, renderScreen } from './helpers';
import type { Handler } from './helpers';

const REL = '01J0000000000000000000RL01';
const NEXT = '01J0000000000000000000RL02';
const UNIT = '01J0000000000000000000UN01';
const UNIT2 = '01J0000000000000000000UN02';
const hash = (c: string) => c.repeat(64);

function artifact(overrides: Partial<ReleaseArtifactView> = {}): ReleaseArtifactView {
  const base = { kind: 'record' as const, unitId: UNIT, identifier: 'RF-7', title: 'The tiles are original', revision: 3, sha256: hash('a'), publicApproved: true, drift: 'unchanged' as const };
  const merged = { ...base, ...overrides };
  return { ...merged, citation: versionCitation({ id: REL, name: 'Spring release' }, merged) };
}

function release(overrides: Partial<ReleaseView> = {}): ReleaseView {
  return {
    id: REL, name: 'Spring release', state: 'draft', licenceVersion: 'CC BY 4.0', snapshotSeq: 4, snapshotAt: '2026-10-30T09:00:00.000Z',
    predecessorId: null, sealedAt: null, manifestHash: null, publicManifestHash: null, scope: 'The 1944 register', rationale: 'A citable state',
    artifacts: [artifact()], hiddenArtifacts: 0, ...overrides,
  };
}

const view = (rel: ReleaseView, extra: Record<string, Handler> = {}) => ({ [`GET /releases/${rel.id}`]: () => json({ release: rel }), ...extra });

describe('the releases list (R59.1)', () => {
  it('lists each release with its state and sealed date, and offers a new release', async () => {
    const { client } = fakeApi({
      'GET /releases': () => json({ releases: [
        { id: REL, name: 'Spring release', state: 'published', licenceVersion: 'CC BY 4.0', snapshotAt: '2026-10-30T09:00:00.000Z', sealedAt: '2026-10-30T10:00:00.000Z', publishedAt: '2026-10-30T11:00:00.000Z', withdrawnAt: null, predecessorId: null },
      ], nextCursor: null }),
    });
    renderScreen(<ReleasesListPage />, { client, administrator: true });
    await waitFor(() => expect(screen.getByRole('link', { name: 'Spring release' })).toBeTruthy());
    expect(screen.getByText('Published')).toBeTruthy();
    expect(screen.getByText(/Sealed 2026-10-30/u)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'New release' }).getAttribute('href')).toBe('/releases/new');
  });
});

describe('creating a release (R59.1)', () => {
  it('posts the draft and navigates to its page', async () => {
    const { client, writes } = fakeApi({ 'POST /releases': () => json({ id: REL }, 201) });
    renderScreen(<NewReleasePage />, { client, administrator: true, route: '/releases/new', path: '/releases/new' });
    fireEvent.change(screen.getByLabelText(/Name/u), { target: { value: 'Spring release' } });
    fireEvent.change(screen.getByLabelText(/Scope/u), { target: { value: 'The 1944 register' } });
    fireEvent.change(screen.getByLabelText(/Rationale/u), { target: { value: 'A citable state' } });
    fireEvent.change(screen.getByLabelText(/Content-licence version/u), { target: { value: 'CC BY 4.0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create the draft' }));
    await waitFor(() => expect(writes().some((call) => call.path === '/releases')).toBe(true));
    expect(writes()[0]!.body).toEqual({ name: 'Spring release', scope: 'The 1944 register', rationale: 'A citable state', licenceVersion: 'CC BY 4.0' });
  });
});

describe('the draft preflight view (R59.1, R59.5)', () => {
  it('seals when every readable artifact is unchanged and approved', async () => {
    const draft = release();
    const { client, writes } = fakeApi(view(draft, { [`POST /releases/${REL}/seal`]: () => json({ id: REL, manifestHash: hash('m'), publicManifestHash: hash('p') }) }));
    renderScreen(<ReleasePage id={REL} />, { client, administrator: true });
    await waitFor(() => expect(screen.getByText(/Preflight is clean/u)).toBeTruthy());
    const seal = screen.getByRole('button', { name: 'Seal the release' }) as HTMLButtonElement;
    expect(seal.disabled).toBe(false);
    fireEvent.click(seal);
    await waitFor(() => expect(writes().some((call) => call.path === `/releases/${REL}/seal`)).toBe(true));
    expect(writes().find((call) => call.path.endsWith('/seal'))!.body).toEqual({ rev: 4 });
  });

  it('flags a drifted artifact and disables sealing', async () => {
    const draft = release({ artifacts: [artifact({ drift: 'changed' })] });
    const { client } = fakeApi(view(draft));
    renderScreen(<ReleasePage id={REL} />, { client, administrator: true });
    await waitFor(() => expect(screen.getByText(/Preflight found issues/u)).toBeTruthy());
    expect(screen.getByText(/Changed after it was captured/u)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Seal the release' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('blocks sealing when the viewer cannot see every artifact', async () => {
    const draft = release({ hiddenArtifacts: 2 });
    const { client } = fakeApi(view(draft));
    renderScreen(<ReleasePage id={REL} />, { client, administrator: true });
    await waitFor(() => expect(screen.getAllByText(/2 artifacts you cannot see/u).length).toBeGreaterThan(0));
    expect((screen.getByRole('button', { name: 'Seal the release' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('the sealed and published view (R59.2, R59.3)', () => {
  it('shows the manifest hashes and publishes a sealed release', async () => {
    const sealed = release({ state: 'sealed', sealedAt: '2026-10-30T10:00:00.000Z', manifestHash: hash('m'), publicManifestHash: hash('p') });
    const { client, writes } = fakeApi(view(sealed, { [`POST /releases/${REL}/publish`]: () => json({ id: REL, state: 'published' }) }));
    renderScreen(<ReleasePage id={REL} />, { client, administrator: true });
    await waitFor(() => expect(screen.getByText(new RegExp(`Manifest hash ${hash('m')}`, 'u'))).toBeTruthy());
    expect(screen.getByText(new RegExp(`Public manifest hash ${hash('p')}`, 'u'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Seal the release' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(writes().some((call) => call.path === `/releases/${REL}/publish`)).toBe(true));
  });

  it('withdraws a published release', async () => {
    const published = release({ state: 'published', sealedAt: '2026-10-30T10:00:00.000Z', manifestHash: hash('m'), publicManifestHash: hash('p') });
    const { client, writes } = fakeApi(view(published, { [`POST /releases/${REL}/withdraw`]: () => json({ id: REL, state: 'withdrawn' }) }));
    renderScreen(<ReleasePage id={REL} />, { client, administrator: true });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Withdraw' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(writes().some((call) => call.path === `/releases/${REL}/withdraw`)).toBe(true));
  });

  it('makes a successor and navigates to the new draft', async () => {
    const sealed = release({ state: 'sealed', sealedAt: '2026-10-30T10:00:00.000Z', manifestHash: hash('m'), publicManifestHash: hash('p') });
    const { client, writes } = fakeApi(view(sealed, { [`POST /releases/${REL}/successor`]: () => json({ id: NEXT }, 201) }));
    renderScreen(<ReleasePage id={REL} />, { client, administrator: true });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Make a successor release' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Make a successor release' }));
    await waitFor(() => expect(writes().some((call) => call.path === `/releases/${REL}/successor`)).toBe(true));
  });
});

describe('version-specific citations and the deposit note (R59.4, R59.5, R60.9)', () => {
  it('shows each artifact’s citation line and a separate-deposit note', async () => {
    const sealed = release({ state: 'sealed', sealedAt: '2026-10-30T10:00:00.000Z', manifestHash: hash('m'), publicManifestHash: hash('p') });
    const { client } = fakeApi(view(sealed));
    renderScreen(<ReleasePage id={REL} />, { client, administrator: true });
    await waitFor(() => expect(screen.getByText(sealed.artifacts[0]!.citation.line)).toBeTruthy());
    expect(screen.getByText(/External repository or DOI deposit is a separate step/u)).toBeTruthy();
    expect(screen.getByText(/mints no DOI/u)).toBeTruthy();
  });

  it('copies the exact citation line to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...globalThis.navigator, clipboard: { writeText } });
    const sealed = release({ state: 'sealed', manifestHash: hash('m'), publicManifestHash: hash('p') });
    const { client } = fakeApi(view(sealed));
    renderScreen(<ReleasePage id={REL} />, { client, administrator: true });
    const button = await screen.findByRole('button', { name: /Copy the citation of RF-7/u });
    fireEvent.click(button);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(sealed.artifacts[0]!.citation.line));
    expect(await screen.findByText('Copied to the clipboard.')).toBeTruthy();
  });
});

describe('offline export of the citations (R59.5, R60.9)', () => {
  beforeEach(() => {
    vi.stubGlobal('URL', { ...globalThis.URL, createObjectURL: () => 'blob:release', revokeObjectURL: () => undefined });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('exports the readable citations as four offline files', async () => {
    const clicks: string[] = [];
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const element = realCreate(tag) as HTMLAnchorElement;
      if (tag === 'a') element.click = () => clicks.push(element.download);
      return element;
    });
    const sealed = release({ state: 'sealed', manifestHash: hash('m'), publicManifestHash: hash('p') });
    const { client } = fakeApi(view(sealed));
    renderScreen(<ReleasePage id={REL} />, { client, administrator: true });
    const button = await screen.findByRole('button', { name: 'Export all citations' });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByText(/Exported 4 files/u)).toBeTruthy());
    expect(clicks).toEqual(['citations.json', 'citations.csl.json', 'citations.html', 'manifest.json']);
  });
});

describe('hidden and unavailable artifacts leak nothing (R59.4)', () => {
  it('shows a hidden count with no title, hash, or kind of the unreadable artifact', async () => {
    const rel = release({ state: 'published', manifestHash: hash('m'), publicManifestHash: hash('p'), artifacts: [artifact()], hiddenArtifacts: 1 });
    const { client } = fakeApi(view(rel));
    const { container } = renderScreen(<ReleasePage id={REL} />, { client, administrator: true });
    await waitFor(() => expect(screen.getByText(/1 artifact you cannot see/u)).toBeTruthy());
    // The one readable artifact is shown fully; nothing of the hidden one is named.
    expect(container.textContent).toContain('The tiles are original');
    expect(screen.queryByText(/2 artifacts/u)).toBeNull();
  });

  it('shows an unavailable artifact as unavailable without leaking its metadata after a later hold or withdrawal', async () => {
    // A once-public artifact later held/withdrawn: the API returns it with no readable detail (title/identifier/hash blanked) and drift 'unavailable'.
    const suppressed: ReleaseArtifactView = {
      kind: 'record', unitId: UNIT2, identifier: null, title: null, revision: null, sha256: hash('0'), publicApproved: true, drift: 'unavailable',
      citation: versionCitation({ id: REL, name: 'Spring release' }, { kind: 'record', identifier: null, revision: null, sha256: hash('0') }),
    };
    const rel = release({ state: 'published', manifestHash: hash('m'), publicManifestHash: hash('p'), artifacts: [artifact(), suppressed] });
    const { client } = fakeApi(view(rel));
    const { container } = renderScreen(<ReleasePage id={REL} />, { client, administrator: true });
    await waitFor(() => expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0));
    // The readable artifact keeps its title; the unavailable one shows no title and is marked unavailable.
    expect(container.textContent).toContain('The tiles are original');
    expect(screen.getByText(/No longer available/u)).toBeTruthy();
  });
});
