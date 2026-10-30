import { useState } from 'react';
import { Link } from 'react-router';
import { QUESTION_STATE_NAMES, QUESTION_STATES } from '@researchforce/domain/work';
import type { QuestionState } from '@researchforce/domain/work';
import { useApi } from '../../api';
import { useSession } from '../../session';
import type { ItemView } from '../../types';
import { Button, formatDate, LoadState, SaveFailure, SelectField, TextField, useLoad } from '../../ui';
import { parseIds } from '../../work/model';
import type { AssessmentVersion, AssessmentView } from '../../work/model';

function Evidence({ version }: { readonly version: AssessmentVersion }) {
  if (version.evidence.length === 0) return <p className="rf-meta">No evidence you can read.</p>;
  return (
    <ul className="rf-list">
      {version.evidence.map((entry) => (
        <li key={entry.targetId}>
          <Link to={`/items/${entry.targetId}`}>{entry.title}</Link>{` (${entry.targetKind.replaceAll('_', ' ')}, revision ${entry.targetRev})`}
          {entry.changedSince && <span className="rf-status rf-status--warning">{' Changed since this assessment'}</span>}
        </li>
      ))}
    </ul>
  );
}

function RecordForm({ question, view, onSaved }: { readonly question: ItemView; readonly view: AssessmentView; readonly onSaved: () => void }) {
  const client = useApi();
  const [state, setState] = useState<QuestionState>(view.state);
  const [assessment, setAssessment] = useState(view.current?.assessment?.text ?? '');
  const [evidence, setEvidence] = useState(view.current?.evidence.map((entry) => entry.targetId).join(' ') ?? '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(undefined);
  const save = async () => {
    const changedText = assessment !== (view.current?.assessment?.text ?? '');
    const ids = parseIds(evidence);
    const changedEvidence = ids.join(' ') !== (view.current?.evidence.map((entry) => entry.targetId).join(' ') ?? '');
    try {
      await client.post(`/questions/${question.id}/assessment`, {
        rev: question.rev, state, ...(changedText ? { assessment: { text: assessment, spans: [] } } : {}), ...(changedEvidence ? { evidence: ids.map((targetId) => ({ targetId })) } : {}),
        ...(reason === '' ? {} : { reason }),
      });
      setError(undefined); setReason('');
      onSaved();
    } catch (failure) { setError(failure); }
  };
  return (
    <section aria-label="Record an assessment">
      <h3>Record an assessment</h3>
      <SelectField label="Investigation state" value={state} options={QUESTION_STATES.map((value) => ({ value, label: QUESTION_STATE_NAMES[value] }))} onChange={(value) => setState(value as QuestionState)} />
      <TextField label="Assessment" hint="Your current answer, and how sure you are." value={assessment} onChange={setAssessment} multiline />
      <TextField label="Supporting evidence" hint="Identifiers of Findings, Runs, Sources or Decision Records, separated by spaces." value={evidence} onChange={setEvidence} />
      <TextField label="Reason" hint="Needed to park the Question or to reopen an answered one." value={reason} onChange={setReason} multiline />
      <div className="rf-actions"><Button variant="primary" onClick={() => { void save(); }}>Record this assessment</Button></div>
      <SaveFailure error={error} />
    </section>
  );
}

/** A Research_Question's investigation state, current assessment and evidence, and every earlier assessment (R50.9, R50.10). */
export function AssessmentPanel({ item, onChanged }: { readonly item: ItemView; readonly onChanged?: () => void }) {
  const session = useSession();
  const loaded = useLoad<{ assessment: AssessmentView }>(`/questions/${item.id}/assessment`);
  if (!loaded.data) return <LoadState error={loaded.error} />;
  const view = loaded.data.assessment;
  const saved = () => { loaded.reload(); onChanged?.(); };
  return (
    <section className="rf-section" aria-label="Assessment">
      <h2>Assessment</h2>
      <p>{`Investigation state: ${QUESTION_STATE_NAMES[view.state]}`}</p>
      {view.current === null ? <p className="rf-meta">No assessment has been recorded.</p> : (
        <>
          {view.current.assessment !== undefined && <p>{view.current.assessment.text}</p>}
          {view.current.reason !== null && <p className="rf-meta">{`Reason: ${view.current.reason}`}</p>}
          <Evidence version={view.current} />
        </>
      )}
      {view.history.length > 1 && (
        <section aria-label="Earlier assessments">
          <h3>Earlier assessments</h3>
          <ol className="rf-list">
            {view.history.slice(0, -1).reverse().map((version) => (
              <li key={version.version}>
                {`Version ${version.version}, ${QUESTION_STATE_NAMES[version.state]}, ${formatDate(version.recordedAt)}`}
                {version.assessment !== undefined && <span>{`: ${version.assessment.text}`}</span>}
              </li>
            ))}
          </ol>
        </section>
      )}
      {session.can('item.edit') && <RecordForm key={view.version} question={item} view={view} onSaved={saved} />}
    </section>
  );
}
