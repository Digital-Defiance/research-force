import { useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { ITEM_KIND_NAMES } from '@researchforce/domain/kind-names';
import { ApiFailure, useApi } from '../api';
import type { FieldIssue } from '../api';
import { useDraft, DraftControlsBar } from '../drafts/drafts';
import { RichTextView } from '../editor/RichTextView';
import { useFormData } from '../items/forms/ItemForm';
import type { FormData } from '../items/forms/inputs';
import { FieldInput } from '../items/forms/inputs';
import { editBody, fieldsFor, valuesFromItem } from '../items/forms/model';
import type { FormValues } from '../items/forms/model';
import { fieldLabel } from '../history/history';
import { usePersistentForm } from '../persist';
import { useSession } from '../session';
import type { ItemView, MemberRow, ProposalPage, ProposalView } from '../types';
import { Button, formatDate, LoadState, Notice, PersonLink, SaveFailure, TextField, useLoad } from '../ui';

/**
 * Edit_Proposals (R57.4, R57.5, R57.6). Any Member who can read a record may suggest an edit of it: an
 * exact diff against one revision, an explanation, and references. Proposing grants no edit or public
 * disclosure right over the target. The review screen shows the diff, lets the proposer rebase onto a
 * changed record or withdraw, and lets an authorized editor accept or decline; the Worker alone decides
 * whether the actor is authorized for every changed field. Each change is recorded on the proposal's
 * attributed timeline, so the proposer stays the suggestion's author and the accepter the acting editor.
 */

const STATE_LABELS: Readonly<Record<ProposalView['state'], string>> = { open: 'Open', accepted: 'Accepted', declined: 'Declined', withdrawn: 'Withdrawn' };
const EVENT_LABELS: Readonly<Record<string, string>> = { submitted: 'Proposed', rebased: 'Rebased', accepted: 'Accepted', declined: 'Declined', withdrawn: 'Withdrawn' };

function StateBadge({ state }: { readonly state: ProposalView['state'] }) {
  const className = state === 'accepted' ? 'rf-status rf-status--success' : state === 'open' ? 'rf-status rf-status--warning' : 'rf-status';
  return <span className={className}>{STATE_LABELS[state]}</span>;
}

/** A person named only by id, as the proposal records attribution; the member list resolves a display name when known. */
function memberName(members: readonly MemberRow[], id: string): string | null {
  return members.find((member) => member.id === id)?.displayName ?? null;
}

/** Whether the viewer may withdraw this proposal: its proposer, while it is open (R57.6). */
export function canWithdraw(viewerId: string, proposal: ProposalView): boolean {
  return proposal.state === 'open' && proposal.proposer === viewerId;
}
/** Whether the viewer may rebase this proposal: its proposer, while it is open and the record has moved (R57.5). */
export function canRebase(viewerId: string, proposal: ProposalView): boolean {
  return proposal.state === 'open' && proposal.proposer === viewerId && proposal.stale;
}

/** The changed fields of a proposal's diff, shown with each field's label and its proposed value (R57.4). */
export function ProposedDiff({ proposal, item, data }: { readonly proposal: ProposalView; readonly item: ItemView; readonly data: FormData }) {
  const entries = Object.entries(proposal.diff).filter(([field]) => field !== 'rev' && field !== 'mark' && field !== 'statusReason');
  if (entries.length === 0) return <p className="rf-meta">This proposal changes no field.</p>;
  return (
    <dl className="rf-diff">
      {entries.map(([field, value]) => (
        <div key={field}>
          <dt>{fieldLabel(item, field, (item.sections ?? []).map((section) => section.id))}</dt>
          <dd><ProposedValue value={value} data={data} /></dd>
        </div>
      ))}
    </dl>
  );
}

const isRich = (value: unknown): value is { text: string; spans: unknown[] } => typeof value === 'object' && value !== null && typeof (value as { text?: unknown }).text === 'string' && Array.isArray((value as { spans?: unknown }).spans);

function ProposedValue({ value, data }: { readonly value: unknown; readonly data: FormData }): ReactNode {
  if (value === null) return <span className="rf-meta">cleared</span>;
  if (isRich(value)) return <RichTextView value={value as never} />;
  if (typeof value === 'string') {
    const member = data.members.find((candidate) => candidate.id === value);
    return member === undefined ? value : (member.displayName ?? value);
  }
  return <code>{JSON.stringify(value)}</code>;
}

/** The attributed history of a proposal, oldest first, naming who did each and at which revision (R57.6). */
export function ProposalHistory({ proposal, members }: { readonly proposal: ProposalView; readonly members: readonly MemberRow[] }) {
  if (proposal.events.length === 0) return null;
  return (
    <section className="rf-section" aria-label="Proposal history">
      <h2>History</h2>
      <ol className="rf-list">
        {proposal.events.map((event, index) => (
          <li key={index}>
            <span className="rf-status">{EVENT_LABELS[event.kind] ?? event.kind}</span>{' '}
            {event.actor === null ? 'the system' : <PersonLink person={{ id: event.actor, displayName: memberName(members, event.actor) }} />}
            {` on ${formatDate(event.at)}`}
            {event.atRev !== null && ` (revision ${event.atRev})`}
            {event.note !== null && event.note !== '' && <>{': '}{event.note}</>}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The decline reason an authorized editor may give; the whole action is gated server-side (R57.6). */
function DeclineForm({ proposal, onChanged }: { readonly proposal: ProposalView; readonly onChanged: (proposal: ProposalView) => void }) {
  const client = useApi();
  const [note, setNote] = useState('');
  const [failure, setFailure] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const decline = async () => {
    setBusy(true);
    setFailure(undefined);
    try {
      const result = (await client.post<{ proposal: ProposalView }>(`/proposals/edits/${proposal.id}/decline`, note.trim() === '' ? {} : { note })).proposal;
      onChanged(result);
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  };
  const errors = failure instanceof ApiFailure ? failure.issuesFor('note') : [];
  return (
    <div className="rf-stack">
      <SaveFailure error={errors.length > 0 ? undefined : failure} />
      <TextField label="Reason for declining" multiline value={note} onChange={setNote} maxLength={2000} hint="Optional; shared with the proposer." errors={errors} />
      <div className="rf-actions"><Button variant="danger" onClick={() => void decline()} disabled={busy}>Decline the proposal</Button></div>
    </div>
  );
}

/** The actions on an open proposal: accept, decline, withdraw, and the rebase prompt a stale base needs (R57.5, R57.6). */
function ProposalActions({ proposal, onChanged }: { readonly proposal: ProposalView; readonly onChanged: (proposal: ProposalView) => void }) {
  const client = useApi();
  const session = useSession();
  const [failure, setFailure] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const [declining, setDeclining] = useState(false);
  const viewerId = session.me.member.id;
  const run = async (path: string) => {
    setBusy(true);
    setFailure(undefined);
    try {
      const result = (await client.post<{ proposal: ProposalView }>(`/proposals/edits/${proposal.id}/${path}`, {})).proposal;
      onChanged(result);
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  };
  // A conflict on accept means the record moved under the base; the proposer must rebase and review first (R57.5).
  const conflict = failure instanceof ApiFailure && failure.code === 'conflict';
  const stale = proposal.stale || conflict;
  const mine = proposal.proposer === viewerId;
  return (
    <section className="rf-section" aria-label="Proposal actions">
      <SaveFailure error={conflict ? undefined : failure} />
      {stale && (
        <Notice tone="warning" title="The record changed after this proposal was written.">
          <p>{mine ? 'Rebase the proposal onto the current record and review the changes before it can be accepted.' : 'The proposer must rebase this proposal onto the current record before it can be accepted.'}</p>
          {canRebase(viewerId, proposal) && <Link className="rf-button" to={`/items/${proposal.targetRootId}/propose?rebase=${proposal.id}`}>Rebase this proposal</Link>}
        </Notice>
      )}
      <div className="rf-actions">
        {!stale && <Button variant="primary" onClick={() => void run('accept')} disabled={busy}>Accept</Button>}
        {!declining && <Button onClick={() => setDeclining(true)} disabled={busy}>Decline</Button>}
        {canWithdraw(viewerId, proposal) && <Button variant="quiet" onClick={() => void run('withdraw')} disabled={busy}>Withdraw</Button>}
      </div>
      {declining && <DeclineForm proposal={proposal} onChanged={onChanged} />}
      <p className="rf-meta">Only an editor authorized for every field this proposal changes can accept or decline it. Proposing an edit does not grant any editing or public disclosure right over the record.</p>
    </section>
  );
}

/** `/proposals/:id`: one proposed edit, its diff, explanation, references, history, and actions (R57.4, R57.5, R57.6). */
export function ProposalPage({ id }: { readonly id: string }) {
  const loaded = useLoad<{ proposal: ProposalView }>(`/proposals/edits/${id}`);
  const [live, setLive] = useState<ProposalView | undefined>(undefined);
  const proposal = live ?? loaded.data?.proposal;
  const item = useLoad<{ item: ItemView }>(proposal === undefined ? undefined : `/items/${proposal.targetRootId}`);
  const members = useLoad<{ members: MemberRow[] }>('/members');
  const { data } = useFormData();
  if (proposal === undefined || !item.data || !members.data || !data) return <LoadState error={loaded.error ?? item.error ?? members.error} />;
  const record = item.data.item;
  const roster = members.data.members;
  return (
    <div className="rf-stack">
      <h1>{`Proposed edit of ${ITEM_KIND_NAMES[record.kind]} ${record.identifier}`}</h1>
      <p><StateBadge state={proposal.state} />{proposal.stale && proposal.state === 'open' && <>{' '}<span className="rf-status rf-status--warning">Needs rebase</span></>}</p>
      <p className="rf-meta">{'Proposed by '}<PersonLink person={{ id: proposal.proposer, displayName: memberName(roster, proposal.proposer) }} />{` on ${formatDate(proposal.createdAt)}, against revision ${proposal.baseRev}`}{proposal.appliesToRev !== proposal.baseRev && ` (now revision ${proposal.appliesToRev})`}.</p>
      <p>{'Record: '}<Link to={`/items/${proposal.targetRootId}`}>{`${record.identifier}: ${record.title}`}</Link>{proposal.targetRev !== null && ` (current revision ${proposal.targetRev})`}</p>
      <section className="rf-section" aria-label="Explanation">
        <h2>Why</h2>
        <p>{proposal.explanation}</p>
      </section>
      <section className="rf-section" aria-label="Proposed changes">
        <h2>Proposed changes</h2>
        <ProposedDiff proposal={proposal} item={record} data={data} />
      </section>
      {proposal.references.length > 0 && (
        <section className="rf-section" aria-label="References">
          <h2>References</h2>
          <ul className="rf-list">{proposal.references.map((ref) => <li key={ref}><Link to={`/items/${ref}`}>{ref}</Link></li>)}</ul>
        </section>
      )}
      {proposal.state === 'open' && <ProposalActions proposal={proposal} onChanged={(next) => { setLive(next); loaded.reload(); }} />}
      <ProposalHistory proposal={proposal} members={roster} />
    </div>
  );
}

/** `/items/:id/proposals`: every proposed edit of a readable record, newest first (R57.6). */
export function ProposalsListPage({ rootId }: { readonly rootId: string }) {
  const item = useLoad<{ item: ItemView }>(`/items/${rootId}`);
  const members = useLoad<{ members: MemberRow[] }>('/members');
  const page = useLoad<ProposalPage>(`/proposals/edits?target=${rootId}`);
  if (!item.data || !members.data || !page.data) return <LoadState error={item.error ?? members.error ?? page.error} />;
  const record = item.data.item;
  const roster = members.data.members;
  return (
    <div className="rf-stack">
      <h1>{`Proposed edits of ${record.identifier}`}</h1>
      <div className="rf-actions"><Link className="rf-button rf-button--primary" to={`/items/${rootId}/propose`}>Propose an edit</Link></div>
      {page.data.proposals.length === 0 ? <p className="rf-meta">No edit has been proposed for this record.</p> : (
        <ul className="rf-list">
          {page.data.proposals.map((proposal) => (
            <li key={proposal.id}>
              <article className="rf-companion" aria-label={`Proposed edit by ${memberName(roster, proposal.proposer) ?? 'a Member'}`}>
                <p><Link to={`/proposals/${proposal.id}`}>{proposal.explanation.slice(0, 120) || 'Proposed edit'}</Link>{' '}<StateBadge state={proposal.state} /></p>
                <p className="rf-meta">{'By '}<PersonLink person={{ id: proposal.proposer, displayName: memberName(roster, proposal.proposer) }} />{` on ${formatDate(proposal.createdAt)}`}</p>
              </article>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface ProposeState { readonly values: FormValues; readonly before: FormValues; readonly explanation: string; readonly references: string }

/** Field issues the form shows nowhere, such as an issue with the whole diff. */
function unplaced(failure: unknown, shown: readonly string[]): FieldIssue[] {
  if (!(failure instanceof ApiFailure)) return [];
  return failure.fields.filter((issue) => !shown.some((field) => issue.field === field || issue.field.startsWith(`${field}.`)));
}

/**
 * Propose or rebase an edit of a readable record (R57.4, R57.5). The form reuses the record's own edit
 * fields; on submit it builds the exact edit body, the explanation, and the readable references, and
 * posts the proposal or, when rebasing, re-bases an open one onto the record's current revision. The
 * form keeps its unsent input in this tab, and can save a durable proposal draft that survives closing
 * and reopening the tab (R57.1).
 */
export function ProposeEditForm({ item, data, rebaseId }: { readonly item: ItemView; readonly data: FormData; readonly rebaseId?: string | undefined }) {
  const client = useApi();
  const navigate = useNavigate();
  const form = usePersistentForm<ProposeState>(`propose:${item.id}${rebaseId === undefined ? '' : `:rebase:${rebaseId}`}`, () => {
    const values = valuesFromItem(item);
    return { values, before: values, explanation: '', references: '' };
  });
  const draft = useDraft(undefined, { kind: 'proposal', form: item.kind, targetId: item.id, targetRootId: item.id, baseRev: item.rev });
  const [failure, setFailure] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const shown = useMemo(() => ['explanation', 'references', 'diff', 'baseRev', ...fieldsFor(item.kind, 'edit').map((field) => field.name)], [item.kind]);
  const diff = useMemo(() => {
    const { rev: _rev, ...rest } = editBody(item.kind, item.rev, form.values.before, form.values.values, { mark: '', reason: '' });
    return rest;
  }, [item.kind, item.rev, form.values.before, form.values.values]);
  const references = () => form.values.references.split(/[\s,]+/u).map((ref) => ref.trim()).filter((ref) => ref !== '');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (Object.keys(diff).length === 0) {
      setFailure(new ApiFailure(422, 'validation', [{ field: 'diff', rule: 'Change at least one field to propose an edit.' }]));
      return;
    }
    setBusy(true);
    setFailure(undefined);
    const refs = references();
    const body = { diff, explanation: form.values.explanation, ...(refs.length === 0 ? {} : { references: refs }) };
    try {
      const result = rebaseId === undefined
        ? (await client.post<{ proposal: ProposalView }>('/proposals/edits', { targetId: item.id, baseRev: item.rev, ...body })).proposal
        : (await client.post<{ proposal: ProposalView }>(`/proposals/edits/${rebaseId}/rebase`, { baseRev: item.rev, ...body })).proposal;
      form.sent();
      void navigate(`/proposals/${result.id}`);
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  };
  const errors = failure instanceof ApiFailure ? failure.fields : [];
  return (
    <form className="rf-stack" onSubmit={(event) => void submit(event)} noValidate>
      <h1>{rebaseId === undefined ? `Propose an edit of ${ITEM_KIND_NAMES[item.kind]} ${item.identifier}` : `Rebase the proposed edit of ${item.identifier}`}</h1>
      <p className="rf-meta">{`Against the current revision ${item.rev}. Your suggestion is recorded in your name; an authorized editor decides whether to apply it. Proposing does not give you editing or public disclosure rights over this record.`}</p>
      <SaveFailure error={failure} />
      {errors.filter((issue) => issue.field === 'diff' || issue.field === 'baseRev').map((issue, index) => <Notice key={index} tone="danger" title={issue.rule} />)}
      {unplaced(failure, shown).length > 0 && <Notice tone="danger" title="Correct these issues:"><ul>{unplaced(failure, shown).map((issue, index) => <li key={index}>{issue.rule}</li>)}</ul></Notice>}
      {fieldsFor(item.kind, 'edit').map((spec) => (
        <FieldInput key={spec.name} spec={spec} value={form.values.values[spec.name]}
          onChange={(value) => { const values = { ...form.values.values, [spec.name]: value }; form.set('values', values); draft.change({ ...form.values, values }); }}
          errors={errors} data={data} />
      ))}
      <TextField label="Why this edit" multiline required value={form.values.explanation} onChange={(explanation) => { form.set('explanation', explanation); draft.change({ ...form.values, explanation }); }}
        maxLength={2000} hint="Explain the change so an editor can judge it." errors={errors.filter((issue) => issue.field === 'explanation')} />
      <TextField label="References" value={form.values.references} onChange={(value) => form.set('references', value)}
        hint="Optional record ids that support the change, separated by spaces or commas." errors={errors.filter((issue) => issue.field === 'references' || issue.field.startsWith('references.'))} />
      <DraftControlsBar controls={draft} content={form.values} />
      <div className="rf-actions">
        <Button type="submit" variant="primary" disabled={busy}>{rebaseId === undefined ? 'Propose the edit' : 'Rebase the proposal'}</Button>
        <Button variant="quiet" onClick={() => { form.discard(); void navigate(`/items/${item.id}`); }}>Discard</Button>
      </div>
    </form>
  );
}

/** `/items/:id/propose`, loading the record and its form data before the propose/rebase form (R57.4). */
export function ProposeEditPage({ rootId, rebaseId }: { readonly rootId: string; readonly rebaseId?: string | undefined }) {
  const item = useLoad<{ item: ItemView }>(`/items/${rootId}`);
  const { data, error } = useFormData();
  if (!item.data || !data) return <LoadState error={item.error ?? error} />;
  return <ProposeEditForm key={item.data.item.rev} item={item.data.item} data={data} rebaseId={rebaseId} />;
}
