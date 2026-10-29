import { ITEM_KIND_NAMES } from '@researchforce/domain/kind-names';
import type { PublicView, ResearchItemView, StatusView } from '@researchforce/kernel/views';
import type { EmailEntry } from './compose';

/** The status of an Item and the fields that qualify it, in the order the pages show them (R5.6, R6.3, R7.4, R8.3, R29.2 to R29.4). */
function statusLines(status: StatusView): { lines: string[]; notes: string[] } {
  switch (status.kind) {
    case 'finding': return { lines: [`Status: ${status.status.name}`], notes: [`Scope and caveats: ${status.scopeCaveat.text}`] };
    case 'hypothesis': return { lines: [`Status: ${status.status.name}`], notes: status.eliminationScope ? [`Elimination scope: ${status.eliminationScope.text}`] : [] };
    case 'source': return { lines: [`Reliability: ${status.reliability.name}`], notes: [] };
    case 'run': return { lines: [`Outcome: ${status.outcome.name}`, `Tool: ${status.toolName} ${status.toolVersion}`], notes: [] };
    case 'archival_request': return { lines: [`Status: ${status.status.name}`], notes: [] };
    case 'journal_entry': return { lines: status.status ? [`Status: ${status.status.name}`] : [], notes: [] };
  }
}

/** A Research_Item described by its current Public_View alone, for an email entry (R20.6). Other views have no email entry. */
export function emailEntryFor(view: PublicView, origin: string): EmailEntry | null {
  if (view.tag === 'withheld') return { heading: 'Withheld item', lines: [`${view.line.kindOfMaterial}, ${view.line.date.value}`] };
  if (view.tag !== 'research_item') return null;
  const item: ResearchItemView = view;
  const { lines, notes } = item.status ? statusLines(item.status) : { lines: [], notes: [] };
  return {
    heading: `${ITEM_KIND_NAMES[item.kind]}: ${item.title}`,
    lines,
    notes: [...(item.publicSummary ? [item.publicSummary.text] : []), ...notes],
    url: `${origin}/go/${item.key.slice(2)}`,
  };
}
