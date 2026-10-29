import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalDevelopmentBar, workspaceClient } from '../src/local-development';

afterEach(cleanup);
describe('local sign-in controls', () => {
  it('shows switch/sign-out only for the local opt-in page', () => {
    const view = render(<LocalDevelopmentBar enabled={false} />);
    expect(screen.queryByRole('complementary')).toBeNull();
    view.rerender(<LocalDevelopmentBar enabled />);
    expect(screen.getByRole('link', { name: 'Switch synthetic member' }).getAttribute('href')).toBe('/api/dev/sign-in');
    expect(screen.getByRole('button', { name: 'Sign out of local development' }).closest('form')?.getAttribute('method')).toBe('post');
  });
  it('sends local unauthenticated clients to sign-in while production retains Access reload', async () => {
    const fetch = vi.fn().mockImplementation(async () => Response.json({ error: 'unauthenticated' }, { status: 401 }));
    const navigate = vi.fn(); const reload = vi.fn();
    await expect(workspaceClient(true, { fetch, reload }, navigate).get('/me')).rejects.toThrow();
    expect(navigate).toHaveBeenCalledWith('/api/dev/sign-in'); expect(reload).not.toHaveBeenCalled();
    await expect(workspaceClient(false, { fetch, reload }, navigate).get('/me')).rejects.toThrow();
    expect(reload).toHaveBeenCalledOnce();
  });
});
