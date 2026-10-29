import { element, text, type AttributeValue, type ElementNode, type ViewNode } from '@researchforce/domain/tree';

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';

export interface ButtonProps {
  readonly label: string;
  readonly variant?: ButtonVariant;
  readonly type?: 'button' | 'submit' | 'reset';
  readonly disabled?: boolean;
  readonly name?: string;
  readonly value?: string;
  /** Extra attributes for behaviour, such as `data-action` or `aria-controls`. */
  readonly attributes?: Readonly<Record<string, AttributeValue>>;
}

const buttonClass = (variant: ButtonVariant): string => `rf-button rf-button--${variant}`;

export function button(props: ButtonProps): ElementNode {
  return element('button', {
    ...props.attributes, class: buttonClass(props.variant ?? 'secondary'), type: props.type ?? 'button', disabled: props.disabled, name: props.name, value: props.value,
  }, [text(props.label)]);
}

/** A link styled as a button, for actions that navigate. */
export function linkButton(props: { readonly label: string; readonly href: string; readonly variant?: ButtonVariant }): ElementNode {
  return element('a', { class: buttonClass(props.variant ?? 'secondary'), href: props.href }, [text(props.label)]);
}

export interface FieldOption { readonly value: string; readonly label: string; readonly selected?: boolean }

export interface FieldProps {
  readonly id: string;
  readonly name?: string;
  readonly label: string;
  readonly control?: 'text' | 'email' | 'search' | 'url' | 'number' | 'date' | 'textarea' | 'select' | 'checkbox';
  readonly value?: string;
  readonly checked?: boolean;
  readonly hint?: string;
  /** The error and a suggestion for fixing it, shown next to the field and linked to it (R45.5). */
  readonly error?: string;
  readonly required?: boolean;
  readonly options?: readonly FieldOption[];
  readonly attributes?: Readonly<Record<string, AttributeValue>>;
}

/** A labelled form field with an optional hint and a labelled error, both tied to the control by `aria-describedby`. */
export function formField(props: FieldProps): ElementNode {
  const control = props.control ?? 'text';
  const hintId = props.hint === undefined ? undefined : `${props.id}-hint`;
  const errorId = props.error === undefined ? undefined : `${props.id}-error`;
  const describedBy = [hintId, errorId].filter((value) => value !== undefined).join(' ') || undefined;
  const common = {
    ...props.attributes, id: props.id, name: props.name ?? props.id, required: props.required, 'aria-describedby': describedBy, 'aria-invalid': errorId === undefined ? undefined : 'true',
  };
  const input: ElementNode = control === 'textarea'
    ? element('textarea', { ...common, class: 'rf-input rf-input--textarea', rows: 6 }, [text(props.value ?? '')])
    : control === 'select'
      ? element('select', { ...common, class: 'rf-input rf-input--select' }, (props.options ?? []).map((option) => element('option', { value: option.value, selected: option.selected }, [text(option.label)])))
      : control === 'checkbox'
        ? element('input', { ...common, class: 'rf-checkbox', type: 'checkbox', value: props.value, checked: props.checked })
        : element('input', { ...common, class: 'rf-input', type: control, value: props.value });
  const label = element('label', { class: 'rf-field__label', for: props.id }, [
    text(props.label),
    ...(props.required ? [element('span', { class: 'rf-field__required' }, [text(' (required)')])] : []),
  ]);
  const hint: ViewNode[] = props.hint === undefined ? [] : [element('p', { class: 'rf-field__hint', id: hintId }, [text(props.hint)])];
  const error: ViewNode[] = props.error === undefined ? [] : [element('p', { class: 'rf-field__error', id: errorId }, [
    element('span', { class: 'rf-visually-hidden' }, [text('Error: ')]), text(props.error),
  ])];
  const className = `rf-field${control === 'checkbox' ? ' rf-field--checkbox' : ''}${props.error === undefined ? '' : ' rf-field--invalid'}`;
  return control === 'checkbox'
    ? element('div', { class: className }, [input, label, ...hint, ...error])
    : element('div', { class: className }, [label, ...hint, ...error, input]);
}
