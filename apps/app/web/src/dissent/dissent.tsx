import { useState } from 'react';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import type { RichText } from '@researchforce/domain/richtext';
import { ApiFailure, useApi } from '../api';
import { useSession } from '../session';
import { RichTextEditor } from '../editor/RichTextEditor';
import type { MentionOptions } from '../editor/RichTextEditor';
import { RichTextView } from '../editor/RichTextView';
import { WordChanges } from '../history/history';
import { DisclosureDialog } from '../disclosure/disclosure';
import type { DissentConflictDetails, DissentNoteView, ItemView, MemberRow, WithdrawnDissentNoteView } from '../types';
import { Button, formatDate, Notice, PersonLink, SaveFailure, SelectField, TextField } from '../ui';

const EMPTY: RichText = { text: '', spans: [] };
const REVISION_KIND_NAMES: Readonly<Record<string, string>> = {
  creation: 'Creation', minor_edit: 'Minor edit', correction: 'Correction', withdrawal: 'Withdrawal', disclosure_change: 'Disclosure change', deletion: 'Deletion',
};

/** Who may permanently delete a Dissent_Note or change its disclosure: an Administrator (R42.17). */
function isAdministrator(session: ReturnType<typeof useSession>): boolean {
  return session.me.member.roleId === ROLE_IDS.administrator;
}

/** The `details` of a 409 from a Dissent_Note edit or withdraw, or undefined for any other failure (R42.16). */
function conflictOf(error: unknown): DissentConflictDetails | undefined {
  return error instanceof ApiFailure && error.code === 'conflict' ? (error.details as DissentConflictDetails | undefined) : undefined;
}

/** The current Log_Summary and the Revisions recorded since the editor opened, so the author can reconcile and retry (R42.16). */
function ConflictView({ conflict }: { readonly conflict: DissentConflictDetails }) {
  const list = (label: string, revisions: DissentConflictDetails['changes']['dissent']) => (
    revisions.length === 0 ? null : (
      <div>
        <p className="rf-meta">{label}</p>
        <ul className="rf-list">
          {revisions.map((revision, index) => (
            <li key={index}>
              {REVISION_KIND_NAMES[revision.kind] ?? revision.kind}{' by '}
              <PersonLink person={{ id: revision.memberId, displayName: revision.displayName }} />{` at ${formatDate(revision.at)}`}
            </li>
          ))}
        </ul>
      </div>
    )
  );
  return (
    <Notice tone="warning" title="The Log Summary or your note changed since you opened the editor, so nothing was saved. Review the changes, then save again.">
      <section aria-label="The Log Summary now">
        <p className="rf-meta">The Log Summary now:</p>
        <RichTextView value={conflict.logSummary} />
      </section>
      {list('Changes to the Log Summary since you opened the editor:', conflict.changes.logSummary)}
      {list('Changes to your note since you opened the editor:', conflict.changes.dissent)}
    </Notice>
  );
}

/** The earlier-wording mark on a note, with a toggle to its word comparison from the recorded wording to the current one (R42.9). */
function EarlierWording({ note }: { readonly note: DissentNoteView }) {
  const [open, setOpen] = useState(false);
  if (!note.aboutEarlierWording || note.comparison === undefined) return null;
  return (
    <div className="rf-stack">
      <p className="rf-status rf-status--warning">Written about an earlier wording of the Log Summary.</p>
      <Button variant="quiet" onClick={() => setOpen((value) => !value)}>{open ? 'Hide the comparison' : 'Compare with the current wording'}</Button>
      {open && (
        <section className="rf-section" aria-label="Wording comparison">
          <p className="rf-meta">Added words are underlined and removed words are struck through.</p>
          <WordChanges parts={note.comparison.words} />
          <p className="rf-meta">The wording this note concerns:</p>
          <RichTextView value={note.comparison.concernedSummary} />
          {note.comparison.currentSummary !== null && (
            <>
              <p className="rf-meta">The current wording:</p>
              <RichTextView value={note.comparison.currentSummary} />
            </>
          )}
        </section>
      )}
    </div>
  );
}

type Mark = { readonly mark: 'minor_edit' | 'correction'; readonly reason?: string };
const MARK_OPTIONS = [{ value: 'minor_edit', label: 'Minor edit' }, { value: 'correction', label: 'Correction' }];

