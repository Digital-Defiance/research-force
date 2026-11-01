import { useState } from 'react';
import { Link } from 'react-router';
import { useApi } from '../api';
import type { MemberRow, ProjectRecord, PublicUnitsPageView, PublicUnitView, UnclassifiedCountsView, UnclassifiedGroup } from '../types';
import { Button, formatDate, levelName, LoadState, Notice, PersonLink, SelectField, useLoad } from '../ui';

const EFFECTIVE_OPTIONS = [{ value: 'public', label: 'Public' }, { value: 'withheld', label: 'Withheld' }];

/** A group of Unclassified counts, listed highest first, with its own heading (R26.8). */
function CountGroup({ title, groups, empty }: { readonly title: string; readonly groups: readonly UnclassifiedGroup[]; readonly empty: string }) {
  return (
    <section className="rf-section" aria-label={title}>
      <h2>{title}</h2>
      {groups.length === 0 ? <p className="rf-meta">{empty}</p> : (
        <ul className="rf-list">{groups.map((group) => <li key={group.id}>{`${group.label}: ${group.count.toLocaleString('en-GB')}`}</li>)}</ul>
      )}
    </section>
  );
}

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
  return (
    <div className="rf-stack">
      <h1>Unclassified disclosure units</h1>
      <form aria-label="Filter unclassified units" onSubmit={(event) => event.preventDefault()}>
        <SelectField label="Project" value={project} placeholder="Every Project" options={(projects.data?.projects ?? []).map((record) => ({ value: record.id, label: record.name }))} onChange={setProject} />
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
          <CountGroup title="Per root item" groups={counts.data.byRootItem} empty="No Unclassified unit belongs to a Root Item." />
          <CountGroup title="Per import" groups={counts.data.byImport} empty="No Unclassified unit came from an import." />
          <CountGroup title="Per accepted outside submission" groups={counts.data.byOutsideSubmission} empty="No Unclassified unit came from an accepted Outside Submission." />
        </>
      )}
    </div>
  );
}

const KIND_NAMES: Readonly<Record<string, string>> = {
  project: 'Project', entry_section: 'Entry Section', reply: 'Reply', dissent_note: 'Dissent Note', attachment: 'Attachment', research_item: 'Research Item',
};
const kindName = (kind: string): string => KIND_NAMES[kind] ?? kind.replace(/_/gu, ' ');

/** One row of the public overview: the unit's kind, Effective_Disclosure, Project, Root_Item, Rights_Status, and last projection (R23.8). */
function PublicUnitRow({ unit }: { readonly unit: PublicUnitView }) {
  const id = unit.key.slice(2);
  const name = unit.rootItem ? `${unit.rootItem.identifier ?? ''}${unit.rootItem.title === null ? '' : `: ${unit.rootItem.title}`}`.trim() : unit.project.name ?? 'A Project';
  return (
    <li>
      <span className="rf-status">{levelName(unit.effective)}</span>{' '}
      {kindName(unit.kind)}{' — '}
      {unit.rootItem ? <Link to={`/items/${unit.rootItem.id}`}>{name || id}</Link> : <Link to="/projects">{name}</Link>}
      <span className="rf-meta">{` in ${unit.project.name ?? 'a Project'}`}</span>
      {unit.rights !== null && <span className="rf-meta">{` — Rights: ${unit.rights.name} (${unit.rights.permitsPublication ? 'permits publication' : 'does not permit publication'})`}</span>}
      <span className="rf-meta">{` — last published ${formatDate(unit.lastProjectedAt)}`}</span>
    </li>
  );
}

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
  return (
    <div className="rf-stack">
      <h1>Public overview</h1>
      <form aria-label="Filter the public overview" onSubmit={(event) => event.preventDefault()}>
        <SelectField label="Effective disclosure" value={effective} placeholder="Public and Withheld" options={EFFECTIVE_OPTIONS} onChange={setEffective} />
        <SelectField label="Project" value={project} placeholder="Every Project" options={(projects.data?.projects ?? []).map((record) => ({ value: record.id, label: record.name }))} onChange={setProject} />
      </form>
      {first.data === undefined ? <LoadState error={first.error} /> : (
        <>
          {first.data.items.length + extra.items.length === 0 ? <p>No Public or Withheld Disclosure Unit matches.</p> : (
            <ul className="rf-list">{[...first.data.items, ...extra.items].map((unit) => <PublicUnitRow key={unit.key} unit={unit} />)}</ul>
          )}
          {next !== null && <Button onClick={() => { void loadMore(); }}>Show more</Button>}
          {failure !== undefined && <LoadState error={failure} />}
        </>
      )}
    </div>
  );
}
