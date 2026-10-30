import { Failure } from './failure';
import { useState } from 'react';
import { Link } from 'react-router';
import { INGREDIENT_NAMES } from '@researchforce/domain/compute';
import { API_BASE, ApiFailure, useApi } from '../api';
import { useSession } from '../session';
import type { ItemView } from '../types';
import { Button, CheckboxField, formatDate, LoadState, Notice, SelectField, TextField, useLoad } from '../ui';
import { artifactStatus, draftOf, packageBody, STATE_MEANING } from './model';
import type { PackageCheck, PackageDraft, PackageView } from './model';
import { ScopeSection } from './scope';
import { ReproductionSection } from './reproductions';

const ROLE_OPTIONS = [{ value: 'input', label: 'Input' }, { value: 'output', label: 'Output' }, { value: 'checkpoint', label: 'Checkpoint' }];
const KIND_OPTIONS = [{ value: 'toolchain', label: 'Toolchain' }, { value: 'hardware', label: 'Hardware' }, { value: 'os', label: 'Operating system' }, { value: 'dependency', label: 'Dependency' }, { value: 'seed', label: 'Random seed' }];
const TYPE_OPTIONS = [{ value: 'attachment', label: 'An Attachment in the archive' }, { value: 'external', label: 'An external reference' }];
const BLANK_ENVIRONMENT: PackageDraft['environment'][number] = { kind: 'toolchain', name: '', value: '' };
const BLANK_ARTIFACT: PackageDraft['artifacts'][number] = { role: 'input', type: 'external', unitId: '', uri: '', name: '', sha256: '' };
const ROLE_NAMES: Readonly<Record<string, string>> = { input: 'Input', output: 'Output', checkpoint: 'Checkpoint' };

function Manifest({ view }: { readonly view: PackageView }) {
  const { manifest } = view;
  const line = (label: string, value: string | undefined) => (value === undefined ? null : <><dt>{label}</dt><dd>{value}</dd></>);
  return (
    <dl aria-label="Package description">
      {line('Repository', manifest.code.repository)}{line('Commit', manifest.code.commit)}{line('Release', manifest.code.release)}
      {line('Command', manifest.command)}{line('Entrypoint', manifest.entrypoint)}{line('Method version', manifest.methodVersion)}
      {line('Uses randomness', manifest.usesRandomness ? 'Yes' : 'No')}
      {manifest.configuration !== undefined && <><dt>Configuration</dt><dd><pre className="rf-code" aria-label="Configuration">{JSON.stringify(manifest.configuration, null, 2)}</pre></dd></>}
      {manifest.environment.length > 0 && (
        <><dt>Environment</dt><dd><ul className="rf-list">{manifest.environment.map((entry, index) => <li key={index}>{`${entry.kind}: ${entry.name} = ${entry.value}`}</li>)}</ul></dd></>
      )}
    </dl>
  );
}

function Artifacts({ view }: { readonly view: PackageView }) {
  if (view.artifacts.length === 0) return <p>No input, output or checkpoint is listed that you can read.</p>;
  return (
    <ul className="rf-list" aria-label="Inputs, outputs and checkpoints">
      {view.artifacts.map((artifact, index) => (
        <li key={index}>
          <strong>{ROLE_NAMES[artifact.role]}</strong>{': '}
          {artifact.type === 'attachment' && artifact.unitId !== undefined ? <Link to={`/items/${artifact.unitId}`}>{artifact.title ?? artifact.identifier ?? artifact.unitId}</Link> : <span>{artifact.name ?? artifact.uri}</span>}
          {artifact.type === 'external' && artifact.uri !== undefined && <span className="rf-meta">{` (${artifact.uri})`}</span>}
          {artifact.sha256 !== undefined && <span className="rf-meta">{` SHA-256 ${artifact.sha256}`}</span>}
          <span className={artifact.type === 'external' || !artifact.verified ? 'rf-status rf-status--warning' : 'rf-status rf-status--success'}>{` ${artifactStatus(artifact)}`}</span>
        </li>
      ))}
    </ul>
  );
}

