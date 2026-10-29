import { useId, useState } from 'react';
import { ACCESS_STATEMENT, ROLE_IDS } from '@researchforce/domain/permissions';
import type { AccessLevel } from '@researchforce/domain/types';
import { ApiFailure, useApi } from '../api';
import type { FieldIssue } from '../api';
import { useSession } from '../session';
import type { AccessPreviewView, AccessView, ItemView, MemberRow, PersonRef } from '../types';
import { Button, CheckboxField, levelName, Notice, PersonLink, SaveFailure } from '../ui';

export const ACCESS_LEVEL_NAMES: Readonly<Record<AccessLevel, string>> = { whole_team: 'Whole team', restricted: 'Restricted' };
export const accessLevelName = (level: string): string => ACCESS_LEVEL_NAMES[level as AccessLevel] ?? level;

/** A new Research_Item's Access_Level and Access_List, as the Submission sends them (R47.1, R47.2). */
export interface AccessValue { readonly level: AccessLevel; readonly members: readonly string[] }
export const WHOLE_TEAM: AccessValue = { level: 'whole_team', members: [] };
export const accessBody = (value: AccessValue) => ({ level: value.level, ...(value.level === 'restricted' && value.members.length > 0 ? { members: value.members } : {}) });

const memberName = (member: MemberRow): string => member.displayName ?? member.email;
/** Members an Access_List can name: Pending or Active, other than the Owner, who always reads the item (R47.2). */
export function listable(members: readonly MemberRow[], ownerId: string): MemberRow[] {
  return members.filter((member) => (member.status === 'pending' || member.status === 'active') && member.id !== ownerId);
}
const names = (people: readonly PersonRef[]): string => people.map((person) => person.displayName ?? 'a Member without a display name').join(', ');

/** Shown with a Research_Item that only its Owner, its Access_List, and Administrators read (R47.11). */
export function RestrictedMark() {
  return <span className="rf-status rf-status--warning">Restricted</span>;
}

function MemberChoices({ legend, members, chosen, onChange, errors, empty }: {
  readonly legend: string; readonly members: readonly MemberRow[]; readonly chosen: readonly string[]; readonly onChange: (chosen: string[]) => void;
  readonly errors: readonly FieldIssue[]; readonly empty: string;
}) {
  return (
    <fieldset className={errors.length > 0 ? 'rf-field rf-field--invalid' : 'rf-field'}>
      <legend className="rf-field__label">{legend}</legend>
      {errors.length > 0 && <p className="rf-field__error">{errors.map((issue) => issue.rule).join(' ')}</p>}
      {members.length === 0 ? <p className="rf-meta">{empty}</p> : members.map((member) => (
        <CheckboxField key={member.id} label={memberName(member)} checked={chosen.includes(member.id)}
          onChange={(checked) => onChange(checked ? [...chosen, member.id] : chosen.filter((id) => id !== member.id))} />
      ))}
    </fieldset>
  );
}

function LevelChoice<T extends string>({ legend, value, options, onChange, errors = [] }: {
  readonly legend: string; readonly value: T; readonly options: readonly { readonly value: T; readonly label: string }[]; readonly onChange: (value: T) => void;
  readonly errors?: readonly FieldIssue[];
}) {
  const name = useId();
  return (
    <fieldset className={errors.length > 0 ? 'rf-field rf-field--invalid' : 'rf-field'}>
      <legend className="rf-field__label">{legend}</legend>
      <p className="rf-field__hint">{ACCESS_STATEMENT}</p>
      {errors.length > 0 && <p className="rf-field__error">{errors.map((issue) => issue.rule).join(' ')}</p>}
      {options.map((option) => (
        <div className="rf-field rf-field--checkbox" key={option.value}>
          <input className="rf-checkbox" type="radio" id={`${name}-${option.value}`} name={name} checked={value === option.value} onChange={() => onChange(option.value)} />
          <label className="rf-field__label" htmlFor={`${name}-${option.value}`}>{option.label}</label>
        </div>
      ))}
    </fieldset>
  );
}
const LEVEL_OPTIONS = (['whole_team', 'restricted'] as const).map((value) => ({ value, label: ACCESS_LEVEL_NAMES[value] }));

/** Whole_Team or Restricted for a new Research_Item, with the Members who may read it and who always can (R47.1, R47.2). */
export function AccessFields({ value, onChange, members, ownerId, errors }: {
  readonly value: AccessValue; readonly onChange: (value: AccessValue) => void; readonly members: readonly MemberRow[]; readonly ownerId: string; readonly errors: readonly FieldIssue[];
}) {
  const of = (field: string) => errors.filter((issue) => issue.field === field || issue.field.startsWith(`${field}.`));
  return (
    <section className="rf-section" aria-label="Who can read">
      <LevelChoice legend="Who can read this record" value={value.level} options={LEVEL_OPTIONS} onChange={(level) => onChange({ ...value, level })} errors={errors.filter((issue) => issue.field === 'access' || issue.field === 'access.level')} />
      {value.level === 'restricted' && (
        <MemberChoices legend="Access list" members={listable(members, ownerId)} chosen={value.members} onChange={(chosen) => onChange({ ...value, members: chosen })}
          errors={of('access.members')} empty="No other Member can be added." />
      )}
    </section>
  );
}

