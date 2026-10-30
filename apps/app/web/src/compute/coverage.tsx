import { Failure } from './failure';
import { useState } from 'react';
import { Link } from 'react-router';
import { useApi } from '../api';
import { useSession } from '../session';
import { Button, LoadState, Notice, SelectField, TextField, useLoad } from '../ui';
import { REASON_NAMES } from './model';
import type { CoverageView, SchemaView } from './model';

const KIND_OPTIONS = [{ value: 'integer', label: 'Whole numbers' }, { value: 'set', label: 'A set of named members' }];
interface DimensionDraft { kind: string; name: string; min: string; max: string; members: string }

function SchemaForm({ projectId, existing, onSaved }: { readonly projectId: string; readonly existing: readonly SchemaView[]; readonly onSaved: () => void }) {
  const client = useApi();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [dimensions, setDimensions] = useState<DimensionDraft[]>([{ kind: 'integer', name: '', min: '0', max: '', members: '' }]);
  const [error, setError] = useState<unknown>(undefined);
  const send = async () => {
    const expectedVersion = Math.max(0, ...existing.filter((entry) => entry.name === name.trim()).map((entry) => entry.version));
    try {
      await client.post(`/projects/${projectId}/scope-schemas`, {
        name: name.trim(), ...(description.trim() === '' ? {} : { description: description.trim() }), expectedVersion,
        dimensions: dimensions.map((row) => (row.kind === 'integer' ? { kind: 'integer', name: row.name.trim(), min: row.min.trim(), max: row.max.trim() } : { kind: 'set', name: row.name.trim(), members: row.members.split(',').map((member) => member.trim()).filter((member) => member !== '') })),
      });
      setError(undefined); setName(''); setDescription('');
      onSaved();
    } catch (failure) { setError(failure); }
  };
  const change = (index: number, patch: Partial<DimensionDraft>) => setDimensions(dimensions.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  return (
    <section aria-label="Define a scope schema">
      <h2>Define a scope schema</h2>
      <p className="rf-meta">Using a name that exists records its next version. A version never changes, and scopes compare only under the same version.</p>
      <TextField label="Schema name" value={name} onChange={setName} />
      <TextField label="Schema description" value={description} onChange={setDescription} multiline />
      {dimensions.map((row, index) => (
        <fieldset key={index} className="rf-fieldset">
          <legend>{`Dimension ${index + 1}`}</legend>
          <SelectField label={`Kind of dimension ${index + 1}`} value={row.kind} options={KIND_OPTIONS} onChange={(kind) => change(index, { kind })} />
          <TextField label={`Dimension name ${index + 1}`} value={row.name} onChange={(value) => change(index, { name: value })} />
          {row.kind === 'integer'
            ? <><TextField label={`Smallest value ${index + 1}`} value={row.min} onChange={(value) => change(index, { min: value })} /><TextField label={`Largest value ${index + 1}`} value={row.max} onChange={(value) => change(index, { max: value })} /></>
            : <TextField label={`Members ${index + 1}`} hint="Separated by commas." value={row.members} onChange={(value) => change(index, { members: value })} />}
          {dimensions.length > 1 && <div className="rf-actions"><Button variant="quiet" label={`Remove dimension ${index + 1}`} onClick={() => setDimensions(dimensions.filter((_, at) => at !== index))}>Remove</Button></div>}
        </fieldset>
      ))}
      {dimensions.length < 4 && <div className="rf-actions"><Button onClick={() => setDimensions([...dimensions, { kind: 'integer', name: '', min: '0', max: '', members: '' }])}>Add a dimension</Button></div>}
      <div className="rf-actions"><Button variant="primary" onClick={() => { void send(); }}>Define this schema</Button></div>
      <Failure error={error} />
    </section>
  );
}

function Results({ projectId, schema }: { readonly projectId: string; readonly schema: SchemaView }) {
  const loaded = useLoad<{ coverage: CoverageView }>(`/projects/${projectId}/coverage?schemaId=${schema.id}&version=${schema.version}`);
  if (loaded.data === undefined) return <LoadState error={loaded.error} />;
  const { coverage } = loaded.data;
  return (
    <section aria-label="Coverage">
      <h2>{`Coverage under ${schema.name}, version ${schema.version}`}</h2>
      <p>{`${coverage.eliminated} of ${coverage.universe} points are covered by completed, verified work you can read.`}</p>
      {coverage.fullElimination
        ? <p className="rf-status rf-status--success">The whole space is covered.</p>
        : <Notice title="The whole space is not shown to be covered. Partial, suspended, stopped, unverified and incomparable work is never counted as covering it." />}
      {coverage.truncated && <Notice tone="warning" title="Only the 200 newest scopes were considered, so full coverage cannot be stated." />}
      <h3>Runs considered</h3>
      {coverage.contributions.length === 0 ? <p>No Run you can read recorded a scope under this version.</p> : (
        <ul className="rf-list" aria-label="Runs considered">
          {coverage.contributions.map((entry) => (
            <li key={entry.scopeId}>
              <Link to={`/items/${entry.runId}`}>{`${entry.runIdentifier}: ${entry.runTitle}`}</Link>
              {entry.counted ? ` counts: ${entry.completed} points completed` : ` does not count: ${entry.reasons.map((reason) => REASON_NAMES[reason] ?? reason).join(' ')}`}
            </li>
          ))}
        </ul>
      )}
      {coverage.incomparable.length > 0 && (
        <>
          <h3>Not comparable</h3>
          <p className="rf-meta">These Runs describe their scope as text or under another schema. They are listed, never combined with the rest.</p>
          <ul className="rf-list" aria-label="Not comparable">
            {coverage.incomparable.map((entry) => <li key={entry.runId}><Link to={`/items/${entry.runId}`}>{`${entry.runIdentifier}: ${entry.runTitle}`}</Link>{entry.reason === 'generic_text' ? ' (written description)' : ' (another schema)'}</li>)}
          </ul>
        </>
      )}
    </section>
  );
}

interface Comparison {
  readonly comparable: boolean; readonly reason?: string; readonly overlap?: { readonly count: string }; readonly union?: { readonly count: string };
  readonly a?: { readonly eliminated: string }; readonly b?: { readonly eliminated: string };
}
function Compare({ projectId }: { readonly projectId: string }) {
  const client = useApi();
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [result, setResult] = useState<Comparison | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const run = async () => {
    try { setResult((await client.get<{ comparison: Comparison }>(`/projects/${projectId}/coverage/compare?a=${a.trim()}&b=${b.trim()}`)).comparison); setError(undefined); } catch (failure) { setError(failure); setResult(undefined); }
  };
  return (
    <section aria-label="Compare two scopes">
      <h2>Compare two scopes</h2>
      <TextField label="First scope id" value={a} onChange={setA} />
      <TextField label="Second scope id" value={b} onChange={setB} />
      <div className="rf-actions"><Button onClick={() => { void run(); }}>Compare</Button></div>
      <Failure error={error} />
      {result !== undefined && (result.comparable
        ? <p>{`Counted work: ${result.a!.eliminated} and ${result.b!.eliminated} points. Overlap ${result.overlap!.count}; together ${result.union!.count}.`}</p>
        : <Notice tone="warning" title={result.reason === 'generic_text' ? 'These scopes cannot be compared: at least one is only a written description.' : 'These scopes cannot be compared: they use different schemas or versions.'} />)}
    </section>
  );
}

/** A Project's scope schemas, and the exact joined coverage of the verified work its Members can read (R56.3, R56.4). */
export function CoverageScreen({ projectId }: { readonly projectId: string }) {
  const session = useSession();
  const loaded = useLoad<{ schemas: SchemaView[] }>(`/projects/${projectId}/scope-schemas`);
  const [chosen, setChosen] = useState('');
  if (loaded.data === undefined) return <LoadState error={loaded.error} />;
  const schemas = loaded.data.schemas;
  const schema = schemas.find((entry) => entry.id === chosen);
  return (
    <div className="rf-stack">
      <h1>Search coverage</h1>
      {schemas.length === 0 ? <p>This Project has no scope schema yet.</p> : (
        <SelectField label="Scope schema" value={chosen} placeholder="Choose a schema" options={schemas.map((entry) => ({ value: entry.id, label: `${entry.name}, version ${entry.version}` }))} onChange={setChosen} />
      )}
      {schema !== undefined && <Results key={schema.id} projectId={projectId} schema={schema} />}
      {schemas.length > 0 && <Compare projectId={projectId} />}
      {session.can('project.edit') && <SchemaForm projectId={projectId} existing={schemas} onSaved={loaded.reload} />}
    </div>
  );
}
