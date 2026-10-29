import type { Hono } from 'hono';
import { createApi } from './api/app';
import type { ApiEnv } from './api/app';
import { AccessKeys, certsUrl } from './auth/jwt';
import { runScheduled } from './cron';
import type { Env } from './env';
import { createLogger } from './log';
import { assertDevRuntime, cookieAssertion, createDevAuth, devResponse } from './auth/dev';
export { Budget, Jobs, Mailer, Publisher } from './durable-objects';

/** The deployable entrypoint uses false. Only local.ts opts into the local runtime. */
export interface LocalRuntimeAdapter {
  environment(env: Env): Env;
  routes(env: Env): Hono<ApiEnv>;
}
export function createWorker(localRuntime = false, services?: LocalRuntimeAdapter) {
  let cached: { key: string; value: Promise<{ app: Hono<ApiEnv>; dev: Awaited<ReturnType<typeof createDevAuth>> | undefined }> } | undefined;
  const apiFor = (env: Env) => {
    const access = { teamDomain: env.ACCESS_TEAM_DOMAIN ?? '', audience: env.ACCESS_AUD ?? '' };
    const key = JSON.stringify([access.teamDomain, access.audience, env.WORKSPACE_ORIGIN, env.RF_DEV_AUTH, env.RF_DEV_AUTH_PRIVATE_KEY, env.RF_LOCAL_SERVICES]);
    if (cached?.key !== key) cached = { key, value: (async () => {
      const dev = env.RF_DEV_AUTH === '1' ? await createDevAuth(env) : undefined;
      return { dev, app: createApi({ access, keys: dev?.keys ?? new AccessKeys(certsUrl(access)), workspaceOrigin: env.WORKSPACE_ORIGIN ?? '', log: createLogger(), ...(services ? { localRoutes: services.routes(env) } : {}) }) };
    })() };
    return cached.value;
  };
  return {
    async fetch(request: Request, rawEnv: Env, ctx: ExecutionContext) {
      assertDevRuntime(rawEnv, localRuntime);
      if (services && !localRuntime) throw new Error('Local adapters cannot run in the production entrypoint.');
      const env = services ? services.environment(rawEnv) : rawEnv;
      const path = new URL(request.url).pathname;
      if (path.startsWith('/api/dev/')) {
        if (env.RF_DEV_AUTH !== '1') return Response.json({ error: 'not_found' }, { status: 404, headers: { 'cache-control': 'no-store' } });
        return (await apiFor(rawEnv)).dev!.route(request);
      }
      if (path.startsWith('/api/')) {
        if (path.startsWith('/api/v1/dev/') && !services) return Response.json({ error: 'not_found' }, { status: 404 });
        if (env.RF_DEV_AUTH === '1' && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(request.url).hostname)) return new Response('Not found', { status: 404 });
        const result = await (await apiFor(rawEnv)).app.fetch(env.RF_DEV_AUTH === '1' ? cookieAssertion(request) : request, env, ctx);
        return env.RF_DEV_AUTH === '1' && path === '/api/v1/session/logout' && result.status === 303 ? devResponse(result, true) : result;
      }
      return env.ASSETS.fetch(request);
    },
    scheduled(controller, rawEnv, ctx) {
      assertDevRuntime(rawEnv, localRuntime);
      if (services && !localRuntime) throw new Error('Local adapters cannot run in the production entrypoint.');
      const env = services ? services.environment(rawEnv) : rawEnv;
      ctx.waitUntil(runScheduled(controller.cron, env, new Date(controller.scheduledTime), createLogger()));
    },
  } satisfies ExportedHandler<Env>;
}
export default createWorker();
