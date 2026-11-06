import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { OUTSIDE_SUBMISSION_TYPES } from '@researchforce/domain/types';
import { useApi } from '../api';
import type { ProjectRecord } from '../types';
import { Button, DataTable, EmptyState, LoadState, Notice, PageHeader, PageLayout, SelectField, TextField, useClientFilterSort, useLoad } from '../ui';
import type { ClientFilter, ClientSort, Column, Option } from '../ui';
import { OUTSIDE_TYPE_NAMES, STATE_NAMES, stateName, typeName } from './model';
import type { QueueEntry, QueuePage } from './model';
import { ContactReviewMark } from './contact-review';

const TYPE_OPTIONS: Option[] = OUTSIDE_SUBMISSION_TYPES.map((type) => ({ value: type, label: OUTSIDE_TYPE_NAMES[type] }));
const STATE_OPTIONS: Option[] = Object.entries(STATE_NAMES).map(([value, label]) => ({ value, label }));
const CONTACT_REVIEW_OPTIONS: Option[] = [{ value: 'due', label: 'Due for contact review' }];

const projectLabel = (entry: QueueEntry): string => (entry.projectId === null ? 'For the General choice (no Project chosen)' : `Project: ${entry.projectName ?? entry.projectId}`);
const submitterLabel = (entry: QueueEntry): string => `${entry.submitter.name}${entry.submitter.affiliation === null ? '' : `, ${entry.submitter.affiliation}`}`;
const targetLabel = (entry: QueueEntry): string => (entry.responseTarget === null ? '' : `received ${entry.responseTarget.receivedOn}, due ${entry.responseTarget.dueOn}${entry.responseTarget.overdue ? ' — overdue' : ''}`);

/** The columns for the loaded rows: reference, type, state, Project or General_Choice, Submitter, receipt time, and Response_Target dates with an overdue mark (R32.17, R46.24). */
const COLUMNS: readonly Column<QueueEntry>[] = [
  {
    key: 'reference', header: 'Reference', sortBy: (entry) => entry.reference,
    cell: (entry) => (
      <>
        {entry.responseTarget?.overdue === true && <><span className="rf-status rf-status--danger">Overdue</span>{' '}</>}
        <Link to={`/moderation/${entry.id}`}>{entry.reference}</Link>
        {entry.contactReview !== null && <>{' '}<ContactReviewMark contactReview={entry.contactReview} /></>}
        {entry.failedEmail === true && <>{' '}<span className="rf-status rf-status--warning">Email failed</span></>}
      </>
    ),
  },
  { key: 'type', header: 'Type', sortBy: (entry) => typeName(entry.type), cell: (entry) => <span className="rf-status">{typeName(entry.type)}</span> },
  { key: 'state', header: 'State', sortBy: (entry) => stateName(entry.state), cell: (entry) => <span className="rf-status">{stateName(entry.state)}</span> },
  { key: 'project', header: 'Project or General choice', sortBy: projectLabel, cell: projectLabel },
  {
    key: 'submitter', header: 'Submitter', sortBy: (entry) => entry.submitter.name,
    cell: (entry) => <>{submitterLabel(entry)}{entry.files.length > 0 && <span className="rf-meta">{` (${entry.files.length} ${entry.files.length === 1 ? 'file' : 'files'})`}</span>}</>,
  },
  { key: 'received', header: 'Received', sortBy: (entry) => entry.receiptTime, cell: (entry) => entry.receiptTime },
  { key: 'target', header: 'Response target', cell: (entry) => (entry.responseTarget === null ? '' : `Response target: ${targetLabel(entry)}`) },
];

const haystack = (entry: QueueEntry): string =>
  [entry.reference, typeName(entry.type), stateName(entry.state), projectLabel(entry), submitterLabel(entry)].join(' ').toLowerCase();
const FILTERS: readonly ClientFilter<QueueEntry>[] = [{ key: 'text', predicate: (entry, value) => haystack(entry).includes(value.trim().toLowerCase()) }];
const SORTS: readonly ClientSort<QueueEntry>[] = [
  { key: 'reference', compare: (a, b) => a.reference.localeCompare(b.reference) },
  { key: 'type', compare: (a, b) => typeName(a.type).localeCompare(typeName(b.type)) },
  { key: 'state', compare: (a, b) => stateName(a.state).localeCompare(stateName(b.state)) },
  { key: 'submitter', compare: (a, b) => a.submitter.name.localeCompare(b.submitter.name) },
];
const SORT_OPTIONS: Option[] = SORTS.map((sort) => ({ value: sort.key, label: sort.key.charAt(0).toUpperCase() + sort.key.slice(1) }));

