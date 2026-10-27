import { useState } from 'react';
import type { FormEvent } from 'react';
import { ApiFailure, useApi } from '../api';
import { usePersistentForm } from '../persist';
import { useSession } from '../session';
import type { Me, Profile } from '../types';
import { Button, CheckboxField, Notice, RestoredNotice, SaveFailure, SelectField, TextField } from '../ui';

interface ProfileValues {
  readonly displayName: string;
  readonly specialtyIds: readonly string[];
  readonly affiliations: readonly string[];
  readonly biography: string;
  readonly timeZone: string;
  readonly publicProfile: boolean;
}
interface PublicProfilePreview {
  readonly preview: { readonly view: { readonly displayName: string; readonly specialties: readonly string[]; readonly affiliations: readonly string[]; readonly biography: string } };
  readonly confirmation: string;
}

const MISSING_NAMES: Readonly<Record<string, string>> = { displayName: 'a display name', specialtyIds: 'at least one Specialty', timeZone: 'a time zone' };

export function timeZones(current: string): string[] {
  const supported = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  return [...new Set(['UTC', ...supported, ...(current === '' ? [] : [current])])].sort((a, b) => a.localeCompare(b));
}

function initialProfile(profile: Profile | null): ProfileValues {
  return {
    displayName: profile?.displayName ?? '',
    specialtyIds: profile?.specialties.map((specialty) => specialty.id) ?? [],
    affiliations: profile?.affiliations ?? [],
    biography: profile?.biography ?? '',
    timeZone: profile?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    publicProfile: profile?.publicProfile ?? false,
  };
}

/** The People-page entry that turning Public_Profile On would publish, shown before it is confirmed. */
function PreviewConfirmation({ preview, onConfirm, onCancel, busy }: { readonly preview: PublicProfilePreview; readonly onConfirm: () => void; readonly onCancel: () => void; readonly busy: boolean }) {
  const { view } = preview.preview;
  return (
    <section className="rf-companion" aria-label="Public Profile preview">
      <h2>Your entry on the public People page</h2>
      <p>Turning Public Profile on publishes exactly this. Nothing is saved until you confirm.</p>
      <dl>
        <dt>Display name</dt><dd>{view.displayName}</dd>
        <dt>Specialties</dt><dd>{view.specialties.join(', ')}</dd>
        <dt>Affiliations</dt><dd>{view.affiliations.length === 0 ? 'None' : view.affiliations.join('; ')}</dd>
        <dt>Biography</dt><dd>{view.biography === '' ? 'None' : view.biography}</dd>
      </dl>
      <div className="rf-actions">
        <Button variant="primary" onClick={onConfirm} disabled={busy}>Confirm and save with Public Profile on</Button>
        <Button variant="quiet" onClick={onCancel}>Go back to the form</Button>
      </div>
    </section>
  );
}

/**
 * The Member's own Profile form, which also replaces every other page while a required field is missing (R3.1, R3.6);
 * turning Public_Profile On shows the preview first and saves only after confirmation.
 */
