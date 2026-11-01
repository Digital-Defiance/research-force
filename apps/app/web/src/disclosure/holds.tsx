import { useState } from 'react';
import { ApiFailure, useApi } from '../api';
import { useSession } from '../session';
import type { HoldView } from '../types';
import { Button, formatDate, levelName, Notice, PersonLink, SaveFailure, TextField } from '../ui';

interface HoldReset { readonly unitId: string; readonly identifier: string | null; readonly title: string | null; readonly level: string }
interface HoldPreview { readonly resets: readonly HoldReset[]; readonly confirmation: string | null }

/** Place a Confidentiality_Hold: a required note, a preview of the Public_Views it removes, then confirm (R48.1, R48.3). */
function PlaceHold({ itemId, onPlaced, onCancel }: { readonly itemId: string; readonly onPlaced: () => void; readonly onCancel: () => void }) {
  const client = useApi();
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState<HoldPreview | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const run = async (step: () => Promise<void>) => {
    setBusy(true);
    setFailure(undefined);
    try { await step(); } catch (error) { setFailure(error); } finally { setBusy(false); }
  };
  const check = () => run(async () => { setPreview(await client.post<HoldPreview>(`/items/${itemId}/holds/preview`, {})); });
  const place = () => run(async () => {
    await client.post(`/items/${itemId}/holds`, { note, ...(preview?.confirmation == null ? {} : { confirmation: preview.confirmation }) });
    onPlaced();
  });
  const errors = failure instanceof ApiFailure ? failure.issuesFor('note') : [];
  return (
    <section className="rf-section" aria-label="Place a confidentiality hold">
      <h3>Place a Confidentiality Hold</h3>
      <SaveFailure error={errors.length > 0 ? undefined : failure} />
      <TextField label="Why the Item is held" multiline value={note} onChange={setNote} maxLength={2000} required hint="1 to 2,000 characters; shown to everyone who can read the Item." errors={errors} />
      {preview !== undefined && preview.resets.length > 0 && (
        <Notice tone="warning" title="Placing the hold makes these Not published and removes their public pages:">
          <ul className="rf-list">{preview.resets.map((unit) => <li key={unit.unitId}>{`${unit.identifier ?? ''} ${unit.title ?? ''} (${levelName(unit.level)})`.trim()}</li>)}</ul>
        </Notice>
      )}
      {preview !== undefined && preview.resets.length === 0 && <p className="rf-meta">Placing the hold removes no public page.</p>}
      <div className="rf-actions">
        <Button onClick={() => void check()} disabled={busy}>Check what this changes</Button>
        <Button variant="primary" onClick={() => void place()} disabled={busy || note.trim() === ''}>
          {preview !== undefined && preview.resets.length > 0 ? 'Confirm and place the hold' : 'Place the hold'}
        </Button>
        <Button variant="quiet" onClick={onCancel}>Cancel</Button>
      </div>
    </section>
  );
}

/** Lift a Confidentiality_Hold with an optional note; only the placer or the Owner may (R48.6, R48.10). */
function LiftHold({ itemId, hold, onLifted }: { readonly itemId: string; readonly hold: HoldView; readonly onLifted: () => void }) {
  const client = useApi();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [failure, setFailure] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const lift = async () => {
    setBusy(true);
    setFailure(undefined);
    try {
      await client.post(`/items/${itemId}/holds/${hold.id}/lift`, note.trim() === '' ? {} : { note });
      onLifted();
    } catch (error) { setFailure(error); } finally { setBusy(false); }
  };
  if (!open) return <Button onClick={() => setOpen(true)}>Lift this hold</Button>;
  return (
    <div className="rf-stack">
      <SaveFailure error={failure} />
      <TextField label="Lift note" multiline value={note} onChange={setNote} maxLength={2000} hint="Optional; at most 2,000 characters." />
      <div className="rf-actions">
        <Button variant="primary" onClick={() => void lift()} disabled={busy}>Lift the hold</Button>
        <Button variant="quiet" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </div>
  );
}