/**
 * The Moderation_Queue, open to every active Member: Outside_Submissions newest receipt first, with their type, Project
 * or General_Choice, state, Submitter, files, and, for Corrections and Removal_Requests, the Response_Target dates with
 * an overdue mark; filterable by type, state, and Project (R32.1, R32.2, R32.17, R39.14, R46.24).
 */
export function ModerationQueueScreen() {
  const client = useApi();
  const [type, setType] = useState('');
  const [state, setState] = useState('');
  const [project, setProject] = useState('');
  const [contactReview, setContactReview] = useState('');
  const projects = useLoad<{ projects: ProjectRecord[] }>('/projects');
  const params = new URLSearchParams(Object.entries({ type, state, project, contactReview }).filter(([, value]) => value !== ''));
  const path = `/moderation${params.size === 0 ? '' : `?${params.toString()}`}`;
  const first = useLoad<QueuePage>(path);
  const [more, setMore] = useState<{ path: string; items: readonly QueueEntry[]; next: string | null | undefined }>({ path: '', items: [], next: undefined });
  const [failure, setFailure] = useState<unknown>(undefined);
  const extra = more.path === path ? more : { items: [] as readonly QueueEntry[], next: undefined };
  const next = extra.next === undefined ? first.data?.next ?? null : extra.next;
  const loadMore = async () => {
    try {
      const page = await client.get<QueuePage>(`${path}${params.size === 0 ? '?' : '&'}after=${encodeURIComponent(next!)}`);
      setMore({ path, items: [...extra.items, ...page.items], next: page.next });
    } catch (error) { setFailure(error); }
  };
  const projectOptions: Option[] = [{ value: 'general', label: 'The General choice' }, ...(projects.data?.projects ?? []).map((record) => ({ value: record.id, label: record.name }))];
  const all = useMemo(() => (first.data ? [...first.data.items, ...extra.items] : []), [first.data, extra.items]);
  const view = useClientFilterSort(all, { filters: FILTERS, sorts: SORTS });
  return (
    <PageLayout variant="wide">
    <div className="rf-stack">
      <PageHeader title="Moderation queue" />
      <form aria-label="Filter the moderation queue" onSubmit={(event) => event.preventDefault()}>
        <SelectField label="Type" value={type} placeholder="Every type" options={TYPE_OPTIONS} onChange={setType} />
        <SelectField label="State" value={state} placeholder="Every state" options={STATE_OPTIONS} onChange={setState} />
        <SelectField label="Project" value={project} placeholder="Every Project" options={projectOptions} onChange={setProject} />
        <SelectField label="Contact review" value={contactReview} placeholder="Any contact review state" options={CONTACT_REVIEW_OPTIONS} onChange={setContactReview} />
      </form>
      {first.data !== undefined && (
        <form aria-label="Narrow the loaded rows" onSubmit={(event) => event.preventDefault()}>
          <TextField label="Filter loaded rows" value={view.filterValue['text'] ?? ''} onChange={(value) => view.setFilter('text', value)} hint="Narrows only the rows already loaded." />
          <SelectField label="Sort loaded rows" value={view.sortKey ?? ''} placeholder="Loaded order (newest first)" options={SORT_OPTIONS} onChange={(value) => view.setSort(value === '' ? undefined : value)} />
        </form>
      )}
      {first.data === undefined ? <LoadState error={first.error} /> : (
        <>
          {all.length === 0
            ? <EmptyState message="No Outside Submission matches." />
            : view.visible.length === 0
              ? <EmptyState message="No loaded Outside Submission matches the filter." action={<Button onClick={() => view.setFilter('text', '')}>Clear the filter</Button>} />
              : <DataTable caption="Outside submissions" columns={COLUMNS} rows={view.visible} />}
          {next !== null && <Button onClick={() => { void loadMore(); }}>Show more</Button>}
          {failure !== undefined && <Notice tone="danger" title="More of the queue could not be loaded. Try again." />}
        </>
      )}
    </div>
    </PageLayout>
  );
}
