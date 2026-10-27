export const REDACTED = '[redacted]';

/** Headers whose values are credentials (R20.20). */
const SECRET_HEADERS: ReadonlySet<string> = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'cf-access-jwt-assertion', 'cf-access-token', 'cf-access-client-secret']);
/** Fields that hold request or response bodies or text content, which logs never carry. */
const BODY_FIELDS: ReadonlySet<string> = new Set(['body', 'requestbody', 'responsebody', 'text', 'content', 'html']);
const TOKEN_PATTERNS: readonly RegExp[] = [
  /\beyJ[\w-]*\.[\w-]+(?:\.[\w-]*)?/gu, // JWTs and JWS: base64url JSON headers start with "eyJ"
  /\b(?:Bearer|Basic|Token)\s+[\w.~+/=-]+/giu,
  /[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+/gu,
  /\b[A-Za-z0-9+/_-]{40,}={0,2}/gu, // keys, secrets, and other long opaque strings
];
const MAX_DEPTH = 6;

export function redactText(text: string): string {
  return TOKEN_PATTERNS.reduce((value, pattern) => value.replace(pattern, REDACTED), text);
}

/** A copy of `value` fit for a log line: no credential headers, bodies, tokens, or email addresses. */
export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return typeof value === 'function' || typeof value === 'symbol' ? undefined : value;
  if (depth >= MAX_DEPTH) return REDACTED;
  if (value instanceof Error) return { name: value.name, message: redactText(value.message) };
  if (value instanceof Headers) return redact(Object.fromEntries(value), depth);
  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const name = key.toLowerCase();
    if (BODY_FIELDS.has(name)) continue;
    result[key] = SECRET_HEADERS.has(name) ? REDACTED : redact(entry, depth + 1);
  }
  return result;
}

/** The first 16 hex digits of SHA-256, so log lines can be correlated without naming the Member. */
export async function hashMemberId(id: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`rf-member:${id}`)));
  return Array.from(digest.subarray(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export type LogLevel = 'info' | 'warn' | 'error';
export type LogSink = (line: string) => void;
export interface Logger { (level: LogLevel, event: string, fields?: Readonly<Record<string, unknown>>): void }

const consoleSink: LogSink = (line) => console.log(line);

/** Structured JSON logs; every field passes through the redactor before it is written. */
export function createLogger(sink: LogSink = consoleSink): Logger {
  return (level, event, fields = {}) => sink(JSON.stringify(redact({ ...fields, level, event })));
}
