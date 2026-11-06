import { useState } from 'react';
import { useApi } from '../api';
import { useSession } from '../session';
import type { MemberRow, PartyRecord } from '../types';
import { Button, formatDate, LoadState, Notice, PersonLink, SaveFailure, TextField, useLoad } from '../ui';
import { ConsentRequestDialog } from './dialog';
import type { ConsentElement } from './dialog';
import { ConsentRequestsPanel } from './requests';
import type { PartyDetail } from './model';
import type { CorrespondenceEntryView, ListPageView } from '../types';

/** Record or erase an External_Party's Contact_Email; only an Administrator with `party.contact` may (R51.1). */
function ContactEmail({ party, members, onChanged }: { readonly party: PartyDetail; readonly members: readonly MemberRow[]; readonly onChanged: () => void }) {
  const client = useApi();
  const session = useSession();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(party.contactEmail ?? '');
  const [failure, setFailure] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const canEdit = session.can('party.contact');

  const erasedBy = members.find((member) => member.id === party.contactEmailErasedBy);
  const run = (change: Record<string, unknown>) => {
    setBusy(true);
    setFailure(undefined);
    void client.patch(`/parties/${party.id}`, { rev: party.rev, ...change }).then(() => { setEditing(false); onChanged(); }, setFailure).finally(() => setBusy(false));
  };

  return (
    <section className="rf-section" aria-label="Contact email">
      <h2>Contact email</h2>
      <SaveFailure error={failure} />
      {party.contactEmail !== null
        ? <p>{party.contactEmail}</p>
        : party.contactEmailErasedAt !== null
          ? <p className="rf-meta">
              {'The Contact Email was erased on '}{formatDate(party.contactEmailErasedAt)}
              {erasedBy !== undefined && <>{' by '}<PersonLink person={{ id: erasedBy.id, displayName: erasedBy.displayName }} /></>}
              {'. The erased address itself is not kept.'}
            </p>
          : <p className="rf-meta">No Contact Email is recorded. A Consent Request cannot be sent without one.</p>}
      {canEdit && !editing && <div className="rf-actions"><Button onClick={() => { setValue(party.contactEmail ?? ''); setEditing(true); }}>{party.contactEmail === null ? 'Record a Contact Email' : 'Change the Contact Email'}</Button></div>}
      {canEdit && editing && (
        <div className="rf-stack">
          <TextField label="Contact email" type="email" value={value} onChange={setValue} maxLength={254}
            hint="At most 254 characters, in the form local-part@domain. Shown only to Members." />
          <div className="rf-actions">
            <Button variant="primary" onClick={() => run({ contactEmail: value.trim() })} disabled={busy || value.trim() === ''}>Save the Contact Email</Button>
            {party.contactEmail !== null && <Button variant="danger" onClick={() => run({ contactEmail: null })} disabled={busy}>Erase the Contact Email</Button>}
            <Button variant="quiet" onClick={() => setEditing(false)} disabled={busy}>Cancel</Button>
          </div>
        </div>
      )}
    </section>
  );
}

/** The `PartyRecord` the dialog expects, from the loaded detail (the dialog needs only id, name, and naming fields). */
function toRecord(party: PartyDetail): PartyRecord {
  return { id: party.id, name: party.name, doNotName: party.doNotName, genericLabel: party.genericLabel, rev: party.rev };
}

/**
 * An External_Party's page (R51.1, R51.13). It shows the Party's name and naming flags, its Contact_Email to
 * Members (with an Administrator affordance to record or erase it), the affordance to send a Consent_Request to
 * the Party, and every Consent_Request concerning the Party with its state, answers, comments, and withdrawals.
 */
export function PartyPage({ id }: { readonly id: string }) {
  const party = useLoad<{ party: PartyDetail }>(`/parties/${id}`);
  const parties = useLoad<{ parties: PartyRecord[] }>('/parties');
  const members = useLoad<{ members: MemberRow[] }>('/members');
  // The Correspondences the Party is a Party of, offered as the publication request's candidate elements (R51.2).
  const correspondences = useLoad<ListPageView<CorrespondenceEntryView>>(`/lists/correspondences?party=${id}`);
  const [requesting, setRequesting] = useState(false);
  if (!party.data || !parties.data || !members.data) return <LoadState error={party.error ?? parties.error ?? members.error} />;
  const detail = party.data.party;
  const candidates: ConsentElement[] = (correspondences.data?.entries ?? []).map((entry) => ({
    key: `u:${entry.id}`, label: `${entry.identifier}${entry.title === null ? '' : `: ${entry.title}`}`,
  }));
  return (
    <article className="rf-stack">
      <header>
        <p className="rf-meta">External Party</p>
        <h1>{detail.name}</h1>
        <p className="rf-meta">{detail.doNotName ? 'Do Not Name: on' : 'Do Not Name: off'}</p>
        {detail.genericLabel !== null && <p className="rf-meta">{`Generic label: ${detail.genericLabel}`}</p>}
      </header>
      <ContactEmail party={detail} members={members.data.members} onChanged={party.reload} />
      <section className="rf-section" aria-label="Request consent">
        <h2>Request consent or permission</h2>
        {detail.contactEmail === null
          ? <Notice tone="neutral" title="Record a Contact Email above before sending a Consent Request." />
          : requesting
            ? <ConsentRequestDialog party={toRecord(detail)} parties={parties.data.parties} elements={[]} candidates={candidates}
                members={members.data.members} onSent={() => { party.reload(); }} onCancel={() => setRequesting(false)} />
            : <Button onClick={() => setRequesting(true)}>Send a Consent Request</Button>}
        <p className="rf-meta">Add this Party’s Correspondences here, or open a Source or Attachment’s page to request rights permission for it.</p>
      </section>
      <ConsentRequestsPanel party={detail.id} />
    </article>
  );
}
