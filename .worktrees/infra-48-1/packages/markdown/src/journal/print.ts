export interface PrintableSection {
  readonly text: string;
  /** Absent for a section a Member added after the import. */
  readonly sepBefore?: string;
  readonly group?: { readonly kind: 'list' | 'table'; readonly id: number };
}
export interface PrintableEntry {
  readonly phaseId: string | null;
  readonly headingText: string | null;
  /** The imported heading line; cleared when a Member edits the heading text. */
  readonly headingRaw?: string | null;
  readonly leading?: string;
  readonly sections: readonly PrintableSection[];
  readonly trailing?: string;
}

const sameGroup = (a: PrintableSection | undefined, b: PrintableSection): boolean =>
  a?.group !== undefined && b.group !== undefined && a.group.kind === b.group.kind && a.group.id === b.group.id;

/**
 * Journal_Printer (R27.5): each entry's heading line, then every section whatever its Disclosure_Level, each after its separator, then the trailing text.
 * A section without a stored separator follows a blank line, or a single line break after a member of the same list or table group.
 */
export function printJournal(entries: readonly PrintableEntry[]): string {
  let output = '';
  /** Line breaks so that the output ends with `count` of them, counting those already there. */
  const breaks = (count: number): string => {
    if (output === '') return '';
    let present = 0;
    while (present < count && output[output.length - 1 - present] === '\n') present++;
    return '\n'.repeat(count - present);
  };
  entries.forEach((entry, entryIndex) => {
    if (entry.phaseId !== null) {
      output += entry.leading ?? breaks(2);
      output += entry.headingRaw ?? `### ${entry.headingText ?? entry.phaseId}`;
    } else {
      output += entry.leading ?? '';
    }
    entry.sections.forEach((section, index) => {
      output += section.sepBefore ?? breaks(sameGroup(entry.sections[index - 1], section) ? 1 : 2);
      output += section.text;
    });
    output += entry.trailing ?? (entryIndex === entries.length - 1 ? breaks(1) : '');
  });
  return output;
}

/** Stored fields use the same logical section IDs; streaming output never manufactures parser sections. */
export interface VersionedPrintableSection extends Omit<PrintableSection, 'text'> {
  readonly text?: string;
  readonly field?: import('@researchforce/domain/text-fragments').FieldReference;
}
export interface VersionedPrintableEntry extends Omit<PrintableEntry, 'sections'> { readonly sections: readonly VersionedPrintableSection[] }
export async function* printJournalParts(entries: readonly VersionedPrintableEntry[], reader: import('@researchforce/domain/text-fragments').FieldVersionReader): AsyncGenerator<string> {
  const { fragmentText, streamField } = await import('@researchforce/domain/text-fragments');
  let tail = ''; let empty = true;
  const remember = (value: string): string => { if (value.length) { empty = false; tail = (tail + value).slice(-2); } return value; };
  const breaks = (count: number): string => empty ? '' : '\n'.repeat(Math.max(0, count - (/\n*$/u.exec(tail)?.[0].length ?? 0)));
  for (const [entryIndex, entry] of entries.entries()) {
    if (entry.phaseId !== null) { yield remember(entry.leading ?? breaks(2)); yield remember(entry.headingRaw ?? `### ${entry.headingText ?? entry.phaseId}`); }
    else yield remember(entry.leading ?? '');
    for (const [i, section] of entry.sections.entries()) {
      const previous = entry.sections[i - 1];
      const grouped = previous?.group && section.group && previous.group.kind === section.group.kind && previous.group.id === section.group.id;
      yield remember(section.sepBefore ?? breaks(grouped ? 1 : 2));
      if (section.field) { for await (const part of streamField(section.field, reader)) if (part.kind === 'text') yield remember(part.text); }
      else for (const part of fragmentText(section.text ?? '')) yield remember(part.text);
    }
    yield remember(entry.trailing ?? (entryIndex === entries.length - 1 ? breaks(1) : ''));
  }
}
