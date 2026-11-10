import { Hono } from 'hono';
import { siteViewCeiling } from '@researchforce/domain/slice-budget';
import { authorize } from '../../auth/authorize';
import { createLogger } from '../../log';
import { readOutbox } from '../../outbox';
import { isFrozen } from '../../publisher/projection';
import type { ApiEnv } from '../app';
import type { Env } from '../../env';
import { ApiError, toApiError } from '../errors';
/**
 * "Publish now": ask the Publisher to re-render and redeploy the whole public site. Without it the only way to force a
 * rebuild was a save that changed nothing. Gated by `settings.edit` (the Administrator's Settings screen); the global
 * CSRF, Access session and idempotency middleware apply. It writes nothing to rf-core: no research, project or publish
 * setting changes and no outbox row is added.
 */
export const publisherRoutes = new Hono<ApiEnv>();
const log = createLogger();
const GATE = [{ permission: 'settings.edit', target: { type: 'setting', key: 'publicTrafficBudget' } }] as const;
type Blocked = 'frozen' | 'site_too_large' | null;
/** Why publishing cannot run right now: a backup freeze or restore quarantine, or the Free-plan site view ceiling. */
async function blockedBy(env: Env): Promise<Blocked> {
  if (await isFrozen(env.RF_CORE)) return 'frozen';
  const views = (await env.RF_PUBLIC.prepare('SELECT count(*) AS n FROM public_views WHERE valid_to_at IS NULL').first<{ n: number }>())?.n ?? 0;
  return views > siteViewCeiling(env.PUBLISHER_SITE_VIEW_CEILING) ? 'site_too_large' : null;
}
const publisher = (env: Env) => env.PUBLISHER.getByName('publisher');
publisherRoutes.get('/', async (c) => {
  await authorize(c, [...GATE]);
  try {
    const blocked = await blockedBy(c.env);
    const status = await publisher(c.env).status();
    const queued = (await readOutbox(c.env.RF_CORE, 'publish', 1)).length > 0;
    const last = await c.env.RF_PUBLIC.prepare('SELECT started_at AS startedAt, finished_at AS finishedAt, verified_at AS verifiedAt FROM publish_runs ORDER BY started_at DESC LIMIT 1')
      .first<{ startedAt: string | null; finishedAt: string | null; verifiedAt: string | null }>();
    return c.json({ blocked, run: status.running ? { phase: status.phase, startedAt: status.startedAt } : null, queued, lastRun: last });
  } catch (error) {
    throw toApiError(error);
  }
});
publisherRoutes.post('/republish', async (c) => {
  await authorize(c, [...GATE]);
  const blocked = await blockedBy(c.env);
  if (blocked === 'frozen') throw new ApiError('frozen', { details: { reason: 'publishing_paused' } });
  if (blocked === 'site_too_large') throw new ApiError('unavailable', { details: { reason: 'site_too_large' } });
  try {
    const stub = publisher(c.env);
    await stub.republish();
    const status = await stub.status();
    log('info', 'publish_now_requested', { member: c.get('session').member.id });
    return c.json({ requested: true, at: c.get('now'), status }, 202);
  } catch (error) {
    const failure = toApiError(error);
    throw failure.code === 'internal' ? new ApiError('unavailable', {}, { cause: error }) : failure;
  }
});
