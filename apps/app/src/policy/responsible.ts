import { GuardedBatch } from '@researchforce/db/batch';
import type { MemberStatus, Timestamp, ULID } from '@researchforce/domain/types';
import type { Env } from '../env';
import { recordTargetActivity } from '../activity/flags';
import { notifySystemAlert } from '../notifications/fanout';

/**
 * The Responsible_Person designation and the Revoked-alert cron check (R46.35, R46.37, R46.38, R46.39, R46.40).
 *
 * The Responsible_Person is the workspace setting `responsiblePerson`: exactly one Member at a time, initially the
 * campaign owner, named on the Privacy page whatever that Member's status (R46.35). `apps/app/src/api/routes/settings.ts`
 * validates the designation (only an Administrator may change it, only an active Member may be named, others refused with
 * NO Revision — R46.39) and writes the `settings` row; it then calls {@link recordDesignation} for the side effects a
 * SUCCESSFUL change entails, so the one definition of "what a designation does" lives here and the route never
 * duplicates it.
 *
 * A successful change records a Minor_Edit Revision of the Privacy page holding the PREVIOUS Responsible_Person (R46.37),
 * one Activity_Feed entry (as a Policy_Section change is listed, R46.37/R46.31), and an URGENT publish so the Privacy
 * page names the new person within 5 minutes (R46.38): the publish is flagged urgent exactly as a confidentiality
 * -affecting save is, by advancing the public invalidation epoch in the same batch as the `publish` outbox row
 * (`bumpEpoch`), which preempts any in-flight addition run so the Privacy re-render deploys on the urgent path rather
 * than waiting out the addition-quiet window (the same `bumpEpoch` + `publish` pattern the urgent release-withdrawal
 * path uses).
 */

/** The publish scope that re-renders the Privacy page (its Responsible_Person statement and last-updated date). */
export const PRIVACY_PUBLISH_SCOPE = 'policy:privacy';

/**
 * Record the side effects of a SUCCESSFUL Responsible_Person designation into `batch`: the Minor_Edit Revision of the
 * Privacy page holding the previous person, one Activity_Feed entry, and the URGENT publish (R46.37, R46.38). The
 * caller has already validated the change and written the `settings` row in the same batch, so all of it commits or
 * none of it does. `previous` is the Responsible_Person before the change (a Member id, or null when none was set), kept
 * in the Revision's `prev` so the Privacy page's history shows who it was (R46.37).
 */
export function recordDesignation(batch: GuardedBatch, previous: ULID | null): GuardedBatch {
  // A Minor_Edit Revision of the Privacy page that keeps the previous Responsible_Person (R46.37).
  batch.revision({ targetType: 'policy_page', targetId: 'privacy', kind: 'minor_edit', prev: { responsiblePerson: previous } });
  // One Activity_Feed entry, as a change to a Policy_Section is listed (R46.37, R46.31).
  recordTargetActivity(batch, { kind: 'policy_change', targetType: 'policy_page', targetId: 'privacy' });
  // The URGENT publish: advancing the epoch in the same batch as the `publish` row flags the re-render urgent, so the
  // Privacy page names the new person within 5 minutes rather than waiting out the addition-quiet window (R46.38).
  return batch.outbox('publish', PRIVACY_PUBLISH_SCOPE).bumpEpoch();
}

/** 15 minutes in milliseconds: the deadline for the first Revoked alert after the Responsible_Person becomes Revoked (R46.40). */
export const ALERT_WITHIN_MS = 15 * 60 * 1000;
/** 7 days in milliseconds: the repeat interval while the Responsible_Person stays Revoked (R46.40). */
export const ALERT_REPEAT_MS = 7 * 24 * 60 * 60 * 1000;

/** The Responsible_Person's state at `now`, as the Revoked-alert check reads it from `settings` and `members`. */
export interface ResponsibleState {
  /** The designated Member id, or null when no active designation stands (the setting is unset). */
  readonly id: ULID | null;
  /** The designated Member's status, or null when the setting is unset or names a Member that no longer exists. */
  readonly status: MemberStatus | null;
}

/**
 * Whether the Responsible_Person is Revoked for the purpose of the alert (R46.40): the designation is unset, names a
 * Member that no longer exists, or names a Member whose Member_Status is not Active (Revoked or Pending). While this
 * holds, every Administrator is alerted; once an active Member is designated it becomes false and the alerts stop.
 */
export function isResponsibleRevoked(state: ResponsibleState): boolean {
  return state.status !== 'active';
}

