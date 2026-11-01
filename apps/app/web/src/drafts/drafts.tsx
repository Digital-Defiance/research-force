import { useCallback, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ITEM_KIND_NAMES } from '@researchforce/domain/kind-names';
import { ITEM_KINDS } from '@researchforce/domain/types';
import type { ItemKind } from '@researchforce/domain/types';
import { ApiFailure, useApi } from '../api';
import { clearUnsent, readUnsent, writeUnsent } from '../persist';
import type { DraftKind, DraftPage, DraftView } from '../types';
import { Button, formatDate, LoadState, Notice, useLoad } from '../ui';

/**
 * Durable, author-private drafts (R57.1, R57.2). The server holds the content the author last
 * acknowledged saving; this tab holds any change made since. A draft can therefore be in one of three
 * states on reopening: its content is saved durably, it has local changes this tab has not sent, or a
 * save's outcome is unknown because its response was lost. Pinning a draft keeps it past the inactivity
 * expiry. Discarding one throws the author's own work away. None of this is visible to any other Member,
 * and the normal API shows a draft only while its author can still read the record it edits.
 */

/** Which of the three states a draft is in for the author reopening it (R57.1). */
export type DraftStatus = 'saved' | 'local' | 'unknown';

const STATUS_LABELS: Readonly<Record<DraftStatus, string>> = { saved: 'Saved', local: 'Unsaved local changes', unknown: 'Save not confirmed' };

/** A short, accessible badge for one of the three draft states, with no reliance on colour alone (R57.1). */
export function DraftStatusBadge({ status }: { readonly status: DraftStatus }) {
  const className = status === 'saved' ? 'rf-status rf-status--success' : 'rf-status rf-status--warning';
  return <span className={className} data-draft-status={status}>{STATUS_LABELS[status]}</span>;
}

const DRAFT_KIND_NAMES: Readonly<Record<DraftKind, string>> = { item: 'New record', edit: 'Edit', submission: 'Submission', reply: 'Reply', proposal: 'Proposed edit' };
const isKind = (value: string): value is ItemKind => (ITEM_KINDS as readonly string[]).includes(value);

/** What a draft is for in words: its kind, and the record kind its form names when that is known. */
export function draftLabel(draft: DraftView): string {
  const kind = DRAFT_KIND_NAMES[draft.kind] ?? draft.kind;
  const form = isKind(draft.form) ? ITEM_KIND_NAMES[draft.form] : null;
  return form === null ? kind : `${kind}: ${form}`;
}

/** Where resuming a draft takes the author: the edit form of the record it edits, or the new-record form of its kind. */
export function draftResumeTo(draft: DraftView): string {
  if (draft.kind === 'edit' && draft.targetRootId !== null) return `/items/${draft.targetRootId}/edit`;
  if (draft.kind === 'proposal' && draft.targetRootId !== null) return `/items/${draft.targetRootId}/propose`;
  if ((draft.kind === 'item' || draft.kind === 'submission') && isKind(draft.form)) return `/items/new/${draft.form}`;
  return '/me/drafts';
}

/**
 * The state of one draft's content against the server. The server's view carries the acknowledged
 * content and rev; this tab's unsent fallback carries the content and the rev it was last reconciled
 * against. When the tab holds content that differs from the server's acknowledged content the draft has
 * local changes; when the tab recorded a save whose outcome it never confirmed, the draft is unknown.
 */
export interface DraftFallback { readonly content: unknown; readonly rev: number; readonly unknown?: boolean }
const fallbackKey = (id: string): string => `draft:${id}`;

export function draftStatus(draft: DraftView, fallback: DraftFallback | undefined): DraftStatus {
  if (fallback === undefined) return 'saved';
  if (fallback.unknown === true) return 'unknown';
  if (fallback.rev !== draft.rev) return 'local';
  return JSON.stringify(fallback.content) === JSON.stringify(draft.content) ? 'saved' : 'local';
}

