import { canRead } from '@researchforce/db/access';
import { ITEM_KIND_NAMES } from '@researchforce/domain/kind-names';
import { BUILT_IN_VALUE_IDS } from '@researchforce/domain/value-sets';
import type { EventType, ItemKind, Level, Timestamp, ULID } from '@researchforce/domain/types';
import { lessPublic } from '@researchforce/kernel/effective';
import { composeEmail } from '@researchforce/public-render/email/compose';
import type { EmailEntry } from '@researchforce/public-render/email/compose';
import type { EmailMessage } from './provider';

/** What a queued notification email is made from, read when it is sent (R20.6). */
interface BatchRow { id: ULID; memberId: ULID; groupKey: string; email: string; status: string; name: string | null; zone: string | null }
interface EventRow {
  id: ULID; type: EventType; at: Timestamp; actorName: string | null; rootId: ULID | null; submissionId: ULID | null; outsideSubmissionId: ULID | null;
  alertKey: string | null; detail: string | null;
}
interface RootRow {
  id: ULID; kind: ItemKind; title: string; summary: string | null; status: string | null; scope: string | null; line: string | null;
  own: Level; project: Level; restricted: number; readable: number;
}

export const EVENT_NAMES: Readonly<Record<EventType, string>> = {
  new_submission: 'New Submission', item_update: 'Item update', reply: 'Reply', mention: 'Mention', review_requested: 'Review requested',
  review_completed: 'Review completed', outside_submission: 'Outside Submission', reminder: 'Reminder', system_alert: 'System alert', dissent: 'Dissent Note',
};
const CHANGE_NAMES: Readonly<Record<string, string>> = { correction: 'Correction', withdrawal: 'Withdrawal', status_change: 'Status change', disclosure_change: 'Disclosure change', access: 'Access change' };

const parsed = <T>(value: string | null): T | null => { try { return value === null ? null : JSON.parse(value) as T; } catch { return null; } };

/** The time in the recipient's zone, as "27 Oct 2026, 18:00 (Europe/Berlin)". */
export function timeIn(at: Timestamp, zone: string): string {
  const text = new Intl.DateTimeFormat('en-GB', { timeZone: zone, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));
  return `${text} (${zone})`;
}

/** An Item as its Public_View allows: the title when Public, the Disclosure_Line when Withheld, only its kind otherwise (R20.6). */
function describe(root: RootRow): { heading: string; notes: string[] } {
  const level: Level = root.restricted === 1 ? 'not_published' : lessPublic(root.own, root.project);
  const kind = ITEM_KIND_NAMES[root.kind];
  if (level === 'public') {
    const notes = root.summary ? [root.summary] : [];
    if (root.kind === 'hypothesis' && root.status === BUILT_IN_VALUE_IDS.hypothesisEliminated && root.scope) notes.push(`Elimination scope: ${root.scope}`);
    return { heading: `${kind}: ${root.title}`, notes };
  }
  if (level === 'withheld') {
    const line = parsed<{ kindOfMaterial: string; date: { value: string }; note?: string }>(root.line);
    return { heading: line ? `${kind} (withheld): ${line.kindOfMaterial}, ${line.date.value}${line.note ? `. ${line.note}` : ''}` : `${kind} (withheld)`, notes: [] };
  }
  return { heading: kind, notes: [] };
}


export interface Composed { readonly message: EmailMessage; readonly roots: readonly ULID[] }

/**
 * Compose a queued notification email from the Public_Views current now. Roots the recipient can no longer read or that were
 * deleted are left out; an email left with nothing is dropped (`null`), as is one for a recipient who is no longer active (R20.8).
 */
