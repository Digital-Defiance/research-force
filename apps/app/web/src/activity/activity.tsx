import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { ITEM_KIND_NAMES } from '@researchforce/domain/kind-names';
import { ITEM_KINDS } from '@researchforce/domain/types';
import type { ItemKind } from '@researchforce/domain/types';
import { useApi } from '../api';
import { useSession } from '../session';
import type { Badges, FeedEntry, FeedFilter, FeedItem, FeedPage, FlagKind, MemberRow, ProjectRecord, SubmissionItems } from '../types';
import { Button, formatDate, LoadState, Notice, PersonLink, SaveFailure, SelectField, TextField, useLoad } from '../ui';

/** Raised after flags are cleared, so the counts in the header are read again. */
const FLAGS_CHANGED = 'rf:flags-changed';
/** Units one `POST /views` call reports. */
const VIEWS_PER_CALL = 200;

const FLAG_NAMES: Readonly<Record<FlagKind, string>> = { new: 'New', updated: 'Updated' };
/** An Item carrying the viewer's New_Flag or Updated_Flag is marked as new or updated (R18.10). */
export function FlagMark({ flag }: { readonly flag: FlagKind | null | undefined }) {
  if (flag === null || flag === undefined) return null;
  return <span className={`rf-status rf-status--${flag === 'new' ? 'info' : 'warning'}`}>{FLAG_NAMES[flag]}</span>;
}

/**
 * The flag each Item had when the page first showed it, kept while the page reloads, so that opening an Item
 * clears its flag without hiding the mark from the page that was opened (R18.10).
 */
export function useFlagSnapshot(entries: readonly { readonly id: string; readonly flag?: FlagKind | null | undefined }[]): (id: string) => FlagKind | null {
  const seen = useRef(new Map<string, FlagKind | null>());
  for (const entry of entries) if (!seen.current.has(entry.id)) seen.current.set(entry.id, entry.flag ?? null);
  return useCallback((id: string) => seen.current.get(id) ?? null, []);
}

/**
 * Tell the Worker which Items this page shows, once each, so that their flags clear (R18.3). A failed call leaves the
 * page displayed and the flags in place, and the next load tries again (R18.12).
 */
export function useRecordViews(unitIds: readonly string[] | undefined): void {
  const client = useApi();
  const sent = useRef(new Set<string>());
  const key = unitIds?.join(',');
  useEffect(() => {
    if (unitIds === undefined) return;
    const fresh = unitIds.filter((id) => !sent.current.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) sent.current.add(id);
    void (async () => {
      try {
        for (let start = 0; start < fresh.length; start += VIEWS_PER_CALL) await client.post('/views', { unitIds: fresh.slice(start, start + VIEWS_PER_CALL) });
        globalThis.dispatchEvent(new Event(FLAGS_CHANGED));
      } catch {
        for (const id of fresh) sent.current.delete(id);
      }
    })();
  // `key` stands for the list, which callers rebuild on every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);
}

const BUCKET_NAMES: Readonly<Record<string, string>> = { ...ITEM_KIND_NAMES, attachment: 'Attachment', reply: 'Reply' };
export const bucketName = (bucket: string): string => BUCKET_NAMES[bucket] ?? bucket;
const PLURALS: Readonly<Record<string, string>> = { attachment: 'Attachments', reply: 'Replies' };
const bucketPlural = (bucket: string): string => PLURALS[bucket] ?? `${bucketName(bucket)}s`;
/** One count for each Research_Item kind, one for Attachments, and one for Replies (R18.7). */
const GROUPS: readonly string[] = [...ITEM_KINDS, 'attachment', 'reply'];

/** The Member's flag counts, read again on every page and whenever flags are cleared (R18.7). */
export function useBadges(): Badges | undefined {
  const client = useApi();
  const location = useLocation();
  const [badges, setBadges] = useState<Badges | undefined>(undefined);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const again = () => setGeneration((value) => value + 1);
    globalThis.addEventListener(FLAGS_CHANGED, again);
    return () => globalThis.removeEventListener(FLAGS_CHANGED, again);
  }, []);
  useEffect(() => {
    let current = true;
    client.get<Badges>('/me/badges').then((value) => { if (current) setBadges(value); }, () => undefined);
    return () => { current = false; };
  }, [client, location.key, generation]);
  return badges;
}