/** One access change: a new level or none, and the Members to add to and remove from the Access_List. */
interface Change { readonly level: AccessLevel | ''; readonly add: readonly string[]; readonly remove: readonly string[] }
const changeBody = (change: Change) => ({
  ...(change.level === '' ? {} : { level: change.level }), ...(change.add.length > 0 ? { add: change.add } : {}), ...(change.remove.length > 0 ? { remove: change.remove } : {}),
});

/** What the change would do: each item's access before and after, who gains read access, and what stops being public (R47.7, R47.8, R47.14). */
export function AccessPreview({ preview }: { readonly preview: AccessPreviewView }) {
  const changed = preview.items.filter((item) => item.changed);
  const refused = preview.items.filter((item) => item.refusal !== undefined);
  const describe = (side: AccessPreviewView['items'][number]['from']) => `${accessLevelName(side.level)}${side.level === 'restricted' && side.members.length > 0 ? `, Access list: ${names(side.members)}` : ''}`;
  return (
    <section className="rf-stack" aria-label="What this change does">
      {refused.length > 0 && (
        <Notice tone="danger" title="This change cannot be made, so it applies to none of the records.">
          <ul>{refused.map((item) => <li key={item.id}>{`${item.identifier} ${item.title}: ${item.refusal}`}</li>)}</ul>
        </Notice>
      )}
      {changed.length === 0 ? <p>This changes who can read none of the records.</p> : (
        <ul className="rf-list">{changed.map((item) => <li key={item.id}>{`${item.identifier} ${item.title}: ${describe(item.from)} → ${describe(item.to)}`}</li>)}</ul>
      )}
      {preview.gaining.length > 0 && <p>{`These Members would gain read access: ${names(preview.gaining)}.`}</p>}
      {preview.resets.length > 0 && (
        <Notice tone="warning" title="These would become Not published, and their public pages would be removed:">
          <ul>{preview.resets.map((unit) => <li key={unit.unitId}>{`${unit.identifier ?? ''} ${unit.title ?? ''} (${levelName(unit.level)})`.trim()}</li>)}</ul>
        </Notice>
      )}
      <p className="rf-meta">{preview.statement}</p>
    </section>
  );
}

/**
 * Change who can read one or many Research_Items: choose the change, check the preview, and confirm it; a preview that
 * no longer matches comes back to be checked again (R47.6 to R47.8, R47.14).
 */
export function AccessDialog({ title, paths, extra = {}, level, addable, removable, onCancel, onDone }: {
  readonly title: string; readonly paths: { readonly preview: string; readonly apply: string }; readonly extra?: Record<string, unknown>;
  readonly level: AccessLevel | ''; readonly addable: readonly MemberRow[]; readonly removable: readonly MemberRow[];
  readonly onCancel: () => void; readonly onDone: () => void;
}) {
  const client = useApi();
  const [change, setChange] = useState<Change>({ level, add: [], remove: [] });
  const [preview, setPreview] = useState<AccessPreviewView | undefined>(undefined);
  const [stale, setStale] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const edit = (next: Change) => { setChange(next); setPreview(undefined); setStale(false); setFailure(undefined); };
  const run = async (step: () => Promise<void>) => {
    setBusy(true);
    setFailure(undefined);
    try {
      await step();
    } catch (error) {
      if (error instanceof ApiFailure && error.code === 'preview_stale') {
        setPreview((error.details as { preview: AccessPreviewView }).preview);
        setStale(true);
      } else {
        setFailure(error);
      }
    } finally {
      setBusy(false);
    }
  };
  const check = () => run(async () => {
    setPreview(await client.post<AccessPreviewView>(paths.preview, { ...extra, ...changeBody(change) }));
    setStale(false);
  });
  const apply = () => run(async () => {
    await client.post(paths.apply, { ...extra, ...changeBody(change), ...(preview?.confirmation == null ? {} : { confirmation: preview.confirmation }) });
    onDone();
  });
  const errors = failure instanceof ApiFailure ? failure.fields : [];
  const refusals = failure instanceof ApiFailure ? ((failure.details as { items?: { identifier: string; reason: string }[] } | undefined)?.items ?? []) : [];
  const levels = level === '' ? [{ value: '' as const, label: 'Keep each record’s level' }, ...LEVEL_OPTIONS] : LEVEL_OPTIONS;
  const blocked = preview === undefined || preview.items.some((item) => item.refusal !== undefined) || !preview.items.some((item) => item.changed);
  return (
    <section className="rf-section" role="dialog" aria-label={title}>
      <h2>{title}</h2>
      <SaveFailure error={failure} />
      {refusals.length > 0 && <ul>{refusals.map((item) => <li key={item.identifier}>{`${item.identifier}: ${item.reason}`}</li>)}</ul>}
      {errors.some((issue) => issue.field.startsWith('itemIds')) && <Notice tone="danger" title="Some of the chosen records no longer exist or cannot be read." />}
      <LevelChoice legend="Who can read" value={change.level} options={levels} onChange={(next) => edit({ ...change, level: next })} errors={errors.filter((issue) => issue.field === 'level')} />
      {change.level !== 'whole_team' && (
        <MemberChoices legend="Add to the Access list" members={addable} chosen={change.add} onChange={(add) => edit({ ...change, add })}
          errors={errors.filter((issue) => issue.field === 'add' || issue.field.startsWith('add.'))} empty="No other Member can be added." />
      )}
      {removable.length > 0 && change.level !== 'whole_team' && (
        <MemberChoices legend="Remove from the Access list" members={removable} chosen={change.remove} onChange={(remove) => edit({ ...change, remove })}
          errors={errors.filter((issue) => issue.field.startsWith('remove'))} empty="" />
      )}
      {stale && <Notice tone="warning" title="Something changed since you checked. Check what the change does again before confirming." />}
      {preview !== undefined && <AccessPreview preview={preview} />}
      <div className="rf-actions">
        <Button onClick={() => void check()} disabled={busy}>Check what this changes</Button>
        <Button variant="primary" onClick={() => void apply()} disabled={busy || blocked}>Confirm the change</Button>
        <Button variant="quiet" onClick={onCancel}>Cancel</Button>
      </div>
    </section>
  );
}

