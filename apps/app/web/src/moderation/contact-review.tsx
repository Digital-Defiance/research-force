import { useState } from 'react';
import { ApiFailure, useApi } from '../api';
import { useSession } from '../session';
import { Button, Notice, SelectField, TextField } from '../ui';
import type { Option } from '../ui';
import { AFFILIATION_LIMIT, NAME_LIMIT, REASON_LIMIT } from './model';
import type { ContactReview, ContactReviewRecord, QueueEntry, SubmissionHistory, SubmitterCorrectionRecord } from './model';

/** The Contact_Review choices an Administrator records: Keep for another 12 months with a reason, or Erase (R32.20). */
const REVIEW_OPTIONS: Option[] = [
  { value: 'keep', label: 'Keep the contact for another 12 months' },
  { value: 'erase', label: 'Erase the contact' },
];
/** The Submitter corrections an Administrator may make at any time (R32.22). */
const CORRECTION_OPTIONS: Option[] = [
  { value: 'attribution', label: 'Correct the attribution (name and affiliation)' },
  { value: 'contact', label: 'Correct the contact (email)' },
  { value: 'contact_erasure', label: 'Erase the contact' },
];
const REASON_HINT = `1 to ${REASON_LIMIT.toLocaleString('en-GB')} characters.`;

/** Whether an accepted Outside_Submission still holds a Submitter_Contact that a Contact_Review or an erasure can act on (R32.19). */
export function holdsContact(entry: QueueEntry): boolean {
  return entry.state === 'accepted' && entry.submitter.email !== null;
}

/**
 * The due or overdue Contact_Review mark for the Moderation_Queue and the Outside_Submission view: a plain status for a
 * due review, a danger status once it has been overdue for 30 days or more (R32.19, R32.21). Nothing is shown when no
 * review is due.
 */
export function ContactReviewMark({ contactReview }: { readonly contactReview: ContactReview | null }) {
  if (contactReview === null) return null;
  return contactReview.overdue
    ? <span className="rf-status rf-status--danger">Contact review overdue</span>
    : <span className="rf-status rf-status--warning">Contact review due</span>;
}

/**
 * Record a Contact_Review on an accepted Outside_Submission whose Submitter_Contact is still held (R32.19, R32.20). A
 * Keep requires a reason of 1 to 1,000 characters and keeps the contact for another 12 months; an Erase takes no reason
 * and schedules the contact's erasure within 24 hours. Administrator-only; the caller gates this behind
 * `session.can('moderation.decide')`. A refusal, including a contact already erased by a concurrent action, is shown here.
 */
