import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useApi } from '../api';
import type { MemberRow, ProjectRecord, PublicUnitsPageView, PublicUnitView, UnclassifiedCountsView } from '../types';
import { Button, type Column, DataTable, EmptyState, formatDate, levelName, LoadState, Notice, PageHeader, PageLayout, PersonLink, SelectField, TextField, useClientFilterSort, useLoad } from '../ui';

/** One row of the Unclassified table: a group's label and count, with the existing destination it links to (R26.8). */
interface UnclassifiedRow { readonly key: string; readonly group: string; readonly label: string; readonly count: number; readonly to: string | null }

const unclassifiedColumns: readonly Column<UnclassifiedRow>[] = [
  { key: 'group', header: 'Group', cell: (row) => row.group, sortBy: (row) => row.group },
  { key: 'label', header: 'Label', cell: (row) => (row.to === null ? row.label : <Link to={row.to}>{row.label}</Link>), sortBy: (row) => row.label },
  { key: 'count', header: 'Unclassified units', align: 'right', cell: (row) => row.count.toLocaleString('en-GB'), sortBy: (row) => row.count },
];

const EFFECTIVE_OPTIONS = [{ value: 'public', label: 'Public' }, { value: 'withheld', label: 'Withheld' }];

/**
 * The Unclassified list for Administrators: the total count and the counts per Root_Item, per import, and per accepted
 * Outside_Submission, filterable by Project, with the active Confidentiality_Holds on the listed Root_Items (R26.8, R48.5).
 */
export function UnclassifiedScreen() {
  const [project, setProject] = useState('');
  const projects = useLoad<{ projects: ProjectRecord[] }>('/projects');
  const members = useLoad<{ members: MemberRow[] }>('/members');
  const query = project === '' ? '' : `?project=${project}`;
  const counts = useLoad<UnclassifiedCountsView>(`/disclosure/unclassified${query}`);
  const memberName = (id: string) => members.data?.members.find((member) => member.id === id)?.displayName ?? null;
  const rows = useMemo<readonly UnclassifiedRow[]>(() => counts.data === undefined ? [] : [
    ...counts.data.byRootItem.map((group) => ({ key: `r:${group.id}`, group: 'Root item', label: group.label, count: group.count, to: `/items/${group.id}` })),
    ...counts.data.byImport.map((group) => ({ key: `i:${group.id}`, group: 'Import', label: group.label, count: group.count, to: null })),
    ...counts.data.byOutsideSubmission.map((group) => ({ key: `o:${group.id}`, group: 'Accepted outside submission', label: group.label, count: group.count, to: `/moderation/${group.id}` })),
  ], [counts.data]);
  const filters = useMemo(() => [{ key: 'text', predicate: (row: UnclassifiedRow, value: string) => `${row.group} ${row.label}`.toLowerCase().includes(value.toLowerCase()) }], []);
  const view = useClientFilterSort(rows, { filters });
  return (
    <PageLayout variant="wide">
      <div className="rf-stack">
        <PageHeader title="Unclassified disclosure units" />
        <form aria-label="Filter unclassified units" onSubmit={(event) => event.preventDefault()}>
          <SelectField label="Project" value={project} placeholder="Every Project" options={(projects.data?.projects ?? []).map((record) => ({ value: record.id, label: record.name }))} onChange={setProject} />
          <TextField label="Filter groups" value={view.filterValue['text'] ?? ''} onChange={(value) => view.setFilter('text', value)} />
        </form>
        {counts.data === undefined ? <LoadState error={counts.error} /> : (
          <>
            <p>{`${counts.data.total.toLocaleString('en-GB')} Disclosure ${counts.data.total === 1 ? 'Unit is' : 'Units are'} Unclassified.`}</p>
            {counts.data.holds.length > 0 && (
              <Notice tone="warning" title="A Confidentiality Hold covers some of these records:">
                <ul className="rf-list">
                  {counts.data.holds.map((hold) => (
                    <li key={hold.id}>{'Held by '}<PersonLink person={{ id: hold.member.id, displayName: memberName(hold.member.id) ?? hold.member.displayName }} />{` on ${formatDate(hold.placedAt)}: ${hold.note}`}</li>
                  ))}
                </ul>
              </Notice>
            )}
            {rows.length === 0
              ? <EmptyState message="No Unclassified unit belongs to a Root Item, an import, or an accepted Outside Submission." />
              : view.visible.length === 0
                ? <EmptyState message="No group matches the filter." />
                : <DataTable caption="Unclassified units by group" columns={unclassifiedColumns} rows={view.visible} />}
          </>
        )}
      </div>
    </PageLayout>
  );
}

const KIND_NAMES: Readonly<Record<string, string>> = {
  project: 'Project', entry_section: 'Entry Section', reply: 'Reply', dissent_note: 'Dissent Note', attachment: 'Attachment', research_item: 'Research Item',
};
const kindName = (kind: string): string => KIND_NAMES[kind] ?? kind.replace(/_/gu, ' ');

