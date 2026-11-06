import { useState } from 'react';
import { Link } from 'react-router';
import { fileKind } from '@researchforce/domain/file-kinds';
import { useFormData } from '../items/forms/ItemForm';
import type { ProjectRecord } from '../types';
import { useSession } from '../session';
import { LoadState, Notice, SelectField, useLoad } from '../ui';
import type { Option } from '../ui';
import { DownloadButton } from '../files/attachment-page';
import { FilePreview } from '../files/preview';
import { DecisionForm } from './decide';
import { ContactManagement, ContactReviewMark } from './contact-review';
import { stateName, typeName } from './model';
import type { DecisionChoice, DecisionResult, QueueEntry, QueueFile, QueuePage } from './model';

/** The decisions a submission of each type offers; a Removal_Request is accepted or declined, every other type the ordinary way (R32.4, R32.12). */
function decisionOptions(type: QueueEntry['type']): Option[] {
  if (type === 'removal_request') {
    return [{ value: 'removal_accepted', label: 'Accept the removal request' }, { value: 'removal_rejected', label: 'Decline the removal request' }];
  }
  return [
    { value: 'accepted', label: 'Accept and create Items' },
    { value: 'rejected', label: 'Reject' },
    { value: 'more_information_requested', label: 'Ask for more information' },
  ];
}

/** One submitted file, previewed through the same components as an Attachment, with a download (R14.8). */
function SubmissionFile({ file }: { readonly file: QueueFile }) {
  return (
    <li>
      <article className="rf-companion" aria-label={`File ${file.fileName}`}>
        <p>{file.fileName}</p>
        <p className="rf-meta">{`${file.sizeBytes.toLocaleString('en-GB')} bytes — SHA-256 ${file.sha256}`}</p>
        <DownloadButton id={file.id} />
        <FilePreview file={{ id: file.id, fileKind: fileKind(file.fileName), originalName: file.fileName, sizeBytes: file.sizeBytes }} />
      </article>
    </li>
  );
}

/** The decided-submission notice once a decision applies, with the created Items it recorded (R32.13). */
function AppliedNotice({ result }: { readonly result: DecisionResult }) {
  if (!result.applied) return <Notice tone="success" title="The decision was recorded and the email queued." />;
  const created = result.applied.createdUnitIds;
  return (
    <Notice tone="success" title="The decision was recorded and the email queued.">
      {created.length > 0 && (
        <>
          <p>{`${created.length} ${created.length === 1 ? 'unit was' : 'units were'} created:`}</p>
          <ul className="rf-list">{created.map((id) => <li key={id}><Link to={`/items/${id}`}>{id}</Link></li>)}</ul>
        </>
      )}
    </Notice>
  );
}

/**
 * The Outside_Submission view: the Submitter's details, the submitted text and referenced page, the Response_Target
 * dates with an overdue mark, the Attachment previews of the files, a failed-email notice, and, for an Administrator,
 * the decision forms with the email-text confirmation (R14.8, R32.10, R32.11, R32.17, R46.24).
 */
export function OutsideSubmissionScreen({ id }: { readonly id: string }) {
  const session = useSession();
  const queue = useLoad<QueuePage>('/moderation');
  const { reload } = queue;
  const projects = useLoad<{ projects: ProjectRecord[] }>('/projects');
  const { data: formData } = useFormData();
  const [choice, setChoice] = useState('');
  const [applied, setApplied] = useState<DecisionResult | null>(null);
  if (!queue.data) return <LoadState error={queue.error} />;
  const entry = queue.data.items.find((item) => item.id === id);
  if (entry === undefined) return <Notice tone="warning" title="This Outside Submission is not in the queue, or you cannot see it." />;
  const target = entry.responseTarget;
  const canDecide = session.can('moderation.decide');
  const isRemoval = entry.type === 'removal_request';
  return (
    <article className="rf-stack">
      <header>
        <p className="rf-meta">{`Outside submission ${entry.reference}`}</p>
        <h1>{typeName(entry.type)}</h1>
        <p>
          <span className="rf-status">{stateName(entry.state)}</span>
          {target?.overdue === true && <>{' '}<span className="rf-status rf-status--danger">Overdue</span></>}
          {entry.contactReview !== null && <>{' '}<ContactReviewMark contactReview={entry.contactReview} /></>}
        </p>
      </header>

      {entry.failedEmail === true && (
        <Notice tone="warning" title="The email to this submitter could not be sent.">
          <p>The outgoing email failed. The submitter may not have received the acknowledgement or a decision.</p>
        </Notice>
      )}

      <dl>
        <dt>Submitter</dt><dd>{entry.submitter.name}</dd>
        <dt>Email</dt><dd>{entry.submitter.email ?? 'Erased'}</dd>
        <dt>Affiliation</dt><dd>{entry.submitter.affiliation ?? 'Not given'}</dd>
        <dt>Project</dt><dd>{entry.projectId === null ? 'General choice (no Project chosen)' : entry.projectName ?? entry.projectId}</dd>
        <dt>Received</dt><dd>{entry.receiptTime}</dd>
        <dt>Referenced page</dt><dd>{entry.pageRef ?? 'None'}</dd>
      </dl>

      {target !== null && (
        <Notice tone={target.overdue ? 'warning' : 'neutral'} title={`Response target: received ${target.receivedOn}, due ${target.dueOn}${target.overdue ? ' — overdue' : ''}`} />
      )}

      <section className="rf-section" aria-label="Submitted text">
        <h2>Submitted text</h2>
        <p>{entry.text}</p>
      </section>

      <section className="rf-section" aria-label="Files">
        <h2>Files</h2>
        {entry.files.length === 0 ? <p className="rf-meta">No files were submitted.</p> : <ul className="rf-list">{entry.files.map((file) => <SubmissionFile key={file.id} file={file} />)}</ul>}
      </section>

      {applied !== null
        ? <AppliedNotice result={applied} />
        : canDecide && entry.state === 'queued' && (
          <section className="rf-section" aria-label="Record a decision">
            <h2>Record a decision</h2>
            <SelectField label="Decision" value={choice} placeholder="Choose a decision" options={decisionOptions(entry.type)} onChange={setChoice} />
            {choice !== '' && formData !== undefined && (
              <DecisionForm submissionId={entry.id} choice={choice as DecisionChoice} isRemoval={isRemoval}
                generalChoice={entry.projectId === null} submissionProject={entry.projectId} projects={projects.data?.projects ?? []}
                data={formData} onApplied={(result) => { setApplied(result); setChoice(''); }} />
            )}
          </section>
        )}
      {applied === null && canDecide && entry.state !== 'queued' && <Notice tone="neutral" title={`This submission is ${stateName(entry.state).toLowerCase()}; no further decision can be recorded.`} />}

      <ContactManagement entry={entry} onDone={reload} />
    </article>
  );
}
