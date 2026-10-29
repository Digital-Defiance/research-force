import { useRef } from 'react';
import type { FieldIssue } from '../../api';
import { Button, TextField } from '../../ui';
import { EntryPicker } from './entry-picker';
import { chosenTargets, MAX_ENTRIES, MAX_GROUPS, moved } from './model';
import type { EntryValue, GroupValue } from './model';

const under = (errors: readonly FieldIssue[], prefix: string) => errors.filter((issue) => issue.field === prefix || issue.field.startsWith(`${prefix}.`));

type Drag = { readonly type: 'group'; readonly group: number } | { readonly type: 'entry'; readonly group: number; readonly entry: number };

/**
 * The Question_Groups of a Research_Question: headings, and entries that can be added by search, removed, and reordered with
 * buttons or by dragging (R50.1, R50.2).
 */
export function GroupsInput({ label, value, onChange, errors, name }: {
  readonly label: string; readonly value: readonly GroupValue[]; readonly onChange: (value: readonly GroupValue[]) => void; readonly errors: readonly FieldIssue[]; readonly name: string;
}) {
  const drag = useRef<Drag | undefined>(undefined);
  const chosen = chosenTargets(value);
  const setGroup = (index: number, next: GroupValue | undefined) => onChange(next === undefined ? value.filter((_group, at) => at !== index) : value.map((group, at) => (at === index ? next : group)));
  const dropEntry = (toGroup: number, toEntry: number) => {
    const from = drag.current;
    drag.current = undefined;
    if (from?.type !== 'entry') return;
    const entry = value[from.group]!.entries[from.entry]!;
    if (from.group === toGroup) { setGroup(toGroup, { ...value[toGroup]!, entries: moved(value[toGroup]!.entries, from.entry, toEntry) }); return; }
    if (value[toGroup]!.entries.length >= MAX_ENTRIES) return;
    onChange(value.map((group, at) => {
      if (at === from.group) return { ...group, entries: group.entries.filter((_entry, i) => i !== from.entry) };
      if (at === toGroup) return { ...group, entries: [...group.entries.slice(0, toEntry), entry, ...group.entries.slice(toEntry)] };
      return group;
    }));
  };
  const dropGroup = (to: number) => {
    const from = drag.current;
    drag.current = undefined;
    if (from?.type === 'group') onChange(moved(value, from.group, to));
  };
  return (
    <fieldset className="rf-field">
      <legend className="rf-field__label">{label}</legend>
      <p className="rf-field__hint">Up to 20 groups of up to 200 entries each. Each record or Attachment can be an entry once.</p>
      {under(errors, name).filter((issue) => issue.field === name).map((issue, index) => <p key={index} className="rf-field__error">{issue.rule}</p>)}
      {value.map((group, index) => (
        <section key={group.id ?? `new-${index}`} className="rf-section" aria-label={`Group ${index + 1}`} draggable
          onDragStart={(event) => { event.stopPropagation(); drag.current = { type: 'group', group: index }; }}
          onDragOver={(event) => event.preventDefault()} onDrop={() => dropGroup(index)}>
          <TextField label={`Group ${index + 1} heading`} value={group.heading} onChange={(heading) => setGroup(index, { ...group, heading })}
            errors={under(errors, `${name}.${index}.heading`)} maxLength={200} required />
          {under(errors, `${name}.${index}.entries`).filter((issue) => issue.field === `${name}.${index}.entries`).map((issue, at) => <p key={at} className="rf-field__error">{issue.rule}</p>)}
          <ol className="rf-list" aria-label={`Entries of group ${index + 1}`}>
            {group.entries.map((entry, at) => {
              const issues = under(errors, `${name}.${index}.entries.${at}`);
              return (
                <li key={entry.targetId} draggable
                  onDragStart={(event) => { event.stopPropagation(); drag.current = { type: 'entry', group: index, entry: at }; }}
                  onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.stopPropagation(); dropEntry(index, at); }}>
                  <span>{entry.label ?? entry.targetId}</span>
                  {issues.map((issue, i) => <p key={i} className="rf-field__error">{issue.rule}</p>)}
                  <div className="rf-actions">
                    <Button variant="quiet" disabled={at === 0} label={`Move entry ${at + 1} of group ${index + 1} up`} onClick={() => setGroup(index, { ...group, entries: moved(group.entries, at, at - 1) })}>Move up</Button>
                    <Button variant="quiet" disabled={at === group.entries.length - 1} label={`Move entry ${at + 1} of group ${index + 1} down`} onClick={() => setGroup(index, { ...group, entries: moved(group.entries, at, at + 1) })}>Move down</Button>
                    <Button variant="quiet" label={`Remove entry ${at + 1} of group ${index + 1}`} onClick={() => setGroup(index, { ...group, entries: group.entries.filter((_entry, i) => i !== at) })}>Remove</Button>
                  </div>
                </li>
              );
            })}
          </ol>
          {group.entries.length < MAX_ENTRIES && (
            <EntryPicker label={`Find an entry for group ${index + 1}`} chosen={chosen}
              onChoose={(entry: EntryValue) => setGroup(index, { ...group, entries: [...group.entries, entry] })} />
          )}
          <div className="rf-actions">
            <Button variant="quiet" disabled={index === 0} label={`Move group ${index + 1} up`} onClick={() => onChange(moved(value, index, index - 1))}>Move group up</Button>
            <Button variant="quiet" disabled={index === value.length - 1} label={`Move group ${index + 1} down`} onClick={() => onChange(moved(value, index, index + 1))}>Move group down</Button>
            <Button variant="quiet" label={`Remove group ${index + 1}`} onClick={() => setGroup(index, undefined)}>Remove group</Button>
          </div>
        </section>
      ))}
      {value.length < MAX_GROUPS && <Button onClick={() => onChange([...value, { heading: '', entries: [] }])}>Add a group</Button>}
    </fieldset>
  );
}
