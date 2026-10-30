import { Failure } from './failure';
import { useState } from 'react';
import { Link } from 'react-router';
import { useApi } from '../api';
import { useSession } from '../session';
import type { ItemView } from '../types';
import { Button, formatDate, Notice, SelectField, TextField, useLoad } from '../ui';
import { DIFFERENCE_KINDS } from './model';
import type { ReproductionView } from './model';

const OUTCOMES = [{ value: 'reproduced', label: 'Reproduced' }, { value: 'not_reproduced', label: 'Not reproduced' }, { value: 'inconclusive', label: 'Inconclusive' }];
const KINDS = DIFFERENCE_KINDS.map((kind) => ({ value: kind, label: kind[0]!.toUpperCase() + kind.slice(1) }));
interface DifferenceDraft { kind: string; name: string; original: string; attempt: string }

function ReproductionForm({ item, version, onSaved }: { readonly item: ItemView; readonly version: number; readonly onSaved: () => void }) {
  const client = useApi();
  const [identifier, setIdentifier] = useState('');
  const [outcome, setOutcome] = useState('reproduced');
  const [note, setNote] = useState('');
  const [evidence, setEvidence] = useState('');
  const [differences, setDifferences] = useState<DifferenceDraft[]>([]);
  const [error, setError] = useState<unknown>(undefined);
  const send = async () => {
    try {
      const attempt = await client.get<{ item: ItemView }>(`/items/${identifier.trim()}`);
      const ids = [];
      for (const line of evidence.split('\n').map((part) => part.trim()).filter((part) => part !== '')) ids.push((await client.get<{ item: ItemView }>(`/items/${line}`)).item.id);
      await client.post(`/runs/${item.id}/reproductions`, {
        packageVersion: version, attemptRunId: attempt.item.id, outcome, differences: differences.filter((row) => row.name.trim() !== ''), evidence: ids, ...(note.trim() === '' ? {} : { note: note.trim() }),
      });
      setError(undefined); setIdentifier(''); setNote(''); setEvidence(''); setDifferences([]);
      onSaved();
    } catch (failure) { setError(failure); }
  };
  return (
    <section aria-label="Record an independent attempt">
      <h3>Record an independent attempt</h3>
      <p className="rf-meta">Your attempt is its own Run, and it does not change this one. You cannot record an attempt if you wrote this package or own this Run.</p>
      <TextField label="Identifier of your attempt Run" value={identifier} onChange={setIdentifier} />
      <SelectField label="Outcome" value={outcome} options={OUTCOMES} onChange={setOutcome} />
      {differences.map((row, index) => (
        <fieldset key={index} className="rf-fieldset">
          <legend>{`Difference ${index + 1}`}</legend>
          <SelectField label={`Kind of difference ${index + 1}`} value={row.kind} options={KINDS} onChange={(kind) => setDifferences(differences.map((entry, at) => (at === index ? { ...entry, kind } : entry)))} />
          <TextField label={`What differed ${index + 1}`} value={row.name} onChange={(name) => setDifferences(differences.map((entry, at) => (at === index ? { ...entry, name } : entry)))} />
          <TextField label={`In the original ${index + 1}`} value={row.original} onChange={(original) => setDifferences(differences.map((entry, at) => (at === index ? { ...entry, original } : entry)))} />
          <TextField label={`In your attempt ${index + 1}`} value={row.attempt} onChange={(attempt) => setDifferences(differences.map((entry, at) => (at === index ? { ...entry, attempt } : entry)))} />
          <div className="rf-actions"><Button variant="quiet" label={`Remove difference ${index + 1}`} onClick={() => setDifferences(differences.filter((_, at) => at !== index))}>Remove</Button></div>
        </fieldset>
      ))}
      <div className="rf-actions"><Button onClick={() => setDifferences([...differences, { kind: 'environment', name: '', original: '', attempt: '' }])}>Add a difference</Button></div>
      <TextField label="Evidence" hint="The identifiers of records you rely on, one per line." value={evidence} onChange={setEvidence} multiline />
      <TextField label="Note" value={note} onChange={setNote} multiline maxLength={2000} />
      <div className="rf-actions"><Button variant="primary" onClick={() => { void send(); }}>Record this attempt</Button></div>
      <Failure error={error} />
    </section>
  );
}

/** Independent attempts to repeat the Run: each is its own attributed Run, and none replaces the first Run or another Member's conclusion (R56.5). */
export function ReproductionSection({ item, version, onChanged }: { readonly item: ItemView; readonly version: number; readonly onChanged: () => void }) {
  const session = useSession();
  const loaded = useLoad<{ reproductions: ReproductionView[] }>(`/runs/${item.id}/reproductions`);
  const saved = () => { loaded.reload(); onChanged(); };
  const mine = loaded.data?.reproductions ?? [];
  return (
    <section aria-label="Independent reproductions">
      <h3>Independent reproductions</h3>
      <Notice title="Attempts you cannot read are not listed, but they still count toward the package’s state." />
      {loaded.data !== undefined && mine.length === 0 && <p>No independent attempt is listed.</p>}
      {mine.length > 0 && (
        <ol className="rf-list" aria-label="Attempts">
          {mine.map((attempt) => (
            <li key={attempt.id}>
              <strong>{attempt.outcomeName}</strong>{` by ${attempt.recordedByName ?? 'a Member without a display name'} on ${formatDate(attempt.recordedAt)}, for package version ${attempt.packageVersion}: `}
              <Link to={`/items/${attempt.attemptRunId}`}>{attempt.attemptRunIdentifier}</Link>
              {attempt.note !== null && <p>{attempt.note}</p>}
              {attempt.differences.length > 0 && (
                <ul className="rf-list" aria-label="Differences">{attempt.differences.map((row, index) => <li key={index}>{`${row.kind}: ${row.name} — original ${row.original}; attempt ${row.attempt}`}</li>)}</ul>
              )}
              {attempt.evidence.length > 0 && <p className="rf-meta">{'Evidence: '}{attempt.evidence.map((id, index) => <span key={id}>{index > 0 && ', '}<Link to={`/items/${id}`}>{id}</Link></span>)}</p>}
            </li>
          ))}
        </ol>
      )}
      {session.can('item.edit') && <ReproductionForm item={item} version={version} onSaved={saved} />}
    </section>
  );
}
