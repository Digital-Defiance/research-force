import { useId, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { ITEM_KIND_NAMES } from '@researchforce/domain/kind-names';
import type { ItemKind } from '@researchforce/domain/types';
import { ApiFailure, useApi } from '../../api';
import type { FieldIssue } from '../../api';
import { mentionOptions } from '../../discussion/thread';
import { usePersistentForm } from '../../persist';
import { draftsToApi, ReviewDrafts, reviewOptions } from '../../reviews/reviews';
import type { ReviewDraft } from '../../reviews/reviews';
import { useSession } from '../../session';
import type { ConflictDetails, ItemView, MemberRow, PartyRecord, ProjectChoice, ValueSets } from '../../types';
import { Button, formatDate, LoadState, Notice, RestoredNotice, SaveFailure, SelectField, TextField, useLoad } from '../../ui';
import { FieldInput } from './inputs';
import type { FormData } from './inputs';
import { createBody, editBody, fieldsFor, initialValues, needsMark, valuesFromItem } from './model';
import type { EditMarkValue, FormValues } from './model';

const REVISION_KIND_NAMES: Readonly<Record<string, string>> = {
  minor_edit: 'Minor edit', correction: 'Correction', status_change: 'Status change', withdrawal: 'Withdrawal',
  disclosure_change: 'Disclosure change', restoration: 'Restoration', deletion: 'Deletion',
};

/** Value sets, External_Parties, and Members that the fields offer, and the Mention picker's choices. */
export function useFormData(): { data: FormData | undefined; error: unknown } {
  const { me } = useSession();
  const valueSets = useLoad<{ valueSets: ValueSets }>('/value-sets');
  const parties = useLoad<{ parties: PartyRecord[] }>('/parties');
  const members = useLoad<{ members: MemberRow[] }>('/members');
  const data = useMemo<FormData | undefined>(() => {
    if (!valueSets.data || !parties.data || !members.data) return undefined;
    const mentions = mentionOptions(members.data.members, me.specialtyOptions);
    return { valueSets: valueSets.data.valueSets, parties: parties.data.parties, members: members.data.members, mentions };
  }, [valueSets.data, parties.data, members.data, me.specialtyOptions]);
  return { data, error: valueSets.error ?? parties.error ?? members.error };
}

interface CreateState { readonly values: FormValues; readonly projectId: string; readonly reviews: readonly ReviewDraft[] }
interface EditState { readonly values: FormValues; readonly before: FormValues; readonly rev: number; readonly mark: EditMarkValue; readonly statusReason: string }

/** Field issues that no field of the form shows, such as an issue with the whole body. */
function unplaced(failure: unknown, shown: readonly string[]): FieldIssue[] {
  if (!(failure instanceof ApiFailure)) return [];
  return failure.fields.filter((issue) => !shown.some((field) => issue.field === field || issue.field.startsWith(`${field}.`)));
}

/** The Revisions saved since the Member opened the record, with who saved each and when (R4.9, R22.10). */
export function ConflictView({ failure, onDiscard }: { readonly failure: ApiFailure; readonly onDiscard: () => void }) {
  const details = failure.details as ConflictDetails | undefined;
  const revisions = details?.revisions ?? [];
  return (
    <Notice tone="warning" title="Someone saved a change after you opened this record. Your input was not saved; it is kept below.">
      {revisions.length > 0 && (
        <ul>
          {revisions.map((revision, index) => (
            <li key={index}>{`${REVISION_KIND_NAMES[revision.kind] ?? revision.kind} by ${revision.displayName ?? 'a Member without a display name'} at ${formatDate(revision.at)}`}</li>
          ))}
        </ul>
      )}
      <p>Copy anything you need, then discard your input to edit the latest version.</p>
      <Button variant="quiet" onClick={onDiscard}>Discard my input and load the latest version</Button>
    </Notice>
  );
}

/** Minor_Edit or Correction, with neither preselected, and the reason a Correction needs (R22.2). */
function EditMarkChoice({ value, onChange, errors }: { readonly value: EditMarkValue; readonly onChange: (value: EditMarkValue) => void; readonly errors: readonly FieldIssue[] }) {
  const name = useId();
  const markErrors = errors.filter((issue) => issue.field === 'mark' || issue.field === 'mark.mark');
  const reasonErrors = errors.filter((issue) => issue.field === 'mark.reason');
  return (
    <fieldset className={markErrors.length > 0 ? 'rf-field rf-field--invalid' : 'rf-field'}>
      <legend className="rf-field__label">Kind of edit</legend>
      <p className="rf-field__hint">Required unless the edit only changes a status. A Correction fixes a factual error and needs a reason.</p>
      {markErrors.length > 0 && <p className="rf-field__error">{markErrors.map((issue) => issue.rule).join(' ')}</p>}
      {(['minor_edit', 'correction'] as const).map((mark) => (
        <div className="rf-field rf-field--checkbox" key={mark}>
          <input className="rf-checkbox" type="radio" id={`${name}-${mark}`} name={name} checked={value.mark === mark} onChange={() => onChange({ ...value, mark })} />
          <label className="rf-field__label" htmlFor={`${name}-${mark}`}>{REVISION_KIND_NAMES[mark]}</label>
        </div>
      ))}
      <TextField label="Reason" multiline value={value.reason} onChange={(reason) => onChange({ ...value, reason })} errors={reasonErrors} required={value.mark === 'correction'} />
    </fieldset>
  );
}

function Fields({ kind, mode, values, set, failure, data }: {
  readonly kind: ItemKind; readonly mode: 'create' | 'edit'; readonly values: FormValues; readonly set: (field: string, value: unknown) => void;
  readonly failure: unknown; readonly data: FormData;
}) {
  const errors = failure instanceof ApiFailure ? failure.fields : [];
  return (
    <>
      {fieldsFor(kind, mode).map((spec) => (
        <FieldInput key={spec.name} spec={spec} value={values[spec.name]} onChange={(value) => set(spec.name, value)} errors={errors} data={data} />
      ))}
    </>
  );
}

function IssueSummary({ issues }: { readonly issues: readonly FieldIssue[] }) {
  if (issues.length === 0) return null;
  return <Notice tone="danger" title="Correct these issues:"><ul>{issues.map((issue, index) => <li key={index}>{issue.rule}</li>)}</ul></Notice>;
}

/** Submit a new Research_Item of one kind into the chosen Project (R39.2, R39.3, R41.2, R41.7). */
export function CreateItemForm({ kind, choice, data }: { readonly kind: ItemKind; readonly choice: ProjectChoice; readonly data: FormData }) {
  const client = useApi();
  const navigate = useNavigate();
  const session = useSession();
  const form = usePersistentForm<CreateState>(`item:new:${kind}`, () => ({ values: initialValues(kind), projectId: choice.preselected ?? '', reviews: [] }));
  const [failure, setFailure] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const shown = ['projectId', 'reviews', ...fieldsFor(kind, 'create').map((field) => field.name)];
  const sections = Array.isArray(form.values.values['sections']) ? form.values.values['sections'].length : 0;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFailure(undefined);
    try {
      const reviews = form.values.reviews.length === 0 ? {} : { reviews: draftsToApi(form.values.reviews) };
      const response = await client.saveItem<{ item: ItemView }>({ kindPath: kind.replaceAll('_', '-') }, { ...createBody(kind, form.values.projectId, form.values.values), ...reviews });
      form.sent();
      void navigate(`/items/${response.item.id}`);
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  };
  const projectErrors = failure instanceof ApiFailure ? failure.issuesFor('projectId') : [];
  return (
    <form className="rf-stack" onSubmit={(event) => void submit(event)} noValidate>
      <h1>{`New ${ITEM_KIND_NAMES[kind]}`}</h1>
      {form.restored && <RestoredNotice onDiscard={form.discard} />}
      <SaveFailure error={failure} />
      <IssueSummary issues={unplaced(failure, shown)} />
      {choice.projects.length === 0
        ? <Notice tone="warning" title="A Project is required, and none exists yet. An Administrator must first create one." />
        : <SelectField label="Project" required value={form.values.projectId} placeholder="Choose a Project" errors={projectErrors}
            options={choice.projects.map((project) => ({ value: project.id, label: project.name }))} onChange={(projectId) => form.set('projectId', projectId)} />}
      <Fields kind={kind} mode="create" values={form.values.values} set={(field, value) => form.set('values', { ...form.values.values, [field]: value })} failure={failure} data={data} />
      {session.can('review.request') && <ReviewDrafts value={form.values.reviews} onChange={(reviews) => form.set('reviews', reviews)} options={reviewOptions(session, data.members)}
        sections={sections} errors={failure instanceof ApiFailure ? failure.fields : []} />}
      <div className="rf-actions">
        <Button type="submit" variant="primary" disabled={busy}>Submit</Button>
        <Button variant="quiet" onClick={form.discard}>Discard</Button>
      </div>
    </form>
  );
}

/** Edit a Research_Item: the edit mark, field errors, and the conflict view that keeps the input (R4.9, R22.2, R22.10). */
export function EditItemForm({ item, data, onReload }: { readonly item: ItemView; readonly data: FormData; readonly onReload: () => void }) {
  const client = useApi();
  const navigate = useNavigate();
  const form = usePersistentForm<EditState>(`item:${item.id}:edit`, () => {
    const values = valuesFromItem(item);
    return { values, before: values, rev: item.rev, mark: { mark: '', reason: '' }, statusReason: '' };
  });
  const [failure, setFailure] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const hasStatus = fieldsFor(item.kind, 'edit').some((field) => field.name === 'statusValueId' || field.name === 'outcomeId');
  const shown = ['mark', 'statusReason', ...fieldsFor(item.kind, 'edit').map((field) => field.name)];
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const { values, before, rev, mark, statusReason } = form.values;
    const body = editBody(item.kind, rev, before, values, mark, statusReason);
    if (mark.mark === '' && needsMark(body)) {
      setFailure(new ApiFailure(422, 'validation', [{ field: 'mark', rule: 'Choose Minor edit or Correction.' }]));
      return;
    }
    if (mark.mark === 'correction' && mark.reason.trim() === '') {
      setFailure(new ApiFailure(422, 'validation', [{ field: 'mark.reason', rule: 'A Correction needs a reason.' }]));
      return;
    }
    setBusy(true);
    setFailure(undefined);
    try {
      await client.saveItem<{ item: ItemView }>({ id: item.id }, body);
      form.sent();
      void navigate(`/items/${item.id}`);
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  };
  const conflict = failure instanceof ApiFailure && failure.code === 'conflict' ? failure : undefined;
  const errors = failure instanceof ApiFailure ? failure.fields : [];
  return (
    <form className="rf-stack" onSubmit={(event) => void submit(event)} noValidate>
      <h1>{`Edit ${ITEM_KIND_NAMES[item.kind]} ${item.identifier}`}</h1>
      {form.restored && <RestoredNotice onDiscard={form.discard} />}
      {conflict
        ? <ConflictView failure={conflict} onDiscard={() => { form.discard(); onReload(); }} />
        : <SaveFailure error={failure} />}
      <IssueSummary issues={unplaced(failure, shown)} />
      <p className="rf-meta">{`Project: ${item.project.name}`}</p>
      <Fields kind={item.kind} mode="edit" values={form.values.values} set={(field, value) => form.set('values', { ...form.values.values, [field]: value })} failure={failure} data={data} />
      {hasStatus && <TextField label="Reason for a status change" multiline value={form.values.statusReason} onChange={(statusReason) => form.set('statusReason', statusReason)}
        errors={errors.filter((issue) => issue.field === 'statusReason')} hint="Optional; recorded with the status change." />}
      <EditMarkChoice value={form.values.mark} onChange={(mark) => form.set('mark', mark)} errors={errors} />
      <div className="rf-actions">
        <Button type="submit" variant="primary" disabled={busy}>Save</Button>
        <Button variant="quiet" onClick={() => { form.discard(); void navigate(`/items/${item.id}`); }}>Discard</Button>
      </div>
    </form>
  );
}

/** `/items/new/:kind`, with the Project preselected from the page the Member came from (R39.2). */
export function NewItemPage({ kind, search }: { readonly kind: ItemKind; readonly search: URLSearchParams }) {
  const query = new URLSearchParams();
  for (const key of ['project', 'unit']) {
    const value = search.get(key);
    if (value !== null) query.set(key, value);
  }
  const choice = useLoad<ProjectChoice>(`/projects/choice${query.size > 0 ? `?${query}` : ''}`);
  const { data, error } = useFormData();
  if (!choice.data || !data) return <LoadState error={choice.error ?? error} />;
  return <CreateItemForm kind={kind} choice={choice.data} data={data} />;
}

export function EditItemPage({ id }: { readonly id: string }) {
  const item = useLoad<{ item: ItemView }>(`/items/${id}`);
  const { data, error } = useFormData();
  if (!item.data || !data) return <LoadState error={item.error ?? error} />;
  return <EditItemForm key={item.data.item.rev} item={item.data.item} data={data} onReload={item.reload} />;
}
