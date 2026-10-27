import { element, text, type ElementNode, type ViewNode } from '@researchforce/domain/tree';

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export interface NoticeProps {
  readonly tone?: Tone;
  readonly title?: string;
  readonly body: readonly ViewNode[];
  /** `status` or `alert` for notices that appear after an action; static notices, such as a withdrawal notice, have no role. */
  readonly role?: 'status' | 'alert';
}

export function notice(props: NoticeProps): ElementNode {
  return element('div', { class: `rf-notice rf-notice--${props.tone ?? 'info'}`, role: props.role }, [
    ...(props.title === undefined ? [] : [element('p', { class: 'rf-notice__title' }, [text(props.title)])]),
    element('div', { class: 'rf-notice__body' }, props.body),
  ]);
}

export interface StatusLabelProps {
  readonly label: string;
  /** The Methods page entry for the value (R46.14). */
  readonly href?: string;
  readonly tone?: Tone;
}

export function statusLabel(props: StatusLabelProps): ElementNode {
  const className = `rf-status rf-status--${props.tone ?? 'neutral'}`;
  return props.href === undefined ? element('span', { class: className }, [text(props.label)]) : element('a', { class: className, href: props.href }, [text(props.label)]);
}

export interface CompanionFieldProps {
  /** The field label, such as “Scope caveat”, linked to its Methods page entry (R46.14). */
  readonly label: string;
  readonly labelHref?: string;
  readonly value: readonly ViewNode[];
}

export function companionField(props: CompanionFieldProps): ElementNode {
  const label = props.labelHref === undefined ? text(props.label) : element('a', { href: props.labelHref }, [text(props.label)]);
  return element('p', { class: 'rf-companion' }, [
    element('span', { class: 'rf-companion__label' }, [label, text(':')]), text(' '),
    element('span', { class: 'rf-companion__value' }, props.value),
  ]);
}

/** A status label with the fields that must appear beside it, such as a Finding’s Scope_Caveat (R7.6), kept in one block. */
export function statusBlock(status: StatusLabelProps, companions: readonly CompanionFieldProps[]): ElementNode {
  return element('div', { class: 'rf-status-block' }, [statusLabel(status), ...companions.map(companionField)]);
}
