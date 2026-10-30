import { useState } from 'react';
import { Link } from 'react-router';
import { API_BASE, useApi } from '../api';
import { useSession } from '../session';
import type { ItemView } from '../types';
import { Button, Notice, SaveFailure, SelectField, TextField, formatDate, useLoad } from '../ui';
import { compareTexts, endpointLabel, flaggedText, REVIEW_CHOICES, reviewStateName } from './model';
import type { DerivationPage, DerivationRow, EndpointRow } from './model';

function Endpoint({ endpoint }: { readonly endpoint: EndpointRow }) {
  return (
    <li>
      <Link to={`/items/${endpoint.rootId}`}>{endpointLabel(endpoint)}</Link>
      <span className="rf-meta">{` (${endpoint.type === 'attachment' ? 'file' : 'text'}, content ${endpoint.sha256.slice(0, 12)}…)`}</span>
      {endpoint.revisedSince && <span className="rf-status rf-status--warning">{' Edited since this was derived'}</span>}
    </li>
  );
}

function Comparison({ earlier, later }: { readonly earlier: string; readonly later: string }) {
  return (
    <p aria-label="Corrected text compared with the earlier text" className="rf-compare">
      {compareTexts(earlier, later).map((piece, index) => piece.kind === 'same' ? <span key={index}>{piece.text}</span>
        : piece.kind === 'removed' ? <del key={index}>{piece.text}</del> : <ins key={index}>{piece.text}</ins>)}
    </p>
  );
}

function ReviewForm({ derivation, onSaved }: { readonly derivation: DerivationRow; readonly onSaved: () => void }) {
  const client = useApi();
  const [state, setState] = useState('reviewed');
  const [note, setNote] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const save = async () => {
    const passages: { start: number; end: number }[] = [];
    if (start.trim() !== '' || end.trim() !== '') {
      if (!/^\d+$/u.test(start.trim()) || !/^\d+$/u.test(end.trim())) { setProblem('Enter where the uncertain passage starts and ends as whole numbers.'); return; }
      passages.push({ start: Number(start), end: Number(end) });
    }
    setProblem(undefined);
    try {
      await client.post(`/derivations/${derivation.id}/review`, { state, ...(note.trim() === '' ? {} : { note: note.trim() }), passages });
      setError(undefined); setNote(''); setStart(''); setEnd('');
      onSaved();
    } catch (failure) { setError(failure); }
  };
  return (
    <section aria-label={`Review ${derivation.kindName} ${derivation.id}`}>
      <h4>Your review</h4>
      <SelectField label="Your judgement" value={state} options={REVIEW_CHOICES} onChange={setState} />
      <TextField label="Note" hint="Optional. Say what you checked or what is wrong." value={note} onChange={setNote} multiline />
      {derivation.text !== null && (
        <>
          <TextField label="Uncertain passage starts at" hint="Optional, in UTF-16 code units of the text above." value={start} onChange={setStart} />
          <TextField label="Uncertain passage ends at" value={end} onChange={setEnd} />
        </>
      )}
      {problem !== undefined && <p className="rf-field__error" role="alert">{problem}</p>}
      <div className="rf-actions"><Button variant="primary" onClick={() => { void save(); }}>Record my review</Button></div>
      <SaveFailure error={error} />
    </section>
  );
}

