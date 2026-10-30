import { Failure } from './failure';
import { useState } from 'react';
import { COVERAGE_STATE_NAMES } from '@researchforce/domain/coverage';
import type { CoverageState } from '@researchforce/domain/coverage';
import { ApiFailure, useApi } from '../api';
import { useSession } from '../session';
import type { ItemView } from '../types';
import { Button, formatDate, Notice, SelectField, TextField, useLoad } from '../ui';
import { parseRanges, REASON_NAMES, STATE_ORDER } from './model';
import type { SchemaDimension, SchemaView, ScopeView } from './model';

const STATE_OPTIONS = STATE_ORDER.map((state) => ({ value: state, label: COVERAGE_STATE_NAMES[state] }));

function regionText(region: Readonly<Record<string, unknown>>): string {
  return Object.entries(region).map(([name, value]) => `${name}: ${(value as ({ from: string; to: string } | string)[]).map((part) => (typeof part === 'string' ? part : part.from === part.to ? part.from : `${part.from}–${part.to}`)).join(', ')}`).join('; ');
}

/** A scope as recorded: what was searched, in which state, against which package version, and whether it counts toward elimination (R56.3, R56.4). */
export function ScopeCard({ scope }: { readonly scope: ScopeView }) {
  return (
    <article aria-label={`Scope recorded ${formatDate(scope.createdAt)}`}>
      <p>
        {scope.schema === null ? 'A written description' : `${scope.schema.name}, version ${scope.schema.version}`}
        {`, for package version ${scope.packageVersion}. Recorded ${formatDate(scope.createdAt)}.`}
        {!scope.current && <span className="rf-meta">{' Superseded by a newer scope.'}</span>}
      </p>
      {scope.label !== null && <Notice tone="warning" title={scope.label}>{scope.text !== null && <p>{scope.text}</p>}</Notice>}
      {scope.entries.length > 0 && (
        <ul className="rf-list" aria-label="Scope entries">{scope.entries.map((entry, index) => <li key={index}><strong>{entry.stateName}</strong>{`: ${regionText(entry.region)}`}</li>)}</ul>
      )}
      {scope.counts !== null && (
        <p className="rf-meta">{`Of ${scope.universe} points: ${STATE_ORDER.map((state) => `${scope.counts![state] ?? '0'} ${COVERAGE_STATE_NAMES[state].toLowerCase()}`).join(', ')}.`}</p>
      )}
      {scope.assumptions.length > 0 && <ul className="rf-list" aria-label="Assumptions">{scope.assumptions.map((assumption, index) => <li key={index}>{assumption}</li>)}</ul>}
      {scope.comparable && (scope.elimination.counts
        ? <p className="rf-status rf-status--success">Its completed work counts toward elimination.</p>
        : (
          <Notice tone="warning" title="Its completed work does not count toward elimination.">
            <ul className="rf-list">{scope.elimination.reasons.map((reason) => <li key={reason}>{REASON_NAMES[reason] ?? reason}</li>)}</ul>
          </Notice>
        ))}
    </article>
  );
}

interface EntryDraft { state: CoverageState; values: Record<string, string> }

function dimensionLabel(dimension: SchemaDimension): string {
  return dimension.kind === 'integer' ? `${dimension.name} (whole numbers ${dimension.min} to ${dimension.max})` : `${dimension.name} (${dimension.members!.join(', ')})`;
}