const publicUnitColumns: readonly Column<PublicUnitView>[] = [
  { key: 'kind', header: 'Kind', cell: (unit) => kindName(unit.kind), sortBy: (unit) => kindName(unit.kind) },
  {
    key: 'project', header: 'Project', sortBy: (unit) => unit.project.name ?? '',
    cell: (unit) => (unit.rootItem ? (unit.project.name ?? 'a Project') : <Link to="/projects">{unit.project.name ?? 'A Project'}</Link>),
  },
  {
    key: 'rootItem', header: 'Root item', sortBy: (unit) => unit.rootItem?.identifier ?? '',
    cell: (unit) => {
      if (!unit.rootItem) return '—';
      const name = `${unit.rootItem.identifier ?? ''}${unit.rootItem.title === null ? '' : `: ${unit.rootItem.title}`}`.trim();
      return <Link to={`/items/${unit.rootItem.id}`}>{name || unit.key.slice(2)}</Link>;
    },
  },
  {
    key: 'rights', header: 'Rights', sortBy: (unit) => unit.rights?.name ?? '',
    cell: (unit) => (unit.rights === null ? '—' : `${unit.rights.name} (${unit.rights.permitsPublication ? 'permits publication' : 'does not permit publication'})`),
  },
  { key: 'effective', header: 'Effective', cell: (unit) => <span className="rf-status">{levelName(unit.effective)}</span>, sortBy: (unit) => unit.effective },
  { key: 'lastProjected', header: 'Last projected', cell: (unit) => formatDate(unit.lastProjectedAt), sortBy: (unit) => unit.lastProjectedAt },
];

const publicUnitText = (unit: PublicUnitView): string =>
  [kindName(unit.kind), unit.project.name, unit.rootItem?.identifier, unit.rootItem?.title, unit.rights?.name].filter((part) => part != null).join(' ').toLowerCase();

/**
 * The public overview for Administrators: every Disclosure_Unit whose Effective_Disclosure is Public or Withheld, with
 * its kind, Effective_Disclosure, Project, Root_Item, and Rights_Status, filterable by Effective_Disclosure and Project,
 * a page at a time (R23.8).
 */
export function PublicOverviewScreen() {
  const client = useApi();
  const [effective, setEffective] = useState('');
  const [project, setProject] = useState('');
  const projects = useLoad<{ projects: ProjectRecord[] }>('/projects');
  const params = new URLSearchParams(Object.entries({ effective, project }).filter(([, value]) => value !== ''));
  const path = `/disclosure/public-units${params.size === 0 ? '' : `?${params.toString()}`}`;
  const first = useLoad<PublicUnitsPageView>(path);
  const [more, setMore] = useState<{ path: string; items: readonly PublicUnitView[]; next: string | null | undefined }>({ path: '', items: [], next: undefined });
  const [failure, setFailure] = useState<unknown>(undefined);
  const extra = more.path === path ? more : { items: [] as readonly PublicUnitView[], next: undefined };
  const next = extra.next === undefined ? first.data?.next ?? null : extra.next;
  const loadMore = async () => {
    try {
      const page = await client.get<PublicUnitsPageView>(`${path}${params.size === 0 ? '?' : '&'}after=${encodeURIComponent(next!)}`);
      setMore({ path, items: [...extra.items, ...page.items], next: page.next });
    } catch (error) { setFailure(error); }
  };
  const loaded = useMemo(() => [...(first.data?.items ?? []), ...extra.items], [first.data, extra.items]);
  const filters = useMemo(() => [{ key: 'text', predicate: (unit: PublicUnitView, value: string) => publicUnitText(unit).includes(value.toLowerCase()) }], []);
  const view = useClientFilterSort(loaded, { filters });
  return (
    <PageLayout variant="wide">
      <div className="rf-stack">
        <PageHeader title="Public overview" />
        <form aria-label="Filter the public overview" onSubmit={(event) => event.preventDefault()}>
          <SelectField label="Effective disclosure" value={effective} placeholder="Public and Withheld" options={EFFECTIVE_OPTIONS} onChange={setEffective} />
          <SelectField label="Project" value={project} placeholder="Every Project" options={(projects.data?.projects ?? []).map((record) => ({ value: record.id, label: record.name }))} onChange={setProject} />
          <TextField label="Filter loaded units" value={view.filterValue['text'] ?? ''} onChange={(value) => view.setFilter('text', value)} />
        </form>
        {first.data === undefined ? <LoadState error={first.error} /> : (
          <>
            {loaded.length === 0
              ? <EmptyState message="No Public or Withheld Disclosure Unit matches." />
              : view.visible.length === 0
                ? <EmptyState message="No loaded Disclosure Unit matches the filter." />
                : <DataTable caption="Public and Withheld Disclosure Units" columns={publicUnitColumns} rows={view.visible} />}
            {next !== null && <Button onClick={() => { void loadMore(); }}>Show more</Button>}
            {failure !== undefined && <LoadState error={failure} />}
          </>
        )}
      </div>
    </PageLayout>
  );
}
