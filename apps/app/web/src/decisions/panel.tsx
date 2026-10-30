import { useState } from 'react';
import { Link } from 'react-router';
import { DECISION_EVENT_NAMES, DECISION_STATE_NAMES } from '@researchforce/domain/decisions';
import type { AcknowledgementStatus, DecisionEventKind, DecisionState } from '@researchforce/domain/decisions';
import { useApi } from '../api';
import { useSession } from '../session';
import type { ItemView } from '../types';
import { Button, formatDate, Notice, SaveFailure, SelectField, TextField } from '../ui';

interface ParticipantResponse {
  readonly memberId: string;
  readonly name: string | null;
  readonly status: AcknowledgementStatus;
  readonly latest?: { readonly version: number; readonly response: string; readonly comment: string | null; readonly at: string };
}
interface Neighbour { readonly id: string; readonly title: string; readonly state: DecisionState; readonly adoptedAt: string | null; readonly rationale: string | null; readonly responses: readonly ParticipantResponse[] }
interface DecisionEvent { readonly seq: number; readonly kind: DecisionEventKind; readonly actorName: string | null; readonly at: string; readonly reason: string | null; readonly relatedId: string | null }

/** Silence and old wording are named as such; neither reads as agreement (R53.2, R53.3). */
const STATUS_NAMES: Readonly<Record<AcknowledgementStatus, string>> = {
  acknowledged: 'Acknowledged', disagreed: 'Disagrees', earlier_wording: 'Responded to earlier wording; not current', no_response: 'No response',
};

function Responses({ responses, label }: { readonly responses: readonly ParticipantResponse[]; readonly label: string }) {
  if (responses.length === 0) return null;
  return (
    <ul className="rf-list" aria-label={label}>
      {responses.map((response) => (
        <li key={response.memberId}>
          <Link to={`/members/${response.memberId}`}>{response.name ?? 'Member without a display name'}</Link>{`: ${STATUS_NAMES[response.status]}`}
          {response.latest?.comment != null && response.latest.comment !== '' && <span className="rf-meta">{` — ${response.latest.comment}`}</span>}
        </li>
      ))}
    </ul>
  );
}

function Related({ title, decision }: { readonly title: string; readonly decision: Neighbour }) {
  return (
    <section aria-label={title}>
      <h3>{title}</h3>
      <p><Link to={`/items/${decision.id}`}>{decision.title}</Link>{` (${DECISION_STATE_NAMES[decision.state]}${decision.adoptedAt === null ? '' : `, adopted ${formatDate(decision.adoptedAt)}`})`}</p>
      {decision.rationale !== null && <p>{decision.rationale}</p>}
      <Responses responses={decision.responses} label={`${title}: responses`} />
    </section>
  );
}

function Respond({ item, mine, onChanged }: { readonly item: ItemView; readonly mine: ParticipantResponse; readonly onChanged: () => void }) {
  const client = useApi();
  const [response, setResponse] = useState('acknowledged');
  const [comment, setComment] = useState('');
  const [error, setError] = useState<unknown>(undefined);
  const send = async () => {
    try {
      await client.post(`/decisions/${item.id}/acknowledge`, {
        response, digest: item['wordingDigest'], wordingVersion: item['wordingVersion'], expectedVersion: mine.latest?.version ?? 0, ...(comment === '' ? {} : { comment }),
      });
      setError(undefined); setComment('');
      onChanged();
    } catch (failure) { setError(failure); }
  };
  return (
    <section aria-label="Your response">
      <h3>Your response</h3>
      <p>{`Currently: ${STATUS_NAMES[mine.status]}`}</p>
      <SelectField label="Response" value={response} options={[{ value: 'acknowledged', label: 'I acknowledge this decision' }, { value: 'disagreed', label: 'I disagree with this decision' }]} onChange={setResponse} />
      <TextField label="Comment" value={comment} onChange={setComment} multiline maxLength={2000} />
      <div className="rf-actions"><Button variant="primary" onClick={() => { void send(); }}>Record my response</Button></div>
      <SaveFailure error={error} />
    </section>
  );
}