/**
 * Save a change to the viewer's own Dissent_Note: a text editor, a Minor_Edit or Correction mark (with a reason for a
 * Correction), sent as `{ rev, summaryRev, text, mark }`; a 409 shows the conflict view, with the fresh revisions to
 * retry with (R42.16).
 */
function EditForm({ note, summaryRev, mentions, onChanged }: {
  readonly note: DissentNoteView; readonly summaryRev: number; readonly mentions: MentionOptions; readonly onChanged: () => void;
}) {
  const client = useApi();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<RichText>(note.text);
  const [mark, setMark] = useState<'minor_edit' | 'correction' | ''>('');
  const [reason, setReason] = useState('');
  const [failure, setFailure] = useState<unknown>(undefined);
  const [conflict, setConflict] = useState<DissentConflictDetails | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setFailure(undefined);
    setConflict(undefined);
    try {
      const chosen: Mark = { mark: mark as 'minor_edit' | 'correction', ...(mark === 'correction' ? { reason } : {}) };
      // Retry with the fresh revisions once a conflict has given them, so the author reconciles and saves on top.
      const revisions = conflict === undefined ? { rev: note.rev, summaryRev } : { rev: conflict.rev, summaryRev: conflict.summaryRev };
      await client.patch(`/dissent/${note.id}`, { ...revisions, text, mark: chosen });
      setOpen(false);
      onChanged();
    } catch (error) {
      const stale = conflictOf(error);
      if (stale !== undefined) setConflict(stale); else setFailure(error);
    } finally {
      setBusy(false);
    }
  };
  if (!open) return <Button onClick={() => { setOpen(true); setText(note.text); setMark(''); setReason(''); setFailure(undefined); setConflict(undefined); }}>Edit your note</Button>;
  return (
    <section className="rf-section" role="dialog" aria-label="Edit your dissent note">
      <h3>Edit your dissent note</h3>
      <SaveFailure error={failure} />
      {conflict !== undefined && <ConflictView conflict={conflict} />}
      <RichTextEditor label="Your note" value={text} onChange={setText} mentions={mentions} required />
      <SelectField label="Mark this edit" value={mark} options={MARK_OPTIONS} placeholder="Choose a mark" onChange={(value) => setMark(value as 'minor_edit' | 'correction')} required />
      {mark === 'correction' && <TextField label="Reason for the Correction" multiline value={reason} onChange={setReason} maxLength={1000} hint="1 to 1,000 characters." required />}
      <div className="rf-actions">
        <Button variant="primary" onClick={() => void save()} disabled={busy || mark === ''}>Save the change</Button>
        <Button variant="quiet" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </section>
  );
}

/** Withdraw the viewer's own Dissent_Note with a reason, sent as `{ rev, summaryRev, reason }`; a 409 shows the conflict view (R42.8, R42.16). */
function WithdrawForm({ note, summaryRev, onChanged }: { readonly note: DissentNoteView; readonly summaryRev: number; readonly onChanged: () => void }) {
  const client = useApi();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [failure, setFailure] = useState<unknown>(undefined);
  const [conflict, setConflict] = useState<DissentConflictDetails | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const withdraw = async () => {
    setBusy(true);
    setFailure(undefined);
    setConflict(undefined);
    try {
      const revisions = conflict === undefined ? { rev: note.rev, summaryRev } : { rev: conflict.rev, summaryRev: conflict.summaryRev };
      await client.post(`/dissent/${note.id}/withdraw`, { ...revisions, reason });
      setOpen(false);
      onChanged();
    } catch (error) {
      const stale = conflictOf(error);
      if (stale !== undefined) setConflict(stale); else setFailure(error);
    } finally {
      setBusy(false);
    }
  };
  if (!open) return <Button variant="danger" onClick={() => { setOpen(true); setReason(''); setFailure(undefined); setConflict(undefined); }}>Withdraw your note</Button>;
  return (
    <section className="rf-section" role="dialog" aria-label="Withdraw your dissent note">
      <h3>Withdraw your dissent note</h3>
      <SaveFailure error={failure} />
      {conflict !== undefined && <ConflictView conflict={conflict} />}
      <TextField label="Reason for withdrawal" multiline value={reason} onChange={setReason} maxLength={1000} hint="1 to 1,000 characters." required />
      <div className="rf-actions">
        <Button variant="danger" onClick={() => void withdraw()} disabled={busy || reason.trim() === ''}>Withdraw the note</Button>
        <Button variant="quiet" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </section>
  );
}