/** The counts of New and Updated Items, in the header of every page (R18.7). */
export function ActivityBadges() {
  const badges = useBadges();
  return (
    <div className="rf-badges">
      <Link className="rf-nav__link" to="/activity">{badges === undefined ? 'Activity feed' : `Activity feed (${badges.total})`}</Link>
      {badges !== undefined && (
        <ul className="rf-list rf-meta" aria-label="New and updated Items">
          {GROUPS.map((group) => <li key={group}>{`${bucketPlural(group)}: ${badges.counts[group] ?? 0}`}</li>)}
        </ul>
      )}
    </div>
  );
}

function ItemLink({ item }: { readonly item: FeedItem }) {
  const name = `${bucketName(item.bucket)}${item.identifier === null ? '' : ` ${item.identifier}`}${item.title === null ? '' : `: ${item.title}`}`;
  return <><Link to={`/items/${item.rootId}`}>{name}</Link>{' '}<FlagMark flag={item.flag} /></>;
}

const EVENT_NAMES: Readonly<Record<string, string>> = {
  submission: 'Submission', correction: 'Correction', withdrawal: 'Withdrawal', status_change: 'Status change', disclosure_change: 'Disclosure change',
  dissent: 'Dissent Note', policy_change: 'Policy Page change', journal_import: 'Journal import',
};

function Entry({ entry }: { readonly entry: FeedEntry }) {
  return (
    <li>
      <p>
        <strong>{EVENT_NAMES[entry.kind] ?? entry.kind}</strong>{' by '}<PersonLink person={entry.actor} /><span className="rf-meta">{` on ${formatDate(entry.at)}`}</span>
      </p>
      {entry.items !== null && <ul>{entry.items.map((item) => <li key={item.id}><ItemLink item={item} /></li>)}</ul>}
      {entry.counts !== null && entry.submissionId !== null && (
        <p>
          {Object.entries(entry.counts).map(([bucket, n]) => `${n} ${n === 1 ? bucketName(bucket) : bucketPlural(bucket)}`).join(', ')}{' '}
          <Link to={`/activity/submissions/${entry.submissionId}`}>See all</Link>
        </p>
      )}
      {entry.target?.type === 'project' && <p><Link to={`/projects/${entry.target.id}/history`}>The Project</Link></p>}
    </li>
  );
}

const EMPTY_FILTER: FeedFilter = {};
const queryOf = (filter: FeedFilter, before?: string): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value) params.set(key, value);
  if (before !== undefined) params.set('before', before);
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
};

