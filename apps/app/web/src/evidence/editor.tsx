import { useState } from 'react';
import { Link } from 'react-router';
import { ApiFailure, useApi } from '../api';
import type { EvidenceGrantView, UnitEvidenceView, UnitIdentityView } from '../types';
import { Button, CheckboxField, formatDate, LoadState, Notice, SaveFailure, SelectField, TextField, useLoad } from '../ui';
import { GrantSnapshot } from './snapshot';

const SOURCE_OPTIONS = [
  { value: 'letter', label: 'Letter' },
  { value: 'call', label: 'Telephone call' },
  { value: 'email', label: 'Email' },
  { value: 'other', label: 'Other evidenced method' },
];
const NAMING_OPTIONS = [
  { value: 'unnamed', label: 'Do not permit naming the party' },
  { value: 'named', label: 'Permit naming the party' },
];

interface GrantBody {
  unitId: string;
  grantorName: string;
  claimedAuthority: string;
  source: string;
  evidenceReference: string;
  uses: string[];
  naming: 'named' | 'unnamed';
  label?: string;
  licence?: string;
  covered: { unitId: string; contentRev: number; fileHash?: string; fileSize?: number }[];
  expiresAt?: string;
  reason?: string;
}

/** The manual Permission_Evidence editor for one Disclosure_Unit: its current grants, and a form to record a new one (R51.15). */
export function EvidenceEditorScreen({ id }: { readonly id: string }) {
  const loaded = useLoad<UnitEvidenceView>(`/units/${id}/evidence`);
  if (loaded.data === undefined) return <LoadState error={loaded.error} />;
  return <EvidenceEditor key={id} unit={loaded.data.unit} grants={loaded.data.grants} onDone={loaded.reload} />;
}

