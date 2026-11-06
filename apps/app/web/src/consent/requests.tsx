import { Link } from 'react-router';
import { useApi } from '../api';
import { useSession } from '../session';
import { Button, formatDate, LoadState, Notice, useLoad } from '../ui';
import { useState } from 'react';
import { choiceName, kindName, stateName } from './model';
import type { ConsentAnswerView, ConsentRequestView, ConsentWithdrawalView } from './model';

/** An element reference the panels link to: a Correspondence/Source goes to its Item page, an Attachment to its own. */
function elementLink(unit: { readonly key: string; readonly unitId: string }, attachments: ReadonlySet<string>): string {
  return attachments.has(unit.unitId) ? `/attachments/${unit.unitId}` : `/items/${unit.unitId}`;
}

/** One recorded Consent_Answer: the choice, the optional Generic_Label and comment, and the time (R51.13). */
function AnswerLine({ answer }: { readonly answer: ConsentAnswerView }) {
  return (
    <li>
      <p>{`Answer: ${choiceName(answer.choice)}`}{answer.genericLabel !== null && ` (named as “${answer.genericLabel}”)`}</p>
      {answer.comment !== null && answer.comment.trim() !== '' && <p className="rf-meta">{`Comment: ${answer.comment}`}</p>}
      <p className="rf-meta">{`Answered ${formatDate(answer.answeredAt)}`}</p>
    </li>
  );
}

/** One recorded withdrawal through a Change_Link: the optional comment and the time (R51.10, R51.13). */
function WithdrawalLine({ withdrawal }: { readonly withdrawal: ConsentWithdrawalView }) {
  return (
    <li>
      <p>Withdrawn</p>
      {withdrawal.comment !== null && withdrawal.comment.trim() !== '' && <p className="rf-meta">{`Comment: ${withdrawal.comment}`}</p>}
      <p className="rf-meta">{`Withdrawn ${formatDate(withdrawal.withdrawnAt)}`}</p>
    </li>
  );
}

/** Cancel an open Consent_Request; only an Administrator with `consent.request` may, and a cancelled request changes no status (R51.11). */
function CancelRequest({ request, onChanged }: { readonly request: ConsentRequestView; readonly onChanged: () => void }) {
  const client = useApi();
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  if (request.state !== 'sent' || !session.can('consent.request')) return null;
  const cancel = () => {
    setBusy(true);
    setFailure(undefined);
    void client.post(`/consent-requests/${request.id}/cancel`, {}).then(onChanged, setFailure).finally(() => setBusy(false));
  };
  return (
    <>
      {failure !== undefined && <Notice tone="danger" title="The request could not be cancelled." />}
      <Button variant="quiet" onClick={cancel} disabled={busy}>Cancel this request</Button>
    </>
  );
}

/**
 * One Consent_Request as every Member reads it: its kind and state, the elements it names, and the answers,
 * comments, and withdrawals recorded on them (R51.13). `scopeUnitId`, when set, limits the elements, answers,
 * and withdrawals shown to one element, so an element's own page shows only what concerns it.
 */
export function ConsentRequestCard({ request, attachments, onChanged, scopeUnitId }: {
  readonly request: ConsentRequestView;
  readonly attachments: ReadonlySet<string>;
  readonly onChanged: () => void;
  readonly scopeUnitId?: string;
}) {
  const inScope = <T extends { readonly unitId: string }>(entry: T): boolean => scopeUnitId === undefined || entry.unitId === scopeUnitId;
  const units = request.units.filter(inScope);
  const answers = request.answers.filter(inScope);
  const withdrawals = request.withdrawals.filter(inScope);
  return (
    <li className="rf-companion">
      <p><strong>{kindName(request.kind)}</strong>{' — '}<span className="rf-status">{stateName(request.state)}</span></p>
      <p className="rf-meta">{`Sent ${formatDate(request.sentAt)}; expires ${formatDate(request.expiresAt)}`}</p>
      {request.message !== null && request.message.trim() !== '' && <p className="rf-meta">{`Message: ${request.message}`}</p>}
      {scopeUnitId === undefined && (
        <section aria-label="Named elements">
          <p className="rf-meta">Named elements:</p>
          <ul className="rf-list">
            {units.map((unit) => <li key={unit.key}><Link to={elementLink(unit, attachments)}>{unit.unitId}</Link></li>)}
          </ul>
        </section>
      )}
      {answers.length > 0 && (
        <section aria-label="Answers">
          <p className="rf-meta">Answers:</p>
          <ul className="rf-list">{answers.map((answer, index) => <AnswerLine key={index} answer={answer} />)}</ul>
        </section>
      )}
      {withdrawals.length > 0 && (
        <section aria-label="Withdrawals">
          <p className="rf-meta">Withdrawals:</p>
          <ul className="rf-list">{withdrawals.map((withdrawal, index) => <WithdrawalLine key={index} withdrawal={withdrawal} />)}</ul>
        </section>
      )}
      <CancelRequest request={request} onChanged={onChanged} />
    </li>
  );
}

/**
 * The Consent_Requests concerning one element or one External_Party, with each request's state, answers,
 * comments, and withdrawals (R51.13). Given a `party`, it loads that Party's requests; given an `element`, it
 * loads the requests naming it and scopes each to that element. Shown on the External_Party's page and on the
 * page of each named Correspondence, Source, and Attachment.
 */
export function ConsentRequestsPanel({ party, element, attachments }: {
  /** The External_Party whose requests to list, when the panel is on a Party page. */
  readonly party?: string;
  /** One element and the party of interest, when the panel is on a Correspondence/Source/Attachment page. */
  readonly element?: { readonly unitId: string };
  /** Unit ids that are Attachments, so element links go to the Attachment page rather than an Item page. */
  readonly attachments?: ReadonlySet<string>;
}) {
  const loaded = useLoad<{ requests: ConsentRequestView[] }>(party !== undefined ? `/consent-requests?party=${party}` : '/consent-requests');
  const attachmentIds = attachments ?? new Set<string>();
  if (loaded.data === undefined) return <LoadState error={loaded.error} />;
  const scope = element?.unitId;
  const requests = scope === undefined
    ? loaded.data.requests
    : loaded.data.requests.filter((request) => request.units.some((unit) => unit.unitId === scope));
  return (
    <section className="rf-section" aria-label="Consent requests">
      <h2>Consent requests</h2>
      {requests.length === 0
        ? <p className="rf-meta">No Consent Request concerns this {scope === undefined ? 'External Party' : 'element'}.</p>
        : (
          <ul className="rf-list">
            {requests.map((request) => (
              <ConsentRequestCard key={request.id} request={request} attachments={attachmentIds} onChanged={loaded.reload}
                {...(scope === undefined ? {} : { scopeUnitId: scope })} />
            ))}
          </ul>
        )}
    </section>
  );
}

/**
 * The Consent_Requests list screen: every Consent_Request, newest first, with its state and the elements it
 * names, and the answers, comments, and withdrawals recorded on them (R51.13). Open to every active Member.
 */
export function ConsentRequestsScreen() {
  const loaded = useLoad<{ requests: ConsentRequestView[] }>('/consent-requests');
  if (loaded.data === undefined) return <LoadState error={loaded.error} />;
  return (
    <div className="rf-stack">
      <h1>Consent requests</h1>
      {loaded.data.requests.length === 0
        ? <p className="rf-meta">No Consent Request has been sent.</p>
        : (
          <ul className="rf-list">
            {loaded.data.requests.map((request) => (
              <ConsentRequestCard key={request.id} request={request} attachments={new Set()} onChanged={loaded.reload} />
            ))}
          </ul>
        )}
    </div>
  );
}