/** The Activity_Feed: newest first, 50 entries a page, with filters and "Mark all as seen" (R18.5, R18.8, R18.9, R39.14). */
export function FeedScreen() {
  const client = useApi();
  const session = useSession();
  const members = useLoad<{ members: MemberRow[] }>('/members');
  const projects = useLoad<{ projects: ProjectRecord[] }>('/projects');
  const [filter, setFilter] = useState<FeedFilter>(EMPTY_FILTER);
  const [entries, setEntries] = useState<readonly FeedEntry[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [openedAt, setOpenedAt] = useState<string | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [loaded, setLoaded] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let current = true;
    setLoaded(false);
    client.get<FeedPage>(`/feed${queryOf(filter)}`).then(
      (page) => { if (current) { setEntries(page.entries); setNext(page.next); setOpenedAt(page.openedAt); setError(undefined); setLoaded(true); } },
      (reason: unknown) => { if (current) setError(reason); },
    );
    return () => { current = false; };
  }, [client, filter, generation]);
  const more = async () => {
    try {
      const page = await client.get<FeedPage>(`/feed${queryOf(filter, next ?? undefined)}`);
      setEntries((shown) => [...shown, ...page.entries]);
      setNext(page.next);
    } catch (reason) {
      setFailure(reason);
    }
  };
  const markSeen = async () => {
    setFailure(undefined);
    try {
      const chosen = Object.fromEntries(Object.entries(filter).filter(([, value]) => value));
      await client.post('/feed/mark-seen', { openedAt, ...(Object.keys(chosen).length === 0 ? {} : { filter: chosen }) });
      globalThis.dispatchEvent(new Event(FLAGS_CHANGED));
      setGeneration((value) => value + 1);
    } catch (reason) {
      setFailure(reason);
    }
  };
  const set = (key: keyof FeedFilter) => (value: string) => setFilter((current) => ({ ...current, [key]: value === '' ? undefined : value }));
  const others = useMemo(() => (members.data?.members ?? []).filter((member) => member.status !== 'pending'), [members.data]);
  return (
    <div className="rf-stack">
      <h1>Activity feed</h1>
      <form className="rf-stack" aria-label="Filter the Activity feed" onSubmit={(event) => event.preventDefault()}>
        <SelectField label="Kind of record" value={filter.itemKind ?? ''} placeholder="Any kind" options={ITEM_KINDS.map((kind: ItemKind) => ({ value: kind, label: ITEM_KIND_NAMES[kind] }))} onChange={set('itemKind')} />
        <SelectField label="Member who acted" value={filter.actor ?? ''} placeholder="Any Member" options={others.map((member) => ({ value: member.id, label: member.displayName ?? member.email }))} onChange={set('actor')} />
        <SelectField label="Specialty of the Member who acted" value={filter.specialty ?? ''} placeholder="Any Specialty" options={session.me.specialtyOptions.map((specialty) => ({ value: specialty.id, label: specialty.name }))} onChange={set('specialty')} />
        <SelectField label="Project" value={filter.project ?? ''} placeholder="Any Project" options={(projects.data?.projects ?? []).map((project) => ({ value: project.id, label: project.name }))} onChange={set('project')} />
        <TextField label="From (including this date)" type="date" value={filter.from ?? ''} onChange={set('from')} />
        <TextField label="To (including this date)" type="date" value={filter.to ?? ''} onChange={set('to')} />
      </form>
      <SaveFailure error={failure} />
      <div className="rf-actions"><Button onClick={() => void markSeen()} disabled={!loaded}>Mark all as seen</Button></div>
      {!loaded ? <LoadState error={error} /> : entries.length === 0 ? <p className="rf-meta">No entries match.</p> : (
        <ol className="rf-list" aria-label="Entries, newest first">{entries.map((entry) => <Entry key={entry.id} entry={entry} />)}</ol>
      )}
      {loaded && next !== null && <div className="rf-actions"><Button onClick={() => void more()}>Show older entries</Button></div>}
    </div>
  );
}

/** The full list of the Items of a Submission that a feed entry only counted (R18.8). */
export function SubmissionItemsScreen({ id }: { readonly id: string }) {
  const loaded = useLoad<SubmissionItems>(`/feed/submissions/${id}`);
  if (!loaded.data) return <LoadState error={loaded.error} />;
  const { submission, items } = loaded.data;
  return (
    <div className="rf-stack">
      <h1>Submission</h1>
      <p>{'By '}<PersonLink person={submission.actor} /><span className="rf-meta">{` on ${formatDate(submission.at)}`}</span></p>
      {items.length === 0 ? <Notice title="This Submission has no Items you can read." /> : (
        <ul className="rf-list" aria-label="Items of the Submission">{items.map((item) => <li key={item.id}><ItemLink item={item} /></li>)}</ul>
      )}
      <p><Link to="/activity">Back to the Activity feed</Link></p>
    </div>
  );
}
