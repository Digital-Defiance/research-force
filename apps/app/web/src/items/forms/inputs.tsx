import type { RichText } from '@researchforce/domain/richtext';
import type { FieldIssue } from '../../api';
import { RichTextEditor } from '../../editor/RichTextEditor';
import type { MentionOptions } from '../../editor/RichTextEditor';
import { EMPTY_RICH_TEXT } from '../../editor/spans';
import type { MemberRow, PartyRecord, ValueSets } from '../../types';
import { Button, CheckboxField, SelectField, TextField } from '../../ui';
import type { Option } from '../../ui';
import type { CorrespondencePartyValue, CountValue, DateValue, DocumentDateValue, FieldSpec, PartyValue, SectionValue } from './model';

export interface FormData {
  readonly valueSets: ValueSets;
  readonly parties: readonly PartyRecord[];
  readonly members: readonly MemberRow[];
  readonly mentions: MentionOptions;
}

interface InputProps {
  readonly spec: FieldSpec;
  readonly value: unknown;
  readonly onChange: (value: unknown) => void;
  readonly errors: readonly FieldIssue[];
  readonly data: FormData;
}

const optional = <T,>(key: string, value: T | undefined): Record<string, T> => (value === undefined ? {} : { [key]: value });
const own = (errors: readonly FieldIssue[], field: string) => errors.filter((issue) => issue.field === field);
const under = (errors: readonly FieldIssue[], prefix: string) => errors.filter((issue) => issue.field === prefix || issue.field.startsWith(`${prefix}.`));

/** Values that can be newly chosen, plus the current one even after it was retired (R4.6). */
export function valueOptions(sets: ValueSets, spec: FieldSpec, current: string): Option[] {
  const values = spec.set === undefined ? [] : sets[spec.set] ?? [];
  return values.filter((value) => !value.retired || value.id === current).map((value) => ({ value: value.id, label: value.retired ? `${value.name} (retired)` : value.name }));
}

export const partyName = (party: PartyRecord): string => (party.doNotName ? party.genericLabel ?? 'Unnamed party' : party.name);

function partyOptions(data: FormData): Option[] {
  return [
    ...data.members.filter((member) => member.status === 'active' && member.displayName !== null).map((member) => ({ value: `member:${member.id}`, label: `${member.displayName} (Member)` })),
    ...data.parties.map((party) => ({ value: `external:${party.id}`, label: `${partyName(party)} (External Party)` })),
  ];
}
const partyKey = (party: { kind: string; id: string }): string => (party.id === '' ? '' : `${party.kind}:${party.id}`);
function parsePartyKey(key: string): PartyValue {
  const [kind, id] = key.split(':');
  return kind === 'member' || kind === 'external' ? { kind, id: id ?? '' } : { kind: '', id: '' };
}

function DateInput({ label, value, onChange, errors, required, hint }: { label: string; value: DateValue; onChange: (value: DateValue) => void; errors: readonly FieldIssue[]; required?: boolean; hint: string }) {
  return (
    <fieldset className="rf-field">
      <legend className="rf-field__label">{label}</legend>
      <TextField label="Date" value={value.value} onChange={(text) => onChange({ ...value, value: text })} hint={hint} errors={errors} {...optional('required', required)} />
      <CheckboxField label="Approximate" checked={value.approx} onChange={(approx) => onChange({ ...value, approx })} />
    </fieldset>
  );
}

const PARTIAL_HINT = 'A year, a year and month, or a full date: 1944, 1944-06, or 1944-06-06.';
const FULL_HINT = 'A full date: 1944-06-06.';
const CONSENT_OPTIONS: Option[] = [
  { value: 'not_asked', label: 'Not asked' }, { value: 'requested', label: 'Requested' }, { value: 'granted', label: 'Granted' }, { value: 'refused', label: 'Refused' },
];

