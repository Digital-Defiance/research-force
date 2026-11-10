import { element, type ElementNode } from '@researchforce/domain/tree';
type Part = 'cream' | 'blue' | 'pink';
const svg = (tag: string, attributes: Record<string, string | undefined>, children: readonly ElementNode[] = []): ElementNode => ({ ...element(tag, attributes, children), namespace: 'svg' });
/** The class that sets a part's stroke; cream parts follow `currentColor`, and attributes cannot hold `var()`, so the other two use classes. */
const partClass = (part: Part): string | undefined => (part === 'cream' ? undefined : `rf-mark__${part}`);
const trace = (part: Part, d: string): ElementNode => svg('path', { d, class: partClass(part) });
const ring = (part: Part, cx: number, cy: number): ElementNode => svg('circle', { cx: String(cx), cy: String(cy), r: '7', class: partClass(part) });
/**
 * The open-book mark, redrawn from the brand logo as an inline SVG: a book outline, circuit traces ending in rings on the left page, and two lower
 * arcs. It is decorative (the link or heading beside it carries the name), so it is hidden from assistive technology.
 */
export function brandMark(className: string): ElementNode {
  return svg('svg', {
    class: `rf-mark ${className}`, viewBox: '90 92 392 392', fill: 'none', stroke: 'currentColor', 'stroke-width': '8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    'aria-hidden': 'true', focusable: 'false',
  }, [
    trace('cream', 'M97 375V103Q190 100 285 180Q380 100 475 103V375'),
    trace('cream', 'M97 375Q195 372 285 452Q375 372 475 375'),
    trace('cream', 'M285 180V452'),
    trace('blue', 'M101 177H133L158 150H203'), ring('blue', 213, 150),
    trace('cream', 'M101 224H160'), ring('cream', 167, 224),
    trace('pink', 'M174 224H238'), ring('pink', 245, 251),
    trace('pink', 'M101 271H150L175 291H207'), ring('cream', 217, 291),
    trace('cream', 'M101 322H169'), ring('cream', 176, 322),
    trace('blue', 'M101 350H212L240 370'), ring('blue', 244, 377),
    trace('blue', 'M97 408Q190 415 285 470'),
    trace('pink', 'M475 408Q380 415 285 470'),
  ]);
}
const ICONS = {
  /** A line with a node at its end: a claim followed back to its source. */
  trace: [trace('cream', 'M4 20H12L20 12'), ring('cream', 22, 10), ring('cream', 4, 20)],
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
