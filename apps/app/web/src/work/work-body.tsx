import { useState } from 'react';
import { Link } from 'react-router';
import type { RichText } from '@researchforce/domain/richtext';
import { useApi } from '../api';
import { RichTextView } from '../editor/RichTextView';
import { useSession } from '../session';
import type { ItemView } from '../types';
import { Button, formatDate, LoadState, Notice, PersonLink, SaveFailure, SelectField, TextField, useLoad } from '../ui';
import { ANSWER_NAMES, needsReason, nextStates, parseIds, priorityName, stateName } from './model';
import type { WorkView } from './model';
import type { WorkState } from '@researchforce/domain/work';

const EVENT_TEXT: Readonly<Record<string, string>> = {
  assigned: 'assigned', unassigned: 'removed an assignment', accepted: 'accepted the assignment', declined: 'declined the assignment', responsible: 'changed who is responsible',
  due_date: 'changed the due date', state: 'changed the state', dependency_added: 'added a predecessor', dependency_removed: 'removed a predecessor', dependency_kind: 'changed a predecessor’s kind',
};

function Answer({ work, onChanged }: { readonly work: WorkView; readonly onChanged: () => void }) {
  const client = useApi();
  const { me } = useSession();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(undefined);
  const mine = work.assignments.find((assignment) => assignment.memberId === me.member.id);
  if (mine === undefined || work.state === 'done' || work.state === 'cancelled') return null;
  const send = async (response: 'accepted' | 'declined') => {
    try {
      await client.post(`/work/${work.id}/accept`, { response, ...(response === 'declined' ? { reason } : {}) });
      setError(undefined);
      onChanged();
    } catch (failure) { setError(failure); }
  };
  return (
    <section aria-label="Your assignment">
      <h3>Your assignment</h3>
      <p>{ANSWER_NAMES[mine.state]}</p>
      <TextField label="Reason for declining" value={reason} onChange={setReason} multiline />
      <div className="rf-actions">
        {mine.state !== 'accepted' && <Button variant="primary" onClick={() => { void send('accepted'); }}>Accept this assignment</Button>}
        {mine.state !== 'declined' && <Button onClick={() => { void send('declined'); }}>Decline this assignment</Button>}
      </div>
      <SaveFailure error={error} />
    </section>
  );
}

function Progress({ work, onChanged }: { readonly work: WorkView; readonly onChanged: () => void }) {
  const client = useApi();
  const choices = nextStates(work.state);
  const [state, setState] = useState<WorkState>(choices[0]!);
  const [reason, setReason] = useState('');
  const [statement, setStatement] = useState('');
  const [records, setRecords] = useState('');
  const [error, setError] = useState<unknown>(undefined);
  const save = async () => {
    const ids = parseIds(records);
    const result = state !== 'done' ? undefined : ids.length > 0 ? { kind: 'references', targets: ids.map((targetId) => ({ targetId })) } : { kind: 'no_result', statement };
    try {
      await client.post(`/work/${work.id}/progress`, { state, expectedState: work.state, ...(reason === '' ? {} : { reason }), ...(result === undefined ? {} : { result }) });
      setError(undefined); setReason(''); setStatement(''); setRecords('');
      onChanged();
    } catch (failure) { setError(failure); }
  };
  return (
    <section aria-label="Move this work">
      <h3>Move this work</h3>
      <SelectField label="New state" value={state} options={choices.map((value) => ({ value, label: stateName(value) }))} onChange={(value) => setState(value as WorkState)} />
      {needsReason(work.state, state) && <TextField label="Reason" value={reason} onChange={setReason} multiline required />}
      {state === 'done' && (
        <>
          <TextField label="Resulting records" hint="Identifiers of the Findings, Runs, Sources, Decision Records or Attachments this work produced, separated by spaces." value={records} onChange={setRecords} />
          <TextField label="No result" hint="Used when no record is named: say why there is none." value={statement} onChange={setStatement} multiline />
        </>
      )}
      <div className="rf-actions"><Button variant="primary" onClick={() => { void save(); }}>Save the new state</Button></div>
      <SaveFailure error={error} />
    </section>
  );
}

