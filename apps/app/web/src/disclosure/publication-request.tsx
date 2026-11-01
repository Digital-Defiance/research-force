import { useState } from 'react';
import { Link } from 'react-router';
import type { RichText } from '@researchforce/domain/richtext';
import { ApiFailure, useApi } from '../api';
import type { MemberRow, PublicationRequestView } from '../types';
import type { DisclosureGateFailure, DisclosurePreviewView } from '../types';
import { Button, formatDate, levelName, LoadState, Notice, PersonLink, SaveFailure, SelectField, TextField, useLoad } from '../ui';
import { changeUnitBody, PreviewSummary, presentationName } from './disclosure';
import type { UnitChange } from './disclosure';
import { disclosureLineBody, DisclosureLineFields, emptyDisclosureLine } from './line';
import type { DisclosureLineValue } from './line';
import { PublicSummaryEditor } from './public-summary';

const LEVEL_OPTIONS = [
  { value: 'not_published', label: 'Not published' },
  { value: 'withheld', label: 'Withheld' },
  { value: 'public', label: 'Public' },
];
const PRESENTATION_OPTIONS = [
  { value: 'summary_only', label: 'Summary only' },
  { value: 'full_content', label: 'Full content' },
];

const isRich = (value: unknown): value is RichText => typeof value === 'object' && value !== null && 'text' in value;

/**
 * An Administrator reviews a Publication_Request from the review queue: the change is pre-filled from the request's
 * proposed values, previewed through the ordinary disclosure preview, and either applied with the preview token or
 * declined with a note; the Administrator may edit each proposed value before previewing (R23.11, R23.12). The apply
 * runs the same preview and gates as a direct change, so an Owner-consent refusal leaves the request Needs_Review.
 */
export function PublicationRequestScreen({ id, members }: { readonly id: string; readonly members: readonly MemberRow[] }) {
  const loaded = useLoad<{ request: PublicationRequestView }>(`/reviews/publication-requests/${id}`);
  if (loaded.data === undefined) return <LoadState error={loaded.error} />;
  return <PublicationRequestForm key={loaded.data.request.id} request={loaded.data.request} members={members} onDone={loaded.reload} />;
}

