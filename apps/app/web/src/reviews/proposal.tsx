import { useState } from 'react';
import { Link } from 'react-router';
import { ApiFailure, useApi } from '../api';
import { ConsentValues, HoldLine } from '../disclosure/disclosure';
import type { MemberRow, ProposalDetailView, ProposalUnitView } from '../types';
import { Button, formatDate, LoadState, Notice, PersonLink, SaveFailure, TextField, useLoad } from '../ui';

const withNote = (note: string) => (note.trim() === '' ? {} : { note });

/** Approve or decline a Publication_Proposal with an optional note (R23.19). */
function Decide({ id, onDecided }: { readonly id: string; readonly onDecided: () => void }) {
  const client = useApi();
  const [note, setNote] = useState('');
  const [failure, setFailure] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const decide = (outcome: 'approved' | 'declined') => async () => {
    setBusy(true);
    setFailure(undefined);
    try {
      await client.post(`/reviews/proposals/${id}/decide`, { outcome, ...withNote(note) });
      onDecided();
    } catch (error) { setFailure(error); } finally { setBusy(false); }
  };
  const errors = failure instanceof ApiFailure ? failure.issuesFor('note') : [];
  return (
    <section className="rf-section" aria-label="Decide this proposal">
      <SaveFailure error={errors.length > 0 ? undefined : failure} />
      <TextField label="Note" multiline value={note} onChange={setNote} maxLength={2000} hint="Optional; at most 2,000 characters." errors={errors} />
      <div className="rf-actions">
        <Button variant="primary" onClick={() => void decide('approved')()} disabled={busy}>Approve</Button>
        <Button variant="danger" onClick={() => void decide('declined')()} disabled={busy}>Decline</Button>
      </div>
    </section>
  );
}

/** Withdraw a Publication_Consent the Member already gave, while it is still unused (R23.19). */
function WithdrawConsent({ unit, onWithdrawn }: { readonly unit: ProposalUnitView; readonly onWithdrawn: () => void }) {
  const client = useApi();
  const [failure, setFailure] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  if (unit.consent === undefined) return null;
  if (!unit.consent.withdrawable) return <p className="rf-meta">Your consent for this has already been used and can no longer be withdrawn.</p>;
  const withdraw = async () => {
    setBusy(true);
    setFailure(undefined);
    try {
      await client.post(`/reviews/consents/${unit.consent!.id}/withdraw`, undefined);
      onWithdrawn();
    } catch (error) { setFailure(error); } finally { setBusy(false); }
  };
  return (
    <div className="rf-stack">
      <SaveFailure error={failure} />
      <Button onClick={() => void withdraw()} disabled={busy}>Withdraw your consent</Button>
    </div>
  );
}

const unitName = (unit: ProposalUnitView): string => `${unit.identifier ?? ''}${unit.title === null ? '' : `: ${unit.title}`}`.trim() || 'A Disclosure Unit';
const OUTCOME_NAMES: Readonly<Record<string, string>> = { approved: 'Approved', declined: 'Declined' };

/** One Disclosure_Unit of the proposal: the proposed values, the resulting Public_View, and the consent withdraw (R23.18, R23.19). */
function ProposalUnit({ unit, decided, onChanged }: { readonly unit: ProposalUnitView; readonly decided: boolean; readonly onChanged: () => void }) {
  const view = unit.view as { readonly tag?: string } | undefined;
  return (
    <li className="rf-companion" aria-label={unitName(unit)}>
      <p>
        {unit.identifier !== null ? <Link to={`/items/${unit.key.slice(2)}`}>{unitName(unit)}</Link> : unitName(unit)}
      </p>
      <p className="rf-meta">Proposed values:</p>
      <ConsentValues values={unit.values} />
      {view !== undefined && <p className="rf-meta">{`Resulting public view: ${view.tag === 'withheld' ? 'shown as a Disclosure line only' : view.tag === undefined ? 'none' : 'shown on the public site'}.`}</p>}
      {decided && <WithdrawConsent unit={unit} onWithdrawn={onChanged} />}
    </li>
  );
}

/**
 * The Consenting_Member's Publication_Proposal page: the proposed values and resulting Public_Views for each of their
 * Disclosure_Units, the covering Confidentiality_Holds, and approve, decline, or withdraw (R23.18, R23.19, R48.5).
 */
export function ProposalScreen({ id, members }: { readonly id: string; readonly members: readonly MemberRow[] }) {
  const loaded = useLoad<{ proposal: ProposalDetailView }>(`/reviews/proposals/${id}`);
  if (!loaded.data) return <LoadState error={loaded.error} />;
  const proposal = loaded.data.proposal;
  const decided = proposal.state === 'reviewed';
  return (
    <div className="rf-stack">
      <h1>Publication Proposal</h1>
      <p className="rf-meta">{'Proposed by '}<PersonLink person={proposal.proposer} />{` on ${formatDate(proposal.createdAt)}`}</p>
      {proposal.note !== null && proposal.note.trim() !== '' && <p>{proposal.note}</p>}
      {decided && (
        <Notice tone={proposal.outcome === 'approved' ? 'success' : 'neutral'} title={`You ${OUTCOME_NAMES[proposal.outcome ?? ''] ?? 'reviewed'} this proposal${proposal.reviewedAt === null ? '' : ` on ${formatDate(proposal.reviewedAt)}`}.`}>
          {proposal.reviewNote !== null && proposal.reviewNote.trim() !== '' && <p>{proposal.reviewNote}</p>}
        </Notice>
      )}
      {proposal.holds.length > 0 && (
        <Notice tone="warning" title="A Confidentiality Hold covers part of this proposal:">
          <ul className="rf-list">{proposal.holds.map((hold) => <HoldLine key={hold.id} hold={{ id: hold.id, memberId: hold.member.id, placedAt: hold.placedAt, note: hold.note }} members={members} />)}</ul>
        </Notice>
      )}
      <section className="rf-section" aria-label="Proposed units">
        <h2>Proposed values</h2>
        <ul className="rf-list">{proposal.units.map((unit) => <ProposalUnit key={unit.key} unit={unit} decided={decided} onChanged={loaded.reload} />)}</ul>
      </section>
      {!decided
        ? <Decide id={id} onDecided={loaded.reload} />
        : proposal.outcome === 'approved' && proposal.units.every((unit) => unit.consent === undefined || !unit.consent.withdrawable)
          ? <p className="rf-meta">Nothing more can be withdrawn on this proposal.</p>
          : null}
    </div>
  );
}
