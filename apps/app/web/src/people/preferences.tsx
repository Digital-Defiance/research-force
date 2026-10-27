import { useState } from 'react';
import type { FormEvent } from 'react';
import type { EMAIL_MODES } from '@researchforce/db/schema/core';
import { EVENT_TYPES } from '@researchforce/domain/types';
import type { EventType } from '@researchforce/domain/types';
import { ApiFailure, useApi } from '../api';
import { usePersistentForm } from '../persist';
import { useSession } from '../session';
import type { EventPreference, Me, ProjectRecord } from '../types';
import { Button, CheckboxField, LoadState, Notice, RestoredNotice, SaveFailure, SelectField, useLoad } from '../ui';

type EmailMode = typeof EMAIL_MODES[number];
const EMAIL_MODE_NAMES: Readonly<Record<EmailMode, string>> = { immediate: 'Immediately', daily_digest: 'In the Daily Digest', off: 'Off' };
const EVENT_TYPE_NAMES: Readonly<Record<EventType, string>> = {
  new_submission: 'New Submissions', item_update: 'Updates to Items', reply: 'Replies', mention: 'Mentions', review_requested: 'Review requests',
  review_completed: 'Completed reviews', outside_submission: 'Outside Submissions', reminder: 'Reminders', system_alert: 'System Alerts', dissent: 'Dissent Notes',
};
const HOURS = Array.from({ length: 24 }, (_unused, hour) => ({ value: String(hour), label: `${String(hour).padStart(2, '0')}:00` }));

interface PreferenceValues { readonly events: Readonly<Record<string, EventPreference>>; readonly dailyDigestHour: number }

/** A Notification_Preference for each Event_Type and the Daily_Digest hour, applied to events created afterwards (R19.8, R20.13). */
export function PreferencesForm({ me, onSaved }: { readonly me: Me; readonly onSaved: () => void }) {
  const client = useApi();
  const form = usePersistentForm<PreferenceValues>('me:preferences', () => ({ events: me.preferences.events, dailyDigestHour: me.preferences.dailyDigestHour }));
  const [failure, setFailure] = useState<unknown>(undefined);
  const [saved, setSaved] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFailure(undefined);
    setSaved(false);
    try {
      await client.put('/me/preferences', form.values);
      form.sent();
      setSaved(true);
      onSaved();
    } catch (error) {
      setFailure(error);
    }
  };
  const setEvent = (type: EventType, change: Partial<EventPreference>) => {
    const current = form.values.events[type] ?? { inApp: true, email: 'immediate' };
    form.set('events', { ...form.values.events, [type]: { ...current, ...change } });
  };
  return (
    <form className="rf-stack" onSubmit={(event) => void submit(event)} noValidate>
      <h2>Notifications</h2>
      {form.restored && <RestoredNotice onDiscard={form.discard} />}
      {saved && <Notice tone="success" title="Your notification settings were saved. They apply to events from now on." />}
      <SaveFailure error={failure} />
      <div className="rf-table-scroll">
        <table className="rf-table">
          <thead><tr><th scope="col">Event</th><th scope="col">In the Workspace</th><th scope="col">By email</th></tr></thead>
          <tbody>
            {EVENT_TYPES.map((type) => {
              const preference = form.values.events[type] ?? { inApp: true, email: 'immediate' };
              return (
                <tr key={type}>
                  <th scope="row">{EVENT_TYPE_NAMES[type]}</th>
                  <td><CheckboxField label={`${EVENT_TYPE_NAMES[type]} in the Workspace`} checked={preference.inApp} onChange={(inApp) => setEvent(type, { inApp })} /></td>
                  <td>
                    <SelectField label={`${EVENT_TYPE_NAMES[type]} by email`} value={preference.email} onChange={(email) => setEvent(type, { email })}
                      options={Object.entries(EMAIL_MODE_NAMES).map(([value, label]) => ({ value, label }))} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <SelectField label="Daily Digest hour" value={String(form.values.dailyDigestHour)} options={HOURS} onChange={(hour) => form.set('dailyDigestHour', Number(hour))}
        hint={`In your Profile’s time zone (${me.profile?.timeZone ?? 'not set'}).`} errors={failure instanceof ApiFailure ? failure.issuesFor('dailyDigestHour') : []} />
      <div className="rf-actions">
        <Button type="submit" variant="primary">Save notification settings</Button>
        <Button variant="quiet" onClick={form.discard}>Discard changes</Button>
      </div>
    </form>
  );
}

/** Add Projects to, and remove them from, the Member's own Muted_Projects (R39.10). */
export function MutedProjectsForm({ me, projects, onSaved }: { readonly me: Me; readonly projects: readonly ProjectRecord[]; readonly onSaved: () => void }) {
  const client = useApi();
  const form = usePersistentForm<{ projectIds: readonly string[] }>('me:mutes', () => ({ projectIds: me.mutedProjectIds }));
  const [failure, setFailure] = useState<unknown>(undefined);
  const [saved, setSaved] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFailure(undefined);
    setSaved(false);
    try {
      await client.put('/me/mutes', form.values);
      form.sent();
      setSaved(true);
      onSaved();
    } catch (error) {
      setFailure(error);
    }
  };
  const ids = form.values.projectIds;
  return (
    <form className="rf-stack" onSubmit={(event) => void submit(event)} noValidate>
      <h2>Muted Projects</h2>
      <p className="rf-meta">Notifications about a muted Project stop from the time you save. New Projects are never muted until you mute them.</p>
      {form.restored && <RestoredNotice onDiscard={form.discard} />}
      {saved && <Notice tone="success" title="Your Muted Projects were saved." />}
      <SaveFailure error={failure} />
      {projects.length === 0 ? <p className="rf-meta">No Project exists yet.</p> : projects.map((project) => (
        <CheckboxField key={project.id} label={`Mute ${project.name}`} checked={ids.includes(project.id)}
          onChange={(checked) => form.set('projectIds', checked ? [...ids, project.id] : ids.filter((id) => id !== project.id))} />
      ))}
      <Button type="submit" variant="primary">Save Muted Projects</Button>
    </form>
  );
}

/** `/me/preferences`. */
export function PreferencesPage() {
  const { me, refresh } = useSession();
  const projects = useLoad<{ projects: ProjectRecord[] }>('/projects');
  return (
    <div className="rf-stack">
      <h1>Notification settings</h1>
      <PreferencesForm me={me} onSaved={refresh} />
      {projects.data ? <MutedProjectsForm me={me} projects={projects.data.projects} onSaved={refresh} /> : <LoadState error={projects.error} />}
    </div>
  );
}
