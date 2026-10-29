import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';
import { fragmentDigest } from '@researchforce/domain/text-fragments';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { ApiEnv } from './app';
import { ApiError } from './errors';

/** The client chooses and stores the key before it sends a write; the Worker never invents one. */
export const OPERATION_KEY_HEADER = 'Idempotency-Key';
const KEY = /^[A-Za-z0-9_-]{16,64}$/u;
const MUTATING: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** A request still pending after this long was cut off before it committed, or its outcome was lost. */
export const PENDING_WINDOW_MS = 120_000;
const ID = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

export type OperationState = 'pending' | 'committed' | 'refused' | 'unknown';
export interface OperationView {
  readonly key: string; readonly state: OperationState; readonly status?: number; readonly error?: string;
  readonly resource?: Readonly<Record<string, string>>; readonly createdAt: string; readonly completedAt?: string;
}
interface Row {
  requestHash: string; method: string; route: string; state: 'pending' | 'committed' | 'refused'; status: number | null; errorCode: string | null; resource: string | null;
  createdAt: string; completedAt: string | null;
}
const COLUMNS = `request_hash AS requestHash, method, route, state, status, error_code AS errorCode, resource_json AS resource, created_at AS createdAt, completed_at AS completedAt`;

/** Digest of what the key stands for: the method, the full path and query, and the exact body bytes. */
async function requestDigest(request: Request): Promise<string> {
  const url = new URL(request.url);
  const body = new Uint8Array(await request.clone().arrayBuffer());
  return fragmentDigest({ method: request.method, target: url.pathname + url.search, body: bytesToHex(sha256(body)) });
}

function viewOf(key: string, row: Row, now: number): OperationView {
  const stale = row.state === 'pending' && now - Date.parse(row.createdAt) >= PENDING_WINDOW_MS;
  return {
    key, state: stale ? 'unknown' : row.state, createdAt: row.createdAt,
    ...(row.status === null ? {} : { status: row.status }), ...(row.errorCode === null ? {} : { error: row.errorCode }),
    ...(row.resource === null ? {} : { resource: JSON.parse(row.resource) as Record<string, string> }), ...(row.completedAt === null ? {} : { completedAt: row.completedAt }),
  };
}

/** The IDs a response names, one level into the body and at most eight of them: enough to find the result again, never its content. */
async function resourceOf(response: Response): Promise<string | null> {
  if (!(response.headers.get('Content-Type') ?? '').includes('application/json')) return null;
  const length = Number(response.headers.get('Content-Length') ?? '0');
  if (length > 1_000_000) return null;
  let body: unknown;
  try { body = await response.clone().json(); } catch { return null; }
  const found: Record<string, string> = {};
  const visit = (value: unknown, path: string, depth: number): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(found).length >= 8) return;
    for (const [name, child] of Object.entries(value)) {
      const label = path ? `${path}.${name}` : name;
      if (typeof child === 'string' && ID.test(child) && (name === 'id' || name.endsWith('Id'))) found[label] = child;
      else if (depth < 1) visit(child, label, depth + 1);
    }
  };
  visit(body, '', 0);
  return Object.keys(found).length ? JSON.stringify(found) : null;
}

/**
 * Actor-scoped operation keys for every write (R28.10, R28.13, R60.2). The row is inserted before the handler runs and flips to `committed` inside the
 * handler's own GuardedBatch; a same-key replay of the same request gets the recorded status and result IDs instead of running again.
 */
export function idempotency(): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const key = c.req.header(OPERATION_KEY_HEADER);
    if (key === undefined || !MUTATING.has(c.req.method)) return next();
    if (!KEY.test(key)) throw new ApiError('validation', { fields: [{ field: OPERATION_KEY_HEADER, rule: 'Use 16 to 64 letters, digits, hyphens or underscores.' }] });
    const db = c.env.RF_CORE;
    const accountant = c.get('accountant');
    const actor = c.get('session').member.id;
    const now = c.get('now');
    const digest = await requestDigest(c.req.raw);
    const inserted = await accountant.track(db.prepare(`INSERT INTO idempotency_results (actor_id, op_key, request_hash, method, route, state, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6)
      ON CONFLICT (actor_id, op_key) DO NOTHING`).bind(actor, key, digest, c.req.method, routePath(c, -1), now).run());
    if (inserted.meta.changes !== 1) {
      const row = (await db.prepare(`SELECT ${COLUMNS} FROM idempotency_results WHERE actor_id = ?1 AND op_key = ?2`).bind(actor, key).first<Row>())!;
      if (row.requestHash !== digest) throw new ApiError('conflict', { details: { rule: 'operation_key_reused' } });
      if (row.state === 'pending') {
        const claimed = Date.parse(now) - Date.parse(row.createdAt) >= PENDING_WINDOW_MS
          && (await db.prepare("UPDATE idempotency_results SET created_at = ?3 WHERE actor_id = ?1 AND op_key = ?2 AND state = 'pending' AND created_at = ?4")
            .bind(actor, key, now, row.createdAt).run()).meta.changes === 1;
        if (!claimed) throw new ApiError('conflict', { details: { rule: 'operation_pending' } });
      } else {
        c.header('Idempotency-Replayed', 'true');
        const view = viewOf(key, row, Date.parse(now));
        return row.state === 'committed' ? c.json({ replayed: true, operation: view }, row.status as 200) : c.json({ error: row.errorCode ?? 'conflict', replayed: true, operation: view }, row.status as 409);
      }
    }
    accountant.operation = { actorId: actor, key };
    await next();
    const status = c.res.status;
    const failure = c.get('failure') as string | undefined;
    try {
      if (status < 400) {
        await accountant.track(db.prepare("UPDATE idempotency_results SET state = 'committed', status = ?3, resource_json = ?4, completed_at = coalesce(completed_at, ?5) WHERE actor_id = ?1 AND op_key = ?2")
          .bind(actor, key, status, await resourceOf(c.res), now).run());
      } else if (status < 500) {
        await accountant.track(db.prepare("UPDATE idempotency_results SET state = 'refused', status = ?3, error_code = ?4, completed_at = ?5 WHERE actor_id = ?1 AND op_key = ?2 AND state = 'pending'")
          .bind(actor, key, status, failure ?? 'rule', now).run());
      }
    } catch (error) {
      c.get('log')('error', 'operation-record', { error });
    }
  };
}

/** `GET /operations/{key}`: the caller's own operation, or 404, so another actor's key is indistinguishable from an unused one. */
export const operationRoutes = new Hono<ApiEnv>();
operationRoutes.get('/:key', async (c) => {
  const key = c.req.param('key');
  if (!KEY.test(key)) throw new ApiError('not_found');
  const row = await c.get('accountant').track(c.env.RF_CORE.prepare(`SELECT ${COLUMNS} FROM idempotency_results WHERE actor_id = ?1 AND op_key = ?2`)
    .bind(c.get('session').member.id, key).all<Row>()).then((result) => result.results[0]);
  if (!row) throw new ApiError('not_found');
  return c.json({ operation: viewOf(key, row, Date.parse(c.get('now'))) });
});
