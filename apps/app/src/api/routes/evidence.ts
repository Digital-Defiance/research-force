import { Hono } from 'hono';
import type { ApiEnv } from '../app';
import { readJson } from '../input';
import { listUnitEvidence, recordEvidence, withdrawEvidence } from '../../records/evidence';

export const evidenceRoutes = new Hono<ApiEnv>();

/** Record one immutable manual Permission_Evidence grant for a letter, call, email, or other evidenced method (R51.15). */
evidenceRoutes.post('/', async (c) => c.json(await recordEvidence(c, await readJson(c)), 201));

/** Append a withdrawal of a grant; once withdrawn it covers nothing (R51.15, R51.18). */
evidenceRoutes.post('/:id/withdrawal', async (c) => c.json(await withdrawEvidence(c, c.req.param('id'), await readJson(c))));

export const unitEvidenceRoutes = new Hono<ApiEnv>();

/** Every Permission_Evidence grant recorded about one Disclosure_Unit, newest first (R51.13). */
unitEvidenceRoutes.get('/:id/evidence', async (c) => c.json(await listUnitEvidence(c, c.req.param('id'))));
