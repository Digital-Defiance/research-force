import { useState } from 'react';
import { ApiFailure, useApi } from '../api';
import { useSession } from '../session';
import type { PartyRecord } from '../types';
import { Button, Notice, SelectField, TextField } from '../ui';
import type { Option } from '../ui';
import { disclosureLineBody, DisclosureLineFields, emptyDisclosureLine } from '../disclosure/line';
import type { DisclosureLineValue } from '../disclosure/line';
import { PublicSummaryEditor } from '../disclosure/public-summary';
import { SnapshotPreview } from './snapshot';
import { CONSENT_LIMITS, proposedUnitBody } from './model';
import type { ConsentCheckFailure, ConsentKind, ConsentPreview, ProposedUnit } from './model';
import type { RichText } from '@researchforce/domain/richtext';

const KIND_OPTIONS: Option[] = [
  { value: 'publication', label: 'Publication consent (Correspondences)' },
  { value: 'rights', label: 'Rights permission (Sources and Attachments)' },
];
const LEVEL_OPTIONS: Option[] = [
  { value: 'not_published', label: 'Not published' },
  { value: 'withheld', label: 'Withheld' },
  { value: 'public', label: 'Public' },
];
const PRESENTATION_OPTIONS: Option[] = [
  { value: 'summary_only', label: 'Summary only' },
  { value: 'full_content', label: 'Full content' },
];

/** One named element the Administrator is composing, with the Disclosure_Level and the Public values proposed for it. */
interface UnitDraft {
  readonly key: string;
  /** A human label for the element, shown beside its fields; the page that launches the dialog supplies it. */
  readonly label: string;
  readonly level: string;
  readonly presentation: string;
  readonly summary: RichText | undefined;
  readonly line: DisclosureLineValue;
}

/** The element a page prefills, or offers to add: its unit key and a readable label (the Item's identifier and title, or the file name). */
export interface ConsentElement { readonly key: string; readonly label: string }

function emptyDraft(element: ConsentElement): UnitDraft {
  return { key: element.key, label: element.label, level: 'withheld', presentation: 'summary_only', summary: undefined, line: emptyDisclosureLine };
}

/** The `units` body for one draft, carrying only the fields the chosen Disclosure_Level needs (R51.2). */
function draftUnit(draft: UnitDraft): ProposedUnit {
  return {
    key: draft.key,
    level: draft.level,
    ...(draft.level === 'public' ? { presentation: draft.presentation } : {}),
    ...(draft.level === 'public' && draft.summary !== undefined ? { publicSummary: draft.summary } : {}),
    ...(draft.level === 'withheld' ? { disclosureLine: disclosureLineBody(draft.line) } : {}),
  };
}

/** The R51.3 gate-failure reasons a `rule` error carries, when the preview or send refuses (R51.3). */
function checkFailures(error: unknown): readonly ConsentCheckFailure[] {
  if (!(error instanceof ApiFailure)) return [];
  const details = error.details as { rule?: string; failures?: readonly ConsentCheckFailure[] } | undefined;
  return details?.rule === 'consent_checks' && Array.isArray(details.failures) ? details.failures : [];
}

/** The fields for one named element's proposed values (R51.2). A rights request names only the Disclosure_Level. */
function UnitFields({ draft, kind, members, onChange }: {
  readonly draft: UnitDraft;
  readonly kind: ConsentKind;
  readonly members: PartyMembers;
  readonly onChange: (next: UnitDraft) => void;
}) {
  return (
    <fieldset className="rf-field" aria-label={`Proposed values for ${draft.label}`}>
      <legend className="rf-field__label">{draft.label}</legend>
      <SelectField label="Disclosure level" value={draft.level} options={LEVEL_OPTIONS} onChange={(level) => onChange({ ...draft, level })} />
      {kind === 'publication' && draft.level === 'public' && (
        <SelectField label="Public presentation" value={draft.presentation} options={PRESENTATION_OPTIONS} onChange={(presentation) => onChange({ ...draft, presentation })} />
      )}
      {kind === 'publication' && draft.level === 'public' && (
        <PublicSummaryEditor value={draft.summary} members={members} onChange={(summary) => onChange({ ...draft, summary })} />
      )}
      {draft.level === 'withheld' && <DisclosureLineFields value={draft.line} onChange={(line) => onChange({ ...draft, line })} />}
    </fieldset>
  );
}

