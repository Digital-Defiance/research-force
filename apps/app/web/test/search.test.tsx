import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router';
import { ApiContext } from '../src/api';
import { Workspace } from '../src/routes';
import { BUILT_IN, failure, fakeApi, makeMe } from './helpers';

const renderAt = (api: ReturnType<typeof fakeApi>, route: string) => render(
  <ApiContext.Provider value={api.client}><MemoryRouter initialEntries={[route]}><Workspace /></MemoryRouter></ApiContext.Provider>,
);
const base = {
  'GET /me': makeMe(), 'GET /roles': { roles: BUILT_IN }, 'GET /members': { members: [] }, 'GET /projects': { projects: [] },
  'GET /me/badges': { counts: {}, total: 0, unreadNotifications: 0 },
};
const result = {
  id: 'U1', rootId: 'U1', unitType: 'research_item', kind: 'finding', title: 'A synthetic finding', credit: ['Ada Example'], createdAt: '2026-10-27T18:00:00.000Z',
  withdrawn: false, superseded: false, level: 'not_published', effective: 'not_published', restricted: true, flag: 'new', project: { id: 'P1', name: 'Alpha' },
  excerpt: { pieces: [{ text: 'The ' }, { text: 'harbour', highlight: true, label: { kind: 'quote', caption: 'Quote · Log book' } }, { text: ' was calm.' }], cutBefore: true, cutAfter: false },
};

describe('the search screen', () => {
  it('shows each result with its markers, project, disclosure, and a highlighted, labelled excerpt (R21.7)', async () => {
    const api = fakeApi({ ...base, 'GET /search': { results: [result], next: null } });
    renderAt(api, '/search?q=harbour');
    const link = await screen.findByRole('link', { name: 'A synthetic finding' });
    expect(link.getAttribute('href')).toBe('/items/U1');
    const list = screen.getByRole('list', { name: 'Search results' });
    expect(within(list).getByText('New')).toBeTruthy();
    expect(within(list).getByText('Restricted')).toBeTruthy();
    expect(within(list).getByText(/Alpha/u)).toBeTruthy();
    expect(within(list).getByText('harbour').tagName).toBe('MARK');
    expect(within(list).getByText(/Quote · Log book/u)).toBeTruthy();
    expect(api.calls.find((call) => call.path.startsWith('/search'))!.path).toBe('/search?q=harbour');
  });

  it('says that no result matched', async () => {
    renderAt(fakeApi({ ...base, 'GET /search': { results: [], next: null } }), '/search?q=nothing');
    expect(await screen.findByText('No result matched.')).toBeTruthy();
  });

  it('shows the refusal of a query beside the field and keeps what was entered (R21.9)', async () => {
    const api = fakeApi({ ...base, 'GET /search': failure(422, 'validation', { fields: [{ field: 'query', rule: 'Enter at least one letter or digit.' }] }) });
    renderAt(api, '/search?q=...');
    expect(await screen.findByText('Enter at least one letter or digit.')).toBeTruthy();
    expect((screen.getByLabelText(/Search for/u) as HTMLInputElement).value).toBe('...');
  });

  it('says search is unavailable, and that it resumes at 00:00 UTC at a daily limit, keeping the query (R21.10)', async () => {
    renderAt(fakeApi({ ...base, 'GET /search': failure(503, 'daily_limit') }), '/search?q=harbour&kind=finding');
    expect(await screen.findByText('Search is unavailable.')).toBeTruthy();
    expect(screen.getByText(/resumes at 00:00 UTC/u)).toBeTruthy();
    expect((screen.getByLabelText(/Search for/u) as HTMLInputElement).value).toBe('harbour');
    expect((screen.getByLabelText('Kind of record') as HTMLSelectElement).value).toBe('finding');
  });

  it('searches with the entered filters and offers more results', async () => {
    const api = fakeApi({ ...base, 'GET /search': (call: { path: string }) => (call.path.includes('after=') ? { results: [], next: null } : { results: [result], next: '1.5' }) });
    renderAt(api, '/search');
    fireEvent.change(await screen.findByLabelText(/Search for/u), { target: { value: 'harbour lamp' } });
    fireEvent.change(screen.getByLabelText('Kind of record'), { target: { value: 'finding' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByRole('link', { name: 'A synthetic finding' });
    expect(api.calls.find((call) => call.path.startsWith('/search'))!.path).toBe('/search?q=harbour+lamp&kind=finding');
    fireEvent.click(screen.getByRole('button', { name: 'Show more results' }));
    await waitFor(() => expect(api.calls.some((call) => call.path.includes('after=1.5'))).toBe(true));
  });
});
