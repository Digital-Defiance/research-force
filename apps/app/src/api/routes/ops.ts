import { Hono } from 'hono';
import { isAdministrator } from '@researchforce/domain/permissions';
import { permissionContext } from '../../auth/authorize';
import { operationsStatus } from '../../metrics';
import type { StatusSources } from '../../metrics';
import type { ApiEnv } from '../app';
import { ApiError } from '../errors';

/**
 * The operations-status endpoint (task 46.1, R24.11, R28.2, R28.3; design "Observability and Operations"). An
 * Administrator-only summary that AGGREGATES the metrics named in the design — Publisher lag (save→deploy and
 * save→verified-removal), Mailer queue depth / held time / delay-against-the-limit, AI Neurons per day, and
 * Public_Traffic_Budget use — from their real owners (`rf-public.publish_runs`, the `rf-core` sending queue, and the
 * `Budget` object), never a parallel counter. Per-route request/CPU/D1 figures are emitted as structured `metric`
 * events to Workers Logs by {@link import('../../metrics').recordRouteMetric}, which supplies the CPU column; this
 * endpoint serves the aggregated operational summary.
 *
 * Gated on {@link isAdministrator}: a non-Administrator (and anyone whose session is not an active Member) is refused
 * with the ordinary authorization error, exactly as the Administrator-only Project_Accent and Responsible_Person
 * paths are, reusing the existing Role/Member_Status permission context rather than a new auth mechanism.
 */
export const opsRoutes = new Hono<ApiEnv>();

/** A test may inject fake status sources (no running `Budget` object in the Workers pool); production reads the real owners. */
export interface OpsRouteConfig { readonly statusSources?: StatusSources }

export function opsStatusRoutes(config: OpsRouteConfig = {}): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>();
  routes.get('/status', async (c) => {
    // Administrator-only: reuse the request's Role/Member_Status permission context; refuse everyone else (R2.7).
    if (!isAdministrator(await permissionContext(c))) throw new ApiError('forbidden');
    const status = await operationsStatus(c.env, c.get('now'), config.statusSources ?? {}, c.get('log'));
    return c.json({ status });
  });
  return routes;
}
