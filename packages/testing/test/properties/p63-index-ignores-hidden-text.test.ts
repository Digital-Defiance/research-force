// Feature: research-collab-cms, Property 63: Non-public text leaves the public index unchanged
import { expect, it } from 'vitest';
import type { RichText } from '@researchforce/domain/richtext';
import type { ProjectionInput, UnitRecord } from '@researchforce/kernel/input';
import { project } from '@researchforce/kernel/project';
import { buildSearchIndex } from '@researchforce/search-public/build';
import { fc } from '../../src/fc';
import { referenceModel, workspaceStateArb } from '../../src/workspace';

const CANARY = /zq\d{6}zq/iu;
/** Addresses stay unique, so they only ever gain text. */
const APPEND_ONLY: ReadonlySet<string> = new Set(['identifier', 'slug']);
/** Optional text fields, which an edit may remove. */
const OPTIONAL: ReadonlySet<string> = new Set([
  'publicSummary', 'caption', 'rightsHolder', 'rightsTerms', 'archivalReference', 'reliabilityNote', 'notes', 'resumePoint', 'replyContent', 'accent', 'note',
]);
/** What a Public Summary_Only Research_Item shows of its own text (R24.1). */
const SUMMARY_ONLY_SHOWN: ReadonlySet<string> = new Set(['identifier', 'title', 'publicSummary', 'scopeCaveat', 'eliminationScope', 'toolName', 'toolVersion']);
const NOTHING: ReadonlySet<string> = new Set();

const isRich = (value: object): value is RichText => 'text' in value && typeof value.text === 'string' && 'spans' in value && Array.isArray(value.spans);

/** Adds, changes, and removes text, choosing each edit from the given numbers. */
class Editor {
  private index = 0;
  edits = 0;
  constructor(private readonly choices: readonly number[]) {}
  private next(): number { return this.choices[this.index++ % this.choices.length]!; }
  text(value: string, appendOnly = false): string {
    this.edits++;
    return appendOnly || this.next() % 2 ? `${value} hidden addition` : 'replaced hidden text';
  }
  rich(value: RichText): RichText {
    this.edits++;
    return this.next() % 2 ? { ...value, text: `${value.text} hidden addition` } : { text: 'replaced hidden text', spans: [] };
  }
  added(): RichText { this.edits++; return { text: 'added hidden text', spans: [] }; }
  /** Every text value under the value, except under the kept keys. */
  deep<T>(value: T, keep: ReadonlySet<string>, key = ''): T {
    if (typeof value === 'string') return (CANARY.test(value) ? this.text(value, APPEND_ONLY.has(key)) : value) as T;
    if (Array.isArray(value)) return value.map((entry) => this.deep(entry, keep, key)) as T;
    if (typeof value !== 'object' || value === null) return value;
    if (isRich(value)) return this.rich(value) as T;
    const result: Record<string, unknown> = {};
    for (const [name, entry] of Object.entries(value)) {
      if (keep.has(name)) { result[name] = entry; continue; }
      if (OPTIONAL.has(name) && this.next() % 3 === 0) { this.edits++; continue; }
      result[name] = this.deep(entry, keep, name);
    }
    return result as T;
  }
  /** Sometimes gives a Research_Item a hidden text field it lacked. */
  maybeAdd<T extends object>(item: T, name: string): T {
    return name in item || this.next() % 2 ? item : { ...item, [name]: this.added() };
  }
}

/** The input with every text that no Public_View presents edited: Not_Published units and Projects, Withheld ones beyond their Disclosure_Line and address, the hidden fields of Summary_Only items, and Do_Not_Name names. */
function editHiddenText(input: ProjectionInput, editor: Editor): ProjectionInput {
  const { levels } = referenceModel(input);
  const units = input.units.map((unit): UnitRecord => {
    const level = levels.get(`u:${unit.id}`);
    if (level === 'not_published') {
      const edited = editor.deep(unit, NOTHING);
      return edited.type === 'research_item' ? { ...edited, item: editor.maybeAdd(edited.item, 'publicSummary') } : edited;
    }
    if (level === 'withheld') {
      const edited = editor.deep(unit, new Set(['identifier', 'disclosureLine']));
      return edited.type === 'research_item' ? { ...edited, item: editor.maybeAdd(edited.item, 'publicSummary') } : edited;
    }
    if (unit.type === 'research_item' && unit.item.presentation === 'summary_only') {
      return { ...unit, item: editor.maybeAdd(editor.deep(unit.item, SUMMARY_ONLY_SHOWN), 'logSummary') };
    }
    return unit;
  });
  const projects = input.projects.map((entry) => {
    const level = levels.get(`p:${entry.id}`);
    if (level === 'not_published') return editor.deep(entry, NOTHING);
    if (level === 'withheld') return editor.deep(entry, new Set(['slug', 'disclosureLine']));
    return entry;
  });
  const parties = input.parties.map((party) => (party.doNotName ? { ...party, name: editor.text(party.name) } : party));
  return { ...input, units, projects, parties };
}

it('adding, changing, or removing text that no Public_View presents leaves every public index file byte-identical', () => {
  fc.assert(fc.property(workspaceStateArb, fc.array(fc.nat(), { minLength: 1, maxLength: 12 }), (state, choices) => {
    const editor = new Editor(choices);
    const edited = editHiddenText(state.input, editor);
    expect(buildSearchIndex(project(edited))).toEqual(buildSearchIndex(project(state.input)));
  }));
});