/** Read the current Responsible_Person designation and the named Member's status (null when unset or gone). */
async function readResponsible(env: Env): Promise<ResponsibleState> {
  const setting = await env.RF_CORE.prepare("SELECT value FROM settings WHERE key = 'responsiblePerson'").first<{ value: string }>();
  const id = parseResponsibleId(setting?.value);
  if (id === null) return { id: null, status: null };
  const member = await env.RF_CORE.prepare('SELECT status FROM members WHERE id = ?1').bind(id).first<{ status: MemberStatus }>();
  return { id, status: member?.status ?? null };
}

/** The Member id a stored `responsiblePerson` setting names, or null when unset, null, or malformed. */
function parseResponsibleId(value: string | undefined): ULID | null {
  if (value === undefined) return null;
  try { const parsed = JSON.parse(value) as unknown; return typeof parsed === 'string' ? (parsed as ULID) : null; }
  catch { return null; }
}

/** The alert signature for the current Revoked designation, so a different Responsible_Person starts a fresh cadence. */
function alertKeyFor(id: ULID | null): string {
  return `responsible_person:revoked:${id ?? 'none'}`;
}

/**
 * The quarter-hour Responsible_Person-Revoked check (R46.40). While the Responsible_Person is Revoked (unset, gone, or
 * not Active), create for every Administrator a System_Alert Notification_Event WITHIN 15 minutes of the Member_Status
 * becoming Revoked and REPEAT it every 7 days until an active Member is designated. The check is wired into the
 * every-minute cron, so the first alert lands within a minute of the change — well inside the 15-minute bound — and
 * the repeats land on the 7-day cadence.
 *
 * De-duplication mirrors the RPO-age check (`checkRpoAge`): the last alert is read from the `notification_events` the
 * fan-out already writes, keyed per Responsible_Person signature. A repeated tick creates nothing until 7 days have
 * passed since the last alert for the same signature, so Administrators are not spammed each minute; a change to a
 * different (also Revoked) Responsible_Person is a new signature, so it alerts at once. When an active Member is
 * designated the condition is false, so no alert is created and the cadence naturally resets for any later revocation.
 *
 * The payload is content-free: it names the Responsible_Person's display name (already shown publicly on the Privacy
 * page, R46.35) and the standing instruction, never any research body. Returns 1 when an alert was raised, 0 otherwise.
 */
export async function checkResponsiblePersonRevoked(env: Env, now: Timestamp): Promise<number> {
  const state = await readResponsible(env);
  if (!isResponsibleRevoked(state)) return 0;

  const alertKey = alertKeyFor(state.id);
  // The most recent alert for THIS Revoked signature, so the 7-day repeat is measured from it (R46.40).
  const last = await env.RF_CORE.prepare(
    "SELECT max(at) AS at FROM notification_events WHERE event_type = 'system_alert' AND alert_key = ?1",
  ).bind(alertKey).first<{ at: string | null }>();
  const lastAt = last?.at ?? null;
  // No alert yet for this signature: the person just became Revoked, so alert now (within the minute, inside 15
  // minutes). Otherwise repeat only once 7 days have passed since the last alert.
  if (lastAt !== null && Date.parse(now) - Date.parse(lastAt) < ALERT_REPEAT_MS) return 0;

  const name = state.id === null ? null : await displayNameOf(env, state.id);
  const detail = {
    allowance: name === null
      ? 'No active Responsible Person is designated; an Administrator must designate an active Member as the Responsible Person'
      : `The Responsible Person “${name}” is no longer an active Member; an Administrator must designate an active Member as the Responsible Person`,
    kind: 'responsible_person_revoked', at: now,
  };
  // `notification_events` is a rebuildable, non-snapshotted table, so the alert is exempt from the Internal_Backup
  // write-freeze (as the RPO-age alert is): a backup in flight must not delay the 15-minute bound (R36.14, R46.40).
  const batch = new GuardedBatch(env.RF_CORE, { id: null, now }, { ignoreFreeze: true });
  notifySystemAlert(batch, alertKey, detail);
  await batch.commit();
  return 1;
}

/** The display name of the named Member, for the content-free alert; empty when no Profile row holds one (R46.35). */
async function displayNameOf(env: Env, id: ULID): Promise<string> {
  const row = await env.RF_CORE.prepare('SELECT display_name AS displayName FROM profiles WHERE member_id = ?1').bind(id).first<{ displayName: string | null }>();
  return row?.displayName ?? '';
}
