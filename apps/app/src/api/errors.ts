import { GuardViolation, type GuardCode } from '@researchforce/db/batch';

/** Every API error code with its HTTP status (design "Error Handling"). */
export const ERROR_STATUS = Object.freeze({
  unauthenticated: 401,
  forbidden: 403,
  profile_incomplete: 428,
  validation: 422,
  rule: 422,
  gate: 422,
  conflict: 409,
  preview_stale: 409,
  too_large: 413,
  daily_limit: 503,
  frozen: 503,
  unavailable: 503,
  rate_limited: 429,
  not_found: 404,
  /** Anything unexpected: the save did not happen, and the response says only that (R28.13). */
  internal: 500,
} as const);
export type ErrorCode = keyof typeof ERROR_STATUS;
export type ErrorStatus = typeof ERROR_STATUS[ErrorCode];

export interface FieldIssue { readonly field: string; readonly rule: string }
/** The one error shape of every route; it names the caller's own fields, limits, and rules, never internal data. */
export interface ErrorBody { readonly error: ErrorCode; readonly fields?: readonly FieldIssue[]; readonly details?: unknown }

export class ApiError extends Error {
  readonly status: ErrorStatus;
  constructor(readonly code: ErrorCode, readonly extra: { readonly fields?: readonly FieldIssue[]; readonly details?: unknown } = {}, options?: ErrorOptions) {
    super(code, options);
    this.name = 'ApiError';
    this.status = ERROR_STATUS[code];
  }
  get body(): ErrorBody {
    return { error: this.code, ...(this.extra.fields === undefined ? {} : { fields: this.extra.fields }), ...(this.extra.details === undefined ? {} : { details: this.extra.details }) };
  }
}

/** D1 refuses every query once the account reaches a Free plan daily row limit, until 00:00 UTC (R28.9). */
const DAILY_LIMIT = /daily row (?:read|write) limit/iu;
export function isDailyLimitError(error: unknown): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause) if (DAILY_LIMIT.test(current.message)) return true;
  return false;
}

const GUARD_ERRORS: Readonly<Partial<Record<GuardCode, ErrorCode>>> = { rev: 'conflict', chain_tip: 'conflict', decision_open: 'conflict', preview_fresh: 'preview_stale', frozen: 'frozen' };

/** The API error for anything a handler throws. Unknown errors become `internal` without their message. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof GuardViolation) {
    const code = GUARD_ERRORS[error.code] ?? 'rule';
    return new ApiError(code, code === 'rule' ? { details: { rule: error.code, message: error.message } } : {}, { cause: error });
  }
  if (isDailyLimitError(error)) return new ApiError('daily_limit', {}, { cause: error });
  return new ApiError('internal', {}, { cause: error });
}

export function errorResponse(error: ApiError, headers?: HeadersInit): Response {
  return Response.json(error.body, { status: error.status, ...(headers === undefined ? {} : { headers }) });
}
