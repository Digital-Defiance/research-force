import { useCallback, useEffect, useId, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ApiFailure, failureMessage, useApi } from './api';
import type { FieldIssue } from './api';
import type { DisclosureView, PersonRef } from './types';

/** Controlled counterparts of the design package's components, using the same classes. */

export interface FieldProps {
  readonly label: string;
  readonly hint?: string;
  readonly errors?: readonly FieldIssue[];
  readonly required?: boolean;
  readonly children: (control: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}

export function Field({ label, hint, errors = [], required = false, children }: FieldProps) {
  const id = useId();
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  const errorId = errors.length === 0 ? undefined : `${id}-error`;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={errors.length > 0 ? 'rf-field rf-field--invalid' : 'rf-field'}>
      <label className="rf-field__label" htmlFor={id}>
        {label}
        {required && <span className="rf-field__required"> (required)</span>}
      </label>
      {hint !== undefined && <p className="rf-field__hint" id={hintId}>{hint}</p>}
      {errorId !== undefined && <p className="rf-field__error" id={errorId}>{errors.map((issue) => issue.rule).join(' ')}</p>}
      {children({ id, describedBy, invalid: errors.length > 0 })}
    </div>
  );
}

interface TextProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly hint?: string;
  readonly errors?: readonly FieldIssue[];
  readonly required?: boolean;
  readonly multiline?: boolean;
  readonly type?: string;
  readonly maxLength?: number;
}

export function TextField({ label, value, onChange, hint, errors, required, multiline = false, type = 'text', maxLength }: TextProps) {
  return (
    <Field label={label} {...(hint === undefined ? {} : { hint })} {...(errors === undefined ? {} : { errors })} {...(required === undefined ? {} : { required })}>
      {({ id, describedBy, invalid }) => multiline
        ? <textarea className="rf-input rf-input--textarea" id={id} value={value} aria-describedby={describedBy} aria-invalid={invalid || undefined} required={required} maxLength={maxLength} onChange={(event) => onChange(event.target.value)} />
        : <input className="rf-input" id={id} type={type} value={value} aria-describedby={describedBy} aria-invalid={invalid || undefined} required={required} maxLength={maxLength} onChange={(event) => onChange(event.target.value)} />}
    </Field>
  );
}

export interface Option { readonly value: string; readonly label: string }

interface SelectProps {
  readonly label: string;
  readonly value: string;
  readonly options: readonly Option[];
  readonly onChange: (value: string) => void;
  /** The text of the empty choice; without it, one option is always chosen. */
  readonly placeholder?: string;
  readonly hint?: string;
  readonly errors?: readonly FieldIssue[];
  readonly required?: boolean;
}

export function SelectField({ label, value, options, onChange, placeholder, hint, errors, required }: SelectProps) {
  return (
    <Field label={label} {...(hint === undefined ? {} : { hint })} {...(errors === undefined ? {} : { errors })} {...(required === undefined ? {} : { required })}>
      {({ id, describedBy, invalid }) => (
        <select className="rf-input" id={id} value={value} aria-describedby={describedBy} aria-invalid={invalid || undefined} required={required} onChange={(event) => onChange(event.target.value)}>
          {placeholder !== undefined && <option value="">{placeholder}</option>}
          {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      )}
    </Field>
  );
}

interface CheckboxProps {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly hint?: string;
  readonly errors?: readonly FieldIssue[];
}

export function CheckboxField({ label, checked, onChange, hint, errors = [] }: CheckboxProps) {
  const id = useId();
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  const errorId = errors.length === 0 ? undefined : `${id}-error`;
  return (
    <div className={errors.length > 0 ? 'rf-field rf-field--checkbox rf-field--invalid' : 'rf-field rf-field--checkbox'}>
      <input className="rf-checkbox" id={id} type="checkbox" checked={checked} aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined} onChange={(event) => onChange(event.target.checked)} />
      <label className="rf-field__label" htmlFor={id}>{label}</label>
      {hint !== undefined && <p className="rf-field__hint" id={hintId}>{hint}</p>}
      {errorId !== undefined && <p className="rf-field__error" id={errorId}>{errors.map((issue) => issue.rule).join(' ')}</p>}
    </div>
  );
}

