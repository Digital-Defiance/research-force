import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ITEM_KIND_NAMES } from '@researchforce/domain/kind-names';
import { BulkAccess, RestrictedMark, useSelection } from '../access/access';
import { FlagMark, useFlagSnapshot, useRecordViews } from '../activity/activity';
import { ApiFailure, useApi } from '../api';
import type { FieldIssue } from '../api';
import { RichTextView } from '../editor/RichTextView';
import { useSession } from '../session';
import type {
  ArchivalEntryView, CorrespondenceEntryView, CreditDisplayView, FindingEntryView, HypothesisEntryView, ListEntryBase, ListPageView,
  MemberRow, PartialDateView, PartyDisplayView, ProjectRecord, RunEntryView, ValueSets,
} from '../types';
import { Button, formatDate, Notice, PersonLink, SelectField, TextField, useLoad } from '../ui';

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

const DIRECTION_NAMES: Readonly<Record<string, string>> = { sent: 'Sent', received: 'Received' };
function Party({ party }: { readonly party: PartyDisplayView }) {
  return party.kind === 'member' ? <PersonLink person={{ id: party.id, displayName: party.displayName }} /> : <>{party.name}</>;
}

/** The link to a list entry's Research_Item, its identifier, title, flag, and the Restricted mark (R47.11). */
function EntryHead({ entry, flag }: { readonly entry: ListEntryBase; readonly flag: ReturnType<typeof useFlagSnapshot> }) {
  return (
    <p>
      <Link to={`/items/${entry.id}`}>{entry.identifier}</Link>{`: ${entry.title}`}{' '}
      <FlagMark flag={flag(entry.id)} />
      {entry.restricted && <RestrictedMark />}
      {entry.withdrawn && <span className="rf-status rf-status--warning">Withdrawn</span>}
    </p>
  );
}

/**
 * A record-kind list screen: a filter form with the list's own filters and the multi-Project filter, cursor
 * pagination keeping those filters, the Restricted mark on each entry, each entry's Project name, and the flag
 * snapshot with recorded views for the entries that carry Research_Item ids (R39.14, R43.1, R47.11, R18.12).
 */