/**
 * Durable draft controls for one editing form (R57.1, R57.6). It saves the form content to the server
 * under a stable draft id so the save survives tab closure, mirrors every change into this tab's local
 * fallback so an unsent change is kept and told apart from the saved content, and exposes discard and
 * pin. A lost save response leaves the draft in the `unknown` state until the next save confirms it,
 * rather than claiming the content was saved or lost.
 */
export interface DraftControls {
  readonly draft: DraftView | undefined;
  readonly status: DraftStatus;
  readonly busy: boolean;
  readonly error: unknown;
  /** Record a local change to the draft's content without sending it, so it is kept across a reload. */
  readonly change: (content: unknown) => void;
  /** Save the current content durably to the server. */
  readonly save: (content: unknown) => Promise<void>;
  readonly pin: (pinned: boolean) => Promise<void>;
  readonly discard: () => Promise<void>;
}

export interface DraftTarget {
  readonly kind: DraftKind;
  readonly form: string;
  readonly targetId?: string;
  readonly targetRootId?: string;
  readonly baseRev?: number;
}

export function useDraft(existing: DraftView | undefined, target: DraftTarget): DraftControls {
  const client = useApi();
  const [draft, setDraft] = useState<DraftView | undefined>(existing);
  const [fallback, setFallback] = useState<DraftFallback | undefined>(() => (existing === undefined ? undefined : readUnsent<DraftFallback>(fallbackKey(existing.id))));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);

  const change = useCallback((content: unknown) => {
    setDraft((current) => {
      if (current === undefined) { setFallback({ content, rev: 0 }); return current; }
      const next: DraftFallback = { content, rev: current.rev };
      writeUnsent(fallbackKey(current.id), next);
      setFallback(next);
      return current;
    });
  }, []);

  const save = useCallback(async (content: unknown) => {
    setBusy(true);
    setError(undefined);
    const body = { kind: target.kind, form: target.form, content, ...(target.targetId === undefined ? {} : { targetId: target.targetId }), ...(target.targetRootId === undefined ? {} : { targetRootId: target.targetRootId }), ...(target.baseRev === undefined ? {} : { baseRev: target.baseRev }) };
    try {
      const saved = draft === undefined
        ? (await client.post<{ draft: DraftView }>('/drafts', body)).draft
        : (await client.put<{ draft: DraftView }>(`/drafts/${draft.id}`, { ...body, expectedRev: draft.rev })).draft;
      setDraft(saved);
      clearUnsent(fallbackKey(saved.id));
      setFallback(undefined);
    } catch (failure) {
      // A save whose outcome is not known leaves the content in this tab and marks the draft unknown, so
      // the author is told the server has not confirmed it rather than that it was saved (R57.1).
      if (draft !== undefined && failure instanceof ApiFailure && (failure.code === 'network' || failure.code === 'committed' || failure.code === 'unknown')) {
        const next: DraftFallback = { content, rev: draft.rev, unknown: true };
        writeUnsent(fallbackKey(draft.id), next);
        setFallback(next);
      }
      setError(failure);
    } finally {
      setBusy(false);
    }
  }, [client, draft, target.kind, target.form, target.targetId, target.targetRootId, target.baseRev]);

  const pin = useCallback(async (pinned: boolean) => {
    if (draft === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      const saved = (await client.post<{ draft: DraftView }>(`/drafts/${draft.id}/pin`, { pinned })).draft;
      setDraft(saved);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }, [client, draft]);

  const discard = useCallback(async () => {
    if (draft === undefined) { setFallback(undefined); return; }
    setBusy(true);
    setError(undefined);
    try {
      await client.delete(`/drafts/${draft.id}`);
      clearUnsent(fallbackKey(draft.id));
      setDraft(undefined);
      setFallback(undefined);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }, [client, draft]);

  return { draft, status: draft === undefined ? 'saved' : draftStatus(draft, fallback), busy, error, change, save, pin, discard };
}

/** One draft in the list, with its state, times, and resume/pin/discard controls (R57.1, R57.2, R57.6). */
function DraftRow({ draft, onChanged }: { readonly draft: DraftView; readonly onChanged: () => void }) {
  const client = useApi();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const fallback = readUnsent<DraftFallback>(fallbackKey(draft.id));
  const status = draftStatus(draft, fallback);
  const act = async (run: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try { await run(); } catch (failure) { setError(failure); } finally { setBusy(false); }
  };
  const pin = () => act(async () => { await client.post(`/drafts/${draft.id}/pin`, { pinned: !draft.pinned }); onChanged(); });
  const discard = () => act(async () => { await client.delete(`/drafts/${draft.id}`); clearUnsent(fallbackKey(draft.id)); onChanged(); });
  return (
    <article className="rf-companion" aria-label={`Draft: ${draftLabel(draft)}`}>
      <p><strong>{draftLabel(draft)}</strong>{' '}<DraftStatusBadge status={status} />{draft.pinned && <>{' '}<span className="rf-status">Pinned</span></>}</p>
      <p className="rf-meta">{`Last saved ${formatDate(draft.lastSavedAt)}.`}</p>
      {!draft.pinned && <p className="rf-meta">{`Warns on ${formatDate(draft.warnAt)}; expires on ${formatDate(draft.expireAt)} unless pinned.`}</p>}
      {status === 'unknown' && <Notice tone="warning" title="A save of this draft was not confirmed. Open it and save again to be sure." />}
      {error !== undefined && <Notice tone="danger" title="This action could not be completed. Try again." />}
      <div className="rf-actions">
        <Button variant="primary" onClick={() => void navigate(draftResumeTo(draft))} disabled={busy}>Resume</Button>
        <Button onClick={() => void pin()} disabled={busy}>{draft.pinned ? 'Unpin' : 'Pin'}</Button>
        <Button variant="danger" onClick={() => void discard()} disabled={busy}>Discard</Button>
      </div>
    </article>
  );
}

/** `/me/drafts`: the author's own saved drafts, newest first, with their state and controls (R57.1, R57.2). */
export function DraftsPage({ embedded = false }: { readonly embedded?: boolean }) {
  const page = useLoad<DraftPage>('/drafts');
  if (!page.data) return <LoadState error={page.error} />;
  const drafts = page.data.drafts;
  return (
    <div className="rf-stack">
      {!embedded && <h1>Your drafts</h1>}
      <p className="rf-meta">Only you can see your drafts. A draft keeps what you saved even after you close the tab; an unpinned draft is removed after 90 days without a save.</p>
      {drafts.length === 0 ? <p className="rf-meta">You have no saved drafts.</p> : (
        <ul className="rf-list">
          {drafts.map((draft) => <li key={draft.id}><DraftRow draft={draft} onChanged={page.reload} /></li>)}
        </ul>
      )}
    </div>
  );
}

/** A compact save/pin/discard control strip for an editing form, with the current state shown (R57.1, R57.6). */
export function DraftControlsBar({ controls, content }: { readonly controls: DraftControls; readonly content: unknown }) {
  return (
    <div className="rf-stack" aria-label="Draft">
      <p>{'Draft: '}<DraftStatusBadge status={controls.status} />{controls.draft?.pinned === true && <>{' '}<span className="rf-status">Pinned</span></>}</p>
      {controls.draft !== undefined && <p className="rf-meta">{`Last saved ${formatDate(controls.draft.lastSavedAt)}.`}</p>}
      {controls.status === 'unknown' && <Notice tone="warning" title="The last save of this draft was not confirmed. Save again to be sure." />}
      {controls.error !== undefined && <Notice tone="danger" title="Your draft could not be saved. It is kept in this tab." />}
      <div className="rf-actions">
        <Button onClick={() => void controls.save(content)} disabled={controls.busy}>Save draft</Button>
        {controls.draft !== undefined && <Button onClick={() => void controls.pin(!controls.draft?.pinned)} disabled={controls.busy}>{controls.draft.pinned ? 'Unpin draft' : 'Pin draft'}</Button>}
        {controls.draft !== undefined && <Button variant="danger" onClick={() => void controls.discard()} disabled={controls.busy}>Discard draft</Button>}
        <Link className="rf-button rf-button--quiet" to="/me/drafts">All drafts</Link>
      </div>
    </div>
  );
}
