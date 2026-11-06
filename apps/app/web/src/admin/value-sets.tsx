import { useState } from 'react';
import { VALUE_SET_KINDS } from '@researchforce/domain/value-sets';
import type { ValueSetKind } from '@researchforce/domain/value-sets';
import { ApiFailure, useApi } from '../api';
import { useSession } from '../session';
import { Button, LoadState, Notice, SaveFailure, TextField, useLoad } from '../ui';
import { METHODS_GROUP_NAMES, VALUE_SET_NAMES } from './labels';

/** One value of a configurable value set, as `GET /value-sets` returns it (R46.11, R46.13, R33.8). */
interface ValueRecord {
  readonly id: string;
  readonly set: ValueSetKind;
  readonly name: string;
  readonly retired: boolean;
  readonly locked: boolean;
  readonly position: number;
  readonly publicDescription: string | null;
  readonly permitsPublication?: boolean;
  readonly rev: number;
}
/** One fixed Methods_Term with its Public_Description (R46.12, R46.13). */
interface MethodsTermRecord {
  readonly key: string;
  readonly group: string;
  readonly name: string;
  readonly position: number;
  readonly publicDescription: string;
  readonly rev: number;
}
interface ValueSetsView {
  readonly valueSets: Readonly<Record<string, readonly ValueRecord[]>>;
  readonly methodsTerms: readonly MethodsTermRecord[];
}
/** The confirmation step a mark-not-permitting returns: the number of Public Attachments it would downgrade (R33.8). */
interface AffectedView { readonly affected: { readonly count: number; readonly confirmation: string } }

const setPath = (set: ValueSetKind): string => set.replaceAll('_', '-');
const isMethodsTermSet = (set: ValueSetKind): boolean => set !== 'specialty';
const fieldErrors = (failure: unknown, field: string) => (failure instanceof ApiFailure ? failure.issuesFor(field) : []);

/** One value's controls: rename, retire, the publication mark (with R33.8 confirmation), and the Public_Description. */
function ValueRow({ value, canManage, canMark, canDescribe, onChanged }: {
  readonly value: ValueRecord; readonly canManage: boolean; readonly canMark: boolean; readonly canDescribe: boolean; readonly onChanged: () => void;
}) {
  const client = useApi();
  const set = value.set;
  const [name, setName] = useState(value.name);
  const [description, setDescription] = useState(value.publicDescription ?? '');
  const [failure, setFailure] = useState<unknown>(undefined);
  const [confirm, setConfirm] = useState<{ count: number; confirmation: string } | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const patch = async (body: Record<string, unknown>) => {
    setBusy(true); setFailure(undefined);
    try {
      const result = await client.patch<Partial<AffectedView>>(`/value-sets/${setPath(set)}/${value.id}`, { rev: value.rev, ...body });
      // A mark that would downgrade Public Attachments applies nothing until re-sent with the confirmation (R33.8).
      if (result.affected !== undefined) { setConfirm(result.affected); return; }
      setConfirm(undefined);
      onChanged();
    } catch (error) { setFailure(error); }
    finally { setBusy(false); }
  };

  const applyMarkNotPermitting = () => void patch({ permitsPublication: false, confirmation: confirm?.confirmation });

  return (
    <li className="rf-section" aria-label={`${value.name}${value.retired ? ' (retired)' : ''}`}>
      <SaveFailure error={failure} />
      <p>
        <strong>{value.name}</strong>
        {value.retired && <span className="rf-meta"> — retired</span>}
        {value.permitsPublication !== undefined && <span className="rf-meta">{value.permitsPublication ? ' — permits publication' : ' — does not permit publication'}</span>}
      </p>

      {canManage && !value.locked && (
        <div className="rf-actions">
          <TextField label={`Name of ${value.name}`} value={name} onChange={setName} maxLength={50} errors={fieldErrors(failure, 'name')} />
          <Button disabled={busy || name.trim() === value.name} onClick={() => void patch({ name })}>{`Rename ${value.name}`}</Button>
          {!value.retired && <Button variant="danger" disabled={busy} onClick={() => void patch({ retired: true })}>{`Retire ${value.name}`}</Button>}
        </div>
      )}

      {canMark && value.permitsPublication !== undefined && (
        <div className="rf-actions">
          {value.permitsPublication
            ? <Button disabled={busy} onClick={() => void patch({ permitsPublication: false })}>Mark as not permitting publication</Button>
            : <Button disabled={busy} onClick={() => void patch({ permitsPublication: true })}>Mark as permitting publication</Button>}
        </div>
      )}
      {confirm !== undefined && (
        <section className="rf-section" role="dialog" aria-label={`Confirm marking ${value.name} as not permitting publication`}>
          <Notice tone="warning" title={`${confirm.count} public attachment${confirm.count === 1 ? '' : 's'} hold this value and would be set to Withheld.`} />
          <div className="rf-actions">
            <Button variant="danger" disabled={busy} onClick={applyMarkNotPermitting}>Confirm and apply the mark</Button>
            <Button variant="quiet" onClick={() => setConfirm(undefined)}>Cancel</Button>
          </div>
        </section>
      )}

      {canDescribe && isMethodsTermSet(set) && (
        <div className="rf-actions">
          <TextField label={`Public description of ${value.name}`} multiline value={description} maxLength={500} onChange={setDescription} errors={fieldErrors(failure, 'publicDescription')} hint="1 to 500 characters, shown on the Methods page." />
          <Button disabled={busy || description === (value.publicDescription ?? '')} onClick={() => void patch({ publicDescription: description })}>{`Save the description of ${value.name}`}</Button>
        </div>
      )}
    </li>
  );
}

