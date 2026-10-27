// Feature: research-collab-cms, Property 8: Summary_Only exposes only the allowed fields
import { expect, it } from 'vitest';
import { searchTokens } from '@researchforce/domain/search-text';
import type { UnitRecord } from '@researchforce/kernel/input';
import { projectPaths } from '@researchforce/public-render/paths';
import { fc } from '../../src/fc';
import { byClass, find, findAll, textOf, type HtmlElement } from '../../src/html';
import { publicOutput } from '../../src/public-output';
import { canariesIn, referenceModel, workspaceStateArb } from '../../src/workspace';

/** The text fields of a Summary_Only Research_Item that may reach public output, with the status and tool fields listings show. */
const SUMMARY_ONLY_FIELDS: ReadonlySet<string> = new Set([
  'identifier', 'title', 'publicSummary', 'publicSummary.source', 'scopeCaveat', 'scopeCaveat.source', 'eliminationScope', 'eliminationScope.source',
  'toolName', 'toolVersion', 'credit.name', 'credit.affiliation', 'credit.imported', 'withdrawal.reason',
]);
const CHILD_TYPES: ReadonlySet<UnitRecord['type']> = new Set(['entry_section', 'reply', 'dissent_note']);

it('a Summary_Only item shows only its allowed fields everywhere, and a Full_Content log entry shows the Log_Summary then its Dissent_Notes', () => {
  fc.assert(fc.property(workspaceStateArb, (state) => {
    const { input, canaries } = state;
    const out = publicOutput(state);
    const model = referenceModel(input);
    const units = new Map(input.units.map((unit) => [unit.id, unit]));
    const rootOf = (unit: UnitRecord): UnitRecord => {
      const seen = new Set<string>();
      let current = unit;
      while (current.parentId !== undefined && !seen.has(current.id)) { seen.add(current.id); current = units.get(current.parentId) ?? current; }
      return current;
    };
    const shown = new Set<string>();
    for (const content of [...out.files.values(), ...out.index.map((file) => file.content)]) for (const token of canariesIn(content)) shown.add(token);

    for (const token of shown) {
      const { owner, field } = canaries.get(token)!;
      const unit = owner.startsWith('u:') ? units.get(owner.slice(2)) : undefined;
      if (unit === undefined) continue;
      const root = rootOf(unit);
      if (root.type !== 'research_item' || root.item.presentation !== 'summary_only' || model.levels.get(`u:${root.id}`) !== 'public') continue;
      if (unit === root) expect(SUMMARY_ONLY_FIELDS.has(field), `${field} of Summary_Only ${owner}`).toBe(true);
      else expect(CHILD_TYPES.has(unit.type), `${unit.type} ${owner} under Summary_Only u:${root.id}`).toBe(false);
    }

    for (const view of out.site.views.values()) {
      if (view.tag !== 'research_item') continue;
      const unit = units.get(view.key.slice(2))!;
      if (unit.type !== 'research_item') continue;
      const project = out.site.views.get(view.project.key);
      if (project?.tag !== 'project') continue;
      const entries = out.listingPages(projectPaths(project.slug).log()).flatMap((page) => findAll(page.main.children, byClass('rf-listing__entry')))
        .filter((entry) => find(entry.children, byClass('rf-listing__title'))?.children.some((node) => typeof node !== 'string' && node.tag === 'a' && node.attributes.get('href') === view.path));
      expect(entries, `log entries for ${view.path}`).toHaveLength(1);
      const summary: HtmlElement | undefined = find(entries[0]!.children, byClass('rf-listing__summary'));
      const summaryText = summary === undefined ? '' : textOf(summary.children);
      const logSummaryTokens = canariesIn(unit.item.logSummary?.text ?? '');

      if (unit.item.presentation === 'summary_only') {
        expect(view.full).toBeUndefined();
        for (const token of canariesIn(view.publicSummary?.text ?? '')) expect(summaryText).toContain(token);
        if (unit.item.publicSummary === undefined) expect(summary).toBeUndefined();
        for (const token of logSummaryTokens) expect(summaryText).not.toContain(token);
        const allowed = new Set([view.title, view.publicSummary?.text, view.status?.kind === 'finding' ? view.status.scopeCaveat.text : undefined,
          view.status?.kind === 'hypothesis' ? view.status.eliminationScope?.text : undefined].flatMap((text) => (text === undefined ? [] : searchTokens(text))));
        const documentKey = view.path.slice(1);
        for (const term of out.terms.get(documentKey) ?? []) expect(allowed.has(term), `${term} indexed for Summary_Only ${documentKey}`).toBe(true);
        continue;
      }

      if (unit.item.logSummary === undefined) { expect(summary).toBeUndefined(); continue; }
      const dissent = input.units.filter((note) => note.type === 'dissent_note' && note.parentId === unit.id && model.levels.get(`u:${note.id}`) !== 'private');
      expect(new Set(view.full!.dissent.map((ref) => ref.key))).toEqual(new Set(dissent.map((note) => `u:${note.id}`)));
      const markers = [logSummaryTokens[0]!, ...view.full!.dissent.map((ref) => {
        const note = units.get(ref.key.slice(2))!;
        return canariesIn(model.levels.get(ref.key) === 'withheld' ? model.lineOf(ref.key)!.kindOfMaterial : note.type === 'dissent_note' ? note.text.text : '')[0]!;
      })];
      const positions = markers.map((token) => summaryText.indexOf(token));
      expect(positions.every((position) => position >= 0), `${markers.join(', ')} in the log entry of ${view.path}`).toBe(true);
      expect([...positions].sort((a, b) => a - b), `log entry order of ${view.path}`).toEqual(positions);
    }
  }));
});