/** Propose a Hold_Override as a Dual_Approval, with an immutable reason, when the viewer cannot lift the hold (R48.8, R49.2). */
function ProposeOverride({ itemId, hold, onProposed }: { readonly itemId: string; readonly hold: HoldView; readonly onProposed: () => void }) {
  const client = useApi();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [failure, setFailure] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const propose = async () => {
    setBusy(true);
    setFailure(undefined);
    try {
      await client.post('/dual-approvals', { action: 'hold_override', target: { itemId, holdId: hold.id }, reason });
      setDone(true);
      onProposed();
    } catch (error) { setFailure(error); } finally { setBusy(false); }
  };
  if (done) return <Notice tone="success" title="A Hold Override was proposed. A second Administrator must approve it." />;
  if (!open) return <Button onClick={() => setOpen(true)}>Propose a Hold Override</Button>;
  const rule = failure instanceof ApiFailure && failure.code === 'rule' ? (failure.details as { message?: string } | undefined)?.message : undefined;
  return (
    <div className="rf-stack">
      {rule !== undefined ? <Notice tone="warning" title={rule} /> : <SaveFailure error={failure} />}
      <p className="rf-meta">A Hold Override is a Dual Approval: a second active Administrator must approve it before the hold is overridden.</p>
      <TextField label="Why the hold should be overridden" multiline value={reason} onChange={setReason} maxLength={2000} required hint="1 to 2,000 characters; kept in history." />
      <div className="rf-actions">
        <Button variant="primary" onClick={() => void propose()} disabled={busy || reason.trim() === ''}>Propose the override</Button>
        <Button variant="quiet" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </div>
  );
}

/** Whether the viewer may lift this hold: its placer, or the Item's Owner (R48.6, R48.10). */
function canLift(session: ReturnType<typeof useSession>, hold: HoldView, ownerId: string): boolean {
  const me = session.me.member.id;
  return (hold.member.id === me || me === ownerId) && session.can('hold.lift');
}

/**
 * The hold panel on an Item's page: the active Confidentiality_Holds with placer and note, placing a hold (preview then
 * confirm), lifting a hold the viewer may lift, and proposing a Hold_Override when the viewer cannot (R48.1, R48.5, R48.6, R48.8).
 */
export function HoldPanel({ itemId, ownerId, holds, onChanged }: {
  readonly itemId: string;
  readonly ownerId: string;
  readonly holds: readonly HoldView[];
  readonly onChanged: () => void;
}) {
  const session = useSession();
  const [placing, setPlacing] = useState(false);
  const canPlace = session.can('hold.place');
  const canOverride = session.can('dual.propose');
  const mine = holds.some((hold) => hold.member.id === session.me.member.id);
  return (
    <section className="rf-section" aria-label="Confidentiality holds">
      <h2>Confidentiality holds</h2>
      {holds.length === 0 ? <p className="rf-meta">No Confidentiality Hold is in place.</p> : (
        <ul className="rf-list">
          {holds.map((hold) => (
            <li key={hold.id} className="rf-companion">
              <p>{'Held by '}<PersonLink person={hold.member} />{` on ${formatDate(hold.placedAt)}`}</p>
              <p>{hold.note}</p>
              {canLift(session, hold, ownerId)
                ? <LiftHold itemId={itemId} hold={hold} onLifted={onChanged} />
                : canOverride ? <ProposeOverride itemId={itemId} hold={hold} onProposed={onChanged} /> : null}
            </li>
          ))}
        </ul>
      )}
      {canPlace && !mine && !placing && <Button onClick={() => setPlacing(true)}>Place a Confidentiality Hold</Button>}
      {canPlace && mine && !placing && <p className="rf-meta">You already have an active Confidentiality Hold on this Item.</p>}
      {placing && <PlaceHold itemId={itemId} onPlaced={() => { setPlacing(false); onChanged(); }} onCancel={() => setPlacing(false)} />}
    </section>
  );
}
