import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link } from 'react-router';
import { ApiFailure, useApi } from '../api';
import type { FieldIssue } from '../api';
import { usePersistentForm } from '../persist';
import { useSession } from '../session';
import type { Session } from '../session';
import type { MemberRow, ReviewView } from '../types';
import { Button, CheckboxField, formatDate, LoadState, Notice, PersonLink, SaveFailure, SelectField, TextField, useLoad } from '../ui';
import type { Option } from '../ui';

/** Who a Review_Request can name: active Members other than the requester, Specialties that are not retired, and Roles (R17.2). */
export interface ReviewOptions {
  readonly members: readonly { readonly id: string; readonly name: string }[];
  readonly specialties: readonly { readonly id: string; readonly name: string }[];
  readonly roles: readonly { readonly id: string; readonly name: string }[];
}
export interface Addressees { readonly memberIds: readonly string[]; readonly specialtyIds: readonly string[]; readonly roleIds: readonly string[] }
const NO_ADDRESSEES: Addressees = { memberIds: [], specialtyIds: [], roleIds: [] };

export function reviewOptions(session: Session, members: readonly MemberRow[]): ReviewOptions {
  return {
    members: members.flatMap((member) => (member.status === 'active' && member.id !== session.me.member.id ? [{ id: member.id, name: member.displayName ?? member.email }] : [])),
    specialties: session.me.specialtyOptions.filter((specialty) => specialty.retired !== true),
    roles: session.roles.map((role) => ({ id: role.id, name: role.name })),
  };
}

/** Whether the Member is an Eligible_Reviewer: not the requester, and named, holding a named Specialty, or in a named Role (R17.4). */
export function canReview(session: Session, review: ReviewView): boolean {
  const { me } = session;
  if (review.requester.id === me.member.id) return false;
  const held = new Set((me.profile?.specialties ?? []).map((specialty) => specialty.id));
  return review.addressees.some((addressee) => (addressee.type === 'member' && addressee.id === me.member.id)
    || (addressee.type === 'role' && addressee.id === me.member.roleId) || (addressee.type === 'specialty' && held.has(addressee.id)));
}

const ADDRESSEE_TYPE_NAMES = { member: 'Member', specialty: 'Specialty', role: 'Role' } as const;
const addresseeList = (review: ReviewView): string => review.addressees.map((addressee) => `${addressee.name ?? addressee.id} (${ADDRESSEE_TYPE_NAMES[addressee.type]})`).join(', ');

/** Shown with an Item or Entry_Section while it has a Needs_Review request; never on the Public_Site (R17.7). */
export function PendingReview() {
  return <span className="rf-status rf-status--warning">Review pending</span>;
}

/** Members, Specialties, and Roles as checkboxes; `prefix` places the API's field issues, such as `reviews.0.`. */
export function AddresseeFields({ value, onChange, options, errors, prefix = '' }: {
  readonly value: Addressees; readonly onChange: (value: Addressees) => void; readonly options: ReviewOptions; readonly errors: readonly FieldIssue[]; readonly prefix?: string;
}) {
  const groups = [
    { key: 'memberIds', legend: 'Members', choices: options.members },
    { key: 'specialtyIds', legend: 'Specialties', choices: options.specialties },
    { key: 'roleIds', legend: 'Roles', choices: options.roles },
  ] as const;
  return (
    <>
      {groups.map(({ key, legend, choices }) => {
        const issues = errors.filter((issue) => issue.field === `${prefix}${key}` || issue.field.startsWith(`${prefix}${key}.`));
        const chosen = value[key];
        return (
          <fieldset key={key} className={issues.length > 0 ? 'rf-field rf-field--invalid' : 'rf-field'}>
            <legend className="rf-field__label">{`Ask ${legend.toLowerCase()}`}</legend>
            {issues.length > 0 && <p className="rf-field__error">{issues.map((issue) => issue.rule).join(' ')}</p>}
            {choices.length === 0 ? <p className="rf-meta">{`No ${legend.toLowerCase()} to choose from.`}</p> : choices.map((choice) => (
              <CheckboxField key={choice.id} label={choice.name} checked={chosen.includes(choice.id)}
                onChange={(checked) => onChange({ ...value, [key]: checked ? [...chosen, choice.id] : chosen.filter((id) => id !== choice.id) })} />
            ))}
          </fieldset>
        );
      })}
    </>
  );
}

const withNote = (note: string) => (note.trim() === '' ? {} : { note });

interface RequestState { readonly targetId: string; readonly addressees: Addressees; readonly note: string }