export async function composeBatch(db: D1Database, origin: string, batchId: string): Promise<Composed | null> {
  const batch = await db.prepare(
    `SELECT b.id, b.member_id AS memberId, b.group_key AS groupKey, m.email, m.status, p.display_name AS name, p.time_zone AS zone
      FROM email_batches b JOIN members m ON m.id = b.member_id LEFT JOIN profiles p ON p.member_id = b.member_id WHERE b.id = ?1`,
  ).bind(batchId).first<BatchRow>();
  if (batch === null || batch.status !== 'active') return null;
  const zone = batch.zone ?? 'UTC';
  const { results: events } = await db.prepare(
    `SELECT e.id, e.event_type AS type, e.at, ap.display_name AS actorName, e.root_id AS rootId, e.submission_id AS submissionId, e.outside_submission_id AS outsideSubmissionId,
        e.alert_key AS alertKey, e.detail
      FROM notification_events e LEFT JOIN profiles ap ON ap.member_id = e.actor_id WHERE e.email_batch_id = ?1 ORDER BY e.id`,
  ).bind(batchId).all<EventRow>();
  const detailOf = (event: EventRow) => parsed<{ roots?: ULID[]; count?: number; changes?: string[]; change?: string; reminder?: string; days?: number; percent?: number; allowance?: string; replyId?: ULID; type?: string }>(event.detail) ?? {};
  const rootIds = [...new Set(events.flatMap((event) => [...(event.rootId === null ? [] : [event.rootId]), ...(detailOf(event).roots ?? [])]))];
  const { results: roots } = await db.prepare(
    `SELECT u.id, ri.kind, ri.title, ri.public_summary AS summary, ri.status_value_id AS status, hy.elimination_scope AS scope, u.disclosure_line AS line,
        u.disclosure_level AS own, pr.disclosure_level AS project, CASE WHEN ri.access_level = 'restricted' THEN 1 ELSE 0 END AS restricted,
        ${canRead('?2', 'u.id')} AS readable
      FROM json_each(?1) j JOIN units u ON u.id = j.value JOIN research_items ri ON ri.unit_id = u.id JOIN projects pr ON pr.id = u.project_id
        LEFT JOIN hypotheses hy ON hy.unit_id = u.id
      WHERE NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = u.id)`,
  ).bind(JSON.stringify(rootIds), batch.memberId).all<RootRow>();
  const available = new Map(roots.filter((root) => root.readable === 1).map((root) => [root.id, root]));
  const noteIds = [...new Set(events.flatMap((event) => (event.submissionId === null ? [] : [event.submissionId])))];
  const { results: notes } = await db.prepare(
    `SELECT u.submission_id AS submissionId, u.id, u.root_id AS rootId, r.text, u.disclosure_level AS own
      FROM units u JOIN replies r ON r.unit_id = u.id JOIN submissions s ON s.id = u.submission_id
      WHERE s.has_group_note = 1 AND u.submission_id IN (SELECT value FROM json_each(?1)) AND u.position = 0 AND u.unit_type = 'reply'`,
  ).bind(JSON.stringify(noteIds)).all<{ submissionId: ULID; id: ULID; rootId: ULID; text: string; own: Level }>();

  const entries: EmailEntry[] = [];
  const byRoot = new Map<ULID, string[]>();
  const rootNotes = new Map<ULID, string[]>();
  const noteLinks = new Map<ULID, string>();
  const extras: EmailEntry[] = [];
  for (const event of events) {
    const detail = detailOf(event);
    const who = event.actorName === null ? '' : ` by ${event.actorName}`;
    const when = timeIn(event.at, zone);
    const label = event.type === 'item_update' && (detail.changes ?? (detail.change ? [detail.change] : [])).length > 0
      ? (detail.changes ?? [detail.change!]).map((change) => CHANGE_NAMES[change] ?? change).join(', ')
      : EVENT_NAMES[event.type];
    const line = `${label}${who}, ${when}`;
    const named = [...new Set([...(event.rootId === null ? [] : [event.rootId]), ...(detail.roots ?? [])])].filter((id) => available.has(id));
    if (event.type === 'new_submission') {
      for (const note of notes.filter((entry) => entry.submissionId === event.submissionId && available.has(entry.rootId))) {
        const effective = lessPublic(note.own, lessPublic(available.get(note.rootId)!.own, available.get(note.rootId)!.project));
        const shown = available.get(note.rootId)!.restricted === 1 ? 'not_published' : effective;
        rootNotes.set(note.rootId, [...(rootNotes.get(note.rootId) ?? []), shown === 'public' ? `Group Note: ${note.text}` : 'This Submission includes a Group Note.']);
        noteLinks.set(note.rootId, `${origin}/go/${note.rootId}~${note.id}`);
      }
    }
    if (named.length > 0) {
      for (const id of named) byRoot.set(id, [...(byRoot.get(id) ?? []), line]);
    } else if (event.rootId === null && (detail.roots?.length ?? 0) === 0) {
      if (event.type === 'system_alert' || event.type === 'reminder') {
        const text = event.type === 'system_alert' ? `${detail.allowance ?? event.alertKey ?? 'An alert'}${detail.percent === undefined ? '' : `: ${detail.percent}% used`}` : (detail.reminder ?? event.alertKey ?? 'A reminder');
        extras.push({ heading: EVENT_NAMES[event.type], lines: [`${text}, ${when}`], url: `${origin}/notifications` });
      } else if (event.outsideSubmissionId !== null) {
        const days = detail.days === undefined ? '' : `, ${detail.days} days since receipt`;
        extras.push({ heading: 'Outside Submission', lines: [`${detail.type ?? 'Submission'}, ${when}${days}`], url: `${origin}/notifications` });
      }
    }
  }
  for (const [id, lines] of byRoot) {
    const { heading, notes: companion } = describe(available.get(id)!);
    entries.push({ heading, lines, notes: [...companion, ...(rootNotes.get(id) ?? [])], url: noteLinks.get(id) ?? `${origin}/go/${id}` });
  }
  entries.push(...extras);
  if (entries.length === 0) return null;
  const digest = batch.groupKey.startsWith('digest:');
  const subject = digest ? 'Your daily digest' : entries.length === 1 && events.length === 1 ? EVENT_NAMES[events[0]!.type] : `${events.length} updates`;
  const composed = composeEmail({
    subject, ...(batch.name ? { intro: `Hello ${batch.name},` } : {}), entries, preferencesUrl: `${origin}/me/preferences`,
  });
  return { message: { to: batch.email, subject: composed.subject, html: composed.html, text: composed.text }, roots: [...byRoot.keys()] };
}