/** The Administrator's permanent deletion of a Dissent_Note with a reason, `DELETE /dissent/{id}` (202); the note becomes a Deletion record on refresh (R42.11, R42.17). */
function DeleteForm({ noteId, onChanged }: { readonly noteId: string; readonly onChanged: () => void }) {
  const client = useApi();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [failure, setFailure] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    setFailure(undefined);
    try {
      await client.request('DELETE', `/dissent/${noteId}`, { reason });
      setOpen(false);
      onChanged();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  };
  if (!open) return <Button variant="danger" onClick={() => { setOpen(true); setReason(''); setFailure(undefined); }}>Delete permanently</Button>;
  return (
    <section className="rf-section" role="dialog" aria-label="Delete this dissent note permanently">
      <h3>Delete this dissent note permanently</h3>
      <p className="rf-meta">The note’s text, every value recorded with it, and its revisions are removed, leaving only a deletion record.</p>
      <SaveFailure error={failure} />
      <TextField label="Reason for deletion" multiline value={reason} onChange={setReason} maxLength={1000} hint="1 to 1,000 characters." required />
      <div className="rf-actions">
        <Button variant="danger" onClick={() => void remove()} disabled={busy || reason.trim() === ''}>Delete permanently</Button>
        <Button variant="quiet" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </section>
  );
}