function ScopeForm({ item, packageVersion, onSaved }: { readonly item: ItemView; readonly packageVersion: number; readonly onSaved: () => void }) {
  const client = useApi();
  const schemas = useLoad<{ schemas: SchemaView[] }>(`/projects/${item.project.id}/scope-schemas`);
  const [schemaId, setSchemaId] = useState('');
  const [text, setText] = useState('');
  const [assumptions, setAssumptions] = useState('');
  const [entries, setEntries] = useState<EntryDraft[]>([]);
  const [error, setError] = useState<unknown>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const schema = schemas.data?.schemas.find((entry) => entry.id === schemaId);
  const send = async () => {
    const body: Record<string, unknown> = { rev: item.rev, packageVersion, assumptions: assumptions.split('\n').map((line) => line.trim()).filter((line) => line !== '') };
    if (schema === undefined) body['text'] = text;
    else {
      const built = [];
      for (const [index, entry] of entries.entries()) {
        const region: Record<string, unknown> = {};
        for (const dimension of schema.dimensions) {
          const given = entry.values[dimension.name] ?? '';
          if (dimension.kind === 'integer') {
            const parsed = parseRanges(given);
            if ('error' in parsed) { setProblem(`Entry ${index + 1}, ${dimension.name}: ${parsed.error}`); return; }
            region[dimension.name] = parsed.ranges;
          } else region[dimension.name] = given.split(',').map((member) => member.trim()).filter((member) => member !== '');
        }
        built.push({ state: entry.state, region });
      }
      body['schema'] = { id: schema.id, version: schema.version };
      body['entries'] = built;
    }
    setProblem(undefined);
    try { await client.post(`/runs/${item.id}/scope`, body); setError(undefined); setText(''); setEntries([]); setAssumptions(''); onSaved(); } catch (failure) { setError(failure); }
  };
  return (
    <section aria-label="Record a scope">
      <h3>Record what was searched</h3>
      <SelectField
        label="Scope schema" value={schemaId} placeholder="A written description only" onChange={(next) => { setSchemaId(next); setEntries([]); }}
        hint="A written description is kept, but it cannot be compared and never counts toward elimination."
        options={(schemas.data?.schemas ?? []).map((entry) => ({ value: entry.id, label: `${entry.name}, version ${entry.version}` }))}
      />
      {schema === undefined ? <TextField label="Scope description" value={text} onChange={setText} multiline /> : (
        <>
          {entries.map((entry, index) => (
            <fieldset key={index} className="rf-fieldset">
              <legend>{`Entry ${index + 1}`}</legend>
              <SelectField label={`State of entry ${index + 1}`} value={entry.state} options={STATE_OPTIONS} onChange={(state) => setEntries(entries.map((row, at) => (at === index ? { ...row, state: state as CoverageState } : row)))} />
              {schema.dimensions.map((dimension) => (
                <TextField
                  key={dimension.name} label={`${dimension.name}, entry ${index + 1}`} hint={dimensionLabel(dimension)} value={entry.values[dimension.name] ?? ''}
                  onChange={(value) => setEntries(entries.map((row, at) => (at === index ? { ...row, values: { ...row.values, [dimension.name]: value } } : row)))}
                />
              ))}
              <div className="rf-actions"><Button variant="quiet" label={`Remove entry ${index + 1}`} onClick={() => setEntries(entries.filter((_, at) => at !== index))}>Remove</Button></div>
            </fieldset>
          ))}
          <div className="rf-actions"><Button onClick={() => setEntries([...entries, { state: 'completed', values: {} }])}>Add an entry</Button></div>
        </>
      )}
      <TextField label="Assumptions" hint="One per line." value={assumptions} onChange={setAssumptions} multiline />
      {problem !== undefined && <Notice tone="danger" title={problem} />}
      <div className="rf-actions"><Button variant="primary" onClick={() => { void send(); }}>Record this scope</Button></div>
      <Failure error={error} />
    </section>
  );
}

export function ScopeSection({ item, packageVersion, onChanged }: { readonly item: ItemView; readonly packageVersion: number; readonly onChanged: () => void }) {
  const session = useSession();
  const loaded = useLoad<{ current: ScopeView | null; history: ScopeView[] }>(`/runs/${item.id}/scope`);
  const saved = () => { loaded.reload(); onChanged(); };
  return (
    <section aria-label="Search scope">
      <h3>Search scope</h3>
      {loaded.data === undefined && !(loaded.error instanceof ApiFailure) && <p className="rf-meta" role="status">Loading…</p>}
      {loaded.data !== undefined && loaded.data.current === null && <p>No scope has been recorded for this Run.</p>}
      {loaded.data?.current != null && <ScopeCard scope={loaded.data.current} />}
      {loaded.data !== undefined && loaded.data.history.length > 1 && (
        <details>
          <summary>{`Earlier scopes (${loaded.data.history.length - 1})`}</summary>
          {loaded.data.history.slice(1).map((scope) => <ScopeCard key={scope.id} scope={scope} />)}
        </details>
      )}
      {session.can('item.edit') && item.withdrawal === null && <ScopeForm item={item} packageVersion={packageVersion} onSaved={saved} />}
    </section>
  );
}
