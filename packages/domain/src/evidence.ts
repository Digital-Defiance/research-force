/**
 * Permission_Evidence (R51.9, R51.15 to R51.18): the shared vocabulary, bounds, and coverage helpers for the
 * one immutable record of a grant that both the manual editor and the emailed Consent_Request path write.
 *
 * A grant is never a status someone set by hand. Changing a Consent_Status or a Rights_Status records nothing
 * about who permitted what, so by itself it grants no coverage at all: an uncovered Correspondence, Source, or
 * Attachment stays Withheld rather than being silently published, and a hand-set status is treated as legacy,
 * unverified evidence pending curation, never as an invented historical grant (R51.9, R51.15). Coverage is
 * computed only from a Permission_Evidence row that names the granting Party and claimed authority, the source
 * method and immutable evidence reference, the exact covered content and file identity it was signed against,
 * the permitted uses and naming and any expiry, and whether it has been withdrawn or superseded.
 *
 * The same rules decide manual and emailed grants: an emailed Consent_Answer writes a row whose snapshot is the
 * Consent_Page the Party saw, and a manual grant writes a row whose snapshot is the recorded document identity;
 * both cover a later change only when that change presents nothing the snapshot did not cover and the use stays
 * within the permitted uses, the grant is unexpired, and it is neither withdrawn nor superseded (R51.18). This
 * module holds only the bounded values and the pure coverage functions, so the schema's CHECK constraints, the
 * recording path (task 68.2), the Consent_Request screens (task 56), and the release/gate checks (task 68.4)
 * all compute the same answer.
 */

/**
 * How a grant reached the archive (R51.15, design "Permission evidence"). `emailed` is a Consent_Answer given
 * through a Consent_Link; the rest are grants an Administrator recorded by hand from a letter, a telephone call,
 * an email the Party sent outside the Consent_Request flow, or another evidenced method. The method never
 * widens coverage: a manual `letter` grant and an `emailed` grant follow the same coverage rules (R51.15).
 */
export const EVIDENCE_SOURCES = ['emailed', 'letter', 'call', 'email', 'other'] as const;
export type EvidenceSource = typeof EVIDENCE_SOURCES[number];

/**
 * What the grant permits (R51.9, R51.16). A grant covers exactly the uses it names: `publication` is the public
 * presentation of the covered material, and `file_share` is sharing the file bytes, which even when granted is
 * exercised only through a separately authorized scoped disclosure feature, never an arbitrary download (R51.16).
 * A use the grant does not name is not covered, so a change that introduces one is refused like any other
 * uncovered widening.
 */
export const EVIDENCE_USES = ['publication', 'file_share'] as const;
export type EvidenceUse = typeof EVIDENCE_USES[number];

/**
 * Whether a grant permits naming the Party on the covered element (R51.17). A Withheld Disclosure_Line names an
 * External_Party only with a current `named` grant for that element and with Do_Not_Name off; otherwise the
 * projection falls back to the Generic_Label or a neutral role label without leaking the withheld name.
 */
export const EVIDENCE_NAMING = ['named', 'unnamed'] as const;
export type EvidenceNaming = typeof EVIDENCE_NAMING[number];

/** The neutral role label a Withheld Disclosure_Line uses when no current grant permits naming the Party (R51.17). */
export const NEUTRAL_NAME_FALLBACK = 'a correspondent';

/** Bounds on one Permission_Evidence row, chosen so recording a grant is always one bounded write (R51.15, R51.16). */
export const EVIDENCE_LIMITS = Object.freeze({
  /** The granting Party's name, as recorded with the grant. */
  grantorNameCodePoints: 200,
  /** The authority the grantor claims over the covered material, for example "copyright holder" or "the writer". */
  authorityCodePoints: 2000,
  /** The immutable reference that identifies where the evidence is kept (a stored letter, a call note, a message id). */
  referenceCodePoints: 500,
  /** The licence or terms the grant is given under, when the grantor stated any. */
  licenceCodePoints: 2000,
  /** The optional reason an Administrator records for a manual grant or for overriding a prior refusal (R51.15). */
  reasonCodePoints: 2000,
  /** The Generic_Label a `named` grant may carry for a Withheld Disclosure_Line (matches R51.6's 1 to 100). */
  labelCodePoints: 100,
  /** At most this many covered content/file identities travel with one grant, so the snapshot stays bounded. */
  coveredItems: 50,
});

/** The exact identity of one covered document or file a grant is signed against (R51.16, R51.18). */
export interface CoveredIdentity {
  /** The Disclosure_Unit the identity is for: the Correspondence, Source, or Attachment. */
  readonly unitId: string;
  /** The content revision the snapshot was taken at, so a later edit to the body is detectable (R51.18). */
  readonly contentRev: number;
  /** SHA-256 of the exact file bytes a rights grant covers; empty for a publication grant over text only (R51.16). */
  readonly fileHash?: string;
  /** The exact file size in bytes a rights grant covers, beside its hash (R51.16). */
  readonly fileSize?: number;
}

/**
 * A Permission_Evidence row as the coverage functions read it. Every field is what the grant was recorded with;
 * none of it is editable, so a changed grant is a new, superseding row, never an edit of this one (R51.15).
 */
