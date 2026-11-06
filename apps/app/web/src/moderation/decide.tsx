import { useState } from 'react';
import { ApiFailure, useApi } from '../api';
import type { FieldIssue } from '../api';
import type { FormData } from '../items/forms/inputs';
import type { ProjectRecord } from '../types';
import { Button, Notice, SelectField, TextField } from '../ui';
import type { Option } from '../ui';
import { AcceptanceBuilder, draftsToSelections, emptyDraft } from './acceptance';
import type { Draft } from './acceptance';
import { CHANGED_KIND_NAMES, CHANGED_KINDS, DECISION_TEXT_LIMIT } from './model';
import type { ChangedKind, ChangedRef, DecisionChoice, DecisionEmail, DecisionResult } from './model';

const CHANGED_OPTIONS: Option[] = CHANGED_KINDS.map((kind) => ({ value: kind, label: CHANGED_KIND_NAMES[kind] }));

/** The exact email text a decision returns, shown for confirmation before it is applied (R32.10). */
export function EmailPreview({ email }: { readonly email: DecisionEmail }) {
  return (
    <section className="rf-section" aria-label="Email to the submitter">
      <h3>The email the submitter will receive</h3>
      <p className="rf-meta">{`Subject: ${email.subject}`}</p>
      {email.body.map((line, index) => <p key={index}>{line}</p>)}
    </section>
  );
}

/** The free-text elements a Removal_Request records as changed; the kind and a free-text reference, kept verbatim (R46.23). */
export function ChangedElements({ value, onChange, errors }: { readonly value: readonly ChangedRef[]; readonly onChange: (next: ChangedRef[]) => void; readonly errors: readonly FieldIssue[] }) {
  const update = (index: number, next: ChangedRef | undefined) => onChange(next === undefined ? value.filter((_entry, at) => at !== index) : value.map((entry, at) => (at === index ? next : entry)));
  return (
    <fieldset className="rf-field" aria-label="Changed elements">
      <legend className="rf-field__label">Changed elements</legend>
      <p className="rf-field__hint">Each element this removal changed: its kind and a reference, recorded as given.</p>
      {value.map((entry, index) => (
        <div className="rf-actions" key={index}>
          <SelectField label={`Element ${index + 1} kind`} value={entry.kind} options={CHANGED_OPTIONS} onChange={(kind) => update(index, { ...entry, kind: kind as ChangedKind })}
            errors={errors.filter((issue) => issue.field === `changed.${index}.kind`)} />
          <TextField label={`Element ${index + 1} reference`} value={entry.reference} onChange={(reference) => update(index, { ...entry, reference })} maxLength={200}
            errors={errors.filter((issue) => issue.field === `changed.${index}.reference`)} />
          <Button variant="quiet" onClick={() => update(index, undefined)}>{`Remove element ${index + 1}`}</Button>
        </div>
      ))}
      <Button onClick={() => onChange([...value, { kind: 'item', reference: '' }])}>Add a changed element</Button>
    </fieldset>
  );
}

/** The body of a preview or apply request for one decision choice. */
function decisionBody(choice: DecisionChoice, state: DecideState, confirm: boolean): Record<string, unknown> {
  if (choice === 'removal_accepted' || choice === 'removal_rejected') {
    return { decision: choice, confirm, statement: state.text, changed: state.changed.map((entry) => ({ kind: entry.kind, reference: entry.reference })) };
  }
  if (choice === 'accepted') {
    return { decision: 'accepted', confirm, text: state.text, items: draftsToSelections(state.drafts) };
  }
  return { decision: choice, confirm, text: state.text };
}

interface DecideState {
  readonly text: string;
  readonly changed: readonly ChangedRef[];
  readonly drafts: readonly Draft[];
}

