import type { ShedDecision } from '@researchforce/domain/admission';

/**
 * The public `status.json` document the Budget object publishes to `files.researchforce.org/status.json`, and
 * its pure builder (task 34.1, design "Capacity, cost, and public abuse budgets", R28.6, R28.11).
 *
 * `status.json` is a small, stored JSON object served from the `rf-public` R2 bucket. The Public_Site reads it
 * to decide whether to show the dynamic Outside_Submission / Consent / Response forms, the addressed `/t`
 * snapshot views, and the search form — and the public generation it belongs to. It is rewritten exactly when
 * availability changes: when the public budget crosses the Public_Traffic_Budget-minus-2%-margin threshold and
 * forms shed, and at the 00:00 UTC reset when everything reopens.
 *
 * The decision logic lives in 59.3's pure {@link ShedDecision} ({@link statusJson} below only shapes it into
 * the document); the R2 put is {@link writeStatus}, kept separate so the document shape is unit-testable with
 * no bucket.
 */

/**
 * Whether static public search follows the API budget. It does NOT: static search is a set of stored index
 * files evaluated in the browser and costs no Worker request or D1 read, so it is INDEPENDENT of the
 * Public_Traffic_Budget (R28.6, R28.11, design "Public search"). This constant pins that invariant in one
 * place: the status document's `search` is derived as `PUBLIC_SEARCH_FOLLOWS_BUDGET ? shed... : true`, which is
 * always `true`. Were search ever to depend on the budget, this is the single flag to flip.
 */
export const PUBLIC_SEARCH_FOLLOWS_BUDGET = false;

/** The `rf-public` object key the public status document is written to (served from `files.researchforce.org/status.json`). */
export const STATUS_OBJECT_KEY = 'status.json';

/**
 * The public status document shape. `form` is dynamic Outside_Submission / Consent / Response form availability;
 * `consentView` is addressed `/t` snapshot-view availability; `search` is static public search, always
 * available. `generation` is the current public invalidation epoch the status belongs to (so a reader can tell
 * a stale cached status from a current one). `reason` carries 59.3's shed reason for the operator runbook.
 */
export interface PublicStatus {
  readonly form: boolean;
  readonly consentView: boolean;
  /** Static public search is always available; it is never gated on the API budget (R28.6, R28.11). */
  readonly search: true;
  /** The current public invalidation epoch this status belongs to. */
  readonly generation: number;
  readonly reason: ShedDecision['reason'];
  readonly stage: ShedDecision['stage'];
}

/**
 * Build the public status document from 59.3's shed decision and the current public generation. `search` is
 * forced to `true` through {@link PUBLIC_SEARCH_FOLLOWS_BUDGET}: static search never follows the budget.
 * `form`/`consentView` come straight from the shed decision's availability. Pure: no R2, no clock.
 */
export function statusJson(shed: ShedDecision, generation: number): PublicStatus {
  return {
    form: shed.availability.form,
    consentView: shed.availability.consentView,
    // Static search is independent of the API budget; PUBLIC_SEARCH_FOLLOWS_BUDGET is false, so this is always true.
    search: PUBLIC_SEARCH_FOLLOWS_BUDGET ? (shed.availability.search as true) : true,
    generation,
    reason: shed.reason,
    stage: shed.stage,
  };
}

/** Put the public status document to the `rf-public` bucket at `status.json` as small `application/json`. */
export async function writeStatus(bucket: R2Bucket, status: PublicStatus): Promise<void> {
  await bucket.put(STATUS_OBJECT_KEY, JSON.stringify(status), {
    httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
  });
}
