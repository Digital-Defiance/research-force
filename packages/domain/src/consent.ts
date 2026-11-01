/**
 * Publication consent, Confidentiality_Holds, and Dual_Approvals (R23.17 to R23.24, R48, R49).
 *
 * Publication of a Disclosure_Unit's own values is gated three ways on top of the ordinary disclosure
 * rules. First, a change that would widen a Consenting_Member's Public_View needs that Member's
 * Publication_Consent for the exact proposed values, bound to a canonical snapshot of the resulting
 * material, so that a later dependency change cannot quietly widen what was agreed (R23.17 to R23.24).
 * Second, a Confidentiality_Hold on an Item holds its whole subtree Not_Published until it is lifted or
 * overridden, and no save may widen a covered unit (R48). Third, the few actions that override a
 * Member's protection — a Hold_Override, a widening for a Revoked Owner, and a consent on behalf of a
 * Revoked Member — each need two different Active Administrators through a Dual_Approval (R49).
 *
 * This module holds only the shared vocabulary and bounds those three features store in rf-core, so the
 * schema's CHECK constraints and the later request/preview/approve paths name the same values.
 */

/**
 * How a Publication_Consent was given (design "Consent and holds"): by a Member's own Publication_Request
 * for a unit they are the Consenting_Member of, by that Member approving a Publication_Proposal, or by a
 * Dual_Approval consenting on behalf of a Revoked Member (R23.21, R23.19, R23.22).
 */
export const CONSENT_SOURCES = ['request', 'proposal', 'dual'] as const;
export type ConsentSource = typeof CONSENT_SOURCES[number];

/**
 * Which review a `review_requests` row is (design "Links and reviews"): an ordinary Review_Request, a
 * Publication_Request that proposes publication values, or a Publication_Proposal addressed to one
 * Consenting_Member. A proposal is reviewed with the outcome Approved or Declined; a publication request
 * keeps the existing Applied or Declined; an ordinary review carries no outcome.
 */
export const REQUEST_TYPES = ['review', 'publication_request', 'proposal'] as const;
export type RequestType = typeof REQUEST_TYPES[number];

/**
 * The action a Dual_Approval authorizes (R49.1): overriding a Confidentiality_Hold, widening the access
 * of a Research_Item whose Owner is Revoked, or recording a Publication_Consent on behalf of a Revoked
 * Consenting_Member. Exactly these three actions need two Administrators; nothing else does.
 */
export const DUAL_APPROVAL_ACTIONS = ['hold_override', 'access_widen', 'consent_on_behalf'] as const;
export type DualApprovalAction = typeof DUAL_APPROVAL_ACTIONS[number];

/**
 * Where a Dual_Approval stands (R49.2 to R49.5). It opens when an Administrator proposes it, and then it
 * is approved by a second Administrator, declined by one, withdrawn by its proposer, or lapsed when its
 * effect changed or its proposer became ineligible before a second Administrator could act (R49.4). A
 * closed proposal is kept, with its Administrators, times, and reasons, for as long as its element
 * exists (R49.7).
 */
export const DUAL_APPROVAL_STATES = ['open', 'approved', 'declined', 'withdrawn', 'lapsed'] as const;
export type DualApprovalState = typeof DUAL_APPROVAL_STATES[number];

/** Bounds on one consent, hold, or approval, chosen so each is always one bounded write. */
export const CONSENT_LIMITS = Object.freeze({
  /** A Confidentiality_Hold's note, required when it is placed (R48.1). */
  holdNoteCodePoints: 2000,
  /** The optional note given when a Confidentiality_Hold is lifted (R48.6). */
  liftNoteCodePoints: 2000,
  /** The reason an Administrator gives when proposing or deciding a Dual_Approval (R49.2, R49.3, R49.5). */
  dualReasonCodePoints: 2000,
  /** The optional note a Consenting_Member gives when approving or declining a Publication_Proposal (R23.19). */
  proposalNoteCodePoints: 2000,
});