function Rows<T>({ label, rows, onChange, blank, children }: {
  readonly label: string; readonly rows: readonly T[]; readonly onChange: (rows: T[]) => void; readonly blank: T; readonly children: (row: T, set: (row: T) => void, index: number) => React.ReactNode;
}) {
  return (
    <fieldset className="rf-fieldset">
      <legend>{label}</legend>
      {rows.map((row, index) => (
        <div key={index} className="rf-stack">
          {children(row, (next) => onChange(rows.map((entry, at) => (at === index ? next : entry))), index)}
          <div className="rf-actions"><Button variant="quiet" label={`Remove ${label.toLowerCase()} ${index + 1}`} onClick={() => onChange(rows.filter((_, at) => at !== index))}>Remove</Button></div>
        </div>
      ))}
      <div className="rf-actions"><Button onClick={() => onChange([...rows, blank])}>{`Add to ${label.toLowerCase()}`}</Button></div>
    </fieldset>
  );
}

function PackageForm({ item, current, onSaved }: { readonly item: ItemView; readonly current: PackageView | undefined; readonly onSaved: () => void }) {
  const newest = current === undefined ? 0 : current.versions[current.versions.length - 1]!.version;
  const client = useApi();
  const [draft, setDraft] = useState<PackageDraft>(() => draftOf(current));
  const [error, setError] = useState<unknown>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [check, setCheck] = useState<PackageCheck | undefined>(undefined);
  const set = <K extends keyof PackageDraft>(key: K) => (value: PackageDraft[K]) => setDraft({ ...draft, [key]: value });
  const build = () => {
    const built = packageBody(draft, item.rev, newest);
    if ('error' in built) { setProblem(built.error); return undefined; }
    setProblem(undefined);
    return built.body;
  };
  const send = async (path: string, done: (result: unknown) => void) => {
    const body = build();
    if (body === undefined) return;
    try { done(await client.post(path, body)); setError(undefined); } catch (failure) { setError(failure); }
  };
  return (
    <section aria-label="Record a package version">
      <h3>{current === undefined ? 'Record the package' : `Record a new version, starting from version ${current.version}`}</h3>
      <p className="rf-meta">Nothing here is run or visited. Keep passwords and tokens outside the package and name where they are kept.</p>
      <TextField label="Code repository" value={draft.repository} onChange={set('repository')} />
      <TextField label="Commit" hint="The full 40 or 64 hexadecimal digits." value={draft.commit} onChange={set('commit')} />
      <TextField label="Release" hint="Use this instead of a commit when the code was released." value={draft.release} onChange={set('release')} />
      <TextField label="Command" value={draft.command} onChange={set('command')} />
      <TextField label="Entrypoint" value={draft.entrypoint} onChange={set('entrypoint')} />
      <TextField label="Method version" value={draft.methodVersion} onChange={set('methodVersion')} />
      <CheckboxField label="The Run uses randomness" checked={draft.usesRandomness} onChange={set('usesRandomness')} />
      <TextField label="Configuration (JSON)" hint="Whole numbers up to 9007199254740991 only. Write seeds, decimals and larger numbers as text so every digit is kept." value={draft.configuration} onChange={set('configuration')} multiline />
      <Rows label="Environment" rows={draft.environment} onChange={set('environment')} blank={BLANK_ENVIRONMENT}>
        {(row, change, index) => (
          <>
            <SelectField label={`Environment kind ${index + 1}`} value={row.kind} options={KIND_OPTIONS} onChange={(kind) => change({ ...row, kind: kind as typeof row.kind })} />
            <TextField label={`Environment name ${index + 1}`} value={row.name} onChange={(name) => change({ ...row, name })} />
            <TextField label={`Environment value ${index + 1}`} value={row.value} onChange={(value) => change({ ...row, value })} />
          </>
        )}
      </Rows>
      <Rows label="Inputs, outputs and checkpoints" rows={draft.artifacts} onChange={set('artifacts')} blank={BLANK_ARTIFACT}>
        {(row, change, index) => (
          <>
            <SelectField label={`Role ${index + 1}`} value={row.role} options={ROLE_OPTIONS} onChange={(role) => change({ ...row, role: role as typeof row.role })} />
            <SelectField label={`Kind of reference ${index + 1}`} value={row.type} options={TYPE_OPTIONS} onChange={(type) => change({ ...row, type: type as typeof row.type })} />
            {row.type === 'attachment'
              ? <TextField label={`Attachment id ${index + 1}`} hint="Its hash is recorded as it is now." value={row.unitId} onChange={(unitId) => change({ ...row, unitId })} />
              : <><TextField label={`Address ${index + 1}`} hint="An https, s3, gs, git, ssh, ipfs or doi address. It is never visited." value={row.uri} onChange={(uri) => change({ ...row, uri })} /><TextField label={`Name ${index + 1}`} value={row.name} onChange={(name) => change({ ...row, name })} /></>}
            <TextField label={`SHA-256 ${index + 1}`} hint="Optional for an external reference; it is not verified by the archive." value={row.sha256} onChange={(sha256) => change({ ...row, sha256 })} />
          </>
        )}
      </Rows>
      {problem !== undefined && <Notice tone="danger" title={problem} />}
      {check !== undefined && (
        <Notice tone="success" title={`This description is valid and would be ${check.stateName}.`}>
          {check.missing.length > 0 && <p>{`Still missing: ${check.missing.map((entry) => entry.name).join('; ')}.`}</p>}
          <p className="rf-meta">{`Manifest hash ${check.manifestHash}`}</p>
        </Notice>
      )}
      <div className="rf-actions">
        <Button onClick={() => { void send(`/runs/${item.id}/package/validate`, (result) => setCheck(result as PackageCheck)); }}>Check this description</Button>
        <Button variant="primary" onClick={() => { void send(`/runs/${item.id}/package`, () => { setCheck(undefined); onSaved(); }); }}>Record this version</Button>
      </div>
      <Failure error={error} />
    </section>
  );
}