export function FieldInput({ spec, value, onChange, errors, data }: InputProps) {
  const fieldErrors = under(errors, spec.name);
  const common = { label: spec.label, ...optional('hint', spec.hint), ...optional('required', spec.required) };
  switch (spec.kind) {
    case 'text':
      return <TextField {...common} value={value as string} onChange={onChange} errors={fieldErrors} {...optional('maxLength', spec.max)} />;
    case 'longtext':
      return <TextField {...common} multiline value={value as string} onChange={onChange} errors={fieldErrors} {...optional('maxLength', spec.max)} />;
    case 'item-ref':
      return <TextField {...common} value={value as string} onChange={onChange} errors={fieldErrors} />;
    case 'time':
      return <TextField {...common} value={value as string} onChange={onChange} errors={fieldErrors} hint="A date and time to the second with its offset from UTC: 2026-10-27T18:00:00+01:00." />;
    case 'rich':
      return <RichTextEditor {...common} value={value as RichText} onChange={onChange} errors={fieldErrors} mentions={data.mentions} />;
    case 'value':
      return <SelectField {...common} value={value as string} options={valueOptions(data.valueSets, spec, value as string)} onChange={onChange} placeholder="Choose…" errors={fieldErrors} />;
    case 'choice':
      return <SelectField {...common} value={value as string} options={spec.options ?? []} onChange={onChange} placeholder="Choose…" errors={fieldErrors} />;
    case 'partial-date':
    case 'full-date':
      return <DateInput label={spec.label} value={value as DateValue} onChange={onChange} errors={fieldErrors} hint={spec.kind === 'full-date' ? FULL_HINT : PARTIAL_HINT} {...optional('required', spec.required)} />;
    case 'document-date': {
      const range = value as DocumentDateValue;
      return (
        <fieldset className="rf-field">
          <legend className="rf-field__label">{spec.label}</legend>
          <DateInput label="Date, or start of a date range" value={range.start} onChange={(start) => onChange({ ...range, start })} errors={[...own(fieldErrors, spec.name), ...under(fieldErrors, `${spec.name}.value`), ...under(fieldErrors, `${spec.name}.start`)]} hint={PARTIAL_HINT} />
          <DateInput label="End of a date range" value={range.end} onChange={(end) => onChange({ ...range, end })} errors={under(fieldErrors, `${spec.name}.end`)} hint="Leave empty for a single date." />
        </fieldset>
      );
    }
    case 'party':
      return <SelectField {...common} value={partyKey(value as PartyValue)} options={partyOptions(data)} onChange={(key) => onChange(parsePartyKey(key))} placeholder="Choose…" errors={fieldErrors} />;
    case 'members': {
      const ids = value as readonly string[];
      return (
        <fieldset className="rf-field">
          <legend className="rf-field__label">{spec.label}</legend>
          {fieldErrors.length > 0 && <p className="rf-field__error">{fieldErrors.map((issue) => issue.rule).join(' ')}</p>}
          {data.members.filter((member) => (member.status === 'active' && member.displayName !== null) || ids.includes(member.id)).map((member) => (
            <CheckboxField key={member.id} label={member.displayName ?? member.id} checked={ids.includes(member.id)}
              onChange={(checked) => onChange(checked ? [...ids, member.id] : ids.filter((id) => id !== member.id))} />
          ))}
        </fieldset>
      );
    }
    case 'correspondence-parties': {
      const parties = value as readonly CorrespondencePartyValue[];
      const update = (index: number, next: CorrespondencePartyValue | undefined) => onChange(next === undefined ? parties.filter((_party, at) => at !== index) : parties.map((party, at) => (at === index ? next : party)));
      return (
        <fieldset className="rf-field">
          <legend className="rf-field__label">{spec.label}{spec.required && <span className="rf-field__required"> (required)</span>}</legend>
          <p className="rf-field__hint">At least two Parties; an External Party’s consent applies to this Correspondence only.</p>
          {own(fieldErrors, spec.name).length > 0 && <p className="rf-field__error">{own(fieldErrors, spec.name).map((issue) => issue.rule).join(' ')}</p>}
          {parties.map((party, index) => (
            <div className="rf-actions" key={index}>
              <SelectField label={`Party ${index + 1}`} value={partyKey(party)} options={partyOptions(data)} placeholder="Choose…" errors={under(fieldErrors, `${spec.name}.${index}`)}
                onChange={(key) => {
                  const parsed = parsePartyKey(key);
                  if (parsed.kind !== '') update(index, parsed.kind === 'external' ? { kind: 'external', id: parsed.id, consent: party.consent ?? 'not_asked' } : { kind: 'member', id: parsed.id });
                }} />
              {party.kind === 'external' && <SelectField label="Consent" value={party.consent ?? 'not_asked'} options={CONSENT_OPTIONS} onChange={(consent) => update(index, { ...party, consent })} />}
              <Button variant="quiet" onClick={() => update(index, undefined)}>{`Remove Party ${index + 1}`}</Button>
            </div>
          ))}
          <Button onClick={() => onChange([...parties, { kind: 'member', id: '' }])}>Add a Party</Button>
        </fieldset>
      );
    }
    case 'counts': {
      const counts = value as readonly CountValue[];
      const update = (index: number, next: CountValue | undefined) => onChange(next === undefined ? counts.filter((_count, at) => at !== index) : counts.map((count, at) => (at === index ? next : count)));
      return (
        <fieldset className="rf-field">
          <legend className="rf-field__label">{spec.label}</legend>
          <p className="rf-field__hint">Up to 20 named counts, each a whole number.</p>
          {counts.map((count, index) => (
            <div className="rf-actions" key={index}>
              <TextField label={`Count ${index + 1} name`} value={count.name} onChange={(name) => update(index, { ...count, name })} errors={under(fieldErrors, `${spec.name}.${index}.name`)} maxLength={200} />
              <TextField label={`Count ${index + 1} value`} value={count.value} onChange={(text) => update(index, { ...count, value: text })} errors={under(fieldErrors, `${spec.name}.${index}.value`)} />
              <Button variant="quiet" onClick={() => update(index, undefined)}>{`Remove count ${index + 1}`}</Button>
            </div>
          ))}
          {counts.length < 20 && <Button onClick={() => onChange([...counts, { name: '', value: '' }])}>Add a count</Button>}
        </fieldset>
      );
    }
    case 'sections': {
      const sections = value as readonly SectionValue[];
      const update = (index: number, next: SectionValue | undefined) => onChange(next === undefined ? sections.filter((_section, at) => at !== index) : sections.map((section, at) => (at === index ? next : section)));
      return (
        <fieldset className="rf-field">
          <legend className="rf-field__label">{spec.label}</legend>
          {own(fieldErrors, spec.name).length > 0 && <p className="rf-field__error">{own(fieldErrors, spec.name).map((issue) => issue.rule).join(' ')}</p>}
          {sections.map((section, index) => (
            <div key={section.id ?? `new-${index}`} className="rf-section">
              <RichTextEditor label={`Entry Section ${index + 1}`} value={section.content} onChange={(content) => update(index, { ...section, content })}
                errors={under(fieldErrors, `${spec.name}.${index}`)} mentions={data.mentions} />
              {sections.length > 1 && <Button variant="quiet" onClick={() => update(index, undefined)}>{`Remove Entry Section ${index + 1}`}</Button>}
            </div>
          ))}
          <Button onClick={() => onChange([...sections, { content: EMPTY_RICH_TEXT }])}>Add an Entry Section</Button>
        </fieldset>
      );
    }
  }
}
