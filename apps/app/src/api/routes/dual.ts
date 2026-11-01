import { Hono } from 'hono';
import { approveDual, declineDual, listOpenDualApprovals, proposeDual, readDualApproval, withdrawDual } from '../../reviews/dual';
import type { ApiEnv } from '../app';
import { readJson } from '../input';

/**
 * Dual_Approvals (R49): an Administrator proposes one of the three overriding actions — a Hold_Override,
 * a widening of a Revoked Owner's Access_List, or a Publication_Consent on behalf of a Revoked Member —
 * and a second, different, currently Active Administrator approves it; or the proposer withdraws, or a
 * second Administrator declines, an open proposal, each with an immutable reason kept in history.
 */
export const dualApprovalsRoutes = new Hono<ApiEnv>();

/** The open Dual_Approvals every active Administrator sees, with the fewer-than-two-Administrators explanation (R49.2, R49.6). */
dualApprovalsRoutes.get('/', async (c) => c.json(await listOpenDualApprovals(c)));
dualApprovalsRoutes.get('/:id', async (c) => c.json({ approval: await readDualApproval(c, c.req.param('id')) }));

dualApprovalsRoutes.post('/', async (c) => c.json(await proposeDual(c, await readJson(c)), 201));
dualApprovalsRoutes.post('/:id/approve', async (c) => c.json(await approveDual(c, c.req.param('id'), await readJson(c))));
dualApprovalsRoutes.post('/:id/decline', async (c) => c.json(await declineDual(c, c.req.param('id'), await readJson(c))));
dualApprovalsRoutes.post('/:id/withdraw', async (c) => c.json(await withdrawDual(c, c.req.param('id'), await readJson(c))));
