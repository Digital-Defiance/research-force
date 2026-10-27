import { Hono } from 'hono';
import type { Context } from 'hono';
import { routePath } from 'hono/route';
import { RequestAccountant } from '@researchforce/db/accountant';
import type { OpsAccess } from '@researchforce/domain/ops';
import type { PermissionContext } from '@researchforce/domain/permissions';
import type { Timestamp } from '@researchforce/domain/types';
import { ACCESS_ASSERTION_HEADER, verifyAccessAssertion } from '../auth/jwt';
import type { AccessConfig, AccessKeys } from '../auth/jwt';
import { ACCESS_LOGOUT_PATH, endSession, establishSession } from '../auth/session';
import type { Session } from '../auth/session';
import type { Env } from '../env';
import { hashMemberId } from '../log';
import type { Logger } from '../log';
import { csrfGuard, workspaceCors } from './csrf';
import { ApiError, errorResponse, toApiError } from './errors';
import type { ErrorCode } from './errors';
import { profileGate } from '../auth/profile-gate';
import { membersRoutes } from './routes/members';
import { memberProfileRoutes, meRoutes } from './routes/profile';
import { linksRoutes } from './routes/links';
import { partiesRoutes } from './routes/parties';
import { projectsRoutes } from './routes/projects';
import { rolesRoutes } from './routes/roles';

export interface ApiConfig {
  readonly access: AccessConfig;
  readonly keys: AccessKeys;
  readonly workspaceOrigin: string;
  readonly log: Logger;
  readonly clock?: () => Date;
  /** `rf-ops`; the `OPS` service binding unless a test supplies a fake. */
  readonly ops?: OpsAccess;
  /** The current Content_Licence's name; `CONTENT_LICENCE_NAME` unless a test supplies one. */
  readonly contentLicence?: string;
}
export interface ApiVariables {
  accountant: RequestAccountant;
  now: Timestamp;
  log: Logger;
  ops: OpsAccess;
  /** Empty until the installation configures a Content_Licence. */
  contentLicence: string;
  session: Session;
  permissions: PermissionContext;
  failure: ErrorCode;
}
export type ApiEnv = { Bindings: Env; Variables: ApiVariables };

/** The acting Member's session; set by the authentication middleware before any handler runs. */
export function sessionOf(c: Context<ApiEnv>): Session {
  return c.get('session');
}

export function createApi(config: ApiConfig): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  const clock = config.clock ?? (() => new Date());

  app.use('*', async (c, next) => {
    const started = Date.now();
    c.set('accountant', new RequestAccountant());
    c.set('now', clock().toISOString() as Timestamp);
    c.set('log', config.log);
    c.set('ops', config.ops ?? c.env.OPS);
    c.set('contentLicence', (config.contentLicence ?? c.env.CONTENT_LICENCE_NAME ?? '').trim());
    await next();
    const session = c.get('session') as Session | undefined;
    const failure = c.get('failure') as ErrorCode | undefined;
    // CPU time is not readable inside a Worker; Workers Logs records it for each invocation.
    config.log(c.res.status >= 500 ? 'error' : 'info', 'request', {
      method: c.req.method, route: routePath(c, -1), status: c.res.status, wallMs: Date.now() - started, d1: c.get('accountant').usage,
      ...(session ? { member: await hashMemberId(session.member.id) } : {}),
      ...(failure ? { error: failure } : {}),
    });
  });
  app.use('/api/*', workspaceCors(config.workspaceOrigin));
  app.use('/api/*', csrfGuard(config.workspaceOrigin));
  app.use('/api/*', async (c, next) => {
    const assertion = await verifyAccessAssertion(c.req.header(ACCESS_ASSERTION_HEADER), config.access, config.keys, clock());
    c.set('session', await establishSession(c.env.RF_CORE, assertion, c.get('accountant'), c.get('now')));
    await next();
  });
  app.use('/api/*', profileGate);

  const v1 = new Hono<ApiEnv>();
  v1.route('/me', meRoutes);
  v1.post('/session/logout', async (c) => {
    await endSession(c.env.RF_CORE, sessionOf(c), c.get('accountant'), c.get('now'));
    return c.redirect(ACCESS_LOGOUT_PATH, 303);
  });
  v1.route('/roles', rolesRoutes);
  v1.route('/members', membersRoutes);
  v1.route('/members', memberProfileRoutes);
  v1.route('/projects', projectsRoutes);
  v1.route('/links', linksRoutes);
  v1.route('/parties', partiesRoutes);
  app.route('/api/v1', v1);

  app.notFound((c) => {
    c.set('failure', 'not_found');
    return errorResponse(new ApiError('not_found'));
  });
  app.onError((error, c) => {
    const failure = toApiError(error);
    c.set('failure', failure.code);
    if (failure.code === 'internal') config.log('error', 'unhandled', { method: c.req.method, route: routePath(c, -1), error });
    return errorResponse(failure);
  });
  return app;
}