function Dependencies({ work, editable, onChanged }: { readonly work: WorkView; readonly editable: boolean; readonly onChanged: () => void }) {
  const client = useApi();
  const [added, setAdded] = useState('');
  const [kind, setKind] = useState('blocker');
  const [error, setError] = useState<unknown>(undefined);
  const save = async (dependencies: readonly { predecessorId: string; kind: string }[]) => {
    try {
      await client.put(`/work/${work.id}/dependencies`, { graphRev: work.graphRev, dependencies });
      setError(undefined); setAdded('');
      onChanged();
    } catch (failure) { setError(failure); }
  };
  const current = work.dependencies.map((dependency) => ({ predecessorId: dependency.predecessorId, kind: dependency.kind }));
  return (
    <section aria-label="Predecessors">
      <h3>Predecessors</h3>
      {work.dependencies.length === 0 ? <p className="rf-meta">No predecessors you can read.</p> : (
        <ul className="rf-list">
          {work.dependencies.map((dependency) => (
            <li key={dependency.predecessorId}>
              <Link to={`/items/${dependency.predecessorId}`}>{dependency.title}</Link>
              {` — ${dependency.kind === 'blocker' ? 'blocker' : 'for information'}, ${stateName(dependency.state)}`}
              {dependency.blocking && <span className="rf-status rf-status--warning">{' Blocking'}</span>}
              {editable && <Button variant="quiet" label={`Remove ${dependency.title}`} onClick={() => { void save(current.filter((entry) => entry.predecessorId !== dependency.predecessorId)); }}>Remove</Button>}
            </li>
          ))}
        </ul>
      )}
      {editable && (
        <>
          <TextField label="Add a predecessor" hint="The identifier of another Work Item." value={added} onChange={setAdded} />
          <SelectField label="Kind" value={kind} options={[{ value: 'blocker', label: 'Blocker' }, { value: 'informational', label: 'For information' }]} onChange={setKind} />
          <div className="rf-actions"><Button disabled={added.trim() === ''} onClick={() => { void save([...current, { predecessorId: added.trim(), kind }]); }}>Add the predecessor</Button></div>
        </>
      )}
      <SaveFailure error={error} />
    </section>
  );
}

/** The work: its objective, state, assignments and the answer to them, predecessors, outcomes and history (R52). */
export function WorkBody({ item, onChanged }: { readonly item: ItemView; readonly onChanged?: () => void }) {
  const session = useSession();
  const loaded = useLoad<{ work: WorkView }>(`/work/${item.id}`);
  if (!loaded.data) return <LoadState error={loaded.error} />;
  const work = loaded.data.work;
  const changed = () => { loaded.reload(); onChanged?.(); };
  const objective = item['objective'] as RichText | undefined;
  const due = (item['dueDate'] as { value: string } | undefined)?.value;
  return (
    <section className="rf-section" aria-label="Work">
      <h2>Work</h2>
      {work.blocked && <Notice tone="warning" title="This work is blocked." />}
      <dl>
        <dt>State</dt><dd>{stateName(work.state)}{work.stateReason !== null && <span className="rf-meta">{`: ${work.stateReason}`}</span>}</dd>
        <dt>Priority</dt><dd>{priorityName((item['priority'] as 'low' | 'normal' | 'high' | undefined) ?? 'normal')}</dd>
        <dt>Due</dt><dd>{due ?? 'No due date'}</dd>
        <dt>Responsible</dt><dd><PersonLink person={{ id: work.responsibleId, displayName: work.responsibleName }} /></dd>
      </dl>
      {objective !== undefined && <section aria-label="Objective"><h3>Objective</h3><RichTextView value={objective} /></section>}
      <section aria-label="Assignments">
        <h3>Assignments</h3>
        {work.assignments.length === 0 ? <p className="rf-meta">No one is assigned.</p> : (
          <ul className="rf-list">
            {work.assignments.map((assignment) => (
              <li key={assignment.memberId}>
                <PersonLink person={{ id: assignment.memberId, displayName: assignment.displayName }} />{` — ${ANSWER_NAMES[assignment.state]}`}
                {assignment.reason !== null && <span className="rf-meta">{`: ${assignment.reason}`}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
      <Answer work={work} onChanged={changed} />
      {session.can('work.progress') && nextStates(work.state).length > 0 && <Progress key={work.state} work={work} onChanged={changed} />}
      <Dependencies work={work} editable={session.can('work.edit')} onChanged={changed} />
      <section aria-label="Outcomes">
        <h3>Outcomes</h3>
        {work.outcomes.length === 0 ? <p className="rf-meta">Nothing has been completed, cancelled or reopened.</p> : (
          <ol className="rf-list">
            {work.outcomes.map((outcome) => (
              <li key={outcome.id}>
                {`${outcome.transition === 'done' ? 'Done' : outcome.transition === 'cancelled' ? 'Cancelled' : 'Reopened'} on ${formatDate(outcome.recordedAt)}`}
                {outcome.reason !== null && `: ${outcome.reason}`}
                {outcome.noResultStatement !== null && <span>{` — No result: ${outcome.noResultStatement}`}</span>}
                {outcome.results.map((result) => <span key={result.targetId}>{' '}<Link to={result.targetKind === 'attachment' ? `/attachments/${result.targetId}` : `/items/${result.targetId}`}>{`Result (${result.targetKind})`}</Link></span>)}
              </li>
            ))}
          </ol>
        )}
      </section>
      <section aria-label="Work history">
        <h3>History</h3>
        <ol className="rf-list">
          {work.history.map((event) => (
            <li key={event.seq}>{`${formatDate(event.at)} — ${event.actorName ?? 'A Member'} ${EVENT_TEXT[event.kind] ?? event.kind}`}</li>
          ))}
        </ol>
      </section>
    </section>
  );
}
