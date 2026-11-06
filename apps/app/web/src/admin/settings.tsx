import { useState } from 'react';
import { ApiFailure, useApi } from '../api';
import { useSession } from '../session';
import type { MemberRow } from '../types';
import { Button, LoadState, Notice, SaveFailure, SelectField, TextField, formatDate, useLoad } from '../ui';
import { SETTING_NAMES } from './labels';

/** One workspace-wide setting with its value, default, allowed range, and who last changed it (R46.37). */
interface SettingView {
  readonly value: unknown;
  readonly default: unknown;
  readonly allowed: string;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
}
type Settings = Readonly<Record<string, SettingView>>;

/** The display of a setting's value: scalars as text, structured values as their JSON so nothing is hidden. */
const showValue = (value: unknown): string => (typeof value === 'object' && value !== null ? JSON.stringify(value) : value === null ? 'none' : String(value));
/** The allowed range a refusal named for one setting, from `details.allowed` (R46.37). */
const allowedOf = (failure: unknown, key: string): string | undefined => (failure instanceof ApiFailure ? (failure.details as { allowed?: Record<string, string> } | undefined)?.allowed?.[key] : undefined);

/** One scalar setting the Administrator can edit as text, saved on its own so a refusal names only its range. */
function ScalarSetting({ name, setting, settingKey, onSaved }: { readonly name: string; readonly setting: SettingView; readonly settingKey: string; readonly onSaved: () => void }) {
  const client = useApi();
  const isBoolean = typeof setting.value === 'boolean';
  const isNumber = typeof setting.value === 'number';
  const [draft, setDraft] = useState(isBoolean ? String(setting.value) : showValue(setting.value));
  const [failure, setFailure] = useState<unknown>(undefined);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    setFailure(undefined); setSaved(false);
    // A number setting sends a number so its range check applies; a boolean sends true or false; others send the text.
    const parsed: unknown = isBoolean ? draft === 'true' : isNumber ? (draft.trim() === '' || Number.isNaN(Number(draft)) ? draft : Number(draft)) : draft;
    try {
      await client.put('/settings', { [settingKey]: parsed });
      setSaved(true);
      onSaved();
    } catch (error) { setFailure(error); }
  };

  const errors = failure instanceof ApiFailure ? failure.issuesFor(settingKey) : [];
  const allowed = allowedOf(failure, settingKey);
  return (
    <section className="rf-section" aria-label={name}>
      <h3>{name}</h3>
      <p className="rf-meta">{`Allowed: ${setting.allowed}. Default: ${showValue(setting.default)}.`}</p>
      {setting.updatedAt !== null && <p className="rf-meta">{`Last changed ${formatDate(setting.updatedAt)}.`}</p>}
      <SaveFailure error={failure} />
      {allowed !== undefined && <Notice tone="warning" title={`This value is outside the allowed range: ${allowed}. Nothing was changed.`} />}
      {isBoolean
        ? <SelectField label={`${name} value`} value={draft} options={[{ value: 'true', label: 'On' }, { value: 'false', label: 'Off' }]} onChange={setDraft} errors={errors} />
        : <TextField label={`${name} value`} value={draft} onChange={setDraft} errors={errors} hint={setting.allowed} />}
      <div className="rf-actions">
        <Button variant="primary" onClick={() => void save()}>{`Save the ${name.toLowerCase()}`}</Button>
      </div>
      {saved && <Notice tone="success" title="The setting was saved." />}
    </section>
  );
}

/** The Responsible_Person control: an Administrator designates one active Member as the Responsible_Person (R46.37, R46.39). */
function ResponsiblePerson({ setting, members, onSaved }: { readonly setting: SettingView; readonly members: readonly MemberRow[]; readonly onSaved: () => void }) {
  const client = useApi();
  const active = members.filter((member) => member.status === 'active');
  const [choice, setChoice] = useState<string>(typeof setting.value === 'string' ? setting.value : '');
  const [failure, setFailure] = useState<unknown>(undefined);
  const [saved, setSaved] = useState(false);
  const save = async () => {
    setFailure(undefined); setSaved(false);
    try {
      await client.put('/settings', { responsiblePerson: choice });
      setSaved(true);
      onSaved();
    } catch (error) { setFailure(error); }
  };
  const errors = failure instanceof ApiFailure ? failure.issuesFor('responsiblePerson') : [];
  const current = members.find((member) => member.id === setting.value);
  return (
    <section className="rf-section" aria-label="Responsible person">
      <h3>Responsible person</h3>
      <p className="rf-meta">The person named on the Privacy page as responsible for the platform and its processing of personal data. Must be an active Member.</p>
      {current !== undefined && <p>{`Currently: ${current.displayName ?? current.email}.`}</p>}
      <SaveFailure error={failure} />
      <SelectField
        label="Responsible person (active Member)"
        value={choice}
        placeholder="Choose an active Member"
        options={active.map((member) => ({ value: member.id, label: member.displayName ?? member.email }))}
        onChange={setChoice}
        errors={errors}
      />
      <div className="rf-actions">
        <Button variant="primary" onClick={() => void save()} disabled={choice === '' || choice === setting.value}>Designate the responsible person</Button>
      </div>
      {saved && <Notice tone="success" title="The responsible person was changed." />}
    </section>
  );
}

/**
 * `/admin/settings`: every workspace-wide setting with its allowed range, saved one at a time so one invalid value is
 * refused whole showing its range, and the Responsible_Person control for Administrators (R46.37, R46.39).
 */
export function SettingsScreen() {
  const { can } = useSession();
  const canEdit = can('settings.edit');
  const settings = useLoad<{ settings: Settings }>('/settings');
  const members = useLoad<{ members: MemberRow[] }>('/members');
  if (!settings.data || !members.data) return <LoadState error={settings.error ?? members.error} />;
  const reload = () => settings.reload();
  const entries = Object.entries(settings.data.settings).filter(([key]) => key !== 'responsiblePerson');
  const responsible = settings.data.settings['responsiblePerson'];
  return (
    <div className="rf-stack">
      <h1>Workspace settings</h1>
      {!canEdit && <Notice tone="neutral" title="Your Role does not permit changing settings. You can read each setting and its allowed range below." />}
      {responsible !== undefined && (canEdit
        ? <ResponsiblePerson setting={responsible} members={members.data.members} onSaved={reload} />
        : <section className="rf-section" aria-label="Responsible person"><h3>Responsible person</h3><p className="rf-meta">{`Allowed: ${responsible.allowed}.`}</p></section>)}
      {entries.map(([key, setting]) => (canEdit
        ? <ScalarSetting key={key} settingKey={key} name={SETTING_NAMES[key as keyof typeof SETTING_NAMES] ?? key} setting={setting} onSaved={reload} />
        : (
          <section key={key} className="rf-section" aria-label={SETTING_NAMES[key as keyof typeof SETTING_NAMES] ?? key}>
            <h3>{SETTING_NAMES[key as keyof typeof SETTING_NAMES] ?? key}</h3>
            <p className="rf-meta">{`Value: ${showValue(setting.value)}. Allowed: ${setting.allowed}.`}</p>
          </section>
        )))}
    </div>
  );
}
