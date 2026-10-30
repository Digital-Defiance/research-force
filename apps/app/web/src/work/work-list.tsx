import { useState } from 'react';
import { Link } from 'react-router';
import { WORK_PRIORITIES } from '@researchforce/domain/work';
import { useApi } from '../api';
import { Button, LoadState, SelectField, TextField, useLoad } from '../ui';
import { ANSWER_NAMES, priorityName, STATE_OPTIONS, stateName } from './model';
import type { WorkPage, WorkRow } from './model';

const VIEWS = [
  { value: 'assigned', label: 'Assigned to me' }, { value: 'awaiting', label: 'Waiting for my answer' }, { value: 'due', label: 'Due soon' },
  { value: 'overdue', label: 'Overdue' }, { value: 'blocked', label: 'Blocked' },
];

function Row({ row }: { readonly row: WorkRow }) {
  return (
    <li>
      <Link to={`/items/${row.id}`}>{`${row.identifier}: ${row.title}`}</Link>
      <span className="rf-meta">{` — ${stateName(row.state)}, ${priorityName(row.priority)} priority${row.dueDate === null ? '' : `, due ${row.dueDate}`}, responsible: ${row.responsibleName ?? 'a Member'}`}</span>
      {row.overdue && <span className="rf-status rf-status--warning">{' Overdue'}</span>}
      {row.blocked && <span className="rf-status rf-status--warning">{' Blocked'}</span>}
      {row.myAssignment !== null && <span className="rf-meta">{` — you: ${ANSWER_NAMES[row.myAssignment]}`}</span>}
      {row.flag !== null && <span className="rf-status rf-status--info">{row.flag === 'new' ? ' New' : ' Updated'}</span>}
    </li>
  );
}

/** The Member's own work, or a Project's, with the filters combined and a page at a time (R52.5). */
export function WorkListScreen({ projectId }: { readonly projectId?: string }) {
  const client = useApi();
  const [view, setView] = useState('');
  const [state, setState] = useState('');
  const [priority, setPriority] = useState('');
  const [dueFrom, setDueFrom] = useState('');
  const [dueTo, setDueTo] = useState('');
  const query = new URLSearchParams(Object.entries({ view, state, priority, dueFrom, dueTo }).filter(([, value]) => value !== ''));
  const base = projectId === undefined ? '/me/work' : `/projects/${projectId}/work`;
  const path = `${base}${query.size === 0 ? '' : `?${query.toString()}`}`;
  const first = useLoad<WorkPage>(path);
  const [more, setMore] = useState<{ path: string; rows: readonly WorkRow[]; next: string | null | undefined }>({ path: '', rows: [], next: undefined });
  const [failure, setFailure] = useState<unknown>(undefined);
  const extra = more.path === path ? more : { rows: [] as readonly WorkRow[], next: undefined };
  const next = extra.next === undefined ? first.data?.next ?? null : extra.next;
  const loadMore = async () => {
    try {
      const page = await client.get<WorkPage>(`${path}${query.size === 0 ? '?' : '&'}after=${encodeURIComponent(next!)}`);
      setMore({ path, rows: [...extra.rows, ...page.items], next: page.next });
    } catch (error) { setFailure(error); }
  };
  return (
    <div className="rf-stack">
      <h1>{projectId === undefined ? 'My work' : 'Work in this Project'}</h1>
      <form aria-label="Filter work" onSubmit={(event) => event.preventDefault()}>
        {projectId === undefined && <SelectField label="Show" value={view} placeholder="All my open work" options={VIEWS} onChange={setView} />}
        <SelectField label="State" value={state} placeholder={projectId === undefined ? 'Any open state' : 'Any state'} options={STATE_OPTIONS} onChange={setState} />
        <SelectField label="Priority" value={priority} placeholder="Any priority" options={WORK_PRIORITIES.map((value) => ({ value, label: priorityName(value) }))} onChange={setPriority} />
        <TextField label="Due from" hint="YYYY-MM-DD, in your own time zone." value={dueFrom} onChange={setDueFrom} />
        <TextField label="Due to" hint="YYYY-MM-DD, in your own time zone." value={dueTo} onChange={setDueTo} />
      </form>
      {!first.data ? <LoadState error={first.error} /> : (
        <>
          <p className="rf-meta">{`Today is ${first.data.today} in ${first.data.zone}.`}</p>
          {first.data.items.length + extra.rows.length === 0 ? <p>No work matches.</p> : (
            <ul className="rf-list">{[...first.data.items, ...extra.rows].map((row) => <Row key={row.id} row={row} />)}</ul>
          )}
          {next !== null && <Button onClick={() => { void loadMore(); }}>Show more work</Button>}
          {failure !== undefined && <LoadState error={failure} />}
        </>
      )}
    </div>
  );
}