type Variant = 'primary' | 'secondary' | 'quiet' | 'danger';
interface ButtonProps {
  readonly children: ReactNode;
  readonly onClick?: () => void;
  readonly variant?: Variant;
  readonly type?: 'button' | 'submit';
  readonly disabled?: boolean;
  readonly label?: string;
}

export function Button({ children, onClick, variant = 'secondary', type = 'button', disabled = false, label }: ButtonProps) {
  return <button className={variant === 'secondary' ? 'rf-button' : `rf-button rf-button--${variant}`} type={type} disabled={disabled} aria-label={label} onClick={onClick}>{children}</button>;
}

type Tone = 'neutral' | 'success' | 'warning' | 'danger';
export function Notice({ tone = 'neutral', title, children }: { readonly tone?: Tone; readonly title?: string; readonly children?: ReactNode }) {
  return (
    <div className={`rf-notice rf-notice--${tone}`} role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}>
      {title !== undefined && <p className="rf-notice__title">{title}</p>}
      {children !== undefined && <div className="rf-notice__body">{children}</div>}
    </div>
  );
}

/** The outcome of a failed save: the input was not saved and stays in this tab (R28.10, R28.13). */
export function SaveFailure({ error }: { readonly error: unknown }) {
  if (error === undefined || error === null) return null;
  const rule = error instanceof ApiFailure ? (error.details as { message?: string } | undefined)?.message : undefined;
  return <Notice tone="danger" title={failureMessage(error)}>{rule === undefined ? undefined : <p>{rule}</p>}</Notice>;
}

/** Shown when a form came back from this tab's storage after a reload. */
export function RestoredNotice({ onDiscard }: { readonly onDiscard: () => void }) {
  return (
    <Notice tone="warning" title="Your unsent input was restored. It has not been saved.">
      <Button variant="quiet" onClick={onDiscard}>Discard the unsent input</Button>
    </Notice>
  );
}

/** A Member's display name as a link to that Member's Profile (R3.5). */
export function PersonLink({ person }: { readonly person: PersonRef }) {
  return <Link to={`/members/${person.id}`}>{person.displayName ?? 'Member without a display name'}</Link>;
}

const LEVEL_NAMES: Readonly<Record<string, string>> = { private: 'Private', withheld: 'Withheld', public: 'Public' };
export const levelName = (level: string): string => LEVEL_NAMES[level] ?? level;

/** A Disclosure_Unit's Disclosure_Level and Effective_Disclosure (R23.9). */
export function DisclosureStatus({ disclosure }: { readonly disclosure: DisclosureView }) {
  return (
    <p className="rf-meta">
      Disclosure level: <span className="rf-status">{levelName(disclosure.level)}</span>; effective disclosure: <span className="rf-status">{levelName(disclosure.effective)}</span>
    </p>
  );
}

export interface Loaded<T> {
  readonly data: T | undefined;
  readonly error: unknown;
  readonly reload: () => void;
}

/** A GET request whose result the page shows; `path` undefined waits. */
export function useLoad<T>(path: string | undefined): Loaded<T> {
  const client = useApi();
  const [state, setState] = useState<{ path: string | undefined; data: T | undefined; error: unknown }>({ path: undefined, data: undefined, error: undefined });
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (path === undefined) return undefined;
    let current = true;
    client.get<T>(path).then(
      (data) => { if (current) setState({ path, data, error: undefined }); },
      (error: unknown) => { if (current) setState({ path, data: undefined, error }); },
    );
    return () => { current = false; };
  }, [path, client, generation]);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  return state.path === path ? { data: state.data, error: state.error, reload } : { data: undefined, error: undefined, reload };
}

/** What a page shows while its data is loading or could not be loaded. */
export function LoadState({ error }: { readonly error: unknown }) {
  if (error === undefined) return <p className="rf-meta" role="status">Loading…</p>;
  if (error instanceof ApiFailure && error.code === 'not_found') return <Notice tone="warning" title="This page does not exist, or you cannot see it." />;
  if (error instanceof ApiFailure && error.code === 'forbidden') return <Notice tone="warning" title="Your Role does not permit this page." />;
  return <Notice tone="danger" title="This page could not be loaded. Reload the page to try again." />;
}

/** A time as `2026-10-27 09:30 UTC`, the same for every reader whatever their locale. */
export function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
