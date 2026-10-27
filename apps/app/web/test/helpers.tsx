import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { BUILT_IN_ROLES, ROLE_IDS } from '@researchforce/domain/permissions';
import { ApiClient, ApiContext, StatusStore } from '../src/api';
import { SessionContext, sessionFor } from '../src/session';
import type { Me, Role } from '../src/types';

export interface Call { readonly method: string; readonly path: string; readonly headers: Headers; readonly body: unknown; readonly raw: string | undefined }
type Handler = ((call: Call) => unknown) | Response | object;

export const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
export const failure = (status: number, error: string, extra: Record<string, unknown> = {}): Response => json({ error, ...extra }, status);

/** A fake Workspace API: handlers keyed by `METHOD /path` (with the query), each answering with a Response or a JSON body. */
export function fakeApi(handlers: Record<string, Handler>) {
  const calls: Call[] = [];
  const reloads: number[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input).replace(/^\/api\/v1/u, '');
    const method = init?.method ?? 'GET';
    const raw = typeof init?.body === 'string' ? init.body : undefined;
    const call: Call = { method, path: url, headers: new Headers(init?.headers), body: raw === undefined ? undefined : JSON.parse(raw), raw };
    calls.push(call);
    const handler = handlers[`${method} ${url}`] ?? handlers[`${method} ${url.split('?')[0]}`];
    if (handler === undefined) return failure(404, 'not_found');
    const result: unknown = typeof handler === 'function' ? await (handler as (call: Call) => unknown)(call) : handler instanceof Response ? handler.clone() : handler;
    return result instanceof Response ? result : json(result);
  };
  const client = new ApiClient({ fetch: fetcher as typeof fetch, reload: () => reloads.push(Date.now()), status: new StatusStore() });
  return { client, calls, reloads, writes: () => calls.filter((call) => call.method !== 'GET') };
}

export const MEMBER_ID = '01J00000000000000000000001';
export const OTHER_ID = '01J00000000000000000000002';
export const SPECIALTY_ID = '0000000000000000000000S001';
export const BUILT_IN: Role[] = Object.values(BUILT_IN_ROLES).map((role) => ({ id: role.id, name: role.name, builtin: true, permissions: role.permissions }));

export function makeMe(overrides: Partial<Me> = {}): Me {
  return {
    member: { id: MEMBER_ID, roleId: ROLE_IDS.contributor },
    profile: {
      displayName: 'Ada Example', specialties: [{ id: SPECIALTY_ID, name: 'Historian', retired: false }], affiliations: [], biography: '', timeZone: 'UTC', publicProfile: false,
      licence: { current: false, agreements: [] },
    },
    missing: [],
    preferences: { events: {}, dailyDigestHour: 8 },
    mutedProjectIds: [],
    specialtyOptions: [{ id: SPECIALTY_ID, name: 'Historian' }, { id: '0000000000000000000000S002', name: 'Cryptanalysis' }],
    contentLicence: 'CC BY 4.0',
    ...overrides,
  };
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

export interface RenderOptions {
  readonly client: ApiClient;
  readonly me?: Me;
  readonly administrator?: boolean;
  readonly route?: string;
  readonly path?: string;
  readonly refresh?: () => void;
}

/** Render a screen inside the API, session, and router contexts it needs. */
export function renderScreen(ui: ReactElement, options: RenderOptions) {
  const me = options.me ?? makeMe(options.administrator ? { member: { id: MEMBER_ID, roleId: ROLE_IDS.administrator } } : {});
  const session = sessionFor(me, BUILT_IN, options.refresh ?? (() => undefined));
  return render(
    <ApiContext.Provider value={options.client}>
      <SessionContext.Provider value={session}>
        <MemoryRouter initialEntries={[options.route ?? '/']}>
          <Routes>
            <Route path={options.path ?? '*'} element={ui} />
            <Route path="*" element={null} />
          </Routes>
          <LocationProbe />
        </MemoryRouter>
      </SessionContext.Provider>
    </ApiContext.Provider>,
  );
}
