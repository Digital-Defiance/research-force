import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { ITEM_KIND_NAMES } from '@researchforce/domain/kind-names';
import { ITEM_KINDS } from '@researchforce/domain/types';
import type { ItemKind } from '@researchforce/domain/types';
import { FlagMark, useFlagSnapshot, useRecordViews } from '../activity/activity';
import { ApiFailure, useApi } from '../api';
import type { FieldIssue } from '../api';
import { RichTextView } from '../editor/RichTextView';
import { useSession } from '../session';
import type {
  CreditDisplayView, LogEntryView, LogFilters, LogItemEntryView, LogPageView, MemberRow, PartialDateView, ProjectRecord, ValueSets,
} from '../types';
import { Button, formatDate, Notice, PersonLink, SelectField, TextField, useLoad } from '../ui';

/** A Project_Log whose page has not arrived after this long is reported as unavailable (R43.9). */
export const LOG_TIMEOUT_MS = 10_000;
const FILTER_KEYS = ['itemKind', 'member', 'specialty', 'from', 'to'] as const;

/** The order and filters in the address, so that they survive a reload and the Back button (R43.8). */
const filtersOf = (params: URLSearchParams): LogFilters =>
  Object.fromEntries(FILTER_KEYS.flatMap((key) => (params.get(key) ? [[key, params.get(key)!]] : [])));
const reversedOf = (params: URLSearchParams): boolean => params.get('order') === 'oldest';

/** The request query for one page, keeping the chosen order and filters and adding the cursor (R43.6, R43.8). */
const queryOf = (reversed: boolean, filters: LogFilters, cursor?: string): string => {
  const params = new URLSearchParams();
  if (reversed) params.set('order', 'oldest');
  for (const key of FILTER_KEYS) if (filters[key]) params.set(key, filters[key]!);
  if (cursor !== undefined) params.set('cursor', cursor);
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
};

const formatPartial = (date: PartialDateView): string => (date.approx ? `about ${date.value}` : date.value);

function Credit({ credit }: { readonly credit: readonly CreditDisplayView[] }) {
  if (credit.length === 0) return <>No credit</>;
  return (
    <>
      {credit.map((entry, index) => (
        <span key={index}>
          {index > 0 && ', '}
          {'member' in entry ? <PersonLink person={entry.member} /> : 'outside' in entry ? entry.outside.name : entry.imported}
        </span>
      ))}
    </>
  );
}

