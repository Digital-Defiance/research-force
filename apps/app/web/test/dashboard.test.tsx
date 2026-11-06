import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Dashboard } from '../src/dashboard/dashboard';
import { failure, fakeApi, renderScreen } from './helpers';

const emptyWork = { proposals: { total: 0, items: [] }, archival: { total: 0, items: [] }, questions: [] };
const region = async (heading: string) => (await screen.findByRole('heading', { name: heading })).closest('.rf-card') as HTMLElement;

describe('the Dashboard', () => {
  it('shows an empty state per region when each result is empty, and reads only the existing endpoints (R5.3, R5.6)', async () => {
    const api = fakeApi({
      'GET /reviews/queue': { reviews: [] },
      'GET /drafts': { drafts: [], next: null },
      'GET /me/dashboard': emptyWork,
      'GET /feed': { openedAt: '2026-01-01T00:00:00Z', entries: [], next: null },
    });
    renderScreen(<Dashboard />, { client: api.client });
    expect(await screen.findByText('No reviews are waiting for you.')).toBeTruthy();
    expect(await screen.findByText('You have no saved drafts.')).toBeTruthy();
    expect(await screen.findByText('Nothing is waiting for your attention.')).toBeTruthy();
    expect(await screen.findByText('There is no recent activity.')).toBeTruthy();
    expect(api.calls.map((call) => `${call.method} ${call.path}`).sort()).toEqual(['GET /drafts', 'GET /feed', 'GET /me/dashboard', 'GET /reviews/queue']);
  });
  it('shows the error state, not an empty state, when a region fails, and links to the full destination (R5.4)', async () => {
    const api = fakeApi({
      'GET /reviews/queue': failure(500, 'server_error'),
      'GET /drafts': { drafts: [], next: null },
      'GET /me/dashboard': { ...emptyWork, questions: [{ followId: 'F1', available: false, rootId: null, identifier: null, question: null, state: null }] },
      'GET /feed': { openedAt: '2026-01-01T00:00:00Z', entries: [], next: null },
    });
    renderScreen(<Dashboard />, { client: api.client });
    const reviews = await region('My reviews');
    expect(await within(reviews).findByText('This page could not be loaded. Reload the page to try again.')).toBeTruthy();
    expect(within(reviews).queryByText('No reviews are waiting for you.')).toBeNull();
    const work = await region('My work');
    expect(await within(work).findByText('Questions you follow: 1')).toBeTruthy();
    expect(within(work).getByRole('link', { name: 'View all work' }).getAttribute('href')).toBe('/me/work');
  });
  it('lists every submittable kind in the new-record card (R5.5)', async () => {
    const api = fakeApi({});
    renderScreen(<Dashboard />, { client: api.client });
    const submit = await region('Submit a new record');
    expect(within(submit).getAllByRole('link')).toHaveLength(10);
    expect(within(submit).getByRole('link', { name: 'Finding' }).getAttribute('href')).toBe('/items/new/finding');
  });
});
