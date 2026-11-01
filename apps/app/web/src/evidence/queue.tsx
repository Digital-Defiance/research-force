import { useState } from 'react';
import { Link } from 'react-router';
import { useApi } from '../api';
import type { CurationQueueView, CurationUnitView, ProjectRecord } from '../types';
import { Button, LoadState, SelectField, useLoad } from '../ui';

const KIND_NAMES: Readonly<Record<string, string>> = { correspondence: 'Correspondence', source: 'Source', attachment: 'Attachment' };
const kindName = (kind: string): string => KIND_NAMES[kind] ?? kind.replace(/_/gu, ' ');
const reasonText = (reason: CurationUnitView['reason']): string =>
  reason === 'no_grant' ? 'No permission evidence recorded' : 'Only legacy, unverified, or spent grants';

/** One row of the curation queue: the unit, its root item, and why it still needs a verified grant or a Consent_Request (R51.9). */
function CurationRow({ unit }: { readonly unit: CurationUnitView }) {
  const name = `${unit.identifier ?? ''}${unit.title === null ? '' : `: ${unit.title}`}`.trim() || unit.id;
  const rootName = `${unit.rootItem.identifier ?? ''}${unit.rootItem.title === null ? '' : `: ${unit.rootItem.title}`}`.trim() || unit.rootItem.id;
  return (
    <li>
      {kindName(unit.kind)}{' — '}<Link to={`/evidence/units/${unit.id}`}>{name}</Link>
      <span className="rf-meta">{` in ${rootName}, ${unit.project.name ?? 'a Project'}`}</span>
      <span className="rf-meta">{` — ${reasonText(unit.reason)}`}</span>
      {' '}<Link to={`/evidence/units/${unit.id}`}>Record a grant</Link>
    </li>
  );
}

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
  return (
    <div className="rf-stack">
      <h1>Permission evidence queue</h1>
      <p className="rf-meta">Correspondences, Sources, and Attachments that still need a verified grant or a Consent Request. A unit leaves the queue once it has a live, verified grant.</p>
      <form aria-label="Filter the evidence queue" onSubmit={(event) => event.preventDefault()}>
        <SelectField label="Project" value={project} placeholder="Every Project" options={(projects.data?.projects ?? []).map((record) => ({ value: record.id, label: record.name }))} onChange={setProject} />
      </form>
      {first.data === undefined ? <LoadState error={first.error} /> : (
        <>
          {first.data.items.length + extra.items.length === 0
            ? <p>Every Correspondence, Source, and Attachment has a verified grant.</p>
            : <ul className="rf-list">{[...first.data.items, ...extra.items].map((unit) => <CurationRow key={unit.id} unit={unit} />)}</ul>}
          {next !== null && <Button onClick={() => { void loadMore(); }}>Show more</Button>}
          {failure !== undefined && <LoadState error={failure} />}
        </>
      )}
    </div>
  );
}
