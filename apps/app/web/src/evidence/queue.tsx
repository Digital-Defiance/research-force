import { useState } from 'react';
import { Link } from 'react-router';
import { useApi } from '../api';
import type { CurationQueueView, CurationUnitView, ProjectRecord } from '../types';
import { Button, DataTable, EmptyState, LoadState, PageHeader, PageLayout, SelectField, TextField, useClientFilterSort, useLoad } from '../ui';
import type { ClientFilter, Column } from '../ui';

const KIND_NAMES: Readonly<Record<string, string>> = { correspondence: 'Correspondence', source: 'Source', attachment: 'Attachment' };
const kindName = (kind: string): string => KIND_NAMES[kind] ?? kind.replace(/_/gu, ' ');
const reasonText = (reason: CurationUnitView['reason']): string =>
  reason === 'no_grant' ? 'No permission evidence recorded' : 'Only legacy, unverified, or spent grants';

const unitName = (unit: CurationUnitView): string =>
  `${unit.identifier ?? ''}${unit.title === null ? '' : `: ${unit.title}`}`.trim() || unit.id;
const rootName = (unit: CurationUnitView): string =>
  `${unit.rootItem.identifier ?? ''}${unit.rootItem.title === null ? '' : `: ${unit.rootItem.title}`}`.trim() || unit.rootItem.id;

/** Client-side filters over the loaded rows only; they never change the request (R9.1, R9.5). */
const FILTERS: readonly ClientFilter<CurationUnitView>[] = [
  { key: 'text', predicate: (unit, value) => `${unitName(unit)} ${rootName(unit)} ${unit.project.name ?? ''}`.toLowerCase().includes(value.toLowerCase()) },
  { key: 'kind', predicate: (unit, value) => unit.kind === value },
  { key: 'reason', predicate: (unit, value) => unit.reason === value },
];

/** Columns: unit, kind, root item, project, reason, and the retaining links. Sorting is the table's own header toggle. */
const COLUMNS: readonly Column<CurationUnitView>[] = [
  { key: 'unit', header: 'Unit', cell: (unit) => <Link to={`/evidence/units/${unit.id}`}>{unitName(unit)}</Link>, sortBy: unitName },
  { key: 'kind', header: 'Kind', cell: (unit) => kindName(unit.kind), sortBy: (unit) => kindName(unit.kind) },
  { key: 'root', header: 'Root item', cell: rootName, sortBy: rootName },
  { key: 'project', header: 'Project', cell: (unit) => unit.project.name ?? 'a Project', sortBy: (unit) => unit.project.name ?? '' },
  { key: 'reason', header: 'Reason', cell: (unit) => reasonText(unit.reason), sortBy: (unit) => reasonText(unit.reason) },
  { key: 'links', header: 'Actions', cell: (unit) => <Link to={`/evidence/units/${unit.id}`}>Record a grant</Link> },
];

/**
 * The curation queue for Administrators: every Correspondence, Source, and Attachment that still needs a verified
 * Permission_Evidence grant or a Consent_Request, so an Administrator can work through them (R51.9, R51.15). A unit
 * drops out of the queue as soon as it has a live, verified grant. Filterable by Project, a page at a time.
 */
export function CurationQueueScreen() {
  const client = useApi();
  const [project, setProject] = useState('');
  const projects = useLoad<{ projects: ProjectRecord[] }>('/projects');
  const params = new URLSearchParams(project === '' ? [] : [['project', project]]);
  const path = `/disclosure/evidence-queue${params.size === 0 ? '' : `?${params.toString()}`}`;
  const first = useLoad<CurationQueueView>(path);
  const [more, setMore] = useState<{ path: string; items: readonly CurationUnitView[]; next: string | null | undefined }>({ path: '', items: [], next: undefined });
  const [failure, setFailure] = useState<unknown>(undefined);
  const extra = more.path === path ? more : { items: [] as readonly CurationUnitView[], next: undefined };
  const next = extra.next === undefined ? first.data?.next ?? null : extra.next;
  const loadMore = async () => {
    try {
      const page = await client.get<CurationQueueView>(`${path}${params.size === 0 ? '?' : '&'}after=${encodeURIComponent(next!)}`);
      setMore({ path, items: [...extra.items, ...page.items], next: page.next });
    } catch (error) { setFailure(error); }
  };
  const all = [...(first.data?.items ?? []), ...extra.items];
  const { visible, filterValue, setFilter } = useClientFilterSort(all, { filters: FILTERS });
  return (
    <PageLayout variant="wide">
      <PageHeader title="Permission evidence queue" description="Correspondences, Sources, and Attachments that still need a verified grant or a Consent Request. A unit leaves the queue once it has a live, verified grant." />
      <form aria-label="Filter the evidence queue" onSubmit={(event) => event.preventDefault()}>
        <SelectField label="Project" value={project} placeholder="Every Project" options={(projects.data?.projects ?? []).map((record) => ({ value: record.id, label: record.name }))} onChange={setProject} />
        <TextField label="Search loaded units" value={filterValue['text'] ?? ''} onChange={(value) => setFilter('text', value)} />
        <SelectField label="Kind" value={filterValue['kind'] ?? ''} placeholder="Every kind" options={Object.entries(KIND_NAMES).map(([value, label]) => ({ value, label }))} onChange={(value) => setFilter('kind', value)} />
        <SelectField label="Reason" value={filterValue['reason'] ?? ''} placeholder="Any reason" options={[{ value: 'no_grant', label: 'No grant' }, { value: 'only_legacy', label: 'Unverified or spent grants' }]} onChange={(value) => setFilter('reason', value)} />
      </form>
      {first.data === undefined ? <LoadState error={first.error} /> : (
        <>
          {all.length === 0
            ? <EmptyState message="Every Correspondence, Source, and Attachment has a verified grant." />
            : visible.length === 0
              ? <EmptyState message="No loaded units match the current filters." />
              : <DataTable caption="Units needing permission evidence" columns={COLUMNS} rows={visible} />}
          {next !== null && <Button onClick={() => { void loadMore(); }}>Show more</Button>}
          {failure !== undefined && <LoadState error={failure} />}
        </>
      )}
    </PageLayout>
  );
}