function ListScreen<Entry extends ListEntryBase>({ title, path, keys, label, filters, renderEntry, children }: {
  readonly title: string;
  readonly path: string;
  /** The single-valued filter keys this list sends, besides the repeated `project` parameter. */
  readonly keys: readonly string[];
  readonly label: string;
  /** The list-specific filter controls, given the current values and a setter for each key. */
  readonly filters: (current: Readonly<Record<string, string>>, set: (key: string) => (value: string) => void, forField: (name: string) => FieldIssue[]) => ReactNode;
  readonly renderEntry: (entry: Entry, flag: ReturnType<typeof useFlagSnapshot>) => ReactNode;
  readonly children?: ReactNode;
}) {
  const client = useApi();
  const projects = useLoad<{ projects: ProjectRecord[] }>('/projects');
  const members = useLoad<{ members: MemberRow[] }>('/members');
  const selection = useSelection();
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  // One or more chosen Projects, matching the multi-value `project` filter the API reads (R39.14).
  const [chosenProjects, setChosenProjects] = useState<readonly string[]>([]);
  const [entries, setEntries] = useState<readonly Entry[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'done'>('loading');
  const [failure, setFailure] = useState<unknown>(undefined);
  // Bumped to reload the current page after a bulk access change, so a record the viewer can no longer read drops off.
  const [reloadKey, setReloadKey] = useState(0);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    for (const key of keys) if (values[key]) params.set(key, values[key]!);
    for (const id of chosenProjects) params.append('project', id);
    const text = params.toString();
    return text === '' ? '' : `?${text}`;
  }, [keys, values, chosenProjects]);

  useEffect(() => {
    let current = true;
    setState('loading');
    client.get<ListPageView<Entry>>(`${path}${query}`).then(
      (page) => { if (current) { setEntries(page.entries); setNext(page.next); setFailure(undefined); setState('done'); selection.clear(); } },
      (reason: unknown) => { if (current) { setFailure(reason); setState('done'); } },
    );
    return () => { current = false; };
  // The selection is cleared with each fresh load, not tracked.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, path, query, reloadKey]);

  const more = async () => {
    if (next === null) return;
    const params = new URLSearchParams(query.slice(1));
    params.set('cursor', next);
    try {
      const page = await client.get<ListPageView<Entry>>(`${path}?${params.toString()}`);
      setEntries((shown) => [...shown, ...page.entries]);
      setNext(page.next);
    } catch (reason) {
      setFailure(reason);
    }
  };

  const itemIds = useMemo(() => entries.map((entry) => entry.id), [entries]);
  useRecordViews(state === 'done' ? itemIds : undefined);
  const flag = useFlagSnapshot(entries.map((entry) => ({ id: entry.id, flag: (entry as { flag?: 'new' | 'updated' | null }).flag })));

  const set = (key: string) => (value: string) => setValues((old) => {
    const nextValues = { ...old };
    if (value === '') delete nextValues[key];
    else nextValues[key] = value;
    return nextValues;
  });
  const issues: readonly FieldIssue[] = failure instanceof ApiFailure && failure.code === 'validation' ? failure.fields : [];
  const forField = (name: string): FieldIssue[] => issues.filter((issue) => issue.field === name);
  const refused = failure instanceof ApiFailure && failure.code === 'validation';
  const limited = failure instanceof ApiFailure && (failure.code === 'daily_limit' || failure.code === 'platform_limit');
  const otherFailure = failure !== undefined && !refused;
  const toggleProject = (id: string, on: boolean) => setChosenProjects((old) => (on ? [...old, id] : old.filter((entry) => entry !== id)));
  // Every list entry is a Research_Item, so bulk access change is offered whenever the list has entries (R47.14).
  const chosen = entries.length > 0 ? selection : null;

  return (
    <div className="rf-stack">
      <h1>{title}</h1>
      <form className="rf-stack" aria-label={`Filter ${label}`} onSubmit={(event) => event.preventDefault()}>
        {filters(values, set, forField)}
        <fieldset className="rf-field">
          <legend className="rf-field__label">Projects</legend>
          {(projects.data?.projects ?? []).map((project) => (
            <label key={project.id} className="rf-field rf-field--checkbox">
              <input type="checkbox" className="rf-checkbox" checked={chosenProjects.includes(project.id)} onChange={(event) => toggleProject(project.id, event.target.checked)} />
              {` ${project.name}`}
            </label>
          ))}
        </fieldset>
      </form>
      {refused && <Notice tone="danger" title="This filter was refused."><p>{issues.map((issue) => issue.rule).join(' ')}</p></Notice>}
      {otherFailure && (
        <Notice tone="danger" title={`${title} is unavailable.`}>
          {limited && <p>A daily limit of the hosting platform was reached. It resumes at 00:00 UTC.</p>}
          <p>Reload the page to try again.</p>
        </Notice>
      )}
      {state === 'loading' && <p className="rf-meta" role="status">Loading…</p>}
      {state === 'done' && !otherFailure && (entries.length === 0
        ? <p className="rf-meta" role="status">No entries match.</p>
        : <ol className="rf-list" aria-label={label}>{entries.map((entry) => (
          <li key={entry.id}>
            {chosen !== null && (
              <label className="rf-meta">
                <input type="checkbox" className="rf-checkbox" checked={chosen.has(entry.id)} onChange={(event) => chosen.toggle(entry.id, event.target.checked)} />
                {` Choose ${entry.identifier} ${entry.title}`}
              </label>
            )}
            {renderEntry(entry, flag)}
          </li>
        ))}</ol>)}
      {state === 'done' && next !== null && <div className="rf-actions"><Button onClick={() => void more()}>Show more entries</Button></div>}
      {state === 'done' && !otherFailure && chosen !== null && (
        <BulkAccess itemIds={chosen.chosen} members={members.data?.members ?? []} onDone={() => { chosen.clear(); setReloadKey((key) => key + 1); }} />
      )}
      {children}
    </div>
  );
}

function useStatusOptions(set: keyof ValueSets): readonly { value: string; label: string }[] {
  const values = useLoad<{ valueSets: ValueSets }>('/value-sets');
  return (values.data?.valueSets[set] ?? []).filter((value) => !value.retired).map((value) => ({ value: value.id, label: value.name }));
}

/** The Findings ledger (R5.7). */
export function FindingsScreen() {
  const session = useSession();
  const members = useLoad<{ members: MemberRow[] }>('/members');
  const statuses = useStatusOptions('finding_status');
  const people = useMemo(() => (members.data?.members ?? []).filter((member) => member.status !== 'pending'), [members.data]);
  return (
    <ListScreen<FindingEntryView> title="Findings" path="/lists/findings" keys={['status', 'person', 'specialty']} label="Findings, newest first"
      filters={(current, set) => (
        <>
          <SelectField label="Finding status" value={current['status'] ?? ''} placeholder="Any status" options={statuses} onChange={set('status')} />
          <SelectField label="Credited person" value={current['person'] ?? ''} placeholder="Any Member" options={people.map((member) => ({ value: member.id, label: member.displayName ?? member.email }))} onChange={set('person')} />
          <SelectField label="Specialty of a credited Member" value={current['specialty'] ?? ''} placeholder="Any Specialty" options={session.me.specialtyOptions.map((specialty) => ({ value: specialty.id, label: specialty.name }))} onChange={set('specialty')} />
        </>
      )}
      renderEntry={(entry, flag) => (
        <>
          <EntryHead entry={entry} flag={flag} />
          <p className="rf-meta">
            {`${ITEM_KIND_NAMES.finding} · ${entry.project.name} · ${formatDate(entry.createdAt)} · Owner `}<PersonLink person={entry.owner} />{' · Credit: '}<Credit credit={entry.credit} />
            {entry.status !== null && ` · Status ${entry.status.name}`}
          </p>
          <RichTextView value={entry.claim} />
          {entry.supersededBy !== null && <p className="rf-meta">{'Superseded by '}<Link to={`/items/${entry.supersededBy}`}>the superseding Finding</Link>.</p>}
        </>
      )} />
  );
}

/** The Runs list (R7.6). */
export function RunsScreen() {
  const members = useLoad<{ members: MemberRow[] }>('/members');
  const outcomes = useStatusOptions('run_outcome');
  const people = useMemo(() => (members.data?.members ?? []).filter((member) => member.status !== 'pending'), [members.data]);
  return (
    <ListScreen<RunEntryView> title="Runs" path="/lists/runs" keys={['outcome', 'toolName', 'toolVersion', 'computeResource', 'person']} label="Runs, newest start first"
      filters={(current, set) => (
        <>
          <SelectField label="Run outcome" value={current['outcome'] ?? ''} placeholder="Any outcome" options={outcomes} onChange={set('outcome')} />
          <TextField label="Tool name" value={current['toolName'] ?? ''} onChange={set('toolName')} />
          <TextField label="Tool version" value={current['toolVersion'] ?? ''} onChange={set('toolVersion')} />
          <TextField label="Compute resource" value={current['computeResource'] ?? ''} onChange={set('computeResource')} />
          <SelectField label="Credited person" value={current['person'] ?? ''} placeholder="Any Member" options={people.map((member) => ({ value: member.id, label: member.displayName ?? member.email }))} onChange={set('person')} />
        </>
      )}
      renderEntry={(entry, flag) => (
        <>
          <EntryHead entry={entry} flag={flag} />
          <p className="rf-meta">
            {`${ITEM_KIND_NAMES.run} · ${entry.project.name} · ${entry.toolName} ${entry.toolVersion} · ${entry.computeResource} · Started ${entry.startTime}`}
            {entry.endTime !== null && ` · Ended ${entry.endTime}`}
            {` · Outcome ${entry.outcome.name}`}
            {entry.resumePoint !== null && ` · Resume point ${entry.resumePoint}`}
          </p>
          <p className="rf-meta">{'Owner '}<PersonLink person={entry.owner} />{' · Credit: '}<Credit credit={entry.credit} /></p>
          {entry.counts.length > 0 && <p className="rf-meta">{entry.counts.map((count) => `${count.name}: ${count.value}`).join(' · ')}</p>}
        </>
      )} />
  );
}

/** The Hypotheses list (R8.5). */
export function HypothesesScreen() {
  const statuses = useStatusOptions('hypothesis_status');
  return (
    <ListScreen<HypothesisEntryView> title="Hypotheses" path="/lists/hypotheses" keys={['status']} label="Hypotheses, newest first"
      filters={(current, set) => <SelectField label="Hypothesis status" value={current['status'] ?? ''} placeholder="Any status" options={statuses} onChange={set('status')} />}
      renderEntry={(entry, flag) => (
        <>
          <EntryHead entry={entry} flag={flag} />
          <p className="rf-meta">
            {`${ITEM_KIND_NAMES.hypothesis} · ${entry.project.name} · ${formatDate(entry.createdAt)}`}
            {entry.status !== null && ` · Status ${entry.status.name}`}
          </p>
          <RichTextView value={entry.statement} />
          {entry.eliminationScope !== null && (
            <>
              <p className="rf-meta">Elimination scope</p>
              <RichTextView value={entry.eliminationScope} />
            </>
          )}
        </>
      )} />
  );
}

/** The Correspondences list (R9.7). */
export function CorrespondencesScreen() {
  const parties = useLoad<{ parties: { id: string; name: string }[] }>('/parties');
  return (
    <ListScreen<CorrespondenceEntryView> title="Correspondences" path="/lists/correspondences" keys={['party', 'direction', 'from', 'to']} label="Correspondences, newest first"
      filters={(current, set, forField) => (
        <>
          <SelectField label="Party" value={current['party'] ?? ''} placeholder="Any Party" options={(parties.data?.parties ?? []).map((party) => ({ value: party.id, label: party.name }))} onChange={set('party')} />
          <SelectField label="Direction" value={current['direction'] ?? ''} placeholder="Either direction" options={[{ value: 'sent', label: 'Sent' }, { value: 'received', label: 'Received' }]} onChange={set('direction')} />
          <TextField label="From (including this date)" type="date" value={current['from'] ?? ''} onChange={set('from')} errors={forField('from')} />
          <TextField label="To (including this date)" type="date" value={current['to'] ?? ''} onChange={set('to')} errors={forField('to')} />
        </>
      )}
      renderEntry={(entry, flag) => (
        <>
          <EntryHead entry={entry} flag={flag} />
          <p className="rf-meta">
            {`${ITEM_KIND_NAMES.correspondence} · ${entry.project.name} · ${formatPartial(entry.date)} · ${DIRECTION_NAMES[entry.direction] ?? entry.direction} · Parties: `}
            {entry.parties.length === 0 ? 'none' : entry.parties.map((party, index) => <span key={index}>{index > 0 && ', '}<Party party={party} /></span>)}
          </p>
        </>
      )} />
  );
}

/** The Archival_Requests list (R10.4). */
export function ArchivalRequestsScreen() {
  const parties = useLoad<{ parties: { id: string; name: string }[] }>('/parties');
  const statuses = useStatusOptions('archival_request_status');
  return (
    <ListScreen<ArchivalEntryView> title="Archival requests" path="/lists/archival-requests" keys={['status', 'archive']} label="Archival requests, newest first"
      filters={(current, set) => (
        <>
          <SelectField label="Archival request status" value={current['status'] ?? ''} placeholder="Any status" options={statuses} onChange={set('status')} />
          <SelectField label="Archive or desk" value={current['archive'] ?? ''} placeholder="Any archive or desk" options={(parties.data?.parties ?? []).map((party) => ({ value: party.id, label: party.name }))} onChange={set('archive')} />
        </>
      )}
      renderEntry={(entry, flag) => (
        <>
          <EntryHead entry={entry} flag={flag} />
          <p className="rf-meta">
            {`${ITEM_KIND_NAMES.archival_request} · ${entry.project.name} · ${formatDate(entry.createdAt)} · Archive or desk: `}<Party party={entry.archiveOrDesk} />
            {entry.dateSent !== null && ` · Sent ${formatPartial(entry.dateSent)}`}
            {entry.status !== null && ` · Status ${entry.status.name}`}
            {' · Owner '}<PersonLink person={entry.owner} />
            {entry.followUpDue && <span className="rf-status rf-status--warning"> Follow-up due</span>}
          </p>
        </>
      )} />
  );
}