/** The Administrator's disclosure control for a Dissent_Note unit, reusing the shared disclosure dialog (R42.17). */
function NoteDisclosure({ noteId, members, onChanged }: { readonly noteId: string; readonly members: readonly MemberRow[]; readonly onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  if (!open) return <Button onClick={() => setOpen(true)}>Change the note’s disclosure</Button>;
  return (
    <DisclosureDialog title="Change the note’s disclosure" units={[{ key: `u:${noteId}` }]} members={members}
      onCancel={() => setOpen(false)} onProposed={onChanged} onApplied={() => { setOpen(false); onChanged(); }} />
  );
}

/** One non-withdrawn Dissent_Note: its author, last-saved time, text, the earlier-wording comparison, and the viewer's or an Administrator's controls (R42.3, R42.9, R42.16, R42.17). */
function Note({ note, summaryRev, members, mentions, onChanged }: {
  readonly note: DissentNoteView; readonly summaryRev: number; readonly members: readonly MemberRow[]; readonly mentions: MentionOptions; readonly onChanged: () => void;
}) {
  const session = useSession();
  const own = session.me.member.id === note.author.id;
  const administrator = isAdministrator(session);
  return (
    <li className="rf-section" aria-label="Dissent note">
      <p className="rf-meta">{'By '}<PersonLink person={note.author} />{` — last saved ${formatDate(note.lastSavedAt)}`}</p>
      <RichTextView value={note.text} />
      <EarlierWording note={note} />
      {own && (
        <div className="rf-stack">
          <EditForm note={note} summaryRev={summaryRev} mentions={mentions} onChanged={onChanged} />
          <WithdrawForm note={note} summaryRev={summaryRev} onChanged={onChanged} />
        </div>
      )}
      {administrator && (
        <div className="rf-stack">
          <DeleteForm noteId={note.id} onChanged={onChanged} />
          <NoteDisclosure noteId={note.id} members={members} onChanged={onChanged} />
        </div>
      )}
    </li>
  );
}

/** A withdrawn Dissent_Note, kept on the item page with its withdrawal date and reason (R42.8). */
function WithdrawnNote({ note }: { readonly note: WithdrawnDissentNoteView }) {
  return (
    <li className="rf-section" aria-label="Withdrawn dissent note">
      <p className="rf-meta">{'By '}<PersonLink person={note.author} /></p>
      <RichTextView value={note.text} />
      <Notice tone="warning" title={`Withdrawn on ${formatDate(note.withdrawnAt)}`}>
        {note.withdrawalReason !== null && note.withdrawalReason.trim() !== '' && <p>{`Reason: ${note.withdrawalReason}`}</p>}
      </Notice>
    </li>
  );
}

/** Add a dissent note on this item's Log_Summary, `POST /dissent` `{ itemId, text }`, then refresh (R42.3). */
function AttachForm({ itemId, mentions, onChanged }: { readonly itemId: string; readonly mentions: MentionOptions; readonly onChanged: () => void }) {
  const client = useApi();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<RichText>(EMPTY);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const errors = failure instanceof ApiFailure ? failure.issuesFor('text') : [];
  const attach = async () => {
    setBusy(true);
    setFailure(undefined);
    try {
      await client.post('/dissent', { itemId, text });
      setText(EMPTY);
      setOpen(false);
      onChanged();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  };
  if (!open) return <Button onClick={() => { setOpen(true); setText(EMPTY); setFailure(undefined); }}>Add a dissent note</Button>;
  return (
    <section className="rf-section" role="dialog" aria-label="Add a dissent note">
      <h3>Add a dissent note</h3>
      <SaveFailure error={failure} />
      <RichTextEditor label="Your note" value={text} onChange={setText} mentions={mentions} errors={errors} required />
      <div className="rf-actions">
        <Button variant="primary" onClick={() => void attach()} disabled={busy || text.text.trim() === ''}>Add the note</Button>
        <Button variant="quiet" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </section>
  );
}

/**
 * The Dissent_Note section shown directly after the Log_Summary: the non-withdrawn notes oldest first, then the
 * withdrawn ones with their date and reason, then a Deletion record in each permanently deleted note's place, with the
 * attach form for an eligible Member, each author's own edit and withdraw forms, and an Administrator's delete and
 * disclosure controls (R42.3, R42.8, R42.9, R42.11, R42.16, R42.17).
 */
export function DissentPanel({ item, members, onChanged }: { readonly item: ItemView; readonly members: readonly MemberRow[]; readonly onChanged: () => void }) {
  const session = useSession();
  const dissent = item.dissent;
  // The attach form needs a Log_Summary to concern (R42.2); without one, no note can be attached.
  const hasSummary = item.logSummary !== undefined && item.logSummary.text.trim() !== '';
  const isOwner = session.me.member.id === item.owner.id;
  const hasOwnNote = (dissent?.notes ?? []).some((note) => note.author.id === session.me.member.id);
  // An active Member who is not the Owner and has no current note may add one; the Owner and a Member who already
  // dissents here do not see the form (R42.2).
  const canAttach = session.can('dissent.attach') && hasSummary && !isOwner && !hasOwnNote;
  const mentions: MentionOptions = {
    members: members.filter((member) => (member.status === 'active' || member.status === 'pending') && member.displayName !== null).map((member) => ({ id: member.id, displayName: member.displayName! })),
    specialties: session.me.specialtyOptions.filter((specialty) => specialty.retired !== true).map((specialty) => ({ id: specialty.id, name: specialty.name })),
  };
  const notes = dissent?.notes ?? [];
  const withdrawn = dissent?.withdrawn ?? [];
  const deletions = dissent?.deletions ?? [];
  const summaryRev = item.rev;
  return (
    <section className="rf-section" aria-label="Dissent notes">
      <h2>Dissent notes</h2>
      {notes.length === 0 && withdrawn.length === 0 && deletions.length === 0 && <p className="rf-meta">No dissent notes.</p>}
      {notes.length > 0 && (
        <ul className="rf-list">
          {notes.map((note) => <Note key={note.id} note={note} summaryRev={summaryRev} members={members} mentions={mentions} onChanged={onChanged} />)}
        </ul>
      )}
      {withdrawn.length > 0 && (
        <ul className="rf-list">
          {withdrawn.map((note) => <WithdrawnNote key={note.id} note={note} />)}
        </ul>
      )}
      {deletions.length > 0 && (
        <ul className="rf-list">
          {deletions.map((deletion) => (
            <li key={deletion.id} className="rf-section" aria-label="Deleted dissent note">
              <Notice tone="warning" title={`A dissent note was permanently deleted on ${formatDate(deletion.deletedAt)}.`}>
                <p>{'By '}<PersonLink person={deletion.deletedBy} />{`: ${deletion.reason}`}</p>
              </Notice>
            </li>
          ))}
        </ul>
      )}
      {canAttach && <AttachForm itemId={item.id} mentions={mentions} onChanged={onChanged} />}
    </section>
  );
}
