import { ROLE_IDS } from '@researchforce/domain/permissions';
import { newULID } from '@researchforce/domain/identifiers';
import type { OutsideSubmissionType, Timestamp } from '@researchforce/domain/types';

/**
 * The shared builder for the Outside_Submission Notification_Events that both the public submit endpoint
 * (`rf-submit`, task 34.4) and the Response_Link reply path (`rf-submit`, task 35.3) create, so the two
 * callers fan out to the same recipients by the same rule (R32.3, R32.7, R46.36).
 *
 * The rule: one Outside_Submission event for every Administrator, plus one for the Responsible_Person on a
 * Removal_Request. A Responsible_Person who is also an Administrator gets one event, not two (R46.36). The
 * recipient set is the union of "every Administrator" and, for a Removal_Request, "the Responsible_Person",
 * so the deduplication is a SET-style union; a single INSERT…SELECT over that union makes exactly one row
 * per recipient. Only active Members receive events, as everywhere else (fan-out joins `canRead`, but an
 * Outside_Submission is not an Item, so the only membership test is active status).
 *
 * The events carry no network address, no file bytes, and nothing about the submitted content beyond the
 * Outside_Submission id they point at: the Moderation_Queue reads the submission itself. Each event stores
 * the recipient's email mode in force now (R19.8), defaulting to Immediate when the Member set no preference
 * (R19.9); the mail batching groups them by `os:{id}`. The events are caused by no Member, so `actor_id` is
 * null, exactly as the app's `anonymous` fan-out writes system-caused events.
 *
 * The statements are returned so the caller adds them to the one batch that also stores the Outside_Submission
 * (task 34.4) or attaches the response (task 35.3); the events then commit in the same transaction as the
 * record that caused them.
 */
export interface OutsideEvent {
  readonly outsideSubmissionId: string;
  readonly type: OutsideSubmissionType;
  readonly now: Timestamp;
}

const DEFAULT_EMAIL_MODE = 'immediate';

/**
 * Build the Notification_Event INSERT for one Outside_Submission that was just queued or that just received a
 * Response_Link reply. The single statement selects the recipient set — every Administrator, unioned with the
 * Responsible_Person for a Removal_Request — and inserts one `outside_submission` event per recipient, each
 * with a fresh event id and the recipient's current email mode.
 *
 * The event id is `(timePart || random)` built in SQL, matching the app fan-out's scheme so ids sort by time
 * and never collide within the batch. The Responsible_Person is read from `settings` under `responsiblePerson`
 * (R46.37); when none is set, or the submission is not a Removal_Request, only Administrators are selected.
 */
export function outsideSubmissionEvents(db: D1Database, event: OutsideEvent): D1PreparedStatement {
  const timePart = newULID(event.now).slice(0, 10);
  // The recipient union. Every Administrator always; the Responsible_Person too, and only, for a Removal_Request.
  // The UNION deduplicates, so a Responsible_Person who is also an Administrator appears once (R46.36).
  const responsibleJoin = event.type === 'removal_request'
    ? "UNION SELECT json_extract(value, '$') AS id FROM settings WHERE key = 'responsiblePerson'"
    : '';
  return db
    .prepare(
      `INSERT INTO notification_events (id, member_id, event_type, at, actor_id, outside_submission_id, email_mode)
       SELECT ?1 || upper(hex(randomblob(8))), m.id, 'outside_submission', ?2, NULL, ?3,
         COALESCE((SELECT np.email FROM notification_prefs np WHERE np.member_id = m.id AND np.event_type = 'outside_submission'), ?4)
       FROM members m
       WHERE m.status = 'active' AND m.id IN (
         SELECT id FROM members WHERE role_id = ?5
         ${responsibleJoin}
       )`,
    )
    .bind(timePart, event.now, event.outsideSubmissionId, DEFAULT_EMAIL_MODE, ROLE_IDS.administrator);
}
