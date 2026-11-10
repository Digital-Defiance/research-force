import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StaleBuildNotice } from '../src/build/stale-build-notice';
import { checkBuild, installStaleBuildDetection, StaleBuildStore } from '../src/build/stale-build';
import { readUnsent, writeUnsent } from '../src/persist';
const buildJson = (id: string): typeof fetch => (() => Promise.resolve(new Response(JSON.stringify({ id }), { headers: { 'content-type': 'application/json' } }))) as typeof fetch;
const html: typeof fetch = () => Promise.resolve(new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }));
const missing: typeof fetch = () => Promise.resolve(new Response('Not found', { status: 404 }));
const offline: typeof fetch = () => Promise.reject(new TypeError('Failed to fetch'));
afterEach(() => { sessionStorage.clear(); });
describe('checkBuild', () => {
  it('is stale for a different id and current for the same id', async () => {
    expect(await checkBuild({ fetch: buildJson('new'), runningId: 'old' })).toBe('stale');
    expect(await checkBuild({ fetch: buildJson('old'), runningId: 'old' })).toBe('current');
  });
  it('is unknown for a 404, HTML, a network error or an unidentified build', async () => {
    for (const request of [missing, html, offline]) expect(await checkBuild({ fetch: request, runningId: 'old' })).toBe('unknown');
    expect(await checkBuild({ fetch: buildJson('new'), runningId: null })).toBe('unknown');
  });
});
describe('the stale build notice', () => {
  it('appears politely when a worker fails to load and the server has a new build, and nothing reloads before the click', async () => {
    const reload = vi.fn();
    const store = new StaleBuildStore({ fetch: buildJson('new'), runningId: 'old', reload });
    render(<StaleBuildNotice store={store} />);
    expect(screen.queryByRole('status')).toBeNull();
    await act(async () => { await store.noteLoadFailure('worker'); });
    const notice = screen.getByRole('status');
    expect(notice.textContent).toContain('The Workspace was updated. Reload to use the latest version.');
    expect(notice.textContent).toContain('Anything you have typed but not sent in this tab is kept.');
    expect(reload).not.toHaveBeenCalled();
    writeUnsent('draft:note', { text: 'unsent words' });
    fireEvent.click(screen.getByRole('button', { name: 'Reload to update' }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(readUnsent('draft:note')).toEqual({ text: 'unsent words' });
  });
  it('shows nothing when the build is the same', async () => {
    const store = new StaleBuildStore({ fetch: buildJson('old'), runningId: 'old' });
    render(<StaleBuildNotice store={store} />);
    await act(async () => { await store.noteLoadFailure('worker'); });
    expect(screen.queryByRole('status')).toBeNull();
  });
  it('warns and offers "Reload anyway" while an upload holds the reload', async () => {
    const store = new StaleBuildStore({ fetch: buildJson('new'), runningId: 'old' });
    const release = store.hold();
    render(<StaleBuildNotice store={store} />);
    await act(async () => { await store.check(); });
    expect(screen.getByText(/An upload is in progress/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload anyway' })).toBeTruthy();
    act(() => release());
    expect(screen.getByRole('button', { name: 'Reload to update' })).toBeTruthy();
  });
});
describe('detection', () => {
  it('checks the build when a lazy chunk fails to preload', async () => {
    const request = vi.fn(buildJson('new'));
    const store = new StaleBuildStore({ fetch: request as typeof fetch, runningId: 'old' });
    const remove = installStaleBuildDetection(store);
    await waitFor(() => expect(store.get().stale).toBe(true));
    const initial = request.mock.calls.length;
    window.dispatchEvent(new Event('vite:preloadError'));
    await waitFor(() => expect(request.mock.calls.length).toBe(initial + 1));
    remove();
  });
});