function EvidenceEditor({ unit, grants, onDone }: { readonly unit: UnitIdentityView; readonly grants: readonly EvidenceGrantView[]; readonly onDone: () => void }) {
  const client = useApi();
  const now = new Date().toISOString();
  const [grantorName, setGrantorName] = useState('');
  const [claimedAuthority, setClaimedAuthority] = useState('');
  const [source, setSource] = useState('letter');
  const [evidenceReference, setEvidenceReference] = useState('');
  const [publication, setPublication] = useState(true);
  const [fileShare, setFileShare] = useState(false);
  const [naming, setNaming] = useState<'named' | 'unnamed'>('unnamed');
  const [label, setLabel] = useState('');
  const [licence, setLicence] = useState('');
  const [sealFile, setSealFile] = useState(unit.fileHash !== null);
  const [expiresAt, setExpiresAt] = useState('');
  const [reason, setReason] = useState('');
  const [failure, setFailure] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const hasFile = unit.fileHash !== null && unit.fileSize !== null;
  const uses = [...(publication ? ['publication'] : []), ...(fileShare ? ['file_share'] : [])];
  const errorsFor = (field: string) => (failure instanceof ApiFailure ? failure.issuesFor(field) : []);

  const record = async () => {
    setBusy(true);
    setFailure(undefined);
    const body: GrantBody = {
      unitId: unit.id,
      grantorName,
      claimedAuthority,
      source,
      evidenceReference,
      uses,
      naming,
      ...(naming === 'named' && label.trim() !== '' ? { label } : {}),
      ...(licence.trim() !== '' ? { licence } : {}),
      covered: [{
        unitId: unit.id,
        contentRev: unit.contentRev,
        ...(hasFile && sealFile ? { fileHash: unit.fileHash!, fileSize: unit.fileSize! } : {}),
      }],
      ...(expiresAt.trim() !== '' ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
      ...(reason.trim() !== '' ? { reason } : {}),
    };
    try {
      await client.post<EvidenceGrantView>('/evidence', body);
      setSaved(true);
      onDone();
    } catch (error) { setFailure(error); } finally { setBusy(false); }
  };

  const unitLabel = `${unit.identifier ?? ''}${unit.title === null ? '' : `: ${unit.title}`}`.trim() || unit.id;

  return (
    <div className="rf-stack">
      <h1>Permission evidence</h1>
      <p className="rf-meta">
        {'For '}<Link to={`/items/${unit.id}`}>{unitLabel}</Link>{` — current content revision ${unit.contentRev}`}
        {hasFile && ` — carries a file of ${unit.fileSize!.toLocaleString('en-GB')} bytes`}
      </p>

      <Notice tone="neutral" title="Recording a grant is not publishing, and never shares a file.">
        <p>A grant records who permitted what. It does not change what is published, and a file-sharing grant does not expose the file: sharing the file bytes outside the Workspace is a separately authorized feature, never an arbitrary download.</p>
      </Notice>

      {saved && <Notice tone="success" title="The permission evidence was recorded." />}

      <section className="rf-section" aria-label="Recorded grants">
        <h2>Recorded grants</h2>
        {grants.length === 0
          ? <p className="rf-meta">No grant is recorded for this unit. It needs a verified grant or a Consent Request before its material or file may be used.</p>
          : grants.map((grant) => <GrantSnapshot key={grant.id} grant={grant} now={now} />)}
      </section>

      <section className="rf-section" aria-label="Record a grant">
        <h2>Record a grant by hand</h2>
        <SaveFailure error={failure} />
        <TextField label="Granting party's name" value={grantorName} onChange={setGrantorName} required maxLength={200}
          errors={errorsFor('grantorName')} hint="The person or organization that gave the permission." />
        <TextField label="Claimed authority" value={claimedAuthority} onChange={setClaimedAuthority} required multiline maxLength={2000}
          errors={errorsFor('claimedAuthority')} hint="What authority they claim over the material, for example copyright holder or the writer." />
        <SelectField label="How the grant was given" value={source} options={SOURCE_OPTIONS} onChange={setSource} errors={errorsFor('source')} />
        <TextField label="Evidence reference" value={evidenceReference} onChange={setEvidenceReference} required maxLength={500}
          errors={errorsFor('evidenceReference')} hint="Where the evidence is kept: a stored letter, a call note, a message identifier." />

        <fieldset className="rf-fieldset">
          <legend>Permitted uses</legend>
          <CheckboxField label="Publication: present the covered material publicly" checked={publication} onChange={setPublication} />
          <CheckboxField label="File sharing: permit sharing the file bytes (through the separate feature only)" checked={fileShare} onChange={setFileShare}
            hint="Recording this does not expose the file; sharing bytes needs the separately authorized disclosure feature." />
          {errorsFor('uses').length > 0 && <p className="rf-field__error">{errorsFor('uses').map((issue) => issue.rule).join(' ')}</p>}
        </fieldset>

        <SelectField label="Naming" value={naming} options={NAMING_OPTIONS} onChange={(next) => setNaming(next as 'named' | 'unnamed')} errors={errorsFor('naming')} />
        {naming === 'named' && (
          <TextField label="Generic label (optional)" value={label} onChange={setLabel} maxLength={100}
            errors={errorsFor('label')} hint="A label to show instead of the name on a withheld line, 1 to 100 characters." />
        )}

        {hasFile && (
          <CheckboxField label="Seal the current file bytes and size (a rights grant over the file)" checked={sealFile} onChange={setSealFile}
            hint="Leave off for a grant over the text only. When on, the grant covers only the exact file that exists now." />
        )}

        <TextField label="Licence or terms (optional)" value={licence} onChange={setLicence} multiline maxLength={2000} errors={errorsFor('licence')} />
        <TextField label="Expiry (optional)" type="datetime-local" value={expiresAt} onChange={setExpiresAt}
          errors={errorsFor('expiresAt')} hint="When the grant stops covering anything; leave empty for an open-ended grant." />
        <TextField label="Reason (optional)" value={reason} onChange={setReason} multiline maxLength={2000} errors={errorsFor('reason')}
          hint="Recorded with the grant; required by your group when a grant overrides an earlier refusal." />

        <div className="rf-actions">
          <Button variant="primary" onClick={() => void record()} disabled={busy || uses.length === 0 || grantorName.trim() === '' || claimedAuthority.trim() === '' || evidenceReference.trim() === ''}>
            Record this grant
          </Button>
        </div>
      </section>
    </div>
  );
}

/** A grant's withdrawal control, reused where a grant is shown with its curation actions (R51.15, R51.18). */
export function WithdrawGrant({ grant, onDone }: { readonly grant: EvidenceGrantView; readonly onDone: () => void }) {
  const client = useApi();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  if (grant.withdrawnAt !== null) return <p className="rf-meta">{`Withdrawn ${formatDate(grant.withdrawnAt)}.`}</p>;
  const withdraw = async () => {
    setBusy(true);
    setFailure(undefined);
    try {
      await client.post(`/evidence/${grant.id}/withdrawal`, reason.trim() === '' ? {} : { reason });
      onDone();
    } catch (error) { setFailure(error); } finally { setBusy(false); }
  };
  return (
    <div className="rf-stack">
      <SaveFailure error={failure} />
      <TextField label="Reason for withdrawal (optional)" value={reason} onChange={setReason} multiline maxLength={2000} />
      <div className="rf-actions"><Button variant="danger" onClick={() => void withdraw()} disabled={busy}>Withdraw this grant</Button></div>
    </div>
  );
}
