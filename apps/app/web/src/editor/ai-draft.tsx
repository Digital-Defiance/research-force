import { useEffect, useRef, useState } from 'react';
import { AI_MODEL_VERSION, draftTextHash } from '@researchforce/domain/ai';
import type { DraftField } from '@researchforce/domain/ai';
import { ApiFailure, useApi } from '../api';
import { Button } from '../ui';

/**
 * The AI_Draft control shown next to an AI-draftable field (R44, task 42.4). It offers a "Request an AI draft"
 * control only while `GET /ai/status` is available, posts the field's current unsaved editor text to
 * `POST /ai/drafts`, holds the returned draft in this tab's React state only — never persisted or sent anywhere
 * else — and shows it apart from the field. Accept places the draft into the field (asking before replacing
 * non-empty text) and leaves the field unsaved; placement records the model, version, and SHA-256 of the placed
 * text and surfaces it through `onPlaced` so the surrounding form sends it in the save's `ai` envelope (R44.5,
 * R44.6). Discard, or requesting a new draft, removes the held draft (R44.4, R44.16). The quotation-mark notice
 * shows next to the held draft and, after acceptance, next to the field until the field is saved (R44.8). An
 * error, empty output, or timeout shows the fixed "No AI draft was produced" notice; a late answer to a
 * superseded request is discarded by a request token (R44.12).
 */

/** The fixed "AI drafting is turned off" notice (R44.11, R44.17). */
const TURNED_OFF = 'AI drafting is turned off.';
/** The fixed "AI drafting resumes at 00:00 UTC" notice (R44.10, R44.17). */
const RESUMES_AT_MIDNIGHT = 'AI drafting resumes at 00:00 UTC.';
/** The fixed "No AI draft was produced" notice for an error, empty output, or timeout (R44.12). */
export const NO_DRAFT_NOTICE = 'No AI draft was produced.';
/** The quotation-mark notice shown next to AI text that contains a quotation mark (R44.8). */
export const QUOTATION_NOTICE = 'Quotation marks in AI text are not Quote labels. Check each against the source before saving.';

/** `GET /ai/status`: whether an AI_Draft can be requested right now, and if not, why. */
interface AiStatus { readonly available: boolean; readonly reason?: 'turned_off' | 'resumes_at_utc_midnight' }

/** The `POST /ai/drafts` result the server returns (task 42.1, 42.2); the client only reads these fields. */
type DraftResponse =
  | { readonly draft: null; readonly reason: 'empty_input' | 'no_draft' }
  | { readonly draft: string; readonly truncatedInput: boolean; readonly model: string; readonly quotationNotice: boolean }
  | { readonly kind: string; readonly note: string; readonly truncatedInput: boolean; readonly model: string; readonly quotationNotice: boolean };

/** The draft held in this tab, apart from the field, until it is accepted or discarded (R44.4). */
interface HeldDraft {
  /** The draft text as it would be placed into the field. */
  readonly text: string;
  /** The drafting model id the result reported, recorded with placement for the save provenance (R44.6). */
  readonly model: string;
  /** Whether the draft contains a quotation mark, so the notice shows (R44.8). */
  readonly quotationNotice: boolean;
  /** Whether input was cut to the AI_Input_Limit, so the Member knows the draft summarizes only part (R44.3). */
  readonly truncatedInput: boolean;
}

/** The provenance the control surfaces on placement: the model, its catalog version, and the SHA-256 of the placed text (R44.6). */
export interface PlacedProvenance {
  readonly model: string;
  readonly version: string;
  readonly draftSha256: string;
}

export interface AiDraftControlProps {
  /** The field being drafted; its name is sent to the server and used in the a11y labels. */
  readonly field: DraftField;
  /** The field's human label, shown in the controls and notices. */
  readonly label: string;
  /** The saved Research_Item the draft concerns; while absent (a new, unsaved item) no draft can be requested (R44.1). */
  readonly itemId?: string;
  /** The per-field unsaved editor text to send, keyed by field name; the server prefers it over the saved text (R44.1). */
  readonly editorText: Readonly<Record<string, string>>;
  /** The field's current text, used to decide whether placement needs the replacement confirmation (R44.5). */
  readonly fieldText: string;
  /** Place the draft text into the field; the field stays unsaved (R44.5). */
  readonly onPlace: (text: string) => void;
  /**
   * The provenance to send on the next save for this field, or `undefined` to clear it. Called with the model,
   * version, and SHA-256 of the placed text when a draft is accepted (R44.6).
   */
  readonly onPlaced: (provenance: PlacedProvenance | undefined) => void;
}

/**
 * The placeable text a draft response carries for the control's field, or `undefined` for an empty-input/no-draft
 * result. A Log_Summary or Public_Summary result carries a single `draft`; a Disclosure_Line result carries a
 * `kind` and a `note`, and the control places the one its field targets (R44.2). The quotation notice and the
 * truncated-input flag come from the whole result.
 */
function placeableText(field: DraftField, response: DraftResponse): HeldDraft | undefined {
  if ('draft' in response) {
    return response.draft === null ? undefined : { text: response.draft, model: response.model, quotationNotice: response.quotationNotice, truncatedInput: response.truncatedInput };
  }
  const text = field === 'disclosureNote' ? response.note : response.kind;
  return { text, model: response.model, quotationNotice: response.quotationNotice, truncatedInput: response.truncatedInput };
}

