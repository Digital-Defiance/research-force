import type { Context } from 'hono';
import type { z } from 'zod';
import { validate } from '@researchforce/domain/schemas/common';
import type { RuleResult } from '@researchforce/domain/rules';
import { ApiError } from './errors';

/** The request's JSON body; anything that is not JSON is a validation error on the whole body. */
export async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ApiError('validation', { fields: [{ field: '$', rule: 'Send a JSON body.' }] });
  }
}

/** The accepted value, or a validation error listing every failing field with its rule. */
export function accept<T>(result: RuleResult<T>): T {
  if (result.ok) return result.value;
  throw new ApiError('validation', { fields: result.issues.map((issue) => ({ field: issue.field, rule: issue.message })) });
}

export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  return accept(validate(schema, input));
}