/** One Research_Item of the Project_Log: its fields, flag, Log_Summary, and Dissent_Notes (R43.3). */
function ItemEntry({ entry, flag, statusName }: { readonly entry: LogItemEntryView; readonly flag: ReturnType<typeof useFlagSnapshot>; readonly statusName: (id: string) => string }) {
  return (
    <li>
      <p>
        <strong>{ITEM_KIND_NAMES[entry.kind]}</strong>{' '}
        <Link to={entry.link}>{entry.identifier}</Link>{`: ${entry.title}`}{' '}
        <FlagMark flag={flag(entry.id)} />
        {entry.withdrawal !== null && <span className="rf-status rf-status--warning">Withdrawn</span>}
      </p>
      <p className="rf-meta">
        {`Log date ${formatPartial(entry.logDate)} · Owner `}<PersonLink person={entry.owner} />{' · Credit: '}<Credit credit={entry.credit} />
        {entry.statusValueId !== null && ` · Status ${statusName(entry.statusValueId)}`}
      </p>
      {entry.journal !== null && (
        <p className="rf-meta">
          {`Journal phase ${entry.journal.phaseId ?? 'none'}`}
          {entry.journal.startDate !== null && ` · from ${formatPartial(entry.journal.startDate)}`}
          {entry.journal.endDate !== null && ` · to ${formatPartial(entry.journal.endDate)}`}
        </p>
      )}
      {entry.withdrawal !== null && (
        <p className="rf-meta">
          {`Withdrawn on ${formatDate(entry.withdrawal.at)} by `}<PersonLink person={entry.withdrawal.by} />
          {entry.withdrawal.reason !== null && ` · ${entry.withdrawal.reason}`}
        </p>
      )}
      {entry.logSummary === null ? <p className="rf-meta">No Log Summary recorded.</p> : <RichTextView value={entry.logSummary} />}
      {entry.dissent.length > 0 && (
        <ul className="rf-list" aria-label="Dissent Notes">
          {entry.dissent.map((note) => (
            <li key={note.id}>
              <p className="rf-meta">
                {'Dissent Note by '}<PersonLink person={note.author} />{` · ${formatDate(note.lastSavedAt)}`}
                {note.aboutEarlierWording && ' · about an earlier wording'}
              </p>
              <RichTextView value={note.text} />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** A Deletion record in place of a permanently deleted Research_Item (R43.7). */
function DeletionEntry({ entry }: { readonly entry: Extract<LogEntryView, { type: 'deletion' }> }) {
  return (
    <li>
      <p>
        <strong>{entry.kind === null ? 'Deleted record' : ITEM_KIND_NAMES[entry.kind]}</strong>
        {entry.identifier !== null && ` ${entry.identifier}`}{' '}
        <span className="rf-status rf-status--warning">Deleted</span>
      </p>
      <p className="rf-meta">
        {`Deleted on ${formatDate(entry.deletedAt)} by `}<PersonLink person={entry.deletedBy} />{` · ${entry.reason}`}
      </p>
    </li>
  );
}

/**
 * The Project_Log: a Project switcher, an order toggle, filters, and cursor page links; every page is read live, and
 * a page that has not arrived after ten seconds becomes an unavailable notice that keeps the Project, order, and
 * filters so the Member reloads from the same place (R43.1, R43.6, R43.8, R43.9).
 */
export function ProjectLogScreen({ projectId }: { readonly projectId?: string | undefined }) {
  const client = useApi();
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const reversed = reversedOf(params);
  const filters = useMemo(() => filtersOf(params), [params]);
  const members = useLoad<{ members: MemberRow[] }>('/members');
  const projects = useLoad<{ projects: ProjectRecord[] }>('/projects');
  const values = useLoad<{ valueSets: ValueSets }>('/value-sets');
  // The chosen Project, kept in the address; with none, the first Project's default log is read (R43.6).
  const chosen = params.get('project') ?? projectId ?? '';
  const [entries, setEntries] = useState<readonly LogEntryView[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'done'>('loading');
  const [failure, setFailure] = useState<unknown>(undefined);
  const [unavailable, setUnavailable] = useState(false);

  const path = chosen === '' ? '/projects/log' : `/projects/${chosen}/log`;
  useEffect(() => {
    let current = true;
    setState('loading');
    setUnavailable(false);
    // The ten-second timer flips to the unavailable state only while no page has arrived; a page clears it (R43.9).
    const timer = setTimeout(() => { if (current) setUnavailable(true); }, LOG_TIMEOUT_MS);
    client.get<LogPageView>(`${path}${queryOf(reversed, filters)}`).then(
      (page) => { if (current) { clearTimeout(timer); setEntries(page.entries); setNext(page.next); setFailure(undefined); setUnavailable(false); setState('done'); } },
      // A refused filter keeps the previous results shown and surfaces the error; it does not blank the list (R43.8).
      (reason: unknown) => { if (current) { clearTimeout(timer); setFailure(reason); setUnavailable(false); setState('done'); } },
    );
    return () => { current = false; clearTimeout(timer); };
  }, [client, path, reversed, filters]);

  const more = async () => {
    if (next === null) return;
    try {
      const page = await client.get<LogPageView>(`${path}${queryOf(reversed, filters, next)}`);
      setEntries((shown) => [...shown, ...page.entries]);
      setNext(page.next);
    } catch (reason) {
      setFailure(reason);
    }
  };

  // Record a view of each Research_Item the page opened, so its flag clears on the next load (R18.12).
  const itemIds = useMemo(() => entries.flatMap((entry) => (entry.type === 'item' ? [entry.id] : [])), [entries]);
  useRecordViews(state === 'done' ? itemIds : undefined);
  const flag = useFlagSnapshot(entries.flatMap((entry) => (entry.type === 'item' ? [{ id: entry.id, flag: entry.flag }] : [])));
  const statusName = (id: string): string => {
    for (const set of [values.data?.valueSets.finding_status, values.data?.valueSets.hypothesis_status, values.data?.valueSets.run_outcome, values.data?.valueSets.archival_request_status]) {
      const found = set?.find((value) => value.id === id);
      if (found) return found.name;
    }
    return id;
  };

  const setParam = (key: string) => (value: string) => setParams((current) => {
    const nextParams = new URLSearchParams(current);
    if (value === '') nextParams.delete(key);
    else nextParams.set(key, value);
    return nextParams;
  });
  const toggleOrder = () => setParams((current) => {
    const nextParams = new URLSearchParams(current);
    if (reversed) nextParams.delete('order');
    else nextParams.set('order', 'oldest');
    return nextParams;
  });
  const issues: readonly FieldIssue[] = failure instanceof ApiFailure && failure.code === 'validation' ? failure.fields : [];
  const forField = (name: string): FieldIssue[] => issues.filter((issue) => issue.field === name);
  const refused = failure instanceof ApiFailure && failure.code === 'validation';
  const limited = failure instanceof ApiFailure && (failure.code === 'daily_limit' || failure.code === 'platform_limit');
  const people = useMemo(() => (members.data?.members ?? []).filter((member) => member.status !== 'pending'), [members.data]);

  return (
    <div className="rf-stack">
      <h1>Project log</h1>
      <form className="rf-stack" aria-label="Choose and filter the Project log" onSubmit={(event) => event.preventDefault()}>
        <SelectField label="Project" value={chosen} placeholder="First Project" options={(projects.data?.projects ?? []).map((project) => ({ value: project.id, label: project.name }))} onChange={setParam('project')} />
        <SelectField label="Kind of record" value={filters.itemKind ?? ''} placeholder="Any kind" options={ITEM_KINDS.map((kind: ItemKind) => ({ value: kind, label: ITEM_KIND_NAMES[kind] }))} onChange={setParam('itemKind')} />
        <SelectField label="Member who owns or is credited" value={filters.member ?? ''} placeholder="Any Member" options={people.map((member) => ({ value: member.id, label: member.displayName ?? member.email }))} onChange={setParam('member')} />
        <SelectField label="Specialty of the Member" value={filters.specialty ?? ''} placeholder="Any Specialty" options={session.me.specialtyOptions.map((specialty) => ({ value: specialty.id, label: specialty.name }))} onChange={setParam('specialty')} />
        <TextField label="Log date from (including this date)" type="date" value={filters.from ?? ''} onChange={setParam('from')} errors={forField('from')} />
        <TextField label="Log date to (including this date)" type="date" value={filters.to ?? ''} onChange={setParam('to')} errors={forField('to')} />
        <div className="rf-actions"><Button onClick={toggleOrder}>{reversed ? 'Show newest first' : 'Show oldest first'}</Button></div>
      </form>
      {refused && (
        <Notice tone="danger" title="This filter was refused.">
          <p>{issues.map((issue) => issue.rule).join(' ')}</p>
          <p>The previous results are kept below.</p>
        </Notice>
      )}
      {unavailable && (
        <Notice tone="danger" title="The Project log is unavailable.">
          {limited && <p>A daily limit of the hosting platform was reached. The Project log resumes at 00:00 UTC.</p>}
          <p>Your Project, order, and filters are kept above. Reload the page to try again.</p>
        </Notice>
      )}
      {state === 'loading' && !unavailable && <p className="rf-meta" role="status">Loading…</p>}
      {entries.length === 0 && state === 'done' && !refused && !unavailable
        ? <p className="rf-meta" role="status">No entries match.</p>
        : entries.length > 0 && (
          <ol className="rf-list" aria-label={reversed ? 'Project log, oldest first' : 'Project log, newest first'}>
            {entries.map((entry) => (entry.type === 'item'
              ? <ItemEntry key={entry.id} entry={entry} flag={flag} statusName={statusName} />
              : <DeletionEntry key={entry.id} entry={entry} />))}
          </ol>
        )}
      {state === 'done' && next !== null && <div className="rf-actions"><Button onClick={() => void more()}>Show more entries</Button></div>}
    </div>
  );
}

/** `/projects/:id/log`, the log of the chosen Project. */
export function ProjectLogRoute() {
  const { id = '' } = useParams();
  return <ProjectLogScreen key={id} projectId={id} />;
}
