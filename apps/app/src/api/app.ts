import { Hono } from 'hono';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { routePath } from 'hono/route';
import { RequestAccountant } from '@researchforce/db/accountant';
import type { OutboxTopic } from '@researchforce/db/accountant';
import type { OpsAccess } from '@researchforce/domain/ops';
import type { PermissionContext } from '@researchforce/domain/permissions';
import { OPERATIONS } from '@researchforce/domain/settings';
import type { Timestamp } from '@researchforce/domain/types';
import { ACCESS_ASSERTION_HEADER, verifyAccessAssertion } from '../auth/jwt';
import type { AccessConfig, AccessKeys } from '../auth/jwt';
import { ACCESS_LOGOUT_PATH, endSession, establishSession } from '../auth/session';
import type { Session } from '../auth/session';
import type { Env } from '../env';
import { hashMemberId } from '../log';
import type { Logger } from '../log';
import { kick } from '../outbox';
import { csrfGuard, workspaceCors } from './csrf';
import { ApiError, errorResponse, toApiError } from './errors';
import type { ErrorCode } from './errors';
import { profileGate } from '../auth/profile-gate';
import { membersRoutes } from './routes/members';
import { memberProfileRoutes, meRoutes } from './routes/profile';
import { accessRoutes } from './routes/access';
import { activityRoutes } from './routes/activity';
import { discussionRoutes } from './routes/discussion';
import { historyRoutes } from './routes/history';
import { itemsRoutes } from './routes/items';
import { linksRoutes } from './routes/links';
import { partiesRoutes } from './routes/parties';
import { projectsRoutes } from './routes/projects';
import { reviewsRoutes } from './routes/reviews';
import { rolesRoutes } from './routes/roles';
import { settingsRoutes } from './routes/settings';
import { stagesRoutes } from './routes/stages';
import { valueSetsRoutes } from './routes/value-sets';

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
  /** Kicks the owners of outbox topics after the request; the Durable Object kick unless a test supplies one. */
  readonly kick?: (env: Env, topics: readonly OutboxTopic[], log: Logger) => Promise<void>;
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

/** Run `work` after the response; without an execution context it is left to the next cron run. */
function afterResponse(c: Context<ApiEnv>, work: () => Promise<void>): void {
  let context: Pick<ExecutionContext, 'waitUntil'>;
  try {
    context = c.executionCtx;
  } catch {
    return;
  }
  context.waitUntil(work());
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
    const topics = c.get('accountant').outboxTopics;
    if (topics.length > 0) afterResponse(c, () => (config.kick ?? kick)(c.env, topics, config.log));
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
  app.use('/api/*', bodyLimit({
    maxSize: OPERATIONS.stagedSaveThresholdBytes,
    onError: (c) => {
      c.set('failure', 'too_large');
      return errorResponse(new ApiError('too_large', { details: { limitBytes: OPERATIONS.stagedSaveThresholdBytes } }));
    },
  }));

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
  v1.route('/', discussionRoutes);
  v1.route('/', activityRoutes);
  v1.route('/items', historyRoutes);
  v1.route('/items', itemsRoutes);
  v1.route('/access', accessRoutes);
  v1.route('/reviews', reviewsRoutes);
  v1.route('/stages', stagesRoutes);
  v1.route('/value-sets', valueSetsRoutes);
  v1.route('/settings', settingsRoutes);
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