function Made({ derivation, earlier, onChanged }: { readonly derivation: DerivationRow; readonly earlier: DerivationRow | undefined; readonly onChanged: () => void }) {
  const session = useSession();
  const mine = session.me.member.id;
  const canReview = session.can('derivation.review') && derivation.createdBy !== mine && derivation.correctedBy === null;
  return (
    <li className="rf-stack">
      <p>
        <strong>{derivation.kindName}</strong>{' of '}<Link to={`/items/${derivation.output.rootId}`}>{endpointLabel(derivation.output)}</Link>
        <span className="rf-meta">{` — ${derivation.createdByName ?? 'A Member'}, ${formatDate(derivation.createdAt)}`}</span>
        <span className={`rf-status${derivation.reviewState === 'disputed' ? ' rf-status--warning' : ''}`}>{` ${reviewStateName(derivation.reviewState)}`}</span>
        {derivation.correctedBy !== null && <span className="rf-status">{' Corrected by a later version'}</span>}
      </p>
      <p className="rf-meta">{`Method: ${derivation.method}${derivation.methodVersion === null ? '' : ` ${derivation.methodVersion}`}${derivation.language === null ? '' : `; language ${derivation.language}`}`}</p>
      <p>Made from the originals:</p>
      <ul className="rf-list">{derivation.inputs.map((input) => <Endpoint key={`${input.unitId}#${input.field ?? ''}`} endpoint={input} />)}</ul>
      {derivation.uncertainty !== null && <Notice tone="warning" title="Uncertainty">{derivation.uncertainty}</Notice>}
      {derivation.text !== null && <blockquote lang={derivation.language ?? undefined}>{derivation.text}</blockquote>}
      {earlier?.text != null && derivation.text !== null && <Comparison earlier={earlier.text} later={derivation.text} />}
      {derivation.reviews.length === 0 ? <p className="rf-meta">No independent review yet.</p> : (
        <ul className="rf-list" aria-label="Independent reviews">{derivation.reviews.map((review) => (
          <li key={review.reviewerId}>
            {`${review.reviewerName ?? 'A Member'}: ${review.state === 'reviewed' ? 'reviewed' : 'disputed'}${review.note === null ? '' : ` — ${review.note}`}`}
            {review.passages.length > 0 && (
              <ul className="rf-list">{review.passages.map((passage) => (
                <li key={`${passage.start}-${passage.end}`}>{`Uncertain: “${flaggedText(derivation.text, passage) ?? `characters ${passage.start} to ${passage.end}`}”${passage.note === null ? '' : ` — ${passage.note}`}`}</li>
              ))}</ul>
            )}
          </li>
        ))}</ul>
      )}
      {canReview && <ReviewForm derivation={derivation} onSaved={onChanged} />}
    </li>
  );
}

/**
 * How the artifacts of a record were made and what they were made from, with the originals, method, uncertainty and independent reviews, and a
 * comparison of a corrected text with the one it corrects. Only derivations whose ends the Member can read are here, and nothing says that
 * another exists (R55.3, R55.4). The export keeps the graph, text and reviews exactly (R55.5).
 */
export function ProvenancePanel({ item }: { readonly item: ItemView }) {
  const made = useLoad<DerivationPage>(`/derivations?outputRootId=${item.id}`);
  const used = useLoad<DerivationPage>(`/derivations?inputRootId=${item.id}`);
  const rows = made.data?.derivations ?? [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const active = rows.filter((row) => row.correctedBy === null);
  const history = rows.filter((row) => row.correctedBy !== null);
  const reload = () => { made.reload(); used.reload(); };
  const derived = (used.data?.derivations ?? []).filter((row) => row.output.rootId !== item.id);
  return (
    <section className="rf-section" aria-label="Provenance">
      <h2>Provenance</h2>
      {active.length === 0 ? <p className="rf-meta">Nothing on this record is recorded as made from another artifact you can read.</p>
        : <ul className="rf-list">{active.map((row) => <Made key={row.id} derivation={row} earlier={row.correctsId === null ? undefined : byId.get(row.correctsId)} onChanged={reload} />)}</ul>}
      {history.length > 0 && (
        <section aria-label="Earlier versions that were corrected">
          <h3>Earlier versions that were corrected</h3>
          <p className="rf-meta">These stay as they were, with their method and reviews.</p>
          <ul className="rf-list">{history.map((row) => <Made key={row.id} derivation={row} earlier={undefined} onChanged={reload} />)}</ul>
        </section>
      )}
      <section aria-label="Made from this record">
        <h3>Made from this record</h3>
        {derived.length === 0 ? <p className="rf-meta">No artifact you can read was made from this record.</p> : (
          <ul className="rf-list">{derived.map((row) => (
            <li key={row.id}><Link to={`/items/${row.output.rootId}`}>{endpointLabel(row.output)}</Link>{` — ${row.kindName}, ${row.method}`}</li>
          ))}</ul>
        )}
      </section>
      <p className="rf-actions"><a href={`${API_BASE}/derivations/export?rootId=${item.id}`}>Download this record’s derivations (JSON)</a></p>
    </section>
  );
}