/** Who may open the access dialog: the Owner, or an Administrator, who can only narrow (R47.6, R47.7). */
function canChange(session: ReturnType<typeof useSession>, ownerId: string): boolean {
  return session.me.member.id === ownerId || session.me.member.roleId === ROLE_IDS.administrator;
}

/** The Access_Level with the Owner and the Access_List on an item page, and the access dialog (R47.7, R47.11). */
export function AccessSummary({ item, members, onChanged }: { readonly item: Pick<ItemView, 'id' | 'owner'> & { readonly access: AccessView }; readonly members: readonly MemberRow[]; readonly onChanged: () => void }) {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const { access } = item;
  const onList = new Set(access.members.map((member) => member.id));
  return (
    <section className="rf-section" aria-label="Who can read">
      {access.level === 'whole_team' ? <p>Every Member of the team can read this record.</p> : (
        <>
          <p><RestrictedMark />{' Only its Owner, '}<PersonLink person={item.owner} />{', the Members on its Access list, and Administrators can read this record.'}</p>
          <p>{access.members.length === 0 ? 'The Access list is empty.' : `Access list: ${names(access.members)}.`}</p>
          <p className="rf-meta">{access.statement}</p>
        </>
      )}
      {canChange(session, item.owner.id) && !open && <Button onClick={() => setOpen(true)}>Change who can read</Button>}
      {open && (
        <AccessDialog title="Change who can read" paths={{ preview: `/items/${item.id}/access/preview`, apply: `/items/${item.id}/access` }} level={access.level}
          addable={listable(members, item.owner.id).filter((member) => !onList.has(member.id))} removable={members.filter((member) => onList.has(member.id))}
          onCancel={() => setOpen(false)} onDone={() => { setOpen(false); onChanged(); }} />
      )}
    </section>
  );
}

/** Records chosen on a list for one bulk access change of 1 to 1,000 Research_Items (R47.14). */
export function useSelection(): { readonly chosen: readonly string[]; readonly has: (id: string) => boolean; readonly toggle: (id: string, on: boolean) => void; readonly clear: () => void } {
  const [chosen, setChosen] = useState<readonly string[]>([]);
  return {
    chosen, has: (id) => chosen.includes(id), clear: () => setChosen([]),
    toggle: (id, on) => setChosen((current) => (on ? (current.includes(id) ? current : [...current, id]) : current.filter((entry) => entry !== id))),
  };
}

export const MAX_BULK_ITEMS = 1000;

/** The bulk access change for the records chosen on a list; it applies to every record or to none (R47.14). */
export function BulkAccess({ itemIds, members, onDone }: { readonly itemIds: readonly string[]; readonly members: readonly MemberRow[]; readonly onDone: () => void }) {
  const [open, setOpen] = useState(false);
  if (itemIds.length === 0) return null;
  const tooMany = itemIds.length > MAX_BULK_ITEMS;
  return (
    <div className="rf-stack">
      <p className="rf-meta">{`${itemIds.length} ${itemIds.length === 1 ? 'record' : 'records'} chosen.`}</p>
      {tooMany && <Notice tone="warning" title={`Choose at most ${MAX_BULK_ITEMS.toLocaleString('en-GB')} records for one change.`} />}
      {!open && <Button onClick={() => setOpen(true)} disabled={tooMany}>Change who can read the chosen records</Button>}
      {open && (
        <AccessDialog title="Change who can read the chosen records" paths={{ preview: '/access/bulk/preview', apply: '/access/bulk' }} extra={{ itemIds }} level=""
          addable={members.filter((member) => member.status === 'pending' || member.status === 'active')} removable={members}
          onCancel={() => setOpen(false)} onDone={() => { setOpen(false); onDone(); }} />
      )}
    </div>
  );
}
