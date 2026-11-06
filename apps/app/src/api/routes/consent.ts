import { Hono } from 'hono';
import { cancelConsentRequest, createConsentRequest, listConsentRequests, previewConsentRequest } from '../../consent/requests';
import type { ApiEnv } from '../app';
import { readJson } from '../input';

/**
 * Emailed Consent_Requests to External_Parties (R51.2 to R51.4, R51.11). Sending, previewing, and cancelling
 * are Administrator-only (`consent.request`, checked in each handler); the list is open to every active Member
 * (R51.13). `POST /consent-requests/preview` returns the exact email text, the Consent_Page snapshots, and a
 * preview token; `POST /consent-requests` with that token stores the request and queues the email; `GET
 * /consent-requests` lists requests; `POST /consent-requests/{id}/cancel` cancels an open one.
 */
export const consentRequestsRoutes = new Hono<ApiEnv>();

consentRequestsRoutes.post('/preview', async (c) => c.json(await previewConsentRequest(c, await readJson(c))));

consentRequestsRoutes.post('/', async (c) => c.json(await createConsentRequest(c, await readJson(c)), 201));

consentRequestsRoutes.get('/', async (c) => c.json({ requests: await listConsentRequests(c) }));

consentRequestsRoutes.post('/:id/cancel', async (c) => c.json(await cancelConsentRequest(c, c.req.param('id'))));
