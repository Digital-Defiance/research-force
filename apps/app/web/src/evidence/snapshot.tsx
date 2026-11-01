import type { CoveredIdentityView, EvidenceGrantView } from '../types';
import { formatDate } from '../ui';

/**
 * Shared Permission_Evidence preview/snapshot components (R51.15 to R51.18). These render the structured document
 * identity and the asserted authority of a grant in one place, so the manual evidence editor, the curation screen,
 * and the later task 56 Consent_Request screens all present the exact same snapshot: the covered document, version,
 * file hash and size, the permitted uses and naming, and the Party and authority the grant was given under. Keeping
 * this in one module means a Consent_Page and a manual grant describe coverage identically.
 */

const SOURCE_NAMES: Readonly<Record<string, string>> = {
  emailed: 'Emailed consent answer', letter: 'Letter', call: 'Telephone call', email: 'Email', other: 'Other evidenced method',
};
export const sourceName = (source: string): string => SOURCE_NAMES[source] ?? source;

const USE_NAMES: Readonly<Record<string, string>> = { publication: 'Publication', file_share: 'File sharing' };
export const useName = (use: string): string => USE_NAMES[use] ?? use;

/** A short, stable form of a SHA-256 for display, never the material itself. */
const shortHash = (hash: string): string => `${hash.slice(0, 8)}…${hash.slice(-8)}`;

/** One covered document/file identity: the unit, its content revision, and the exact file hash and size where a file is covered (R51.16, R51.18). */
export function DocumentIdentity({ identity }: { readonly identity: CoveredIdentityView }) {
  return (
    <li>
      <span className="rf-mono">{identity.unitId}</span>
      <span className="rf-meta">{` — content revision ${identity.contentRev}`}</span>
      {identity.fileHash !== undefined
        ? <span className="rf-meta">{` — file ${shortHash(identity.fileHash)}, ${(identity.fileSize ?? 0).toLocaleString('en-GB')} bytes`}</span>
        : <span className="rf-meta">{' — text only, no file covered'}</span>}
    </li>
  );
}

/** The exact documents and files one grant is signed against (R51.16). */
export function DocumentIdentityList({ covered }: { readonly covered: readonly CoveredIdentityView[] }) {
  return (
    <section className="rf-section" aria-label="Covered documents">
      <h3>Covered documents</h3>
      {covered.length === 0
        ? <p className="rf-meta">No document identity is recorded.</p>
        : <ul className="rf-list">{covered.map((identity) => <DocumentIdentity key={`${identity.unitId}:${identity.contentRev}`} identity={identity} />)}</ul>}
    </section>
  );
}

/** Who granted the permission and what authority they claimed over the covered material (R51.15, R51.16). */
export function AssertedAuthority({ grant }: { readonly grant: Pick<EvidenceGrantView, 'grantorName' | 'claimedAuthority' | 'source' | 'evidenceReference' | 'licence'> }) {
  return (
    <section className="rf-section" aria-label="Asserted authority">
      <h3>Asserted authority</h3>
      <ul className="rf-list">
        <li>{`Granted by ${grant.grantorName}`}</li>
        <li>{`Claimed authority: ${grant.claimedAuthority}`}</li>
        <li>{`Evidence: ${sourceName(grant.source)} — ${grant.evidenceReference}`}</li>
        {grant.licence !== null && grant.licence !== undefined && grant.licence !== '' && <li>{`Licence or terms: ${grant.licence}`}</li>}
      </ul>
    </section>
  );
}

/** The uses and naming a grant permits, with the standing reminder that a file-sharing grant does not itself expose the file (R51.16, R51.17). */
export function UsesAndNaming({ uses, naming, label }: { readonly uses: readonly string[]; readonly naming: 'named' | 'unnamed'; readonly label: string | null }) {
  return (
    <section className="rf-section" aria-label="Permitted uses and naming">
      <h3>Permitted uses and naming</h3>
      <ul className="rf-list">
        <li>{`Uses: ${uses.length === 0 ? 'none' : uses.map(useName).join(', ')}`}</li>
        <li>{naming === 'named' ? `Names the party${label ? ` (generic label: ${label})` : ''}` : 'Does not permit naming the party'}</li>
      </ul>
      {uses.includes('file_share') && (
        <p className="rf-meta">Sharing the file bytes outside the Workspace is a separately authorized feature; this grant records the permission but does not expose the file.</p>
      )}
    </section>
  );
}

/** Whether a grant is live right now, or spent because it is unverified legacy, withdrawn, superseded, or expired (R51.9, R51.15, R51.18). */
export function grantStatus(grant: EvidenceGrantView, now: string): string {
  if (!grant.verified) return 'Legacy, unverified — covers nothing';
  if (grant.withdrawnAt !== null) return `Withdrawn ${formatDate(grant.withdrawnAt)} — covers nothing`;
  if (grant.supersededById !== null) return 'Superseded — covers nothing';
  if (grant.expiresAt !== null && grant.expiresAt <= now) return `Expired ${formatDate(grant.expiresAt)} — covers nothing`;
  return grant.expiresAt === null ? 'Live' : `Live until ${formatDate(grant.expiresAt)}`;
}

/** The full snapshot of one grant: its status, authority, covered documents, and permitted uses and naming, reused across screens (R51.15). */
export function GrantSnapshot({ grant, now }: { readonly grant: EvidenceGrantView; readonly now: string }) {
  return (
    <article className="rf-card" aria-label={`Permission evidence ${grant.id}`}>
      <p className="rf-meta">{`${grantStatus(grant, now)} — recorded ${formatDate(grant.recordedAt)}`}</p>
      <AssertedAuthority grant={grant} />
      <DocumentIdentityList covered={grant.covered} />
      <UsesAndNaming uses={grant.uses} naming={grant.naming} label={grant.label} />
      {grant.reason !== null && grant.reason !== '' && <p className="rf-meta">{`Reason: ${grant.reason}`}</p>}
    </article>
  );
}