const DECISION_LABELS: Readonly<Record<DecisionChoice, string>> = {
  accepted: 'Accept and create the Items',
  rejected: 'Reject',
  more_information_requested: 'Ask for more information',
  removal_accepted: 'Accept the removal request',
  removal_rejected: 'Decline the removal request',
};

/**
 * Record one Moderation_Decision. The Administrator writes the message (or the Removal_Request statement), builds any
 * accepted Items, and then sees the exact email text; the decision is applied, and the email queued, only after that
 * text is confirmed (R32.4, R32.10, R32.12). A refusal, including a decision that is already final, is shown here.
 */
export function DecisionForm({ submissionId, choice, isRemoval, generalChoice, submissionProject, projects, data, onApplied }: {
  readonly submissionId: string;
  readonly choice: DecisionChoice;
  readonly isRemoval: boolean;
  readonly generalChoice: boolean;
  readonly submissionProject: string | null;
  readonly projects: readonly ProjectRecord[];
  readonly data: FormData;
  readonly onApplied: (result: DecisionResult) => void;
}) {
  const client = useApi();
  const [state, setState] = useState<DecideState>({ text: '', changed: [], drafts: choice === 'accepted' ? [emptyDraft()] : [] });
  const [preview, setPreview] = useState<DecisionEmail | null>(null);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const errors = failure instanceof ApiFailure ? failure.fields : [];
  const textField = isRemoval ? 'statement' : 'text';
  const conflict = failure instanceof ApiFailure && failure.code === 'conflict' ? (failure.details as { decision?: { kind: string; admin?: { displayName: string | null }; at: string } } | undefined)?.decision : undefined;

  const run = async (confirm: boolean) => {
    setBusy(true);
    setFailure(undefined);
    try {
      const result = await client.post<DecisionResult>(`/moderation/${submissionId}/decide`, decisionBody(choice, state, confirm));
      if (confirm) { onApplied(result); return; }
      setPreview(result.email);
    } catch (error) {
      setFailure(error);
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="rf-stack" aria-label={DECISION_LABELS[choice]} onSubmit={(event) => { event.preventDefault(); void run(false); }} noValidate>
      <h2>{DECISION_LABELS[choice]}</h2>
      {conflict !== undefined
        ? <Notice tone="warning" title={`A ${conflict.kind} decision was already recorded${conflict.admin?.displayName ? ` by ${conflict.admin.displayName}` : ''}.`} />
        : failure !== undefined && !(failure instanceof ApiFailure && failure.fields.length > 0) && <Notice tone="danger" title="The decision was not recorded. Correct the fields and try again." />}
      <TextField label={isRemoval ? 'Statement to the submitter' : 'Message to the submitter'} required multiline value={state.text}
        onChange={(text) => { setState((old) => ({ ...old, text })); setPreview(null); }} maxLength={DECISION_TEXT_LIMIT}
        hint={`1 to ${DECISION_TEXT_LIMIT.toLocaleString('en-GB')} characters.`} errors={errors.filter((issue) => issue.field === textField)} />
      {choice === 'accepted' && (
        <AcceptanceBuilder drafts={state.drafts} onChange={(drafts) => { setState((old) => ({ ...old, drafts })); setPreview(null); }}
          projects={projects} generalChoice={generalChoice} submissionProject={submissionProject} data={data} errors={errors} />
      )}
      {isRemoval && (
        <ChangedElements value={state.changed} onChange={(changed) => { setState((old) => ({ ...old, changed })); setPreview(null); }} errors={errors} />
      )}
      {preview === null
        ? <div className="rf-actions"><Button type="submit" variant="primary" disabled={busy}>Preview the email</Button></div>
        : (
          <>
            <EmailPreview email={preview} />
            <div className="rf-actions">
              <Button variant="primary" disabled={busy} onClick={() => void run(true)}>Confirm and send</Button>
              <Button variant="quiet" disabled={busy} onClick={() => setPreview(null)}>Edit the decision</Button>
            </div>
          </>
        )}
    </form>
  );
}
