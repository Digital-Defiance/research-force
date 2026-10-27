import type { MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { ApiError } from './errors';

export const CSRF_HEADER = 'X-RF-CSRF';
/** Methods without side effects; viewing is recorded by POST, so a GET never changes data. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * State-changing requests need the custom header, which forces a CORS preflight for any other
 * origin, and an `Origin` equal to the Workspace origin (R14.6).
 */
export function csrfGuard(workspaceOrigin: string): MiddlewareHandler {
  return async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method) && (!c.req.header(CSRF_HEADER) || !workspaceOrigin || c.req.header('Origin') !== workspaceOrigin)) throw new ApiError('forbidden');
    await next();
  };
}

/** CORS for the API: only the Workspace origin, with credentials and the CSRF header. */
export function workspaceCors(workspaceOrigin: string): MiddlewareHandler {
  return cors({
    origin: (origin) => (workspaceOrigin && origin === workspaceOrigin ? origin : null),
    allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowHeaders: ['Content-Type', CSRF_HEADER],
    credentials: true,
    maxAge: 600,
  });
}
