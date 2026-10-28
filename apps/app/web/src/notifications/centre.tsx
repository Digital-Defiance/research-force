import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ITEM_KIND_NAMES } from '@researchforce/domain/kind-names';
import type { ItemKind } from '@researchforce/domain/types';
import { FLAGS_CHANGED } from '../activity/activity';
import { useApi } from '../api';
import type { NotificationConcerned, NotificationEntry, NotificationPage } from '../types';
import { Button, formatDate, LoadState, Notice, PersonLink, SaveFailure, useLoad } from '../ui';

const EVENT_NAMES: Readonly<Record<string, string>> = {
  new_submission: 'New Submission', item_update: 'Item update', reply: 'Reply', mention: 'Mention', review_requested: 'Review requested',
  review_completed: 'Review completed', outside_submission: 'Outside Submission', reminder: 'Reminder', system_alert: 'System alert', dissent: 'Dissent Note',
};
const kindName = (kind: string | null): string => (kind !== null && kind in ITEM_KIND_NAMES ? ITEM_KIND_NAMES[kind as ItemKind] : 'Record');

/** Where opening the Notification leads: its Root_Item, the Group_Note in it, the list of Root_Items, or nowhere (R19.7, R41.10). */
export function destinationOf(entry: NotificationEntry): string | null {
  const only = entry.itemCount === 1 ? entry.items[0] : undefined;
  if (entry.groupNote?.rootId && entry.groupNote.replyId) return `/items/${entry.groupNote.rootId}#reply-${entry.groupNote.replyId}`;
  if (only !== undefined && only.deleted === undefined) return `/items/${only.id}`;
  if (entry.itemCount > 1 && entry.submissionId !== null) return `/activity/submissions/${entry.submissionId}`;
  return null;
}

function Concerns({ entry }: { readonly entry: NotificationEntry }) {
  if (entry.alert) return <p>{`System alert: ${entry.alert.key}`}</p>;
  if (entry.outsideSubmission) return <p>{`An Outside Submission (${entry.outsideSubmission.type})`}</p>;
  if (entry.itemCount === 0) return <p className="rf-meta">The records are no longer available to you.</p>;
  if (entry.itemCount > 1) return <p>{`${entry.itemCount} records`}</p>;
  const item = entry.items[0] as NotificationConcerned | undefined;
  if (item === undefined) return <p>1 record</p>;
  if (item.deleted) {
    return <p>{`${kindName(item.kind)}${item.identifier ? ` ${item.identifier}` : ''} was permanently deleted on ${formatDate(item.deleted.at)}: ${item.deleted.reason}`}</p>;
  }
  return <p>{`${kindName(item.kind)}${item.identifier ? ` ${item.identifier}` : ''}${item.title ? `: ${item.title}` : ''}`}</p>;
}

function Entry({ entry, onOpened }: { readonly entry: NotificationEntry; readonly onOpened: (id: string) => void }) {
  const client = useApi();
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>(undefined);
  const destination = destinationOf(entry);
  const open = async () => {
    try {
      if (!entry.read) await client.post(`/notifications/${entry.id}/read`, {});
      onOpened(entry.id);
      if (destination !== null) await navigate(destination);
    } catch (failure) {
      setError(failure);
    }
  };
  return (
    <li>
      <article className="rf-companion" aria-label={`Notification: ${entry.types.map((type) => EVENT_NAMES[type] ?? type).join(', ')}`}>
        <p>
          {!entry.read && <><span className="rf-status rf-status--info">Unread</span>{' '}</>}
          <strong>{entry.types.map((type) => EVENT_NAMES[type] ?? type).join(', ')}</strong>
          {entry.actor && <>{' by '}<PersonLink person={entry.actor} /></>}
          <span className="rf-meta">{` on ${formatDate(entry.at)}`}</span>
        </p>
        {entry.groupNote && <p className="rf-meta">Includes a Group Note.</p>}
        <Concerns entry={entry} />
        <div className="rf-actions">
          <Button variant="quiet" onClick={() => { void open(); }}>{destination === null ? (entry.read ? 'Read' : 'Mark as read') : 'Open'}</Button>
        </div>
        {error !== undefined && <SaveFailure error={error} />}
      </article>
    </li>
  );
}

/** The Notification_Centre: the Member's Notifications newest first, with a page at a time (R19.11, R19.12). */
export function NotificationCentre() {
  const client = useApi();
  const first = useLoad<NotificationPage>('/notifications');
  const [more, setMore] = useState<readonly NotificationEntry[]>([]);
  const [next, setNext] = useState<string | null | undefined>(undefined);
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<unknown>(undefined);
  if (!first.data) return <LoadState error={first.error} />;
  const cursor = next === undefined ? first.data.next : next;
  const entries = [...first.data.notifications, ...more].map((entry) => (opened.has(entry.id) ? { ...entry, read: true } : entry));
  const older = async () => {
    try {
      const page = await client.get<NotificationPage>(`/notifications?before=${cursor}`);
      setMore((current) => [...current, ...page.notifications]);
      setNext(page.next);
    } catch (failure) {
      setError(failure);
    }
  };
  return (
    <div className="rf-stack">
      <h1>Notifications</h1>
      {entries.length === 0 ? <Notice title="You have no notifications." /> : (
        <ul className="rf-list">
          {entries.map((entry) => (
            <Entry key={entry.id} entry={entry} onOpened={(id) => { setOpened((current) => new Set(current).add(id)); globalThis.dispatchEvent(new Event(FLAGS_CHANGED)); }} />
          ))}
        </ul>
      )}
      {cursor !== null && <div className="rf-actions"><Button variant="quiet" onClick={() => { void older(); }}>Show older notifications</Button></div>}
      {error !== undefined && <SaveFailure error={error} />}
      <p><Link to="/me/preferences">Notification settings</Link></p>
    </div>
  );
}