type PartyMembers = Parameters<typeof PublicSummaryEditor>[0]['members'];

/**
 * The Consent_Request dialog, launchable from a Correspondence, Source, Attachment, or External_Party page
 * (R51.2). The Administrator chooses the External_Party (prefilled when the launch is from a Party page), the
 * kind, the named elements with their proposed values, and an optional message; previews the exact email text
 * and the Consent_Page snapshots; and, after confirming, sends. The checks of R51.3 are surfaced as named
 * reasons both on the preview and on the send. Only an Administrator with `consent.request` sees the dialog.
 */
export function ConsentRequestDialog({ party, parties, elements, candidates = [], kind: fixedKind, members, onSent, onCancel }: {
  /** The External_Party the request is for, when the launch prefills it (from a Party page). */
  readonly party?: PartyRecord;
  /** Every External_Party, so a launch without a prefilled Party can choose one. */
  readonly parties: readonly PartyRecord[];
  /** The elements the launch prefills (the Correspondence, Source, or Attachment the page is for), each with a label. */
  readonly elements: readonly ConsentElement[];
  /** Elements the Administrator may add to the request when the launch does not fix them (an External_Party page). */
  readonly candidates?: readonly ConsentElement[];
  /** Fixes the kind when the launching element decides it (an Attachment page always asks for rights). */
  readonly kind?: ConsentKind;
  readonly members: PartyMembers;
  readonly onSent: (id: string) => void;
  readonly onCancel: () => void;
}) {
  const client = useApi();
  const session = useSession();
  const [partyId, setPartyId] = useState(party?.id ?? '');
  const [kind, setKind] = useState<ConsentKind>(fixedKind ?? 'publication');
  const [drafts, setDrafts] = useState<readonly UnitDraft[]>(elements.map(emptyDraft));
  const [message, setMessage] = useState('');
  const [preview, setPreview] = useState<ConsentPreview | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const [sentId, setSentId] = useState<string | undefined>(undefined);

  if (!session.can('consent.request')) return null;

  const run = async (step: () => Promise<void>) => {
    setBusy(true);
    setFailure(undefined);
    try { await step(); } catch (error) { setFailure(error); } finally { setBusy(false); }
  };

  const body = () => ({
    partyId,
    kind,
    units: drafts.map((draft) => proposedUnitBody(draftUnit(draft))),
    ...(message.trim() === '' ? {} : { message }),
  });

  /** Editing anything after a preview invalidates it, so the Administrator previews again before sending (R51.2). */
  const invalidate = () => setPreview(undefined);

  const check = () => run(async () => {
    setPreview(await client.post<ConsentPreview>('/consent-requests/preview', body()));
  });
  const confirm = () => run(async () => {
    const result = await client.post<{ id: string }>('/consent-requests', { ...body(), token: preview!.token });
    setSentId(result.id);
    onSent(result.id);
  });

  const updateDraft = (index: number, next: UnitDraft) => { setDrafts((old) => old.map((draft, at) => (at === index ? next : draft))); invalidate(); };
  const addElement = (key: string) => {
    const element = candidates.find((candidate) => candidate.key === key);
    if (element === undefined || drafts.some((draft) => draft.key === key)) return;
    setDrafts((old) => [...old, emptyDraft(element)]);
    invalidate();
  };
  const removeElement = (index: number) => { setDrafts((old) => old.filter((_draft, at) => at !== index)); invalidate(); };
  const addable = candidates.filter((candidate) => !drafts.some((draft) => draft.key === candidate.key));
  const failures = checkFailures(failure);
  const fieldErrors = failure instanceof ApiFailure && failures.length === 0 ? failure : undefined;

  if (sentId !== undefined) {
    return (
      <section className="rf-section" role="dialog" aria-label="Consent request sent">
        <h2>Consent request sent</h2>
        <Notice tone="success" title="The Consent Request was sent.">
          <p>The External Party will receive the email you confirmed. You can follow the request’s state from this page and the Consent requests list.</p>
        </Notice>
        <div className="rf-actions"><Button variant="quiet" onClick={onCancel}>Close</Button></div>
      </section>
    );
  }

  return (
    <section className="rf-section" role="dialog" aria-label="Send a Consent Request">
      <h2>Send a Consent Request</h2>
      {fieldErrors !== undefined && <Notice tone="danger" title="The request could not be prepared. Check the values and try again." />}
      {failures.length > 0 && (
        <Notice tone="warning" title="This Consent Request cannot be sent yet:">
          <ul className="rf-list">
            {failures.map((reason, index) => (
              <li key={index}>
                {reason.message}
                {reason.details && reason.details.length > 0 && <ul className="rf-list">{reason.details.map((detail, at) => <li key={at}>{detail}</li>)}</ul>}
              </li>
            ))}
          </ul>
        </Notice>
      )}

      {party === undefined
        ? <SelectField label="External Party" required value={partyId} placeholder="Choose an External Party"
            options={parties.map((candidate) => ({ value: candidate.id, label: candidate.name }))} onChange={(next) => { setPartyId(next); invalidate(); }} />
        : <p className="rf-meta">{`For External Party: ${party.name}`}</p>}

      {fixedKind === undefined
        ? <SelectField label="Kind of request" value={kind} options={KIND_OPTIONS} onChange={(next) => { setKind(next as ConsentKind); invalidate(); }} />
        : <p className="rf-meta">{kind === 'publication' ? 'Asking for consent to publish the named Correspondences.' : 'Asking for permission to use the named documents.'}</p>}

      <section className="rf-section" aria-label="Named elements and proposed values">
        <h3>Named elements and the values proposed for publication</h3>
        {drafts.length === 0 && <p className="rf-meta">Name at least one element to send a Consent Request.</p>}
        {drafts.map((draft, index) => (
          <div className="rf-stack" key={draft.key}>
            <UnitFields draft={draft} kind={kind} members={members} onChange={(next) => updateDraft(index, next)} />
            {candidates.length > 0 && <div className="rf-actions"><Button variant="quiet" onClick={() => removeElement(index)}>{`Remove ${draft.label}`}</Button></div>}
          </div>
        ))}
        {addable.length > 0 && (
          <SelectField label="Add a named element" value="" placeholder="Choose an element to add"
            options={addable.map((candidate) => ({ value: candidate.key, label: candidate.label }))} onChange={addElement} />
        )}
      </section>

      <TextField label="Message to the External Party" multiline value={message} onChange={(next) => { setMessage(next); invalidate(); }}
        maxLength={CONSENT_LIMITS.message} hint={`Optional; at most ${CONSENT_LIMITS.message.toLocaleString('en-GB')} characters.`} />

      {preview !== undefined && (
        <>
          <section className="rf-section" aria-label="Email preview">
            <h3>The email the External Party will receive</h3>
            <p className="rf-meta">{`Subject: ${preview.email.subject}`}</p>
            {preview.email.text.split('\n').map((line, index) => (line.trim() === '' ? <br key={index} /> : <p key={index}>{line}</p>))}
          </section>
          <SnapshotPreview snapshots={preview.snapshots} />
        </>
      )}

      <div className="rf-actions">
        {preview === undefined
          ? <Button variant="primary" onClick={() => void check()} disabled={busy || (party === undefined && partyId === '') || drafts.length === 0}>Preview the email and Consent Page</Button>
          : (
            <>
              <Button variant="primary" onClick={() => void confirm()} disabled={busy}>Confirm and send</Button>
              <Button variant="quiet" onClick={invalidate} disabled={busy}>Edit the request</Button>
            </>
          )}
        <Button variant="quiet" onClick={onCancel} disabled={busy}>Close</Button>
      </div>
    </section>
  );
}
