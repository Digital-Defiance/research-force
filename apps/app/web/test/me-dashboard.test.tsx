import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MyWorkPage } from '../src/me/dashboard';
import { SavedNavigationPage } from '../src/me/saved';
import { TeamDashboardPage } from '../src/me/team';
import type { BookmarkView, DashboardView, FollowView, SavedSearchView, TeamDashboardView } from '../src/types';
import { fakeApi, renderScreen } from './helpers';

const ROOT = '01J0000000000000000000RT01';
const PROP = '01J0000000000000000000PR01';
const DERIV = '01J0000000000000000000DV01';
const Q1 = '01J0000000000000000000QU01';
const PROJECT = '01J0000000000000000000PJ01';

const emptyWork = { items: [], next: null, today: '2026-10-28', zone: 'UTC' };
const emptyDashboard: DashboardView = { proposals: { total: 0, items: [] }, archival: { total: 0, items: [] }, questions: [] };

/** The common reads every My_Work render needs; a test overlays the sections it cares about. */
const base = () => ({
  'GET /me/work': emptyWork,
  'GET /members': { members: [] },
  'GET /projects': { projects: [] },
  'GET /reviews/queue': { reviews: [] },
  'GET /drafts': { drafts: [] },
  'GET /me/dashboard': emptyDashboard,
});

describe('My_Work dashboard (R58.1, R58.5)', () => {
  it('keeps outstanding work separate from unseen activity with a clear statement', async () => {
    renderScreen(<MyWorkPage />, { client: fakeApi(base()).client });
    expect(await screen.findByText(/opening this page clears none of them/u)).toBeTruthy();
    // The work, reviews and drafts sections are all present as their own regions.
    expect(screen.getByRole('region', { name: 'My work' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Reviews you can complete' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Your drafts' })).toBeTruthy();
  });

  it('shows outstanding proposals, archival follow-ups and followed Questions with links', async () => {
    const dashboard: DashboardView = {
      proposals: { total: 1, items: [{ id: PROP, targetRootId: ROOT, identifier: 'RF-0001', title: 'A finding', explanation: 'Sharper claim', createdAt: '2026-10-27T10:00:00.000Z', stale: false }] },
      archival: { total: 1, items: [{ id: DERIV, rootId: ROOT, identifier: 'RF-0002', title: 'A scan', kind: 'transcription', reviewState: 'unreviewed', createdAt: '2026-10-27T10:00:00.000Z' }] },
      questions: [{ followId: 'F1', available: true, rootId: Q1, identifier: 'RF-0003', question: 'Who wrote it?', state: 'investigating' }],
    };
    renderScreen(<MyWorkPage />, { client: fakeApi({ ...base(), 'GET /me/dashboard': dashboard }).client });
    const proposals = await screen.findByRole('region', { name: 'Proposed edits to resolve' });
    expect(within(proposals).getByRole('link', { name: 'Sharper claim' }).getAttribute('href')).toBe(`/proposals/${PROP}`);
    const archival = screen.getByRole('region', { name: 'Archival follow-ups' });
    expect(within(archival).getByRole('link', { name: 'RF-0002: A scan' }).getAttribute('href')).toBe(`/items/${ROOT}`);
    expect(archival.textContent).toContain('Needs review');
    const questions = screen.getByRole('region', { name: 'Questions you follow' });
    expect(within(questions).getByRole('link', { name: 'RF-0003: Who wrote it?' }).getAttribute('href')).toBe(`/items/${Q1}`);
    expect(questions.textContent).toContain('Investigating');
  });

  it('shows a lost followed Question as a neutral unavailable entry, naming nothing', async () => {
    const dashboard: DashboardView = { ...emptyDashboard, questions: [{ followId: 'F2', available: false, rootId: null, identifier: null, question: null, state: null }] };
    renderScreen(<MyWorkPage />, { client: fakeApi({ ...base(), 'GET /me/dashboard': dashboard }).client });
    const questions = await screen.findByRole('region', { name: 'Questions you follow' });
    expect(within(questions).getByText('A followed question you can no longer see.')).toBeTruthy();
    expect(within(questions).queryByRole('link')).toBeNull();
  });
});

const bookmark = (id: string, overrides: Partial<BookmarkView> = {}): BookmarkView => ({ id, name: `Bookmark ${id}`, position: 0, createdAt: '2026-10-27T10:00:00.000Z', targetId: ROOT, available: true, ...overrides });
const savedSearch = (id: string, overrides: Partial<SavedSearchView> = {}): SavedSearchView => ({ id, name: `Search ${id}`, position: 0, createdAt: '2026-10-27T10:00:00.000Z', filters: { q: 'tiles' }, ...overrides });
const follow = (id: string, overrides: Partial<FollowView> = {}): FollowView => ({ id, kind: 'item', inApp: true, email: 'immediate', createdAt: '2026-10-27T10:00:00.000Z', targetId: ROOT, available: true, ...overrides });

