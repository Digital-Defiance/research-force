import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router';
import { ApiContext } from '../src/api';
import { Workspace } from '../src/routes';
import { BUILT_IN, fakeApi, makeMe } from './helpers';

const renderAt = (api: ReturnType<typeof fakeApi>, route: string) => render(
  <ApiContext.Provider value={api.client}><MemoryRouter initialEntries={[route]}><Workspace /></MemoryRouter></ApiContext.Provider>,
);
const base = { 'GET /me': makeMe(), 'GET /roles': { roles: BUILT_IN }, 'GET /me/badges': { counts: {}, total: 0, unreadNotifications: 2 } };
const entry = (over: Record<string, unknown>) => ({
  id: 'N1', at: '2026-10-27T18:00:00.000Z', read: false, types: ['new_submission'], actor: { id: 'M2', displayName: 'Ada' }, items: [], itemCount: 0,
  submissionId: null, groupNote: null, outsideSubmission: null, alert: null, ...over,
});

describe('the Notification_Centre', () => {
  it('shows the unread count in the header of every page (R19.12)', async () => {
    renderAt(fakeApi({ ...base, 'GET /projects': { projects: [] } }), '/projects');
    const link = await screen.findByRole('link', { name: 'Notifications (2)' });
    expect(link.getAttribute('href')).toBe('/notifications');
  });

  it('lists what each Notification concerns, including a deleted record and a Group Note (R19.11, R19.13, R41.11)', async () => {
    const api = fakeApi({
      ...base,
      'GET /notifications': {
        next: null,
        notifications: [
          entry({ id: 'N1', types: ['new_submission', 'mention'], items: [{ id: 'U1', kind: 'finding', identifier: 'F-1', title: 'A finding' }], itemCount: 1, groupNote: { rootId: 'U1', replyId: 'R1' } }),
          entry({ id: 'N2', read: true, items: [{ id: 'U2', kind: 'run', identifier: 'R-2', deleted: { at: '2026-10-26T10:00:00.000Z', reason: 'Synthetic.' } }], itemCount: 1 }),
          entry({ id: 'N3', types: ['system_alert'], actor: null, alert: { key: 'usage:d1', detail: null } }),
        ],
      },
    });
    renderAt(api, '/notifications');
    expect(await screen.findByText('Finding F-1: A finding')).toBeTruthy();
    expect(screen.getByText('Includes a Group Note.')).toBeTruthy();
    expect(screen.getByText(/Run R-2 was permanently deleted on .*: Synthetic\./u)).toBeTruthy();
    expect(screen.getByText('System alert: usage:d1')).toBeTruthy();
  });

  it('marks a Notification read and opens its Root_Item at the Group Note when opened (R19.7, R41.10)', async () => {
    const api = fakeApi({
      ...base,
      'GET /notifications': { next: null, notifications: [entry({ id: 'N1', items: [{ id: 'U1', kind: 'finding', identifier: 'F-1', title: 'A finding' }], itemCount: 1, groupNote: { rootId: 'U1', replyId: 'R1' } })] },
      'POST /notifications/N1/read': { read: true },
      'GET /items/U1': new Response('{}', { status: 404 }),
    });
    renderAt(api, '/notifications');
    const article = await screen.findByRole('article', { name: /Notification/u });
    within(article).getByRole('button', { name: 'Open' }).click();
    await waitFor(() => expect(api.writes().map((call) => call.path)).toEqual(['/notifications/N1/read']));
    await waitFor(() => expect(api.calls.some((call) => call.path === '/items/U1')).toBe(true));
  });
});
