import type { Hono } from 'hono';
import { createApi } from './api/app';
import type { ApiEnv } from './api/app';
import { AccessKeys, certsUrl } from './auth/jwt';
import type { Env } from './env';
import { createLogger } from './log';
export { Budget, Jobs, Mailer, Publisher } from './durable-objects';

let api: { readonly key: string; readonly app: Hono<ApiEnv> } | undefined;

/** One API per isolate, so the Access key set stays cached in memory between requests. */
function apiFor(env: Env): Hono<ApiEnv> {
  const access = { teamDomain: env.ACCESS_TEAM_DOMAIN ?? '', audience: env.ACCESS_AUD ?? '' };
  const key = JSON.stringify([access.teamDomain, access.audience, env.WORKSPACE_ORIGIN]);
  if (api?.key !== key) api = { key, app: createApi({ access, keys: new AccessKeys(certsUrl(access)), workspaceOrigin: env.WORKSPACE_ORIGIN ?? '', log: createLogger() }) };
  return api.app;
}

export default {
  fetch(request, env, ctx) {
    if (new URL(request.url).pathname.startsWith('/api/')) return apiFor(env).fetch(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
  scheduled() {
    // Task 20 wires the transactional outbox and scheduled work.
  },
} satisfies ExportedHandler<Env>;
