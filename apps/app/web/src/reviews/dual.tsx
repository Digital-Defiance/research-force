import { useState } from 'react';
import { Link } from 'react-router';
import { ApiFailure, useApi } from '../api';
import type { DualApprovalAction, DualApprovalListView, DualApprovalView } from '../types';
import { Button, formatDate, LoadState, Notice, PersonLink, SaveFailure, TextField, useLoad } from '../ui';

const ACTION_NAMES: Readonly<Record<DualApprovalAction, string>> = {
  hold_override: 'Hold Override',
  access_widen: 'Widen access of a departed Owner’s record',
  consent_on_behalf: 'Publication Consent on behalf of a Revoked Member',
};

const describeTarget = (approval: DualApprovalView): string => `${approval.identifier ?? ''}${approval.title === null ? '' : `: ${approval.title}`}`.trim() || 'the element';

/** One decision on an open Dual_Approval: approve or decline (a second Administrator), or withdraw (the proposer), each with an immutable reason (R49.3, R49.5). */
function Decide({ approval, onDone }: { readonly approval: DualApprovalView; readonly onDone: () => void }) {
  const client = useApi();
  const [reason, setReason] = useState('');
  const [failure, setFailure] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const act = (verb: 'approve' | 'decline' | 'withdraw') => async () => {
    setBusy(true);
    setFailure(undefined);
    try {
      await client.post(`/dual-approvals/${approval.id}/${verb}`, { reason });
      onDone();
    } catch (error) { setFailure(error); } finally { setBusy(false); }
  };
  const errors = failure instanceof ApiFailure ? failure.issuesFor('reason') : [];
  const rule = failure instanceof ApiFailure && (failure.code === 'rule' || failure.code === 'forbidden') ? (failure.details as { message?: string } | undefined)?.message : undefined;
  return (
    <div className="rf-stack">
      {rule !== undefined ? <Notice tone="warning" title={rule} /> : <SaveFailure error={errors.length > 0 ? undefined : failure} />}
      <TextField label="Reason" multiline value={reason} onChange={setReason} maxLength={2000} required hint="1 to 2,000 characters; kept in history." errors={errors} />
      <div className="rf-actions">
        {approval.isProposer
          ? <Button variant="danger" onClick={() => void act('withdraw')()} disabled={busy || reason.trim() === ''}>Withdraw</Button>
          : (
            <>
              <Button variant="primary" onClick={() => void act('approve')()} disabled={busy || reason.trim() === ''}>Approve</Button>
              <Button variant="danger" onClick={() => void act('decline')()} disabled={busy || reason.trim() === ''}>Decline</Button>
            </>
          )}
      </div>
    </div>
  );
}

/** One open Dual_Approval with its action, target, proposer, and reason, and the decision controls (R49.2). */
export function DualApprovalEntry({ approval, needSecondAdmin, explanation, onChanged }: {
  readonly approval: DualApprovalView; readonly needSecondAdmin: boolean; readonly explanation: string; readonly onChanged: () => void;
}) {
  return (
    <article className="rf-companion" aria-label={`Dual Approval: ${ACTION_NAMES[approval.action]}`}>
      <p><span className="rf-status rf-status--warning">{ACTION_NAMES[approval.action]}</span></p>
      <p>
        {approval.identifier !== null ? <Link to={`/items/${approval.rootId}`}>{describeTarget(approval)}</Link> : describeTarget(approval)}
      </p>
      <p className="rf-meta">{'Proposed by '}<PersonLink person={approval.proposer} />{` on ${formatDate(approval.proposedAt)}`}</p>
      <p>{approval.proposalReason}</p>
      {needSecondAdmin && !approval.isProposer && <Notice tone="warning" title={explanation} />}
      {approval.isProposer
        ? <Decide approval={approval} onDone={onChanged} />
        : needSecondAdmin ? null : <Decide approval={approval} onDone={onChanged} />}
    </article>
  );
}

/** The open Dual_Approvals list every active Administrator sees, with approve, decline, and withdraw (R49.2, R49.5, R49.6). */
export function DualApprovalsPage() {
  const loaded = useLoad<DualApprovalListView>('/dual-approvals');
  if (!loaded.data) return <LoadState error={loaded.error} />;
  const { approvals, needSecondAdmin, explanation } = loaded.data;
  return (
    <div className="rf-stack">
      <h1>Open Dual Approvals</h1>
      {needSecondAdmin && <Notice tone="warning" title={explanation} />}
      {approvals.length === 0 ? <p className="rf-meta">No Dual Approval is open.</p> : (
        <ul className="rf-list">
          {approvals.map((approval) => (
            <li key={approval.id}>
              <DualApprovalEntry approval={approval} needSecondAdmin={needSecondAdmin} explanation={explanation} onChanged={loaded.reload} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