function PublicationRequestForm({ request, members, onDone }: { readonly request: PublicationRequestView; readonly members: readonly MemberRow[]; readonly onDone: () => void }) {
  const client = useApi();
  const proposed = request.proposed;
  const [level, setLevel] = useState(proposed.level);
  const [presentation, setPresentation] = useState(proposed.presentation ?? 'summary_only');
  const [summary, setSummary] = useState<RichText | undefined>(isRich(proposed.publicSummary) ? proposed.publicSummary : undefined);
  const [line, setLine] = useState<DisclosureLineValue>(emptyDisclosureLine);
  const [preview, setPreview] = useState<DisclosurePreviewView | undefined>(undefined);
  const [note, setNote] = useState('');
  const [failure, setFailure] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<'applied' | 'declined' | undefined>(undefined);

  const run = async (step: () => Promise<void>) => {
    setBusy(true);
    setFailure(undefined);
    try { await step(); } catch (error) { setFailure(error); } finally { setBusy(false); }
  };

  const change: UnitChange = {
    key: request.target.key,
    level,
    ...(level === 'public' ? { presentation } : {}),
    ...(level === 'public' && summary !== undefined ? { publicSummary: summary } : {}),
    ...(level === 'withheld' ? { disclosureLine: disclosureLineBody(line) } : {}),
  };
  const edit = () => { setPreview(undefined); setOutcome(undefined); };

  const check = () => run(async () => { setPreview(await client.post<DisclosurePreviewView>('/disclosure/preview', { units: [changeUnitBody(change)] })); });
  const apply = (token: string) => run(async () => {
    await client.post(`/reviews/publication-requests/${request.id}/apply`, { token });
    setOutcome('applied');
    onDone();
  });
  const decline = () => run(async () => {
    await client.post(`/reviews/publication-requests/${request.id}/decline`, { note });
    setOutcome('declined');
    onDone();
  });

  const noteErrors = failure instanceof ApiFailure ? failure.issuesFor('note') : [];
  const canApply = preview !== undefined && preview.failures.length === 0 && preview.token !== null;
  const gateFailures: readonly DisclosureGateFailure[] = preview?.failures ?? [];

  if (outcome !== undefined || request.state === 'reviewed') {
    return (
      <div className="rf-stack">
        <h1>Publication request</h1>
        <Notice tone={outcome === 'declined' ? 'neutral' : 'success'} title={outcome === 'declined' ? 'The Publication Request was declined.' : outcome === 'applied' ? 'The Publication Request was applied.' : 'This Publication Request is already reviewed.'} />
      </div>
    );
  }

  return (
    <div className="rf-stack">
      <h1>Publication request</h1>
      <p className="rf-meta">
        {'Proposed by '}<PersonLink person={request.proposer} />{` on ${formatDate(request.createdAt)} for `}
        <Link to={`/items/${request.target.id}`}>{`${request.target.identifier ?? ''}${request.target.title === null ? '' : `: ${request.target.title}`}`.trim() || 'a Disclosure Unit'}</Link>
      </p>
      {request.note !== null && request.note.trim() !== '' && <p>{request.note}</p>}
      <section className="rf-section" aria-label="Proposed values">
        <h2>Proposed values</h2>
        <ul className="rf-list">
          <li>{`Disclosure level: ${levelName(proposed.level)}`}</li>
          {proposed.presentation !== undefined && <li>{`Public presentation: ${presentationName(proposed.presentation)}`}</li>}
          {isRich(proposed.publicSummary) && proposed.publicSummary.text.trim() !== '' && <li>{`Public summary: ${proposed.publicSummary.text}`}</li>}
          {proposed.disclosureLine !== undefined && <li>Disclosure line proposed</li>}
        </ul>
      </section>

      <SaveFailure error={noteErrors.length > 0 ? undefined : failure} />

      <section className="rf-section" aria-label="Edit before applying">
        <h2>Apply, editing the values if needed</h2>
        <SelectField label="Disclosure level" value={level} options={LEVEL_OPTIONS} onChange={(next) => { setLevel(next); edit(); }} />
        {level === 'public' && <SelectField label="Public presentation" value={presentation} options={PRESENTATION_OPTIONS} onChange={(next) => { setPresentation(next); edit(); }} />}
        {level === 'public' && (
          <PublicSummaryEditor value={summary} {...(isRich(proposed.publicSummary) ? { proposed: proposed.publicSummary } : {})} members={members}
            onChange={(next) => { setSummary(next); edit(); }} />
        )}
        {level === 'withheld' && <DisclosureLineFields value={line} onChange={(next) => { setLine(next); edit(); }} />}
      </section>

      {preview !== undefined && (
        <>
          {gateFailures.length === 0
            ? <Notice tone="success" title="This change can be applied." />
            : <Notice tone="warning" title="This change cannot be applied yet, so none of it is applied.">
                <ul className="rf-list">{gateFailures.map((f, index) => <li key={index}>{f.message}</li>)}</ul>
              </Notice>}
          <PreviewSummary diff={preview.diff} members={members} />
        </>
      )}

      <div className="rf-actions">
        <Button onClick={() => void check()} disabled={busy}>Check what this changes</Button>
        {canApply && <Button variant="primary" onClick={() => apply(preview!.token!)} disabled={busy}>Apply the request</Button>}
      </div>

      <section className="rf-section" aria-label="Decline this request">
        <h2>Decline</h2>
        <TextField label="Why the request is declined" multiline value={note} onChange={setNote} maxLength={2000} required
          hint="1 to 2,000 characters; the disclosure values are left unchanged." errors={noteErrors} />
        <div className="rf-actions"><Button variant="danger" onClick={() => void decline()} disabled={busy || note.trim() === ''}>Decline the request</Button></div>
      </section>
    </div>
  );
}
