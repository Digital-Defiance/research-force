import { ITEM_KIND_NAMES } from '@researchforce/domain/kind-names';
import type { ItemKind } from '@researchforce/domain/types';
import type { FieldIssue } from '../api';
import { FieldInput } from '../items/forms/inputs';
import type { FormData } from '../items/forms/inputs';
import { createBody, fieldsFor, initialValues, SUBMITTABLE_KINDS } from '../items/forms/model';
import type { AlternativeValue, FormValues } from '../items/forms/model';
import type { ProjectRecord } from '../types';
import { Button, SelectField, TextField } from '../ui';
import type { Option } from '../ui';
import type { Selection } from './model';

/** The Research_Item kinds the acceptance builder offers a form for; the same kinds the Workspace submits (R32.4). */
const KIND_OPTIONS: Option[] = SUBMITTABLE_KINDS.map((kind) => ({ value: kind, label: ITEM_KIND_NAMES[kind] }));

/** One created unit the Administrator is building; `kind` chooses which unit and the fields it carries. */
export interface Draft {
  readonly unit: 'research_item' | 'reply' | 'attachment';
  readonly kind: ItemKind;
  /** A local handle so a later Reply or Attachment can name this created Item as its Parent (R32.4). */
  readonly ref: string;
  /** The Project for a Research_Item; required for a General_Choice submission, else the submission's Project (R32.18). */
  readonly projectId: string;
  readonly values: FormValues;
  /** A Reply's or Attachment's Parent: an existing Item id, or a local ref of an Item created earlier. */
  readonly parentExisting: string;
  readonly parentCreated: string;
  readonly uploadId: string;
  readonly replyText: FormValues;
}

const REPLY_SPEC = { name: 'text', label: 'Reply text', kind: 'rich' as const, max: 50_000, required: true };

export function emptyDraft(kind: ItemKind = 'finding'): Draft {
  return { unit: 'research_item', kind, ref: '', projectId: '', values: initialValues(kind), parentExisting: '', parentCreated: '', uploadId: '', replyText: { text: { text: '', spans: [] } } };
}

/** Turn one draft into the request body's selection; an unset Project keeps the submission's own, which the Worker applies (R32.18). */
export function draftToSelection(draft: Draft): Selection {
  if (draft.unit === 'reply') {
    return { unit: 'reply', parent: draft.parentCreated !== '' ? { created: draft.parentCreated } : { existing: draft.parentExisting }, text: draft.replyText['text'] as Record<string, unknown> };
  }
  if (draft.unit === 'attachment') {
    return { unit: 'attachment', parent: draft.parentCreated !== '' ? { created: draft.parentCreated } : { existing: draft.parentExisting }, uploadId: draft.uploadId, metadata: {} };
  }
  const body = createBody(draft.kind, '', draft.values);
  return { unit: 'research_item', ...(draft.ref === '' ? {} : { ref: draft.ref }), kind: draft.kind, ...(draft.projectId === '' ? {} : { projectId: draft.projectId }), fields: body };
}

export function draftsToSelections(drafts: readonly Draft[]): Selection[] {
  return drafts.map(draftToSelection);
}

const UNIT_OPTIONS: Option[] = [
  { value: 'research_item', label: 'A Research Item' },
  { value: 'reply', label: 'A Reply on an Item' },
  { value: 'attachment', label: 'An Attachment on an Item' },
];

/** The Parent chooser for a Reply or Attachment: an existing Item by id, or an Item created earlier in this acceptance (R32.4). */
function ParentChooser({ draft, created, onChange, errors }: { readonly draft: Draft; readonly created: readonly Option[]; readonly onChange: (next: Draft) => void; readonly errors: readonly FieldIssue[] }) {
  return (
    <div className="rf-stack">
      {created.length > 0 && (
        <SelectField label="Parent created in this acceptance" value={draft.parentCreated} placeholder="None"
          options={created} onChange={(parentCreated) => onChange({ ...draft, parentCreated, parentExisting: parentCreated === '' ? draft.parentExisting : '' })} errors={errors} />
      )}
      {draft.parentCreated === '' && (
        <TextField label="Parent existing Item (unit id)" value={draft.parentExisting} onChange={(parentExisting) => onChange({ ...draft, parentExisting })}
          hint="The unit id of an existing Research Item, Reply, or Attachment you can read." errors={errors} />
      )}
    </div>
  );
}