describe('saved navigation management (R58.2, R58.3, R58.4)', () => {
  it('renames a bookmark and reorders it by rewriting the whole order', async () => {
    const api = fakeApi({
      'GET /me/bookmarks': { bookmarks: [bookmark('B1'), bookmark('B2')] },
      'GET /me/searches': { searches: [] },
      'GET /me/follows': { follows: [] },
      'PATCH /me/bookmarks/B1': { bookmark: bookmark('B1', { name: 'Renamed' }) },
      'PUT /me/bookmarks/order': { bookmarks: [bookmark('B2'), bookmark('B1')] },
    });
    renderScreen(<SavedNavigationPage />, { client: api.client });
    const first = (await screen.findByRole('article', { name: 'Bookmark: Bookmark B1' }));
    fireEvent.click(within(first).getByRole('button', { name: 'Rename' }));
    fireEvent.change(within(first).getByLabelText(/Bookmark name/u), { target: { value: 'Renamed' } });
    fireEvent.click(within(first).getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(api.writes().some((call) => call.method === 'PATCH')).toBe(true));
    expect(api.writes().find((call) => call.method === 'PATCH')!.body).toEqual({ name: 'Renamed' });

    fireEvent.click(within(await screen.findByRole('article', { name: 'Bookmark: Bookmark B2' })).getByRole('button', { name: 'Move Bookmark B2 up' }));
    await waitFor(() => expect(api.writes().some((call) => call.method === 'PUT')).toBe(true));
    expect(api.writes().find((call) => call.method === 'PUT')!.body).toEqual({ order: ['B2', 'B1'] });
  });

  it('shows a lost bookmark as a neutral unavailable entry with no link', async () => {
    const api = fakeApi({
      'GET /me/bookmarks': { bookmarks: [bookmark('B1', { available: false, targetId: null })] },
      'GET /me/searches': { searches: [] },
      'GET /me/follows': { follows: [] },
    });
    renderScreen(<SavedNavigationPage />, { client: api.client });
    const entry = await screen.findByRole('article', { name: 'Bookmark: Bookmark B1' });
    expect(within(entry).getByText('A record you can no longer see.')).toBeTruthy();
    expect(within(entry).queryByRole('link')).toBeNull();
  });

  it('reruns a saved search through current authorization rather than showing stored results', async () => {
    const api = fakeApi({
      'GET /me/bookmarks': { bookmarks: [] },
      'GET /me/searches': { searches: [savedSearch('S1')] },
      'GET /me/follows': { follows: [] },
      'GET /me/searches/S1/results': { results: [{ id: 'U1', rootId: ROOT, title: 'A readable finding' }], next: null, filters: { q: 'tiles' } },
    });
    renderScreen(<SavedNavigationPage />, { client: api.client });
    const entry = await screen.findByRole('article', { name: 'Saved search: Search S1' });
    fireEvent.click(within(entry).getByRole('button', { name: 'Run search' }));
    expect(await within(entry).findByRole('link', { name: 'A readable finding' })).toBeTruthy();
    expect(api.calls.some((call) => call.path === '/me/searches/S1/results')).toBe(true);
  });

  it('shows a lost followed record as a neutral entry and unfollows a record', async () => {
    const api = fakeApi({
      'GET /me/bookmarks': { bookmarks: [] },
      'GET /me/searches': { searches: [] },
      'GET /me/follows': { follows: [follow('FL1'), follow('FL2', { available: false, targetId: null })] },
      'DELETE /me/follows/FL1': new Response(null, { status: 204 }),
    });
    renderScreen(<SavedNavigationPage />, { client: api.client });
    const follows = await screen.findByRole('region', { name: 'Records you follow' });
    expect(within(follows).getByText('A record you follow but can no longer see.')).toBeTruthy();
    fireEvent.click(within(follows).getAllByRole('button', { name: 'Unfollow' })[0]!);
    await waitFor(() => expect(api.writes().some((call) => call.method === 'DELETE' && call.path === '/me/follows/FL1')).toBe(true));
  });
});

describe('team dashboard (R58.5)', () => {
  it('shows the readable Question progress of a Project with state and lead', async () => {
    const dashboard: TeamDashboardView = { questions: { total: 1, items: [{ rootId: Q1, identifier: 'RF-0003', question: 'Who wrote it?', state: 'answered', leadName: 'Ada Example' }] } };
    const api = fakeApi({
      'GET /projects': { projects: [{ id: PROJECT, name: 'P1030680' }] },
      [`GET /projects/${PROJECT}/work`]: emptyWork,
      'GET /members': { members: [] },
      [`GET /projects/${PROJECT}/dashboard`]: dashboard,
    });
    renderScreen(<TeamDashboardPage projectId={PROJECT} />, { client: api.client });
    expect(await screen.findByRole('heading', { name: 'Team dashboard: P1030680' })).toBeTruthy();
    const progress = screen.getByRole('region', { name: 'Question progress' });
    expect(within(progress).getByRole('link', { name: 'RF-0003: Who wrote it?' }).getAttribute('href')).toBe(`/items/${Q1}`);
    expect(progress.textContent).toContain('Answered');
    expect(progress.textContent).toContain('lead: Ada Example');
  });
});