/** One Methods_Term's Public_Description, editable by a Member who may describe methods (R46.12, R46.13). */
function MethodsTermRow({ term, canDescribe, onChanged }: { readonly term: MethodsTermRecord; readonly canDescribe: boolean; readonly onChanged: () => void }) {
  const client = useApi();
  const [description, setDescription] = useState(term.publicDescription);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setFailure(undefined);
    try {
      await client.patch(`/value-sets/methods-terms/${term.key}`, { rev: term.rev, publicDescription: description });
      onChanged();
    } catch (error) { setFailure(error); }
    finally { setBusy(false); }
  };
  return (
    <li className="rf-section" aria-label={term.name}>
      <p><strong>{term.name}</strong></p>
      <SaveFailure error={failure} />
      {canDescribe
        ? (
          <div className="rf-actions">
            <TextField label={`Public description of ${term.name}`} multiline value={description} maxLength={500} onChange={setDescription} errors={fieldErrors(failure, 'publicDescription')} hint="1 to 500 characters." />
            <Button variant="primary" disabled={busy || description === term.publicDescription} onClick={() => void save()}>{`Save the description of ${term.name}`}</Button>
          </div>
        )
        : <p>{term.publicDescription}</p>}
    </li>
  );
}

/**
 * `/admin/value-sets`: every configurable value set with its values, and the fixed Methods_Terms. An Administrator can
 * rename and retire values, mark Rights_Status values as permitting publication or not (with the R33.8 affected-count
 * confirmation before a mark-not-permitting applies), and write Public_Descriptions (R33.8, R46.13).
 */
export function ValueSetsScreen() {
  const { can } = useSession();
  const canManage = can('valueSet.manage');
  const canMark = can('rights.markPublication');
  const canDescribe = can('methods.describe');
  const data = useLoad<ValueSetsView>('/value-sets');
  if (!data.data) return <LoadState error={data.error} />;
  const reload = () => data.reload();
  const groups = Object.keys(METHODS_GROUP_NAMES);
  const termsByGroup = (group: string) => data.data!.methodsTerms.filter((term) => term.group === group);
  return (
    <div className="rf-stack">
      <h1>Value sets and methods terms</h1>
      <p className="rf-meta">The configurable value sets and the fixed methods terms the public site presents on the Methods page.</p>

      {VALUE_SET_KINDS.map((kind) => {
        const values = data.data!.valueSets[kind] ?? [];
        return (
          <section key={kind} className="rf-section" aria-label={VALUE_SET_NAMES[kind]}>
            <h2>{VALUE_SET_NAMES[kind]}</h2>
            {values.length === 0
              ? <p className="rf-meta">No values yet.</p>
              : <ul className="rf-list">{values.map((value) => <ValueRow key={value.id} value={value} canManage={canManage} canMark={canMark} canDescribe={canDescribe} onChanged={reload} />)}</ul>}
          </section>
        );
      })}

      <section aria-label="Methods terms">
        <h2>Methods terms</h2>
        {groups.map((group) => (
          <section key={group} className="rf-section" aria-label={METHODS_GROUP_NAMES[group]}>
            <h3>{METHODS_GROUP_NAMES[group]}</h3>
            <ul className="rf-list">{termsByGroup(group).map((term) => <MethodsTermRow key={term.key} term={term} canDescribe={canDescribe} onChanged={reload} />)}</ul>
          </section>
        ))}
      </section>
    </div>
  );
}
