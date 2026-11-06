import { useState } from 'react';
import { Link } from 'react-router';
import { useApi } from '../api';
import { useSession } from '../session';
import type { ItemView, MemberRow, PartyRecord } from '../types';
import type { DisclosurePreviewView } from '../types';
import { Button, PersonLink, SaveFailure } from '../ui';
import { PreviewSummary } from './disclosure';
import type { CorrespondencePartyValue } from '../items/forms/model';

const CONSENT_NAMES: Readonly<Record<string, string>> = { not_asked: 'Not asked', requested: 'Requested', granted: 'Granted', refused: 'Refused' };
const consentName = (status: string): string => CONSENT_NAMES[status] ?? status.replace('_', ' ');

/**
 * Turn an External_Party's Do_Not_Name flag off: preview the Public_Views that would then show the Party's name, then
 * confirm and save, after which the name replaces the Generic_Label (R34.9). Only an Administrator with
 * `party.doNotName.off` may; the preview runs through `/disclosure/preview` with the Party in `doNotNameOff`.
 */
function NameParty({ party, members, onChanged }: { readonly party: PartyRecord; readonly members: readonly MemberRow[]; readonly onChanged: () => void }) {
  const client = useApi();
  const session = useSession();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<DisclosurePreviewView | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const run = async (step: () => Promise<void>) => {
    setBusy(true);
    setFailure(undefined);
    try { await step(); } catch (error) { setFailure(error); } finally { setBusy(false); }
  };
  if (!session.can('party.doNotName.off')) return null;
  const check = () => run(async () => { setPreview(await client.post<DisclosurePreviewView>('/disclosure/preview', { doNotNameOff: [party.id] })); });
  const confirm = () => run(async () => {
    await client.patch(`/parties/${party.id}`, { rev: party.rev, doNotName: false });
    onChanged();
  });
  if (!open) return <Button onClick={() => setOpen(true)}>Turn Do Not Name off</Button>;
  return (
    <div className="rf-stack">
      <SaveFailure error={failure} />
      <p className="rf-meta">Turning Do Not Name off shows the Party’s name in place of the Generic Label on the public site. Check what this changes before confirming.</p>
      {preview !== undefined && <PreviewSummary diff={preview.diff} members={members} />}
      <div className="rf-actions">
        <Button onClick={() => void check()} disabled={busy}>Check what this changes</Button>
        <Button variant="primary" onClick={() => void confirm()} disabled={busy || preview === undefined}>Confirm and turn off Do Not Name</Button>
        <Button variant="quiet" onClick={() => { setOpen(false); setPreview(undefined); }}>Cancel</Button>
      </div>
    </div>
  );
}

/**
 * The External_Parties of a Correspondence, each with its Consent_Status, Do_Not_Name flag, and Generic_Label, and the
 * affordance to turn Do_Not_Name off through a preview (R34.7, R34.9). Member parties carry no consent or naming flag.
 */
export function CorrespondenceParties({ item, parties, members, onChanged }: {
  readonly item: ItemView;
  readonly parties: readonly PartyRecord[];
  readonly members: readonly MemberRow[];
  readonly onChanged: () => void;
}) {
  const entries = (item['parties'] as readonly CorrespondencePartyValue[] | undefined) ?? [];
  const external = entries.filter((entry) => entry.kind === 'external');
  if (external.length === 0) return null;
  const memberName = (id: string) => members.find((member) => member.id === id)?.displayName ?? null;
  return (
    <section className="rf-section" aria-label="Correspondence parties">
      <h2>Correspondence parties</h2>
      <ul className="rf-list">
        {external.map((entry) => {
          const record = parties.find((candidate) => candidate.id === entry.id);
          const name = record?.name ?? entry.id;
          return (
            <li key={entry.id} className="rf-companion">
              <p><strong><Link to={`/parties/${entry.id}`}>{name}</Link></strong></p>
              <p className="rf-meta">{`Consent status: ${consentName(entry.consent ?? 'not_asked')}`}</p>
              {record !== undefined && (
                <>
                  <p className="rf-meta">{record.doNotName ? 'Do Not Name: on' : 'Do Not Name: off'}</p>
                  {record.genericLabel !== null && <p className="rf-meta">{`Generic label: ${record.genericLabel}`}</p>}
                  {record.doNotName && <NameParty party={record} members={members} onChanged={onChanged} />}
                </>
              )}
            </li>
          );
        })}
      </ul>
      {entries.some((entry) => entry.kind === 'member') && (
        <p className="rf-meta">
          {'Member parties: '}
          {entries.filter((entry) => entry.kind === 'member').map((entry, index) => (
            <span key={entry.id}>{index > 0 ? ', ' : ''}<PersonLink person={{ id: entry.id, displayName: memberName(entry.id) }} /></span>
          ))}
        </p>
      )}
    </section>
  );
}