/** Ask for review of the Item or one of its Entry_Sections at any time after its Submission (R17.1, R17.9). */
export function ReviewRequestForm({ targets, options, onRequested }: { readonly targets: readonly Option[]; readonly options: ReviewOptions; readonly onRequested: () => void }) {
  const client = useApi();
  const form = usePersistentForm<RequestState>(`review:${targets[0]!.value}`, () => ({ targetId: targets[0]!.value, addressees: NO_ADDRESSEES, note: '' }));
  const [failure, setFailure] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFailure(undefined);
    try {
      await client.post('/reviews', { targetId: form.values.targetId, ...form.values.addressees, ...withNote(form.values.note) });
      form.discard();
      onRequested();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  };
  const errors = failure instanceof ApiFailure ? failure.fields : [];
  return (
    <form className="rf-stack" aria-label="Ask for review" onSubmit={(event) => void submit(event)} noValidate>
      <h3>Ask for review</h3>
      <SaveFailure error={failure} />
      {targets.length > 1 && <SelectField label="What to review" value={form.values.targetId} options={targets} onChange={(targetId) => form.set('targetId', targetId)} errors={errors.filter((issue) => issue.field === 'targetId')} />}
      {targets.length === 1 && errors.filter((issue) => issue.field === 'targetId').map((issue) => <Notice key={issue.rule} tone="danger" title={issue.rule} />)}
      <AddresseeFields value={form.values.addressees} onChange={(addressees) => form.set('addressees', addressees)} options={options} errors={errors} />
      <TextField label="Request note" multiline value={form.values.note} onChange={(note) => form.set('note', note)} maxLength={2000} hint="Optional; at most 2,000 characters." errors={errors.filter((issue) => issue.field === 'note')} />
      <div className="rf-actions"><Button type="submit" variant="primary" disabled={busy}>Ask for review</Button></div>
    </form>
  );
}

