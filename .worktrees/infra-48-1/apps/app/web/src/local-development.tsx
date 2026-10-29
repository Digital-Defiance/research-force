import { ApiClient } from './api';
import type { ApiClientOptions } from './api';

/** Only the local Vite runner injects the enabling meta tag. Production keeps Access reloading. */
export function workspaceClient(local: boolean, options: ApiClientOptions = {}, navigate: (path: string) => void = (path) => globalThis.location.assign(path)): ApiClient {
  return new ApiClient({ ...options, ...(local ? { reload: () => navigate('/api/dev/sign-in') } : {}) });
}
export function LocalDevelopmentBar({ enabled }: { readonly enabled: boolean }) {
  if (!enabled) return null;
  return <aside className="rf-notice" aria-label="Local development">
    <a href="/api/dev/sign-in">Switch synthetic member</a>
    <a href="/api/v1/dev/outbox">Local email outbox (Administrator)</a>
    <form method="post" action="/api/dev/sign-out"><button type="submit">Sign out of local development</button></form>
  </aside>;
}