export function AiDraftControl({ field, label, itemId, editorText, fieldText, onPlace, onPlaced }: AiDraftControlProps) {
  const client = useApi();
  const [status, setStatus] = useState<AiStatus | 'loading' | 'error'>('loading');
  const [held, setHeld] = useState<HeldDraft | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [placed, setPlaced] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  // A request token: only the answer to the latest request is acted on; a late answer to a superseded request is
  // discarded so a stale draft never lands (R44.12, R44.16).
  const sequence = useRef(0);

  useEffect(() => {
    if (itemId === undefined) return undefined;
    let current = true;
    client.get<AiStatus>('/ai/status').then(
      (result) => { if (current) setStatus(result); },
      () => { if (current) setStatus('error'); },
    );
    return () => { current = false; };
  }, [client, itemId]);

  // Requesting a new draft removes the one already held before the new answer arrives (R44.16).
  const request = async () => {
    const token = (sequence.current += 1);
    setHeld(null);
    setMessage(null);
    setConfirming(false);
    setPending(true);
    try {
      const response = await client.post<DraftResponse>('/ai/drafts', { field, itemId, editor: editorText });
      if (token !== sequence.current) return; // A superseded request's answer is discarded (R44.12).
      const draft = placeableText(field, response);
      if (draft === undefined) { setMessage(NO_DRAFT_NOTICE); return; }
      setHeld(draft);
    } catch (error) {
      if (token !== sequence.current) return;
      // An error, timeout, or the off/exhausted refusal all show the fixed notice; an off/exhausted refusal also
      // re-reads status so the request control hides (R44.12, R44.17).
      if (error instanceof ApiFailure && error.code === 'unavailable') {
        const reason = (error.details as { reason?: AiStatus['reason'] } | undefined)?.reason;
        setStatus({ available: false, ...(reason === undefined ? {} : { reason }) });
      }
      setMessage(NO_DRAFT_NOTICE);
    } finally {
      if (token === sequence.current) setPending(false);
    }
  };

  // Accept: place the draft into the field (asking first when the field is non-empty), leave it unsaved, and record
  // the provenance so the form's save carries it (R44.5, R44.6).
  const place = (draft: HeldDraft) => {
    sequence.current += 1; // Any outstanding request's answer is now stale.
    onPlace(draft.text);
    onPlaced({ model: draft.model, version: AI_MODEL_VERSION, draftSha256: draftTextHash(draft.text) });
    setPlaced(draft.quotationNotice);
    setHeld(null);
    setMessage(null);
    setConfirming(false);
    setPending(false);
  };
  const accept = () => {
    if (held === null) return;
    if (fieldText.trim() !== '') { setConfirming(true); return; }
    place(held);
  };
  const discard = () => {
    sequence.current += 1;
    setHeld(null);
    setMessage(null);
    setConfirming(false);
  };

  // Placing a draft sets the field-side quotation notice, which stays until the field is saved; the form clears it by
  // unmounting the control on save/navigation. A later edit that empties the field does not clear it — the notice is
  // about the AI text the Member accepted, shown until that text is saved (R44.8).

  if (itemId === undefined) return null;

  return (
    <section className="rf-ai-draft" aria-label={`AI draft for ${label}`}>
      <span className="rf-field__label">{`AI draft for ${label}`}</span>
      {typeof status === 'object' && status.available
        ? (
          <div className="rf-actions">
            <Button variant="quiet" onClick={() => void request()}>
              {held === null && message === null && !pending ? 'Request an AI draft' : 'Request a new AI draft'}
            </Button>
            {pending && <span className="rf-meta" role="status">Requesting an AI draft…</span>}
          </div>
        )
        : typeof status === 'object'
          ? <p className="rf-meta" role="status">{status.reason === 'turned_off' ? TURNED_OFF : RESUMES_AT_MIDNIGHT}</p>
          : status === 'error'
            ? <p className="rf-meta" role="status">{NO_DRAFT_NOTICE}</p>
            : <p className="rf-meta" role="status">Checking whether AI drafting is available…</p>}

      <div aria-live="polite">
        {message !== null && <p className="rf-field__error">{message}</p>}
        {held !== null && (
          <div className="rf-ai-draft__held">
            {held.quotationNotice && <p className="rf-notice rf-notice--warning" role="note">{QUOTATION_NOTICE}</p>}
            {held.truncatedInput && <p className="rf-meta">This draft summarizes only the first part of the record; some text was left out.</p>}
            <p className="rf-ai-draft__text">{held.text}</p>
            {confirming
              ? (
                <div className="rf-actions" role="group" aria-label={`Replace ${label}?`}>
                  <p className="rf-field__hint">{`The ${label} already has text. Accepting this draft replaces it.`}</p>
                  <Button variant="primary" onClick={() => place(held)}>Replace and place the draft</Button>
                  <Button variant="quiet" onClick={() => setConfirming(false)}>Keep the current text</Button>
                </div>
              )
              : (
                <div className="rf-actions">
                  <Button variant="primary" onClick={accept}>Accept the draft</Button>
                  <Button variant="quiet" onClick={discard}>Discard the draft</Button>
                </div>
              )}
          </div>
        )}
      </div>

      {placed && (
        <p className="rf-notice rf-notice--warning" role="note" aria-live="polite">{QUOTATION_NOTICE}</p>
      )}
    </section>
  );
}
