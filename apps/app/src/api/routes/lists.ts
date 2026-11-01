import { Hono } from 'hono';
import type { Context } from 'hono';
import { authorizeRead } from '../../auth/authorize';
import { findingsFilterSchema, readFindings } from '../../lists/findings';
import { readRuns, runsFilterSchema } from '../../lists/runs';
import { hypothesesFilterSchema, readHypotheses } from '../../lists/hypotheses';
import { correspondencesFilterSchema, readCorrespondences } from '../../lists/correspondences';
import { archivalFilterSchema, readArchival } from '../../lists/archival';
import { projectIdsFromQuery } from '../../lists/shared';
import type { ApiEnv } from '../app';
import { parse } from '../input';

/**
 * The record-kind lists: the Findings ledger, Runs, Hypotheses, Correspondences, and Archival_Requests. Each applies
 * the visibility gate, excludes the Items of incomplete Submissions, and is confined by the shared multi-Project
 * filter (R5.7, R7.6, R8.5, R9.7, R10.4, R39.14, R47.4).
 */
export const listsRoutes = new Hono<ApiEnv>();

/** Build a filter input from the raw query: every single-valued key plus the `project` multi-value. */
function filterInput(c: Context<ApiEnv>, keys: readonly string[]): Record<string, unknown> {
  const single = c.req.query();
  const input: Record<string, unknown> = Object.fromEntries(keys.flatMap((key) => (single[key] ? [[key, single[key]]] : [])));
  const projects = projectIdsFromQuery(c.req.queries());
  if (projects !== undefined) input['project'] = projects;
  return input;
}
const cursorOf = (c: Context<ApiEnv>): string | undefined => c.req.query('cursor') || undefined;

listsRoutes.get('/findings', async (c) => {
  await authorizeRead(c);
  return c.json(await readFindings(c, parse(findingsFilterSchema, filterInput(c, ['status', 'person', 'specialty'])), cursorOf(c)));
});

listsRoutes.get('/runs', async (c) => {
  await authorizeRead(c);
  return c.json(await readRuns(c, parse(runsFilterSchema, filterInput(c, ['outcome', 'toolName', 'toolVersion', 'computeResource', 'person'])), cursorOf(c)));
});

listsRoutes.get('/hypotheses', async (c) => {
  await authorizeRead(c);
  return c.json(await readHypotheses(c, parse(hypothesesFilterSchema, filterInput(c, ['status'])), cursorOf(c)));
});

listsRoutes.get('/correspondences', async (c) => {
  await authorizeRead(c);
  return c.json(await readCorrespondences(c, parse(correspondencesFilterSchema, filterInput(c, ['party', 'direction', 'from', 'to'])), cursorOf(c)));
});

listsRoutes.get('/archival-requests', async (c) => {
  await authorizeRead(c);
  return c.json(await readArchival(c, parse(archivalFilterSchema, filterInput(c, ['status', 'archive'])), cursorOf(c)));
});