function Actions({ item, state, onChanged }: { readonly item: ItemView; readonly state: DecisionState; readonly onChanged: () => void }) {
  const client = useApi();
  const [reason, setReason] = useState('');
  const [earlier, setEarlier] = useState('');
  const [error, setError] = useState<unknown>(undefined);
  const run = async (work: () => Promise<unknown>) => {
    try { await work(); setError(undefined); setReason(''); setEarlier(''); onChanged(); } catch (failure) { setError(failure); }
  };
  if (state !== 'proposed' && state !== 'adopted') return null;
  return (
    <section aria-label="Decision actions">
      <h3>Change the state of this decision</h3>
      {state === 'proposed' && (
        <>
          <div className="rf-actions"><Button variant="primary" onClick={() => { void run(() => client.post(`/decisions/${item.id}/adopt`, { rev: item.rev })); }}>Adopt this decision</Button></div>
          <TextField label="Identifier of the decision this one replaces" hint="Adopts this decision and marks the earlier adopted decision as superseded." value={earlier} onChange={setEarlier} />
          <div className="rf-actions">
            <Button onClick={() => {
              void run(async () => {
                const found = await client.get<{ item: ItemView }>(`/items/${earlier.trim()}`);
                await client.post(`/decisions/${item.id}/supersede`, { rev: item.rev, supersededId: found.item.id, supersededRev: found.item.rev });
              });
            }}>Adopt as the replacement</Button>
          </div>
        </>
      )}
      <TextField label="Reason for withdrawing" value={reason} onChange={setReason} multiline maxLength={1000} />
      <div className="rf-actions">
        <Button onClick={() => { void run(() => client.post(`/decisions/${item.id}/withdraw`, { rev: item.rev, ...(reason === '' ? {} : { reason }) })); }}>Withdraw this decision</Button>
      </div>
      <SaveFailure error={error} />
    </section>
  );
}

/** A Decision_Record's state, who has responded and who has not, what it replaced or was replaced by, and its history (R53.2 to R53.4). */
export function DecisionPanel({ item, onChanged }: { readonly item: ItemView; readonly onChanged: () => void }) {
  const session = useSession();
  const state = (item['decisionState'] ?? 'proposed') as DecisionState;
  const responses = (item['participantResponses'] ?? []) as readonly ParticipantResponse[];
  const events = (item['decisionEvents'] ?? []) as readonly DecisionEvent[];
  const supersedes = item['supersedes'] as Neighbour | null | undefined;
  const supersededBy = item['supersededBy'] as Neighbour | null | undefined;
  const mine = responses.find((response) => response.memberId === session.me.member.id);
  const adoptedAt = typeof item['decisionAdoptedAt'] === 'string' ? item['decisionAdoptedAt'] : null;
  return (
    <section className="rf-section" aria-label="Decision">
      <h2>Decision</h2>
      <p>{`State: ${DECISION_STATE_NAMES[state]}${adoptedAt === null ? '' : `, in effect since ${formatDate(adoptedAt)}`}`}</p>
      {item['revisitDue'] === true && <Notice tone="warning" title="The review date of this decision has come. Revisit it, then supersede or withdraw it if it no longer holds." />}
      {item['scope'] === 'team' && (
        <section aria-label="Participants">
          <h3>Participants</h3>
          <p className="rf-meta">Each participant answers for themselves; no response is not agreement.</p>
          <Responses responses={responses} label="Participant responses" />
        </section>
      )}
      {mine !== undefined && (state === 'proposed' || state === 'adopted') && <Respond key={mine.latest?.version ?? 0} item={item} mine={mine} onChanged={onChanged} />}
      {supersedes != null && <Related title="This decision replaced" decision={supersedes} />}
      {supersededBy != null && <Related title="Replaced by" decision={supersededBy} />}
      {session.can('item.edit') && <Actions item={item} state={state} onChanged={onChanged} />}
      {events.length > 0 && (
        <section aria-label="Decision history">
          <h3>History</h3>
          <ol className="rf-list">
            {events.map((event) => (
              <li key={event.seq}>
                {`${formatDate(event.at)}: ${DECISION_EVENT_NAMES[event.kind]}${event.actorName === null ? '' : ` by ${event.actorName}`}${event.reason === null ? '' : ` — ${event.reason}`}`}
                {event.relatedId !== null && <>{' '}<Link to={`/items/${event.relatedId}`}>Related decision</Link></>}
              </li>
            ))}
          </ol>
        </section>
      )}
    </section>
  );
}
