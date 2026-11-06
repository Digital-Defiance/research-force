import { Hono } from 'hono';
import type { Context } from 'hono';
import { authorizeRead } from '../../auth/authorize';
import { editPolicyPage, loadPolicyPage, policyCompare, policyHistory, policyPageKey, policyResponse } from '../../policy/policy';
import type { PolicyPageRecord } from '../../policy/policy';
import type { ApiEnv } from '../app';
import { ApiError } from '../errors';
import { readJson } from '../input';

/** The Policy_Pages: reading a page with its sections and a Public_Site preview, and editing its section text (R46.27–R46.32). */
export const policyRoutes = new Hono<ApiEnv>();

/** The Policy_Page named in the URL, or a 404 for an unknown page key. */
async function pageByKey(c: Context<ApiEnv>): Promise<PolicyPageRecord> {
  const key = policyPageKey(c.req.param('page'));
  if (key === undefined) throw new ApiError('not_found');
  return loadPolicyPage(c, key);
}

/** The page's fixed sections in order and a preview rendered exactly as the Public_Site shows it (R46.27, R46.32). */
policyRoutes.get('/:page', async (c) => {
  await authorizeRead(c);
  return c.json(await policyResponse(c, await pageByKey(c)));
});

/**
 * Apply an edit to the page's section text after the Administrator confirms the preview, recording a Minor_Edit or
 * Correction Revision with its reason (R46.27). A refusal keeps the input and lists the Revisions since the base `rev`
 * (R46.28). The response carries the saved page with a fresh preview.
 */
policyRoutes.put('/:page', async (c) => {
  const current = await pageByKey(c);
  const saved = await editPolicyPage(c, current, await readJson(c));
  return c.json(await policyResponse(c, saved));
});

/** The creation and every Revision of the page, newest first, and the state after the chosen point (R22.3, R46.27). */
policyRoutes.get('/:page/history', async (c) => {
  await authorizeRead(c);
  return c.json({ history: await policyHistory(c, await pageByKey(c)) });
});

/** Each section whose text differs between two points in the page's history, with both values (R22.4, R46.27). */
policyRoutes.get('/:page/compare', async (c) => {
  await authorizeRead(c);
  const { from, to } = c.req.query();
  if (!from || !to) throw new ApiError('validation', { fields: [...(from ? [] : [{ field: 'from', rule: 'Choose two points to compare.' }]), ...(to ? [] : [{ field: 'to', rule: 'Choose two points to compare.' }])] });
  return c.json(policyCompare(await policyHistory(c, await pageByKey(c)), from, to));
});
