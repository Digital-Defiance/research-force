import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ITEM_KIND_NAMES } from '@researchforce/domain/kind-names';
import { ITEM_KINDS, LEVELS } from '@researchforce/domain/types';
import { RestrictedMark, BulkAccess, useSelection } from '../access/access';
import { FlagMark, useFlagSnapshot } from '../activity/activity';
import { ApiFailure, useApi } from '../api';
import type { FieldIssue } from '../api';
import { useSession } from '../session';
import type { ExcerptPieceView, MemberRow, ProjectRecord, SearchFilters, SearchPageView, SearchResultView } from '../types';
import { Button, formatDate, levelName, Notice, SelectField, TextField, useLoad } from '../ui';

/** A search that has not answered after this long is reported as unavailable (R21.10). */
export const SEARCH_TIMEOUT_MS = 10_000;
const KEYS = ['kind', 'person', 'specialty', 'level', 'project', 'from', 'to'] as const;
const UNIT_NAMES: Readonly<Record<string, string>> = { entry_section: 'Entry section', reply: 'Reply', attachment: 'Attachment', dissent_note: 'Dissent Note' };

/** The query and filters in the address, so that they survive a reload and the Back button. */
const filtersOf = (params: URLSearchParams): SearchFilters => ({
  q: params.get('q') ?? '',
  ...Object.fromEntries(KEYS.flatMap((key) => (params.get(key) ? [[key, params.get(key)!]] : []))),
});
const queryOf = (filters: SearchFilters, after?: string): string => {
  const params = new URLSearchParams({ q: filters.q });
  for (const key of KEYS) if (filters[key]) params.set(key, filters[key]!);
  if (after !== undefined) params.set('after', after);
  return `?${params.toString()}`;
};

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ApiFailure(0, 'unavailable')), SEARCH_TIMEOUT_MS);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (reason: unknown) => { clearTimeout(timer); reject(reason as Error); });
  });
}

/** A piece of an excerpt: the matched terms highlighted, and the label of a Quote, Paraphrase, or Source_Reported span kept with its text (R21.7). */
function Piece({ piece }: { readonly piece: ExcerptPieceView }) {
  const text = piece.highlight ? <mark>{piece.text}</mark> : piece.text;
  if (piece.label === undefined) return <>{text}</>;
  return <span className={`rf-mark--${piece.label.kind}`}>{text}<span className="rf-mark-caption">{` [${piece.label.caption}]`}</span></span>;
}

function Result({ result, flag, selected }: { readonly result: SearchResultView; readonly flag: SearchResultView['flag']; readonly selected: ReturnType<typeof useSelection> | null }) {
  const unit = UNIT_NAMES[result.unitType];
  const kind = ITEM_KIND_NAMES[result.kind];
  return (
    <li>
      {selected !== null && (
        <label className="rf-meta">
          <input type="checkbox" className="rf-checkbox" checked={selected.has(result.rootId)} onChange={(event) => selected.toggle(result.rootId, event.target.checked)} />
          {` Choose ${kind} ${result.title}`}
        </label>
      )}
      <p>
        <strong>{unit === undefined ? kind : `${unit} of ${kind}`}</strong>{': '}<Link to={`/items/${result.rootId}`}>{result.title}</Link>{' '}
        <FlagMark flag={flag} />{result.restricted && <RestrictedMark />}
        {result.withdrawn && <span className="rf-status rf-status--warning">Withdrawn</span>}
        {result.superseded && <span className="rf-status rf-status--warning">Superseded</span>}
      </p>
      {result.dissent !== undefined && <p className="rf-meta">{`Dissent Note by ${result.dissent.author}`}</p>}
      <p className="rf-meta">
        {`${result.credit.length === 0 ? 'No credit' : result.credit.join(', ')} · ${formatDate(result.createdAt)} · ${result.project.name} · Disclosure level ${levelName(result.level)}, effective ${levelName(result.effective)}`}
      </p>
      <p>
        {result.excerpt.cutBefore && '… '}
        {result.excerpt.pieces.map((piece, index) => <Piece key={index} piece={piece} />)}
        {result.excerpt.cutAfter && ' …'}
      </p>
    </li>
  );
}