/** One unit of the acceptance: a Research_Item with its kind, Project, and fields, or a Reply or Attachment on a Parent (R32.4, R32.18). */
export function AcceptanceItem({ index, draft, projects, generalChoice, submissionProject, data, created, errors, onChange, onRemove }: {
  readonly index: number;
  readonly draft: Draft;
  readonly projects: readonly ProjectRecord[];
  /** The submission is a General_Choice, so each Research_Item needs an explicit Project (R32.18). */
  readonly generalChoice: boolean;
  readonly submissionProject: string | null;
  readonly data: FormData;
  /** The local refs of Research_Items created before this one, offered as Parents. */
  readonly created: readonly Option[];
  readonly errors: readonly FieldIssue[];
  readonly onChange: (next: Draft) => void;
  readonly onRemove: () => void;
}) {
  const prefix = `items.${index}`;
  const own = (field: string) => errors.filter((issue) => issue.field === field || issue.field.startsWith(`${field}.`));
  const projectOptions: Option[] = projects.map((project) => ({ value: project.id, label: project.name }));
  const submissionName = submissionProject === null ? null : projects.find((project) => project.id === submissionProject)?.name ?? null;
  return (
    <fieldset className="rf-stack" aria-label={`Accepted unit ${index + 1}`}>
      <legend className="rf-field__label">{`Accepted unit ${index + 1}`}</legend>
      <SelectField label="What to create" value={draft.unit} options={UNIT_OPTIONS}
        onChange={(unit) => onChange({ ...draft, unit: unit as Draft['unit'] })} errors={own(`${prefix}.unit`)} />
      {draft.unit === 'research_item' && (
        <>
          <SelectField label="Kind" required value={draft.kind} options={KIND_OPTIONS}
            onChange={(kind) => onChange({ ...draft, kind: kind as ItemKind, values: initialValues(kind as ItemKind) })} errors={own(`${prefix}.kind`)} />
          <SelectField label="Project" value={draft.projectId} required={generalChoice}
            placeholder={generalChoice ? 'Choose a Project' : `Keep the submission’s Project${submissionName === null ? '' : ` (${submissionName})`}`}
            options={projectOptions} onChange={(projectId) => onChange({ ...draft, projectId })} errors={own(`${prefix}.projectId`)}
            hint={generalChoice ? 'A General choice submission needs a Project for each Item.' : 'Leave unset to keep the submission’s Project.'} />
          <TextField label="Reference (optional)" value={draft.ref} onChange={(ref) => onChange({ ...draft, ref })}
            hint="A short handle so a later Reply or Attachment can name this Item as its Parent." errors={own(`${prefix}.ref`)} />
          {fieldsFor(draft.kind, 'create').map((spec) => (
            <FieldInput key={spec.name} spec={spec} value={draft.values[spec.name]} onChange={(value) => onChange({ ...draft, values: { ...draft.values, [spec.name]: value } })}
              errors={own(`${prefix}.${spec.name}`)} data={draft.kind === 'decision_record' ? { ...data, alternatives: (draft.values['alternatives'] ?? []) as AlternativeValue[] } : data} />
          ))}
        </>
      )}
      {draft.unit === 'reply' && (
        <>
          <ParentChooser draft={draft} created={created} onChange={onChange} errors={own(`${prefix}.parent`)} />
          <FieldInput spec={REPLY_SPEC} value={draft.replyText['text']} onChange={(value) => onChange({ ...draft, replyText: { text: value } })} errors={own(`${prefix}.text`)} data={data} />
        </>
      )}
      {draft.unit === 'attachment' && (
        <>
          <ParentChooser draft={draft} created={created} onChange={onChange} errors={own(`${prefix}.parent`)} />
          <TextField label="Uploaded file id" required value={draft.uploadId} onChange={(uploadId) => onChange({ ...draft, uploadId })}
            hint="The id of a file you uploaded for this Attachment." errors={own(`${prefix}.uploadId`)} />
        </>
      )}
      <Button variant="quiet" onClick={onRemove}>{`Remove unit ${index + 1}`}</Button>
    </fieldset>
  );
}

/** The whole acceptance builder: the ordered units the acceptance creates, at least one (R32.4, R32.5). */
export function AcceptanceBuilder({ drafts, onChange, projects, generalChoice, submissionProject, data, errors }: {
  readonly drafts: readonly Draft[];
  readonly onChange: (next: Draft[]) => void;
  readonly projects: readonly ProjectRecord[];
  readonly generalChoice: boolean;
  readonly submissionProject: string | null;
  readonly data: FormData;
  readonly errors: readonly FieldIssue[];
}) {
  const replace = (index: number, next: Draft) => onChange(drafts.map((draft, at) => (at === index ? next : draft)));
  const refsBefore = (index: number): Option[] => drafts.slice(0, index).flatMap((draft) => (draft.unit === 'research_item' && draft.ref !== '' ? [{ value: draft.ref, label: `${ITEM_KIND_NAMES[draft.kind]} (${draft.ref})` }] : []));
  return (
    <section className="rf-section" aria-label="Items to create">
      <h3>Items to create</h3>
      <p className="rf-meta">At least one. A Reply or Attachment names an existing Item or one created earlier here.</p>
      {drafts.map((draft, index) => (
        <AcceptanceItem key={index} index={index} draft={draft} projects={projects} generalChoice={generalChoice} submissionProject={submissionProject}
          data={data} created={refsBefore(index)} errors={errors} onChange={(next) => replace(index, next)} onRemove={() => onChange(drafts.filter((_draft, at) => at !== index))} />
      ))}
      <Button onClick={() => onChange([...drafts, emptyDraft()])}>Add an Item</Button>
    </section>
  );
}
