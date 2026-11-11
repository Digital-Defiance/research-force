import { resourceProfile } from '@researchforce/domain/resource-profile';
import { authorizeRead } from '../auth/authorize';
import { fileRoutes } from './routes/files';
import { uploadRoutes } from './routes/uploads';
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
import { workspaceSecurityHeaders } from './security-headers';
import { idempotency, operationRoutes } from './idempotency';
import { ApiError, errorResponse, toApiError } from './errors';
import type { ErrorCode } from './errors';
import { profileGate } from '../auth/profile-gate';
import { membersRoutes } from './routes/members';
import { memberProfileRoutes, meRoutes } from './routes/profile';
import { accessRoutes } from './routes/access';
import { activityRoutes } from './routes/activity';
import { notificationRoutes } from './routes/notifications';
import { searchRoutes } from './routes/search';
import { discussionRoutes } from './routes/discussion';
import { historyRoutes } from './routes/history';
import { itemsRoutes } from './routes/items';
import { citationsRoutes } from './routes/citations';
import { computeRoutes } from './routes/compute';
import { projectCoverageRoutes, runCoverageRoutes, scopeRoutes } from './routes/coverage';
import { decisionsRoutes } from './routes/decisions';
import { derivationsRoutes } from './routes/derivations';
import { linksRoutes } from './routes/links';
import { listsRoutes } from './routes/lists';
import { partiesRoutes } from './routes/parties';
import { projectsRoutes } from './routes/projects';
import { reviewsRoutes } from './routes/reviews';
import { rolesRoutes } from './routes/roles';
import { settingsRoutes } from './routes/settings';
import { stagesRoutes } from './routes/stages';
import { valueSetsRoutes } from './routes/value-sets';
import { questionsRoutes } from './routes/questions';
import { workListRoutes } from './routes/work-lists';
import { workRoutes } from './routes/work';
import { draftRecoveryRoutes, draftsRoutes } from './routes/drafts';
import { proposalsRoutes } from './routes/proposals';
import { personalRoutes } from './routes/personal';
import { disclosureRoutes } from './routes/disclosure';
import { evidenceRoutes, unitEvidenceRoutes } from './routes/evidence';
import { dualApprovalsRoutes } from './routes/dual';
import { importsRoutes } from './routes/imports';
import { dissentRoutes } from './routes/dissent';
import { releaseRoutes } from './routes/releases';
import { exportsRoutes } from './routes/exports';
import { backupsRoutes } from './routes/backups';
import { restoresRoutes } from './routes/restores';
import { publisherRoutes } from './routes/publisher';
import { moderationRoutes } from './routes/moderation';
import { consentRequestsRoutes } from './routes/consent';
import { policyRoutes } from './routes/policy';
import { aiRoutes } from './routes/ai';
import { opsStatusRoutes } from './routes/ops';
import { recordRouteMetric } from '../metrics';
import type { StatusSources } from '../metrics';

export interface ApiConfig {
  /** Only the controlled local entrypoint supplies developer routes. */
  readonly localRoutes?: Hono<ApiEnv>;
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
  /** Fake operations-status sources for the `GET /ops/status` summary (no `Budget` object runs in the Workers pool). */
  readonly opsStatusSources?: StatusSources;
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
    const route = routePath(c, -1);
    const wallMs = Date.now() - started;
    const usage = c.get('accountant').usage;
    // The per-route metric event (R28.2, R28.3): a request count of one with the route's wall time and tracked D1
    // rows, so Workers Logs can group routes by the `metric` event and read the CPU column for the same invocation.
    // Emitted before the `request` line so the request log stays the last line for the request.
    recordRouteMetric(config.log, { method: c.req.method, route, status: c.res.status, wallMs, d1: { rowsRead: usage.rowsRead, rowsWritten: usage.rowsWritten } });
    // CPU time is not readable inside a Worker; Workers Logs records it for each invocation.
    config.log(c.res.status >= 500 ? 'error' : 'info', 'request', {
      method: c.req.method, route, status: c.res.status, wallMs, d1: usage,
      ...(session ? { member: await hashMemberId(session.member.id) } : {}),
      ...(failure ? { error: failure } : {}),
    });
  });
  app.use('/api/*', workspaceSecurityHeaders());
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

  app.use('/api/*', idempotency());

  const v1 = new Hono<ApiEnv>();
  if (config.localRoutes) v1.route('/dev', config.localRoutes);
  v1.get('/resource-profile', async (c) => {
    await authorizeRead(c);
    // Local geometry is shared; production runtime certification is a separate release artifact (48.3).
    return c.json({ profile: resourceProfile(c.env.RESOURCE_PROFILE), productionCertified: false, certification: 'pending-runtime-evidence' });
  });
  v1.route('/operations', operationRoutes);
  v1.route('/uploads', uploadRoutes);
  v1.route('/', fileRoutes);
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
  v1.route('/lists', listsRoutes);
  v1.route('/citations', citationsRoutes);
  v1.route('/runs', computeRoutes);
  v1.route('/runs', runCoverageRoutes);
  v1.route('/projects', projectCoverageRoutes);
  v1.route('/scopes', scopeRoutes);
  v1.route('/decisions', decisionsRoutes);
  v1.route('/derivations', derivationsRoutes);
  v1.route('/work', workRoutes);
  v1.route('/', workListRoutes);
  v1.route('/drafts', draftsRoutes);
  v1.route('/proposals', proposalsRoutes);
  v1.route('/me', personalRoutes);
  v1.route('/ops', draftRecoveryRoutes);
  v1.route('/ops', opsStatusRoutes(config.opsStatusSources ? { statusSources: config.opsStatusSources } : {}));
  v1.route('/questions', questionsRoutes);
  v1.route('/parties', partiesRoutes);
  v1.route('/', discussionRoutes);
  v1.route('/', activityRoutes);
  v1.route('/', notificationRoutes);
  v1.route('/', searchRoutes);
  v1.route('/items', historyRoutes);
  v1.route('/items', itemsRoutes);
  v1.route('/access', accessRoutes);
  v1.route('/reviews', reviewsRoutes);
  v1.route('/disclosure', disclosureRoutes);
  v1.route('/evidence', evidenceRoutes);
  v1.route('/units', unitEvidenceRoutes);
  v1.route('/dual-approvals', dualApprovalsRoutes);
  v1.route('/stages', stagesRoutes);
  v1.route('/value-sets', valueSetsRoutes);
  v1.route('/settings', settingsRoutes);
  v1.route('/imports', importsRoutes);
  v1.route('/dissent', dissentRoutes);
  v1.route('/releases', releaseRoutes);
  v1.route('/exports', exportsRoutes);
  v1.route('/backups', backupsRoutes);
  v1.route('/restores', restoresRoutes);
  v1.route('/publisher', publisherRoutes);
  v1.route('/moderation', moderationRoutes);
  v1.route('/consent-requests', consentRequestsRoutes);
  v1.route('/policy', policyRoutes);
  // AI drafting is Workspace-only: mounted solely here on the authenticated API, never on rf-submit, imports,
  // or restores, so Public_Traffic, imports, and restores cannot reach the AI_Service (R44.13).
  v1.route('/ai', aiRoutes);
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