/** Member search: the query, its filters, and the results in pages of 20, with a notice when search is unavailable (R21.2 to R21.10). */
export function SearchScreen() {
  const client = useApi();
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const submitted = useMemo(() => filtersOf(params), [params]);
  const [draft, setDraft] = useState<SearchFilters>(submitted);
  const [results, setResults] = useState<readonly SearchResultView[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'done'>('idle');
  const [failure, setFailure] = useState<unknown>(undefined);
  const members = useLoad<{ members: MemberRow[] }>('/members');
  const projects = useLoad<{ projects: ProjectRecord[] }>('/projects');
  const selection = useSelection();
  const flagOf = useFlagSnapshot(results.map((result) => ({ id: result.id, flag: result.flag })));
  const hasQuery = params.has('q');

  useEffect(() => {
    if (!hasQuery) return undefined;
    let current = true;
    setState('loading');
    setFailure(undefined);
    withTimeout(client.get<SearchPageView>(`/search${queryOf(submitted)}`)).then(
      (page) => { if (current) { setResults(page.results); setNext(page.next); setState('done'); selection.clear(); } },
      (reason: unknown) => { if (current) { setFailure(reason); setResults([]); setNext(null); setState('done'); } },
    );
    return () => { current = false; };
  // The selection is cleared with each new search, not tracked.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, submitted, hasQuery]);

  const more = async () => {
    if (next === null) return;
    try {
      const page = await withTimeout(client.get<SearchPageView>(`/search${queryOf(submitted, next)}`));
      setResults((shown) => [...shown, ...page.results]);
      setNext(page.next);
    } catch (reason) {
      setFailure(reason);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = new URLSearchParams({ q: draft.q });
    for (const key of KEYS) if (draft[key]) next.set(key, draft[key]!);
    setParams(next);
  };
  const set = (key: keyof SearchFilters) => (value: string) => setDraft((current) => ({ ...current, [key]: value === '' ? undefined : value }));
  const issues = failure instanceof ApiFailure && failure.code === 'validation' ? failure.fields : [];
  const forField = (...names: string[]): FieldIssue[] => issues.filter((issue) => names.includes(issue.field));
  const unavailable = failure !== undefined && !(failure instanceof ApiFailure && failure.code === 'validation');
  const dailyLimit = failure instanceof ApiFailure && (failure.code === 'daily_limit' || failure.code === 'platform_limit');
  const people = useMemo(() => (members.data?.members ?? []).filter((member) => member.status !== 'pending'), [members.data]);
  const chosen = results.some((result) => result.unitType === 'research_item') ? selection : null;

  return (
    <div className="rf-stack">
      <h1>Search</h1>
      <form className="rf-stack" aria-label="Search" onSubmit={submit}>
        <TextField label="Search for" value={draft.q} onChange={(value) => setDraft((current) => ({ ...current, q: value }))} errors={forField('query', 'q')}
          hint="Words match whole words or word starts. Put words in double quotes to find them together, in order." />
        <SelectField label="Kind of record" value={draft.kind ?? ''} placeholder="Any kind" options={ITEM_KINDS.map((kind) => ({ value: kind, label: ITEM_KIND_NAMES[kind] }))} onChange={set('kind')} />
        <SelectField label="Credited person" value={draft.person ?? ''} placeholder="Any Member" options={people.map((member) => ({ value: member.id, label: member.displayName ?? member.email }))} onChange={set('person')} />
        <SelectField label="Specialty of a credited Member" value={draft.specialty ?? ''} placeholder="Any Specialty" options={session.me.specialtyOptions.map((specialty) => ({ value: specialty.id, label: specialty.name }))} onChange={set('specialty')} />
        <SelectField label="Disclosure level" value={draft.level ?? ''} placeholder="Any level" options={LEVELS.map((level) => ({ value: level, label: levelName(level) }))} onChange={set('level')} />
        <SelectField label="Project" value={draft.project ?? ''} placeholder="Any Project" options={(projects.data?.projects ?? []).map((project) => ({ value: project.id, label: project.name }))} onChange={set('project')} />
        <TextField label="Created from (including this date)" type="date" value={draft.from ?? ''} onChange={set('from')} errors={forField('from')} />
        <TextField label="Created until (including this date)" type="date" value={draft.to ?? ''} onChange={set('to')} errors={forField('to')} />
        <div className="rf-actions"><Button type="submit" variant="primary">Search</Button></div>
      </form>
      {unavailable && (
        <Notice tone="danger" title="Search is unavailable.">
          {dailyLimit && <p>A daily limit of the hosting platform was reached. Search resumes at 00:00 UTC.</p>}
          <p>Your query and filters are kept above.</p>
        </Notice>
      )}
      {state === 'loading' && <p className="rf-meta" role="status">Searching…</p>}
      {state === 'done' && failure === undefined && (results.length === 0 ? <p className="rf-meta" role="status">No result matched.</p> : (
        <>
          <ol className="rf-list" aria-label="Search results">{results.map((result, index) => <Result key={`${result.id}:${index}`} result={result} flag={flagOf(result.id)} selected={chosen} />)}</ol>
          {next !== null && <div className="rf-actions"><Button onClick={() => void more()}>Show more results</Button></div>}
          {chosen !== null && <BulkAccess itemIds={chosen.chosen} members={members.data?.members ?? []} onDone={() => { chosen.clear(); setParams(new URLSearchParams(params)); }} />}
        </>
      ))}
    </div>
  );
}
