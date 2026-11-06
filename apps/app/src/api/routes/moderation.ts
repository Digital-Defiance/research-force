import { Hono } from 'hono';
import { authorizeRead } from '../../auth/authorize';
import { decide } from '../../moderation/decide';
import { correctSubmitter, recordContactReview } from '../../moderation/contact-review';
import { queueFilterFromQuery, readQueue } from '../../moderation/queue';
import type { ApiEnv } from '../app';

/**
 * The Moderation_Queue, open to every active Member in every Role (R2.8, R32.2). It lists Outside_Submissions with
 * their type, Project or General_Choice, state, text, Submitter details, files, referenced page, and receipt time, and
 * for Corrections and Removal_Requests the Response_Target dates with an overdue mark (R32.1, R32.17, R39.14, R46.24).
 * No network address is ever held or shown (R46.20). Decisions and Contact_Reviews are added by later tasks.
 */
export const moderationRoutes = new Hono<ApiEnv>();

moderationRoutes.get('/', async (c) => {
  await authorizeRead(c);
  return c.json(await readQueue(c, queueFilterFromQuery(c.req.query())));
});

/**
 * Record a Moderation_Decision on an Outside_Submission (R32.4 to R32.18, R41.2, R46.23). Open to Administrators
 * (`moderation.decide`). A request without `confirm` returns the exact email text; `confirm: true` applies the
 * decision and queues the Submitter email (R32.10). The `decision_open` guard refuses a decision once a final one
 * exists and shows it (R32.16).
 */
moderationRoutes.post('/:id/decide', async (c) => c.json(await decide(c, c.req.param('id'), await c.req.json().catch(() => null))));

/**
 * Record a Contact_Review on an accepted Outside_Submission whose Submitter_Contact is still held (R32.19, R32.20).
 * Open to Administrators (`moderation.decide`). Keep requires a reason of 1 to 1,000 characters and keeps the
 * Submitter_Contact for another 12 months; Erase erases it within 24 hours. Both keep the Submitter_Attribution and the
 * submitted text, and earlier Contact_Reviews are never changed.
 */
moderationRoutes.post('/:id/contact-review', async (c) => c.json(await recordContactReview(c, c.req.param('id'), await c.req.json().catch(() => null))));

/**
 * Correct the Submitter_Attribution or the Submitter_Contact of an Outside_Submission, or erase the Submitter_Contact,
 * at any time, with a reason (R32.22). Open to Administrators (`moderation.decide`). A corrected Submitter_Attribution
 * becomes the Credit of every Item created from the Outside_Submission, each with a Minor_Edit Revision; a correction
 * records the previous values except an erased Submitter_Contact.
 */
moderationRoutes.post('/:id/contact', async (c) => c.json(await correctSubmitter(c, c.req.param('id'), await c.req.json().catch(() => null))));