/** Mark a Needs_Review request Reviewed with an optional note (R17.5, R17.10). */
function CompleteReview({ review, onCompleted }: { readonly review: ReviewView; readonly onCompleted: () => void }) {
  const client = useApi();
  const [note, setNote] = useState('');
  const [failure, setFailure] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const complete = async () => {
    setBusy(true);
    setFailure(undefined);
    try {
      await client.post(`/reviews/${review.id}/complete`, withNote(note));
      onCompleted();
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
      <TextField label="Review note" multiline value={note} onChange={setNote} maxLength={2000} hint="Optional; at most 2,000 characters." errors={errors} />
      <div className="rf-actions"><Button variant="primary" onClick={() => void complete()} disabled={busy}>Mark reviewed</Button></div>
    </div>
  );
}

const OUTCOME_NAMES: Readonly<Record<string, string>> = { applied: 'Applied', declined: 'Declined' };

/** One Review_Request with its state, requester, addressees, note, and time, and its review once Reviewed (R17.8, R17.11). */
function ReviewEntry({ review, what, onChanged }: { readonly review: ReviewView; readonly what: ReactNode; readonly onChanged: () => void }) {
  const session = useSession();
  const open = review.state === 'needs_review';
  return (
    <article className="rf-companion" aria-label={`Review request from ${review.requester.displayName ?? 'a Member'}`}>
      <p>
        <span className={open ? 'rf-status rf-status--warning' : 'rf-status rf-status--success'}>{open ? 'Needs review' : 'Reviewed'}</span>
        {review.isPublicationRequest && <>{' '}<span className="rf-status">Publication request</span></>}
        {' '}{what}
      </p>
      <p className="rf-meta">{'Requested by '}<PersonLink person={review.requester} />{` on ${formatDate(review.createdAt)}`}</p>
      <p className="rf-meta">{`Addressed to: ${addresseeList(review)}`}</p>
      {review.note !== null && <p>{review.note}</p>}
      {review.reviewer !== undefined && (
        <>
          <p className="rf-meta">{'Reviewed by '}<PersonLink person={review.reviewer} />{` on ${formatDate(review.reviewedAt ?? '')}`}</p>
          {review.reviewNote !== null && review.reviewNote !== undefined && <p>{review.reviewNote}</p>}
          {review.outcome !== null && review.outcome !== undefined && <p className="rf-meta">{`Outcome: ${OUTCOME_NAMES[review.outcome] ?? review.outcome}`}</p>}
        </>
      )}
      {open && !review.isPublicationRequest && canReview(session, review) && <CompleteReview review={review} onCompleted={onChanged} />}
    </article>
  );
}

/** Every Review_Request of an Item and its Entry_Sections, in either state (R17.11). */
export function ReviewList({ reviews, sectionNumber, onChanged }: { readonly reviews: readonly ReviewView[]; readonly sectionNumber: (id: string) => number | undefined; readonly onChanged: () => void }) {
  if (reviews.length === 0) return <p className="rf-meta">No review has been requested.</p>;
  const what = (review: ReviewView) => {
    if (review.target.type !== 'entry_section') return 'This record';
    const number = sectionNumber(review.target.id);
    return number === undefined ? 'A removed Entry Section' : `Entry Section ${number}`;
  };
  return <ul className="rf-list">{reviews.map((review) => <li key={review.id}><ReviewEntry review={review} what={what(review)} onChanged={onChanged} /></li>)}</ul>;
}

/** Where a Review_Request's target is shown: its Item's page, at the Entry_Section when it names one. */
export function targetLink(review: ReviewView): { to: string; name: string } {
  const { target } = review;
  const root = target.rootId ?? target.id;
  const kind = target.type === 'entry_section' ? 'Entry Section of' : target.type === 'attachment' ? 'Attachment' : 'Record';
  return { to: `/items/${root}${target.type === 'entry_section' ? `#section-${target.id}` : ''}`, name: `${kind} ${target.identifier ?? ''}${target.title === null ? '' : `: ${target.title}`}`.trim() };
}

/** The Needs_Review requests the Member can review now, oldest first, each linking to its Item or Entry_Section (R17.8). */
export function ReviewQueuePage() {
  const queue = useLoad<{ reviews: ReviewView[] }>('/reviews/queue');
  if (!queue.data) return <LoadState error={queue.error} />;
  return (
    <div className="rf-stack">
      <h1>Review queue</h1>
      {queue.data.reviews.length === 0 ? <p className="rf-meta">No Review Requests are waiting for you.</p> : (
        <ul className="rf-list">
          {queue.data.reviews.map((review) => {
            const link = targetLink(review);
            return <li key={review.id}><ReviewEntry review={review} what={<Link to={link.to}>{link.name}</Link>} onChanged={queue.reload} /></li>;
          })}
        </ul>
      )}
    </div>
  );
}

/** A Review_Request added to a new Item's Submission; `section` is an Entry_Section's index, or empty for the whole record. */
export interface ReviewDraft { readonly section: string; readonly addressees: Addressees; readonly note: string }
export const emptyDraft = (): ReviewDraft => ({ section: '', addressees: NO_ADDRESSEES, note: '' });
export function draftsToApi(drafts: readonly ReviewDraft[]): Record<string, unknown>[] {
  return drafts.map((draft) => ({ ...(draft.section === '' ? {} : { section: Number(draft.section) }), ...draft.addressees, ...withNote(draft.note) }));
}

/** Review_Requests within the Submission that adds the Item; a refused one keeps the whole Submission unsubmitted (R17.1, R17.9). */
export function ReviewDrafts({ value, onChange, options, sections, errors }: {
  readonly value: readonly ReviewDraft[]; readonly onChange: (value: ReviewDraft[]) => void; readonly options: ReviewOptions; readonly sections: number; readonly errors: readonly FieldIssue[];
}) {
  const replace = (index: number, draft: ReviewDraft) => onChange(value.map((entry, at) => (at === index ? draft : entry)));
  const targets: Option[] = [{ value: '', label: 'The whole record' }, ...Array.from({ length: sections }, (_, index) => ({ value: String(index), label: `Entry Section ${index + 1}` }))];
  return (
    <section className="rf-section" aria-label="Review requests">
      <h2>Review requests</h2>
      {value.map((draft, index) => {
        const prefix = `reviews.${index}.`;
        const whole = errors.filter((issue) => issue.field === `reviews.${index}`);
        return (
          <fieldset key={index} className="rf-stack" aria-label={`Review request ${index + 1}`}>
            <legend className="rf-field__label">{`Review request ${index + 1}`}</legend>
            {whole.map((issue) => <Notice key={issue.rule} tone="danger" title={issue.rule} />)}
            {sections > 0 && <SelectField label="What to review" value={draft.section} options={targets} onChange={(section) => replace(index, { ...draft, section })}
              errors={errors.filter((issue) => issue.field === `${prefix}section`)} />}
            <AddresseeFields value={draft.addressees} onChange={(addressees) => replace(index, { ...draft, addressees })} options={options} errors={errors} prefix={prefix} />
            <TextField label="Request note" multiline value={draft.note} onChange={(note) => replace(index, { ...draft, note })} maxLength={2000} hint="Optional; at most 2,000 characters."
              errors={errors.filter((issue) => issue.field === `${prefix}note`)} />
            <Button variant="quiet" onClick={() => onChange(value.filter((_, at) => at !== index))}>{`Remove review request ${index + 1}`}</Button>
          </fieldset>
        );
      })}
      <Button onClick={() => onChange([...value, emptyDraft()])}>Add a review request</Button>
    </section>
  );
}
