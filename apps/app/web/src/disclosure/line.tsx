import { CheckboxField, TextField } from '../ui';
import type { MemberRow, PartyRecord } from '../types';
import { partyName } from '../items/forms/inputs';

/** The Disclosure_Line a Withheld unit carries, as the editor builds it, matching the kernel's `disclosureLineSchema` (R23.5). */
export interface DisclosureLineValue {
  readonly kindOfMaterial: string;
  readonly date: { readonly value: string; readonly approx: boolean };
  readonly partyIds: readonly string[];
  readonly note?: string;
}

export const emptyDisclosureLine: DisclosureLineValue = { kindOfMaterial: '', date: { value: '', approx: false }, partyIds: [] };

/** The body a Disclosure_Line field sends, dropping an empty note so the optional field is absent rather than blank. */
export function disclosureLineBody(value: DisclosureLineValue): Readonly<Record<string, unknown>> {
  return {
    kindOfMaterial: value.kindOfMaterial,
    date: value.date,
    partyIds: value.partyIds,
    ...((value.note ?? '').trim() === '' ? {} : { note: value.note }),
  };
}

/**
 * Edit a Withheld unit's Disclosure_Line: a kind of material (1 to 100 characters), a date at year, month, or day
 * precision, up to 20 Party labels, and an optional note of at most 200 characters (R23.5). The server validates the
 * values; Party choices are offered when the caller supplies the Parties and Members in scope.
 */
export function DisclosureLineFields({ value, onChange, parties = [], members = [] }: {
  readonly value: DisclosureLineValue;
  readonly onChange: (value: DisclosureLineValue) => void;
  readonly parties?: readonly PartyRecord[];
  readonly members?: readonly MemberRow[];
}) {
  const togglePartyId = (id: string, on: boolean) => onChange({ ...value, partyIds: on ? [...value.partyIds, id] : value.partyIds.filter((entry) => entry !== id) });
  const namedMembers = members.filter((member) => member.displayName !== null);
  return (
    <fieldset className="rf-field" aria-label="Disclosure line">
      <legend className="rf-field__label">Disclosure line</legend>
      <TextField label="Kind of material" value={value.kindOfMaterial} maxLength={100} required
        hint="1 to 100 characters; shown on the public site in place of the withheld content." onChange={(kindOfMaterial) => onChange({ ...value, kindOfMaterial })} />
      <TextField label="Date" value={value.date.value} required hint="A date at year (YYYY), month (YYYY-MM), or day (YYYY-MM-DD) precision."
        onChange={(dateValue) => onChange({ ...value, date: { ...value.date, value: dateValue } })} />
      <CheckboxField label="The date is approximate" checked={value.date.approx} onChange={(approx) => onChange({ ...value, date: { ...value.date, approx } })} />
      {(parties.length > 0 || namedMembers.length > 0) && (
        <fieldset className="rf-field" aria-label="Party labels">
          <legend className="rf-field__label">Party labels (up to 20)</legend>
          {parties.map((party) => (
            <CheckboxField key={party.id} label={`${partyName(party)} (External Party)`} checked={value.partyIds.includes(party.id)} onChange={(on) => togglePartyId(party.id, on)} />
          ))}
          {namedMembers.map((member) => (
            <CheckboxField key={member.id} label={`${member.displayName} (Member)`} checked={value.partyIds.includes(member.id)} onChange={(on) => togglePartyId(member.id, on)} />
          ))}
        </fieldset>
      )}
      <TextField label="Note" multiline value={value.note ?? ''} maxLength={200} hint="Optional; at most 200 characters." onChange={(note) => onChange({ ...value, note })} />
    </fieldset>
  );
}