export function ProfileForm({ me, onSaved }: { readonly me: Me; readonly onSaved: () => void }) {
  const client = useApi();
  const form = usePersistentForm<ProfileValues>('me:profile', () => initialProfile(me.profile));
  const [failure, setFailure] = useState<unknown>(undefined);
  const [preview, setPreview] = useState<PublicProfilePreview | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const { values } = form;
  const errors = (field: string) => (failure instanceof ApiFailure ? failure.issuesFor(field) : []);
  const offered = [
    ...me.specialtyOptions,
    ...(me.profile?.specialties ?? []).filter((specialty) => specialty.retired === true),
  ];

  const save = async (confirmation?: string) => {
    setBusy(true);
    setFailure(undefined);
    setSaved(false);
    try {
      const body = { ...values, ...(confirmation === undefined ? {} : { confirmation }) };
      const response = await client.patch<{ saved: true } | ({ saved: false } & PublicProfilePreview)>('/me/profile', body);
      if (!response.saved) {
        setPreview({ preview: response.preview, confirmation: response.confirmation });
        return;
      }
      setPreview(null);
      form.sent();
      setSaved(true);
      client.status.update({ profileMissing: null });
      onSaved();
    } catch (error) {
      if (error instanceof ApiFailure && error.code === 'preview_stale') {
        setPreview(error.details as PublicProfilePreview);
        setFailure(undefined);
      } else {
        setFailure(error);
        setPreview(null);
      }
    } finally {
      setBusy(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void save();
  };

  if (preview !== null) return <PreviewConfirmation preview={preview} busy={busy} onConfirm={() => void save(preview.confirmation)} onCancel={() => setPreview(null)} />;
  return (
    <form className="rf-stack" onSubmit={submit} noValidate>
      <h1>Your Profile</h1>
      {me.missing.length > 0 && (
        <Notice tone="warning" title="Complete your Profile to use the Workspace.">
          <p>{`Your Profile still needs ${me.missing.map((field) => MISSING_NAMES[field] ?? field).join(', ')}.`}</p>
        </Notice>
      )}
      {form.restored && <RestoredNotice onDiscard={form.discard} />}
      {saved && <Notice tone="success" title="Your Profile was saved." />}
      <SaveFailure error={failure} />
      <TextField label="Display name" required value={values.displayName} onChange={(value) => form.set('displayName', value)} maxLength={80} errors={errors('displayName')}
        hint="1 to 80 characters, different from every other Member’s display name." />
      <fieldset className="rf-field">
        <legend className="rf-field__label">Specialties<span className="rf-field__required"> (required)</span></legend>
        {errors('specialtyIds').length > 0 && <p className="rf-field__error">{errors('specialtyIds').map((issue) => issue.rule).join(' ')}</p>}
        {offered.map((specialty) => (
          <CheckboxField key={specialty.id} label={specialty.retired === true ? `${specialty.name} (retired)` : specialty.name} checked={values.specialtyIds.includes(specialty.id)}
            onChange={(checked) => form.set('specialtyIds', checked ? [...values.specialtyIds, specialty.id] : values.specialtyIds.filter((id) => id !== specialty.id))} />
        ))}
      </fieldset>
      <fieldset className="rf-field">
        <legend className="rf-field__label">Affiliations</legend>
        <p className="rf-field__hint">Up to 5, each up to 200 characters.</p>
        {values.affiliations.map((affiliation, index) => (
          <div className="rf-actions" key={index}>
            <TextField label={`Affiliation ${index + 1}`} value={affiliation} maxLength={200} errors={errors(`affiliations.${index}`)}
              onChange={(value) => form.set('affiliations', values.affiliations.map((entry, at) => (at === index ? value : entry)))} />
            <Button variant="quiet" onClick={() => form.set('affiliations', values.affiliations.filter((_entry, at) => at !== index))}>{`Remove affiliation ${index + 1}`}</Button>
          </div>
        ))}
        {values.affiliations.length < 5 && <Button onClick={() => form.set('affiliations', [...values.affiliations, ''])}>Add an affiliation</Button>}
      </fieldset>
      <TextField label="Short biography" multiline value={values.biography} onChange={(value) => form.set('biography', value)} maxLength={1000} errors={errors('biography')} hint="Up to 1000 characters." />
      <SelectField label="Time zone" required value={values.timeZone} options={timeZones(values.timeZone).map((zone) => ({ value: zone, label: zone }))} placeholder="Choose a time zone"
        onChange={(value) => form.set('timeZone', value)} errors={errors('timeZone')} />
      <CheckboxField label="Public Profile: show my display name, Specialties, affiliations, and biography on the public People page" checked={values.publicProfile}
        onChange={(value) => form.set('publicProfile', value)} errors={errors('publicProfile')} hint="You will see exactly what is published before it is saved." />
      <div className="rf-actions">
        <Button type="submit" variant="primary" disabled={busy}>Save the Profile</Button>
        <Button variant="quiet" onClick={form.discard}>Discard changes</Button>
      </div>
    </form>
  );
}

/** The Licence_Agreement, given with a checkbox that is never preselected; agreements are kept (R46.16). */
export function LicenceAgreementForm({ me, onSaved }: { readonly me: Me; readonly onSaved: () => void }) {
  const client = useApi();
  const [agreed, setAgreed] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const licence = me.contentLicence;
  const given = me.profile?.licence?.agreements ?? [];
  if (licence === null) return <section className="rf-section" aria-label="Content Licence"><h2>Content Licence</h2><p className="rf-meta">No Content Licence is configured yet.</p></section>;
  const current = given.find((agreement) => agreement.licenceName === licence);
  const submit = async () => {
    setFailure(undefined);
    try {
      await client.post('/me/licence-agreement', { agreed: true, licenceName: licence });
      setAgreed(false);
      onSaved();
    } catch (error) {
      setFailure(error);
    }
  };
  return (
    <section className="rf-section" aria-label="Content Licence">
      <h2>Content Licence</h2>
      {given.length > 0 && <ul className="rf-list">{given.map((agreement) => <li key={agreement.licenceName}>{`You agreed to ${agreement.licenceName} on ${agreement.givenOn}.`}</li>)}</ul>}
      {current === undefined && (
        <>
          <SaveFailure error={failure} />
          <CheckboxField label={`I agree that my contributions are published under ${licence}.`} checked={agreed} onChange={setAgreed}
            errors={failure instanceof ApiFailure ? failure.fields : []} />
          <Button variant="primary" disabled={!agreed} onClick={() => void submit()}>Give the agreement</Button>
        </>
      )}
    </section>
  );
}

/** `/me/profile`: the Profile form and the Licence_Agreement. */
export function OwnProfilePage() {
  const { me, refresh } = useSession();
  return (
    <div className="rf-stack">
      <ProfileForm me={me} onSaved={refresh} />
      {me.profile !== null && <LicenceAgreementForm me={me} onSaved={refresh} />}
    </div>
  );
}