export function ContactReviewForm({ submissionId, onDone }: { readonly submissionId: string; readonly onDone: () => void }) {
  const client = useApi();
  const [choice, setChoice] = useState('');
  const [reason, setReason] = useState('');
  const [failure, setFailure] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const errors = failure instanceof ApiFailure ? failure.fields : [];

  const submit = async () => {
    setBusy(true);
    setFailure(undefined);
    try {
      await client.post(`/moderation/${submissionId}/contact-review`, choice === 'keep' ? { choice: 'keep', reason } : { choice: 'erase' });
      onDone();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="rf-stack" aria-label="Record a contact review" onSubmit={(event) => { event.preventDefault(); void submit(); }} noValidate>
      <h2>Record a contact review</h2>
      {failure !== undefined && !(failure instanceof ApiFailure && failure.fields.length > 0) && <Notice tone="danger" title="The contact review was not recorded. Correct the fields and try again." />}
      <SelectField label="Contact review" value={choice} placeholder="Choose a contact review" options={REVIEW_OPTIONS}
        onChange={(value) => { setChoice(value); setFailure(undefined); }} errors={errors.filter((issue) => issue.field === 'choice')} />
      {choice === 'keep' && (
        <TextField label="Reason to keep the contact" required multiline value={reason} onChange={setReason} maxLength={REASON_LIMIT}
          hint={REASON_HINT} errors={errors.filter((issue) => issue.field === 'reason')} />
      )}
      {choice === 'erase' && (
        <Notice tone="warning" title="The Submitter contact will be erased within 24 hours. The attribution and the submitted text are kept." />
      )}
      {choice !== '' && (
        <div className="rf-actions">
          <Button type="submit" variant={choice === 'erase' ? 'danger' : 'primary'} disabled={busy}>{choice === 'erase' ? 'Erase the contact' : 'Keep the contact'}</Button>
        </div>
      )}
    </form>
  );
}

/** The body of a correction request for one kind, with the chosen fields. */
function correctionBody(kind: string, name: string, affiliation: string, email: string, reason: string): Record<string, unknown> {
  if (kind === 'attribution') return { kind: 'attribution', name, ...(affiliation === '' ? {} : { affiliation }), reason };
  if (kind === 'contact') return { kind: 'contact', email, reason };
  return { kind: 'contact_erasure', reason };
}

/**
 * Correct the Submitter_Attribution or the Submitter_Contact of an Outside_Submission, or erase the Submitter_Contact,
 * at any time, with a reason (R32.22). An attribution correction becomes the Credit of every created Item. Administrator-only;
 * the caller gates this behind `session.can('moderation.decide')`. A contact erasure is offered only while the contact
 * is still held. A refusal is shown here.
 */
export function CorrectionForm({ entry, onDone }: { readonly entry: QueueEntry; readonly onDone: () => void }) {
  const client = useApi();
  const [kind, setKind] = useState('');
  const [name, setName] = useState(entry.submitter.name);
  const [affiliation, setAffiliation] = useState(entry.submitter.affiliation ?? '');
  const [email, setEmail] = useState('');
  const [reason, setReason] = useState('');
  const [failure, setFailure] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const errors = failure instanceof ApiFailure ? failure.fields : [];
  const stillHeld = entry.submitter.email !== null;
  const options = stillHeld ? CORRECTION_OPTIONS : CORRECTION_OPTIONS.filter((option) => option.value !== 'contact_erasure');

  const submit = async () => {
    setBusy(true);
    setFailure(undefined);
    try {
      await client.post(`/moderation/${entry.id}/contact`, correctionBody(kind, name, affiliation, email, reason));
      onDone();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="rf-stack" aria-label="Correct the submitter" onSubmit={(event) => { event.preventDefault(); void submit(); }} noValidate>
      <h2>Correct the submitter</h2>
      {failure !== undefined && !(failure instanceof ApiFailure && failure.fields.length > 0) && <Notice tone="danger" title="The correction was not recorded. Correct the fields and try again." />}
      <SelectField label="Correction" value={kind} placeholder="Choose a correction" options={options}
        onChange={(value) => { setKind(value); setFailure(undefined); }} errors={errors.filter((issue) => issue.field === 'kind')} />
      {kind === 'attribution' && (
        <>
          <TextField label="Submitter name" required value={name} onChange={setName} maxLength={NAME_LIMIT} errors={errors.filter((issue) => issue.field === 'name')} />
          <TextField label="Submitter affiliation" value={affiliation} onChange={setAffiliation} maxLength={AFFILIATION_LIMIT}
            hint="Leave blank to clear the affiliation." errors={errors.filter((issue) => issue.field === 'affiliation')} />
          <Notice tone="neutral" title="The corrected attribution becomes the Credit of every Item created from this submission." />
        </>
      )}
      {kind === 'contact' && (
        <TextField label="Submitter email" required type="email" value={email} onChange={setEmail} errors={errors.filter((issue) => issue.field === 'email')} />
      )}
      {kind === 'contact_erasure' && (
        <Notice tone="warning" title="The Submitter contact will be erased at once and never kept. The attribution and the submitted text are kept." />
      )}
      {kind !== '' && (
        <>
          <TextField label="Reason for the correction" required multiline value={reason} onChange={setReason} maxLength={REASON_LIMIT}
            hint={REASON_HINT} errors={errors.filter((issue) => issue.field === 'reason')} />
          <div className="rf-actions">
            <Button type="submit" variant={kind === 'contact_erasure' ? 'danger' : 'primary'} disabled={busy}>Record the correction</Button>
          </div>
        </>
      )}
    </form>
  );
}

/** One Contact_Review in the history: its choice, the reason for a Keep, the Administrator, and the time (R32.20). */
function ReviewItem({ record }: { readonly record: ContactReviewRecord }) {
  const admin = record.admin.displayName ?? 'an administrator';
  return (
    <li>
      <article className="rf-companion" aria-label={`Contact review ${record.action === 'keep' ? 'kept' : 'erased'}`}>
        <p>
          <span className="rf-status">{record.action === 'keep' ? 'Kept' : 'Erased'}</span>{` by ${admin}`}
        </p>
        <p className="rf-meta">{record.at}</p>
        {record.reason !== null && <p>{record.reason}</p>}
      </article>
    </li>
  );
}

/**
 * One Submitter correction in the history: the kind, the new and previous values, the Administrator, the reason, and
 * the time. A previously erased Submitter_Contact is never present, so none is ever shown (R32.22).
 */
function CorrectionItem({ record }: { readonly record: SubmitterCorrectionRecord }) {
  const admin = record.admin.displayName ?? 'an administrator';
  const label = record.kind === 'attribution' ? 'Attribution corrected' : record.erased ? 'Contact erased' : 'Contact corrected';
  return (
    <li>
      <article className="rf-companion" aria-label={label}>
        <p><span className="rf-status">{label}</span>{` by ${admin}`}</p>
        <p className="rf-meta">{record.at}</p>
        {record.kind === 'attribution' && (
          <dl>
            <dt>New name</dt><dd>{record.newName}</dd>
            <dt>New affiliation</dt><dd>{record.newAffiliation ?? 'Not given'}</dd>
            <dt>Previous name</dt><dd>{record.prevName}</dd>
            <dt>Previous affiliation</dt><dd>{record.prevAffiliation ?? 'Not given'}</dd>
          </dl>
        )}
        {record.kind === 'contact' && !record.erased && (
          <dl>
            <dt>New email</dt><dd>{record.newEmail}</dd>
          </dl>
        )}
        <p>{record.reason}</p>
      </article>
    </li>
  );
}

/**
 * The history of Contact_Reviews and Submitter corrections on the Outside_Submission view, newest first. A previously
 * erased Submitter_Contact is never shown, because the backend never keeps it (R32.20, R32.22).
 */
export function SubmissionHistoryView({ history }: { readonly history: SubmissionHistory }) {
  const empty = history.contactReviews.length === 0 && history.corrections.length === 0;
  return (
    <section className="rf-section" aria-label="Contact review and correction history">
      <h2>Contact reviews and corrections</h2>
      {empty
        ? <p className="rf-meta">No contact review or correction has been recorded.</p>
        : (
          <>
            {history.contactReviews.length > 0 && (
              <>
                <h3>Contact reviews</h3>
                <ul className="rf-list">{history.contactReviews.map((record, index) => <ReviewItem key={index} record={record} />)}</ul>
              </>
            )}
            {history.corrections.length > 0 && (
              <>
                <h3>Corrections</h3>
                <ul className="rf-list">{history.corrections.map((record, index) => <CorrectionItem key={index} record={record} />)}</ul>
              </>
            )}
          </>
        )}
    </section>
  );
}

/**
 * The Contact_Review and correction area of the Outside_Submission view for an Administrator: the forms that record a
 * Contact_Review (while the contact is still held) and a Submitter correction, and the full history (R32.19 to R32.22).
 * Non-administrators see the history only.
 */
export function ContactManagement({ entry, onDone }: { readonly entry: QueueEntry; readonly onDone: () => void }) {
  const session = useSession();
  const canDecide = session.can('moderation.decide');
  return (
    <>
      {canDecide && holdsContact(entry) && <ContactReviewForm submissionId={entry.id} onDone={onDone} />}
      {canDecide && entry.state === 'accepted' && <CorrectionForm entry={entry} onDone={onDone} />}
      <SubmissionHistoryView history={entry.history} />
    </>
  );
}
