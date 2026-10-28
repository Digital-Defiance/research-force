import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router';
import { ApiContext } from '../src/api';
import { Workspace } from '../src/routes';
import { BUILT_IN, fakeApi, makeMe } from './helpers';

const renderAt = (api: ReturnType<typeof fakeApi>, route: string) => render(
  <ApiContext.Provider value={api.client}><MemoryRouter initialEntries={[route]}><Workspace /></MemoryRouter></ApiContext.Provider>,
);
const base = { 'GET /me': makeMe(), 'GET /roles': { roles: BUILT_IN } };

describe('the activity screens', () => {
  it('shows the flag counts in the header of every page (R18.7)', async () => {
    const api = fakeApi({ ...base, 'GET /projects': { projects: [] }, 'GET /me/badges': { counts: { finding: 2, reply: 1 }, total: 3, unreadNotifications: 0 } });
    renderAt(api, '/projects');
    const link = await screen.findByRole('link', { name: 'Activity feed (3)' });
    expect(link.getAttribute('href')).toBe('/activity');
    const list = within(screen.getByRole('banner')).getByRole('list', { name: 'New and updated Items' });
    expect(within(list).getByText('Findings: 2')).toBeTruthy();
    expect(within(list).getByText('Replies: 1')).toBeTruthy();
  });

  it('lists feed entries with flag marks and marks them all seen (R18.5, R18.10)', async () => {
    const entry = {
      id: 'E1', kind: 'submission', at: '2026-10-27T18:00:00.000Z', actor: { id: 'M2', displayName: 'Ada' }, submissionId: 'S1', target: null, counts: null,
      items: [{ id: 'U1', unitType: 'research_item', bucket: 'finding', rootId: 'U1', identifier: 'F-1', title: 'A finding', flag: 'new' }],
    };
    const api = fakeApi({
      ...base, 'GET /me/badges': { counts: {}, total: 0, unreadNotifications: 0 },
      'GET /feed': { openedAt: '2026-10-27T18:05:00.000Z', entries: [entry], next: null },
      'POST /feed/mark-seen': { seen: true },
    });
    renderAt(api, '/activity');
    expect(await screen.findByRole('link', { name: /A finding/u })).toBeTruthy();
    expect(screen.getByText('New')).toBeTruthy();
    screen.getByRole('button', { name: /Mark all as seen/u }).click();
    await waitFor(() => expect(api.writes().some((call) => call.path === '/feed/mark-seen')).toBe(true));
    expect((api.writes().find((call) => call.path === '/feed/mark-seen')!.body as { openedAt: string }).openedAt).toBe('2026-10-27T18:05:00.000Z');
  });
});
