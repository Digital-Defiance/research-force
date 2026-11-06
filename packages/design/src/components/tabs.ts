import { element, text, type ElementNode, type ViewNode } from '@researchforce/domain/tree';

export interface TabItem {
  /** The stable key used to build the `tab`/`tabpanel` `id`s and the `aria-controls`/`aria-labelledby` links. */
  readonly id: string;
  readonly label: string;
  readonly panel: readonly ViewNode[];
}

export interface TabsOptions {
  readonly label: string;
  /** The key of the initially selected tab; defaults to the first tab. */
  readonly selected?: string;
}

const tabId = (id: string): string => `tab-${id}`;
const panelId = (id: string): string => `panel-${id}`;

/**
 * The tablist/tab/tabpanel markup contract: a `<div role="tablist">` of `<button role="tab">` controls and one
 * `<div role="tabpanel">` per view, with roving `tabindex`, `aria-selected`, and the `aria-controls`/`aria-labelledby`
 * links that associate each tab with its panel; inactive panels are hidden (R7.3, R7.7).
 */
export function tabs(items: readonly TabItem[], options: TabsOptions): readonly ElementNode[] {
  const selected = options.selected ?? items[0]?.id;
  const tablist = element('div', { class: 'rf-tablist', role: 'tablist', 'aria-label': options.label }, items.map((item) => {
    const active = item.id === selected;
    return element('button', {
      class: 'rf-tab', type: 'button', role: 'tab', id: tabId(item.id), 'aria-controls': panelId(item.id), 'aria-selected': active ? 'true' : 'false', tabindex: active ? '0' : '-1',
    }, [text(item.label)]);
  }));
  const panels = items.map((item) => {
    const active = item.id === selected;
    return element('div', {
      class: 'rf-tabpanel', role: 'tabpanel', id: panelId(item.id), 'aria-labelledby': tabId(item.id), tabindex: '0', hidden: active ? undefined : true,
    }, item.panel);
  });
  return [tablist, ...panels];
}

export interface SkeletonOptions {
  /** How many placeholder rows to show; defaults to 3. */
  readonly rows?: number;
  /** The visually-hidden loading message announced to assistive technology; defaults to "Loading…". */
  readonly label?: string;
}

/**
 * A loading placeholder occupying the expected shape of the content it replaces: `aria-hidden` `.rf-skeleton__row`
 * blocks plus a visually-hidden `role="status"` loading message for assistive technology (R7.5).
 */
export function skeleton(options: SkeletonOptions = {}): readonly ElementNode[] {
  const count = options.rows ?? 3;
  const rows = Array.from({ length: count }, () => element('div', { class: 'rf-skeleton__row' }));
  return [
    element('div', { class: 'rf-skeleton', 'aria-hidden': 'true' }, rows),
    element('p', { class: 'rf-visually-hidden', role: 'status' }, [text(options.label ?? 'Loading…')]),
  ];
}
