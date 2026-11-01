import { Hono } from 'hono';
import { authorizeRead } from '../../auth/authorize';
import { completeReview, createReview, reviewQueue } from '../../reviews/reviews';
import { createProposals, createPublicationRequest, decideProposal, readProposal, withdrawConsent } from '../../reviews/proposals';
import { applyPublicationRequest, declinePublicationRequest, readPublicationRequest } from '../../reviews/publication';
import type { ApiEnv } from '../app';
import { readJson } from '../input';

export const reviewsRoutes = new Hono<ApiEnv>();

reviewsRoutes.post('/', async (c) => {
  const id = await createReview(c, await readJson(c));
  return c.json({ review: { id } }, 201);
});

reviewsRoutes.get('/queue', async (c) => {
  await authorizeRead(c);
  return c.json({ reviews: await reviewQueue(c) });
});

reviewsRoutes.post('/:id/complete', async (c) => {
  await completeReview(c, c.req.param('id'), await readJson(c));
  return c.json({ completed: true });
});

/** An Administrator proposes publication values; one Publication_Proposal is addressed to each Consenting_Member (R23.18). */
reviewsRoutes.post('/proposals', async (c) => c.json({ proposals: (await createProposals(c, await readJson(c))).proposals }, 201));

/** The Publication_Proposal addressed to the viewing Consenting_Member, with its proposed values and resulting views (R23.18, R23.19). */
reviewsRoutes.get('/proposals/:id', async (c) => c.json({ proposal: await readProposal(c, c.req.param('id')) }));

/** The addressed Consenting_Member approves or declines a Publication_Proposal (R23.19). */
reviewsRoutes.post('/proposals/:id/decide', async (c) => {
  await decideProposal(c, c.req.param('id'), await readJson(c));
  return c.json({ decided: true });
});

/** The Consenting_Member withdraws a Publication_Consent they gave, while it is still unused (R23.19). */
reviewsRoutes.post('/consents/:id/withdraw', async (c) => {
  await withdrawConsent(c, c.req.param('id'));
  return c.json({ withdrawn: true });
});

/** A Contributor proposes publication values; the Publication_Request is addressed to the Administrator Role and records the proposer's own-unit consent (R23.10, R23.21). */
reviewsRoutes.post('/publication-requests', async (c) => c.json(await createPublicationRequest(c, await readJson(c)), 201));

/** The open Publication_Request's proposed values, so an Administrator pre-fills the disclosure change to apply (R23.11). */
reviewsRoutes.get('/publication-requests/:id', async (c) => c.json({ request: await readPublicationRequest(c, c.req.param('id')) }));

/** An Administrator applies a Publication_Request through the previewed disclosure change, marking it Reviewed Applied (R23.11). */
reviewsRoutes.post('/publication-requests/:id/apply', async (c) => c.json(await applyPublicationRequest(c, c.req.param('id'), await readJson(c))));

/** An Administrator declines a Publication_Request with a note of 1 to 2,000 characters, changing no disclosure value (R23.12). */
reviewsRoutes.post('/publication-requests/:id/decline', async (c) => c.json(await declinePublicationRequest(c, c.req.param('id'), await readJson(c))));
