import { act, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router';
import { ApiContext } from '../src/api';
import type { ApiClient } from '../src/api';
import { AppShell } from '../src/shell/app-shell';
import { BUILT_IN, failure, fakeApi, makeMe } from './helpers';

const renderWorkspace = (client: ApiClient, route = '/') => render(
  <ApiContext.Provider value={client}>
    <MemoryRouter initialEntries={[route]}><AppShell /></MemoryRouter>
  </ApiContext.Provider>,
);

describe('the Workspace shell', () => {
  it('links ResearchForce in the header to the Workspace start page (R45.2)', async () => {
    renderWorkspace(fakeApi({ 'GET /me': makeMe(), 'GET /roles': { roles: BUILT_IN }, 'GET /projects/P1/history': { history: [] } }).client, '/projects/P1/history');
    // The Design Suite TopMenu renders the brand as the home link (R45.2).
    const brand = await screen.findByRole('link', { name: 'ResearchForce home' });
    expect(brand.getAttribute('href')).toBe('/');
    expect(await screen.findByRole('heading', { name: 'Project history' })).toBeTruthy();
  });

  it('offers a Submission of every kind on the start page and reports unknown pages', async () => {
    const view = renderWorkspace(fakeApi({ 'GET /me': makeMe(), 'GET /roles': { roles: BUILT_IN } }).client);
    const submit = (await screen.findByRole('heading', { name: 'Submit a new record' })).closest('.rf-card') as HTMLElement;
    expect(within(submit).getByRole('link', { name: 'Finding' }).getAttribute('href')).toBe('/items/new/finding');
    expect(within(submit).getAllByRole('link')).toHaveLength(10);
    expect(within(submit).getByRole('link', { name: 'Decision Record' })).toBeTruthy();
    expect(within(submit).getByRole('link', { name: 'Research Question' }).getAttribute('href')).toBe('/items/new/research_question');
    view.unmount();
    renderWorkspace(fakeApi({ 'GET /me': makeMe(), 'GET /roles': { roles: BUILT_IN } }).client, '/items/new/unknown');
    expect(await screen.findByText('This page does not exist.')).toBeTruthy();
  });

  it('shows the Profile form instead of every page while a required Profile field is missing (R3.6)', async () => {
    const api = fakeApi({ 'GET /me': makeMe({ missing: ['timeZone'] }), 'GET /roles': { roles: BUILT_IN } });
    renderWorkspace(api.client, '/projects');
    expect(await screen.findByRole('heading', { name: 'Your Profile' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Projects' })).toBeNull();
  });

  it('shows the Profile form to a first-visit Member whose Profile is empty even though every route but /me answers profile_incomplete (R3.6)', async () => {
    const incomplete = failure(428, 'profile_incomplete', { details: { missing: ['displayName', 'specialtyIds', 'timeZone'] } });
    const api = fakeApi({ 'GET /me': makeMe({ profile: null, missing: ['displayName', 'specialtyIds', 'timeZone'] }), 'GET /roles': incomplete });
    renderWorkspace(api.client, '/');
    expect(await screen.findByRole('heading', { name: 'Your Profile' })).toBeTruthy();
    expect(screen.queryByText('This page could not be loaded. Reload the page to try again.')).toBeNull();
  });
  it('shows the Profile form after a profile_incomplete answer, and the saving notices on every page (R28.9, R28.13)', async () => {
    const api = fakeApi({ 'GET /me': makeMe(), 'GET /roles': { roles: BUILT_IN }, 'GET /projects': { projects: [] } });
    renderWorkspace(api.client, '/projects');
    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeTruthy();
    act(() => api.client.status.update({ dailyLimit: true, frozen: true }));
    expect(screen.getByText('Saving is unavailable until 00:00 UTC.')).toBeTruthy();
    expect(screen.getByText('Saving is paused for a backup (about a minute).')).toBeTruthy();
    act(() => api.client.status.update({ profileMissing: ['displayName'] }));
    expect(screen.getByRole('heading', { name: 'Your Profile' })).toBeTruthy();
  });
});
