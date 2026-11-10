import { element, type ElementNode } from '@researchforce/domain/tree';
type Part = 'cream' | 'blue' | 'pink';
const svg = (tag: string, attributes: Record<string, string | undefined>, children: readonly ElementNode[] = []): ElementNode => ({ ...element(tag, attributes, children), namespace: 'svg' });
/** The class that sets a part's stroke; cream parts follow `currentColor`, and attributes cannot hold `var()`, so the other two use classes. */
const partClass = (part: Part): string | undefined => (part === 'cream' ? undefined : `rf-mark__${part}`);
const trace = (part: Part, d: string): ElementNode => svg('path', { d, class: partClass(part) });
const ring = (part: Part, cx: number, cy: number): ElementNode => svg('circle', { cx: String(cx), cy: String(cy), r: '7', class: partClass(part) });
/**
 * The open-book mark, redrawn from the brand logo as an inline SVG: a book outline, circuit traces ending in rings on the left page, and three
 * lower arcs. It is decorative (the link or heading beside it carries the name), so it is hidden from assistive technology.
 */
export function brandMark(className: string): ElementNode {
  return svg('svg', {
    class: `rf-mark ${className}`, viewBox: '90 92 392 392', fill: 'none', stroke: 'currentColor', 'stroke-width': '8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    'aria-hidden': 'true', focusable: 'false',
  }, [
    // Pages: outer edges and tops (the tops rise slightly before falling to the spine), the spine, and the page bottoms.
    trace('cream', 'M97 365V103Q190 85 285 172Q380 85 475 103V365'),
    trace('cream', 'M97 365Q200 343 285 445Q370 343 475 365'),
    trace('cream', 'M285 172V445'),
    // Circuit traces on the left page, top to bottom, as in the logo.
    trace('blue', 'M101 177H133L158 150H203'), ring('blue', 213, 150),
    // The cream trace runs through a small ring, then bends down to the pink ring.
    trace('cream', 'M101 224H160'), ring('cream', 167, 224),
    trace('cream', 'M174 226L208 251H236'), ring('pink', 245, 251),
    trace('pink', 'M101 271H150L175 291H207'), ring('cream', 217, 291),
    trace('cream', 'M101 322H169'), ring('cream', 176, 322),
    trace('blue', 'M101 350H212L240 370'), ring('blue', 244, 377),
    // Three lower arcs, each rising slightly from the outer edge before dipping to the spine: cream, then blue (left) and pink (right).
    trace('cream', 'M95 387Q200 366 285 457Q370 366 477 387'),
    trace('blue', 'M97 409Q200 388 285 472'),
    trace('pink', 'M473 409Q370 388 285 472'),
  ]);
}
const ICONS = {
  /** A document with a checkmark: a claim checked against its source. */
  trace: [trace('cream', 'M7 3H17L22 8V25H7Z'), trace('cream', 'M17 3V8H22'), trace('cream', 'M10.5 16L13 18.5L18 13')],
  /** A person: head and shoulders. */
  credit: [svg('circle', { cx: '14', cy: '9', r: '5' }), trace('cream', 'M4 24Q14 12 24 24')],
  /** Stacked entries: a record that keeps every line. */
  record: [trace('cream', 'M5 7H23'), trace('cream', 'M5 14H23'), trace('cream', 'M5 21H16')],
} as const;
export type CardIcon = keyof typeof ICONS;
/** A small decorative icon for a home page card; the card heading carries the meaning. */
export function cardIcon(name: CardIcon): ElementNode {
  return svg('svg', { class: 'rf-icon', viewBox: '0 0 28 28', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' }, ICONS[name]);
}