/** A Run's package: what it was made from and how, the ingredients still missing, and every version (R56.1, R56.2, R56.6). */
export function ComputePanel({ item, onChanged }: { readonly item: ItemView; readonly onChanged: () => void }) {
  const session = useSession();
  const [version, setVersion] = useState<number | undefined>(undefined);
  const loaded = useLoad<{ package: PackageView }>(`/runs/${item.id}/package${version === undefined ? '' : `?version=${version}`}`);
  const none = loaded.error instanceof ApiFailure && loaded.error.code === 'not_found';
  const view = loaded.data?.package;
  const saved = () => { setVersion(undefined); loaded.reload(); onChanged(); };
  const canEdit = session.can('item.edit') && item.withdrawal === null;
  return (
    <section className="rf-section" aria-label="Compute package">
      <h2>Compute package</h2>
      {view === undefined && !none && <LoadState error={loaded.error} />}
      {none && <p>No package has been recorded for this Run.</p>}
      {view !== undefined && (
        <>
          <p>{`Version ${view.version}${view.latest ? ' (latest)' : ''}: ${view.stateName}. ${STATE_MEANING[view.state]}`}</p>
          {view.missing.length > 0 && (
            <Notice tone="warning" title="Still missing from this package">
              <ul className="rf-list" aria-label="Missing ingredients">{view.missing.map((entry) => <li key={entry.ingredient}>{INGREDIENT_NAMES[entry.ingredient as keyof typeof INGREDIENT_NAMES] ?? entry.name}</li>)}</ul>
            </Notice>
          )}
          {!view.configurationIntact && <Notice tone="danger" title="The stored configuration does not match its recorded hash. Do not rely on it." />}
          {!view.hashVerifiable && <Notice tone="warning" title="Some of this package is not visible to you, so its manifest hash cannot be recomputed from what you see." />}
          <p className="rf-meta">{`Recorded ${formatDate(view.createdAt)}${view.createdByName === null ? '' : ` by ${view.createdByName}`}. Manifest hash ${view.manifestHash}.`}</p>
          <Manifest view={view} />
          <Artifacts view={view} />
          <p className="rf-meta">{`${view.held} held by the archive; ${view.unverified} not verified.`}</p>
          <p><a href={`${API_BASE}/runs/${item.id}/package/export?version=${view.version}`} download="compute-package.json">{`Export version ${view.version} as JSON`}</a></p>
          {view.versions.length > 1 && (
            <SelectField label="Version shown" value={String(view.version)} options={view.versions.map((entry) => ({ value: String(entry.version), label: `Version ${entry.version}, ${formatDate(entry.createdAt)}` }))} onChange={(next) => setVersion(Number(next))} />
          )}
        </>
      )}
      {canEdit && (loaded.data !== undefined || none) && <PackageForm key={view?.version ?? 0} item={item} current={view} onSaved={saved} />}
      {view !== undefined && (
        <>
          <ScopeSection item={item} packageVersion={view.versions[view.versions.length - 1]!.version} onChanged={() => { loaded.reload(); onChanged(); }} />
          <ReproductionSection item={item} version={view.version} onChanged={() => { loaded.reload(); onChanged(); }} />
        </>
      )}
    </section>
  );
}
