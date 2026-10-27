export interface RuleIssue { readonly code: string; readonly field: string; readonly message: string; }
export type RuleResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly issues: readonly RuleIssue[] };
export function accepted<T>(value: T): RuleResult<T> { return { ok: true, value }; }
export function refused<T = never>(code: string, field: string, message: string): RuleResult<T> {
  return { ok: false, issues: [{ code, field, message }] };
}