export interface EvidenceRow {
  readonly id: string;
  /** The Disclosure_Unit this grant is about; its covered identities are `covered`. */
  readonly unitId: string;
  /** SHA-256 of the canonical snapshot the Party saw or the Administrator recorded; a change off it is uncovered (R51.9, R51.18). */
  readonly snapshotHash: string;
  /** The exact covered content/file identities the snapshot was signed against. */
  readonly covered: readonly CoveredIdentity[];
  /** The uses the grant permits; a use not listed is not covered (R51.9, R51.16). */
  readonly uses: readonly EvidenceUse[];
  /** Whether the grant permits naming the Party on the covered element (R51.17). */
  readonly naming: EvidenceNaming;
  /** The Generic_Label the grant carries for a Withheld Disclosure_Line, if any (R51.17). */
  readonly label?: string;
  /** When the grant expires and stops covering anything, if it was given a limit (R51.15). */
  readonly expiresAt?: string;
  /** Set when the grant was withdrawn, after which it covers nothing (R51.15, R51.18). */
  readonly withdrawnAt?: string;
  /** Set when a later grant superseded this one; a superseded grant covers nothing (R51.15). */
  readonly supersededById?: string;
  /** False for a hand-set Consent_Status or Rights_Status kept as legacy unverified evidence; it never grants coverage (R51.9, R51.15). */
  readonly verified: boolean;
}

/** The change a grant is asked to cover: the resulting snapshot, its content identity, and the use it makes (R51.9, R51.18). */
export interface CoverageRequest {
  readonly unitId: string;
  /** SHA-256 of the resulting material, which must equal the grant's snapshot for the grant to cover it (R51.9, R51.18). */
  readonly snapshotHash: string;
  /** The content revision of the resulting material, which must match the covered identity (R51.18). */
  readonly contentRev: number;
  /** SHA-256 of the file the change presents, where it presents one; it must match the covered file (R51.16, R51.18). */
  readonly fileHash?: string;
  /** The exact file size the change presents, beside its hash (R51.16). */
  readonly fileSize?: number;
  /** The use the change makes of the material; the grant must permit it (R51.9, R51.16). */
  readonly use: EvidenceUse;
  /** The moment the change is applied, against which expiry is judged (R51.15). */
  readonly at: string;
}

/** A grant that no longer covers anything: unverified legacy evidence, withdrawn, superseded, or expired (R51.9, R51.15, R51.18). */
export function isLiveGrant(row: EvidenceRow, at: string): boolean {
  return row.verified && row.withdrawnAt === undefined && row.supersededById === undefined
    && (row.expiresAt === undefined || row.expiresAt > at);
}

/**
 * Whether one grant covers an exact change (R51.9, R51.16, R51.18). It must be a live grant for the same unit,
 * permit the use the change makes, and have been signed against the exact resulting snapshot and content/file
 * identity. Anything the snapshot did not cover, a changed file or body, or an unlisted use leaves the change
 * uncovered; a hand-set status is never a live grant, so it covers nothing.
 */
export function grantCovers(row: EvidenceRow, request: CoverageRequest): boolean {
  if (row.unitId !== request.unitId || !isLiveGrant(row, request.at)) return false;
  if (!row.uses.includes(request.use)) return false;
  if (row.snapshotHash !== request.snapshotHash) return false;
  const identity = row.covered.find((entry) => entry.unitId === request.unitId);
  if (identity === undefined || identity.contentRev !== request.contentRev) return false;
  // A rights change that presents a file is covered only when the exact bytes and size match the signed identity (R51.16).
  if (request.fileHash !== undefined && (identity.fileHash !== request.fileHash || identity.fileSize !== request.fileSize)) return false;
  return true;
}

/** Why a change is not covered, so the refusal can name the evidence and the uncovered material (R51.9). */
export interface UncoveredReason {
  readonly unitId: string;
  readonly use: EvidenceUse;
  /** The grants that are about this unit but do not cover the change; the refusal offers a new request or manual grant. */
  readonly consideredIds: readonly string[];
}

/**
 * The exact coverage of a change by the grants on hand (R51.9). A change is covered only when at least one live
 * grant covers it; otherwise it is uncovered and the whole widening is refused, with the grants considered named
 * so the caller can identify the evidence and offer a new Consent_Request or a recorded manual grant. This is the
 * one function the emailed and manual paths, the release preflight, and the gates all share, so a status set by
 * hand can never stand in for a grant.
 */
export function coverChange(rows: readonly EvidenceRow[], request: CoverageRequest): { readonly covered: true; readonly grantId: string } | { readonly covered: false; readonly reason: UncoveredReason } {
  const aboutUnit = rows.filter((row) => row.unitId === request.unitId);
  const grant = aboutUnit.find((row) => grantCovers(row, request));
  if (grant !== undefined) return { covered: true, grantId: grant.id };
  return { covered: false, reason: { unitId: request.unitId, use: request.use, consideredIds: aboutUnit.map((row) => row.id) } };
}

/**
 * The name to show for an External_Party on a Withheld Disclosure_Line (R51.17). The withheld name appears only
 * with a current `named` grant for that element and with Do_Not_Name off; otherwise the projection uses the
 * grant's Generic_Label, then the Party's own Generic_Label, then a neutral role label, and never the withheld
 * name itself. Do_Not_Name always wins, so a Party that asked not to be named is never named even if an older
 * grant permitted it.
 */
export function withheldName(
  party: { readonly name: string; readonly doNotName: boolean; readonly genericLabel?: string },
  rows: readonly EvidenceRow[],
  unitId: string,
  at: string,
): string {
  const nameGrant = rows.find((row) => row.unitId === unitId && row.naming === 'named' && isLiveGrant(row, at));
  if (!party.doNotName && nameGrant !== undefined) return party.name;
  // No current naming grant, or Do_Not_Name is on: the withheld name never appears, so fall to the recorded Generic_Label, then a neutral role label.
  const label = party.genericLabel;
  return label !== undefined && label.trim() !== '' ? label : NEUTRAL_NAME_FALLBACK;
}
