import { Hono } from 'hono';
import { z } from 'zod';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import { parse, readJson } from '../api/input';
import { authorizeRead } from '../auth/authorize';
import type { Env } from '../env';
import type { LocalRuntimeAdapter } from '../index';
import { localServicesFor, LOCAL_RETENTION } from './services';

const escape = (text: string): string => text.replace(/[&<>"']/gu, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const htmlHeaders = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'same-origin',
  'content-security-policy': "default-src 'none'; script-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'", 'x-content-type-options': 'nosniff' };
const page = (title: string, body: string) => new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><h1>${escape(title)}</h1><p>Local capture only. No email is delivered, no external Access list is changed and no AI model runs.</p>${body}<p><a href="/">Workspace</a> · <a href="/api/v1/dev/outbox">Local outbox</a></p></html>`, { headers: htmlHeaders });
const cursor = (value: string | undefined): number => {
  if (value === undefined) return Number.MAX_SAFE_INTEGER;
  if (!/^[1-9]\d{0,15}$/u.test(value) || !Number.isSafeInteger(Number(value))) throw new ApiError('validation');
  return Number(value);
};

/** These routes live behind the existing JWT, session, Profile and CSRF middleware. */
export function localRoutes(): Hono<ApiEnv> {
  // The local entrypoint already validated the raw bindings. Use the current request's namespace, never a cached stub.
  const service = (env: Env) => {
    if (env.RF_LOCAL_SERVICES !== '1' || !env.LOCAL_SERVICES) throw new ApiError('not_found');
    return env.LOCAL_SERVICES.getByName('local-services');
  };
  const routes = new Hono<ApiEnv>();
  routes.use('*', async (c, next) => {
    const context = await authorizeRead(c);
    if (context.member.roleId !== ROLE_IDS.administrator) throw new ApiError('forbidden');
    c.header('cache-control', 'no-store');
    await next();
  });
  routes.get('/outbox', async (c) => {
    const data = await service(c.env).mailPage(cursor(c.req.query('before')));
    return page('Local email outbox', `<p>Retains the latest ${LOCAL_RETENTION} captured messages. The normal queue, batching, rate limits and retry behavior still apply.</p><p><a href="/api/v1/dev/services">Service diagnostics (JSON)</a> · <a href="/api/v1/dev/outbox">Refresh</a></p><ul>${data.messages.map((mail) => `<li><a href="/api/v1/dev/outbox/${mail.id}">${escape(mail.subject)}</a> — ${escape(mail.to)} — ${escape(mail.at)}</li>`).join('')}</ul>${data.nextBefore === null ? '' : `<a href="/api/v1/dev/outbox?before=${data.nextBefore}">Older messages</a>`}`);
  });
  routes.get('/outbox/:id', async (c) => {
    const mail = await service(c.env).mail(cursor(c.req.param('id')));
    if (!mail) throw new ApiError('not_found');
    return page('Captured local email', `<h2>${escape(mail.subject)}</h2><p>To: ${escape(mail.to)} · ${escape(mail.at)}</p><h3>Plain text</h3><pre>${escape(mail.text)}</pre><details><summary>HTML source (inert)</summary><pre>${escape(mail.html)}</pre></details>`);
  });
  routes.get('/services', async (c) => c.json(await service(c.env).diagnostics()));
  // Developer probe for the stand-in; this does not implement the research AI-drafting feature of task 42.
  routes.post('/ai', async (c) => {
    const input = parse(z.strictObject({ model: z.string().regex(/^@cf\/[a-z0-9._/-]{1,160}$/iu), prompt: z.string().min(1).max(2000) }), await readJson(c));
    return c.json(await service(c.env).ai(input.model, { prompt: input.prompt }));
  });
  return routes;
}

export const localRuntime: LocalRuntimeAdapter = {
  environment(env) {
    const service = localServicesFor(env);
    return { ...env, OPS: {
      addMember: (email: string) => service.addMember(email), removeMember: (email: string) => service.removeMember(email), revokeSessions: (email: string) => service.revokeSessions(email),
      fetch: async () => new Response('Local RPC methods only', { status: 404 }),
    } as unknown as Env['OPS'], AI: { run: async (model: string, input: unknown) => {
      const result = await service.ai(model, input);
      if ('error' in result) throw new Error(result.error);
      return result;
    } } as unknown as Ai };
  },
  routes: localRoutes,
};
