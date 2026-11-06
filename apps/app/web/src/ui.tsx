import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Alert, AlertTitle, Box, Button as MuiButton, Card as MuiCard, CardContent, Checkbox as MuiCheckbox, NativeSelect, OutlinedInput, Paper, Skeleton, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TableSortLabel, Typography } from '@mui/material';
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
      {({ id, describedBy, invalid }) => (
        <OutlinedInput
          className="rf-input"
          id={id}
          type={multiline ? undefined : type}
          value={value}
          fullWidth
          size="small"
          multiline={multiline}
          minRows={multiline ? 3 : undefined}
          error={invalid}
          required={required}
          inputProps={{ 'aria-describedby': describedBy, maxLength }}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
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
        <NativeSelect
          className="rf-input"
          value={value}
          error={invalid}
          input={<OutlinedInput size="small" />}
          inputProps={{ id, 'aria-describedby': describedBy, required }}
          onChange={(event) => onChange(event.target.value)}
        >
          {placeholder !== undefined && <option value="">{placeholder}</option>}
          {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </NativeSelect>
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
      <MuiCheckbox className="rf-checkbox" id={id} checked={checked} size="small" sx={{ p: 0.5 }}
        inputProps={{ 'aria-describedby': [hintId, errorId].filter(Boolean).join(' ') || undefined }}
        onChange={(event) => onChange(event.target.checked)} />
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

const MUI_BUTTON = {
  primary: { variant: 'contained' as const, color: 'primary' as const },
  secondary: { variant: 'outlined' as const, color: 'primary' as const },
  quiet: { variant: 'text' as const, color: 'primary' as const },
  danger: { variant: 'outlined' as const, color: 'error' as const },
};
export function Button({ children, onClick, variant = 'secondary', type = 'button', disabled = false, label }: ButtonProps) {
  const style = MUI_BUTTON[variant];
  return (
    <MuiButton
      className={variant === 'secondary' ? 'rf-button' : `rf-button rf-button--${variant}`}
      type={type} variant={style.variant} color={style.color} disabled={disabled} aria-label={label} onClick={onClick}
    >{children}</MuiButton>
  );
}

/** One step of a Page_Header Breadcrumb trail; a crumb without `to` is the current page (R6.3). */
export interface Crumb {
  readonly label: string;
  readonly to?: string;
}

/** The navigation trail of a Page_Header: ancestor links plus the current page as the last, unlinked crumb (R6.3). */
export function Breadcrumb({ trail }: { readonly trail: readonly Crumb[] }) {
  if (trail.length === 0) return null;
  return (
    <nav className="rf-breadcrumb" aria-label="Breadcrumb">
      <ol>
        {trail.map((crumb, index) => {
          const last = index === trail.length - 1;
          return (
            <li key={`${crumb.label}-${crumb.to ?? 'current'}`}>
              {crumb.to !== undefined && !last
                ? <Link to={crumb.to}>{crumb.label}</Link>
                : <span aria-current="page">{crumb.label}</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export interface PageHeaderProps {
  readonly title: string;
  readonly description?: string;
  readonly breadcrumb?: readonly Crumb[];
  readonly actions?: ReactNode;
}

/**
 * A page's level-one heading with an optional description, Breadcrumb trail, and actions cluster (R6.1, R6.3, R6.4).
 * `role="none"` keeps this `<header>` from being exposed as a `banner` landmark by tools that map every `<header>` to
 * `banner` (e.g. aria-query/testing-library); the AppShell's `header.rf-header` is the page's only banner.
 */
export function PageHeader({ title, description, breadcrumb, actions }: PageHeaderProps) {
  return (
    <Box component="header" className="rf-page-header" role="none" sx={{ mb: 3 }}>
      {breadcrumb !== undefined && breadcrumb.length > 0 && <Breadcrumb trail={breadcrumb} />}
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', gap: 1 }}>
        <Typography variant="h4" component="h1" sx={{ m: 0 }}>{title}</Typography>
        {actions !== undefined && <div className="rf-actions">{actions}</div>}
      </Box>
      {description !== undefined && <Typography className="rf-page-header__description" color="text.secondary">{description}</Typography>}
    </Box>
  );
}

/** The layout measure for a page: reading keeps the default `.rf-main` reading width (R6.2, R6.5). */
export type LayoutVariant = 'reading' | 'wide' | 'split';

/** Constrains a page to the reading measure, a wide measure, or a two-column split (R6.2, R6.5). */
export function PageLayout({ variant = 'reading', children }: { readonly variant?: LayoutVariant; readonly children: ReactNode }) {
  const className = variant === 'reading' ? 'rf-layout' : `rf-layout rf-layout--${variant}`;
  return <div className={className}>{children}</div>;
}

/** Groups related content on a raised MUI surface, with an optional header heading that may link via `headingHref` (R7.1). */
export function Card({ heading, headingHref, children }: { readonly heading?: string; readonly headingHref?: string; readonly children: ReactNode }) {
  return (
    <MuiCard variant="outlined" className="rf-card" sx={{ mb: 2 }}>
      <CardContent>
        {heading !== undefined && (
          <Typography variant="h6" component="h2" gutterBottom>
            {headingHref !== undefined ? <Link to={headingHref}>{heading}</Link> : heading}
          </Typography>
        )}
        {children}
      </CardContent>
    </MuiCard>
  );
}

/**
 * One column of a {@link DataTable}: an identifying key, a header label, a `cell` renderer for each record,
 * an optional alignment, and an optional `sortBy` that makes the column's header a sort toggle (R7.2, R8.2).
 */
export interface Column<Row> {
  readonly key: string;
  readonly header: ReactNode;
  readonly cell: (row: Row) => ReactNode;
  readonly align?: 'left' | 'center' | 'right';
  /** The value a column sorts on; when present, the column header becomes an ascending/descending sort toggle (R8). */
  readonly sortBy?: (row: Row) => string | number;
}

export interface DataTableProps<Row> {
  readonly caption: string;
  readonly columns: readonly Column<Row>[];
  readonly rows: readonly Row[];
}

const compareValues = (a: string | number, b: string | number): number => {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
};

/**
 * A semantic `<table class="rf-table">` inside the keyboard-focusable `.rf-table-scroll` region: a `<caption>`, a header
 * row of `<th scope="col">`, and one `<tr>` per record. A column with `sortBy` gets a sort `<button>`; the active column
 * carries `aria-sort="ascending|descending"` and the others `none`. Sort state is held here; cells keep their own links
 * and buttons (R7.2, R8.2, R8.4). The rows are presented already filtered/sorted by the caller; the sort toggle only
 * reorders the given rows and issues no request (R11.4).
 */
export function DataTable<Row>({ caption, columns, rows }: DataTableProps<Row>) {
  const [sort, setSort] = useState<{ key: string; direction: 'ascending' | 'descending' } | undefined>(undefined);
  const active = sort === undefined ? undefined : columns.find((column) => column.key === sort.key && column.sortBy !== undefined);
  const ordered = active === undefined || active.sortBy === undefined
    ? rows
    : [...rows].sort((a, b) => {
        const result = compareValues(active.sortBy!(a), active.sortBy!(b));
        return sort!.direction === 'ascending' ? result : -result;
      });
  const toggle = (key: string): void =>
    setSort((current) => (current?.key === key && current.direction === 'ascending' ? { key, direction: 'descending' } : { key, direction: 'ascending' }));
  return (
    <TableContainer
      component={Paper}
      variant="outlined"
      className="rf-table-scroll"
      role="region"
      aria-label={caption}
      tabIndex={0}
      sx={{ mb: 2 }}
    >
      <Table className="rf-table" size="small">
        <caption style={{ captionSide: 'top', textAlign: 'start', fontWeight: 600, padding: '0 0 8px' }}>{caption}</caption>
        <TableHead>
          <TableRow>
            {columns.map((column) => {
              const sortable = column.sortBy !== undefined;
              const isActive = active?.key === column.key;
              const ariaSort = sortable ? (isActive ? sort!.direction : 'none') : undefined;
              return (
                <TableCell key={column.key} component="th" scope="col" align={column.align} aria-sort={ariaSort} sx={{ fontWeight: 600 }}>
                  {sortable
                    ? (
                      <TableSortLabel
                        className="rf-table__sort"
                        active={isActive}
                        direction={isActive && sort ? (sort.direction === 'ascending' ? 'asc' : 'desc') : 'asc'}
                        onClick={() => toggle(column.key)}
                      >
                        {column.header}
                      </TableSortLabel>
                    )
                    : column.header}
                </TableCell>
              );
            })}
          </TableRow>
        </TableHead>
        <TableBody>
          {ordered.map((row, index) => (
            <TableRow key={index} hover>
              {columns.map((column) => <TableCell key={column.key} align={column.align}>{column.cell(row)}</TableCell>)}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

/** A named client-side filter: `predicate` keeps a row for the current non-empty filter value (R9.1). */
export interface ClientFilter<Row> {
  readonly key: string;
  readonly predicate: (row: Row, value: string) => boolean;
}

/** A named client-side sort: `compare` orders two rows (R9.2). */
export interface ClientSort<Row> {
  readonly key: string;
  readonly compare: (a: Row, b: Row) => number;
}

export interface ClientFilterSort<Row> {
  /** The filtered, then sorted rows; always a subset of the input rows (R9.1, R9.2). */
  readonly visible: Row[];
  /** The current value of each filter, by key; a missing or empty value applies no narrowing. */
  readonly filterValue: Readonly<Record<string, string>>;
  readonly setFilter: (key: string, value: string) => void;
  /** The active sort's key, or undefined to keep the loaded order. */
  readonly sortKey: string | undefined;
  readonly setSort: (key: string | undefined) => void;
}

/**
 * Narrows and reorders rows already loaded in state. `visible` is derived purely from `rows` with `useMemo`: it
 * applies every filter with a non-empty value, then the chosen comparator to a copy. It never calls `useApi` or
 * `useLoad` and changes no request (R9.1, R9.2, R9.3, R9.5).
 */
export function useClientFilterSort<Row>(
  rows: readonly Row[],
  opts: { readonly filters?: readonly ClientFilter<Row>[]; readonly sorts?: readonly ClientSort<Row>[] } = {},
): ClientFilterSort<Row> {
  const { filters, sorts } = opts;
  const [filterValue, setFilterValue] = useState<Readonly<Record<string, string>>>({});
  const [sortKey, setSortKey] = useState<string | undefined>(undefined);
  const setFilter = useCallback((key: string, value: string) => setFilterValue((current) => ({ ...current, [key]: value })), []);
  const setSort = useCallback((key: string | undefined) => setSortKey(key), []);
  const visible = useMemo(() => {
    const active = (filters ?? []).flatMap((filter) => {
      const value = filterValue[filter.key] ?? '';
      return value === '' ? [] : [{ filter, value }];
    });
    const narrowed = rows.filter((row) => active.every(({ filter, value }) => filter.predicate(row, value)));
    const sort = sortKey === undefined ? undefined : sorts?.find((candidate) => candidate.key === sortKey);
    return sort === undefined ? narrowed : [...narrowed].sort(sort.compare);
  }, [rows, filters, sorts, filterValue, sortKey]);
  return { visible, filterValue, setFilter, sortKey, setSort };
}

/** A short explanation shown where a listing or region has no content, with an optional next action (R7.4, R8.3, R9.4). */
export function EmptyState({ message, action }: { readonly message: string; readonly action?: ReactNode }) {
  return (
    <Paper variant="outlined" className="rf-empty" sx={{ p: 4, textAlign: 'center', color: 'text.secondary', borderStyle: 'dashed' }}>
      <Typography sx={{ mb: action !== undefined ? 2 : 0 }}>{message}</Typography>
      {action !== undefined && action}
    </Paper>
  );
}

/**
 * A loading placeholder shaped like the content it replaces: `aria-hidden` `.rf-skeleton__row` blocks plus a
 * visually-hidden `role="status"` message for assistive technology, matching the existing loading convention (R7.5).
 */
export function LoadingSkeleton({ rows = 3, label = 'Loading…' }: { readonly rows?: number; readonly label?: string }) {
  return (
    <>
      <Box className="rf-skeleton" aria-hidden="true">
        {Array.from({ length: rows }, (_, index) => <Skeleton key={index} className="rf-skeleton__row" variant="rounded" height={24} sx={{ my: 1 }} />)}
      </Box>
      <p className="rf-visually-hidden" role="status">{label}</p>
    </>
  );
}

/** One view of a {@link Tabs} set: a stable `id` keying its `tab`/`tabpanel`, a tab `label`, and the `panel` content (R7.3, R7.7). */
export interface TabDef {
  readonly id: string;
  readonly label: string;
  readonly panel: ReactNode;
}

export interface TabsProps {
  readonly label: string;
  readonly tabs: readonly TabDef[];
  /** The `id` of the initially selected tab; defaults to the first tab. */
  readonly initial?: string;
}

/**
 * Sibling views switched in place, never by navigating: a `<div role="tablist">` of `<button role="tab">` controls
 * (`id="tab-{id}"`, `aria-controls="panel-{id}"`, `aria-selected`) with roving `tabindex` (active `0`, others `-1`)
 * and Left/Right arrow-key focus movement, plus one `<div role="tabpanel" id="panel-{id}" aria-labelledby="tab-{id}">`
 * per view with inactive panels hidden. Selection is local state only and changes no route (R7.3, R7.7, R11.2, R11.4).
 */
export function Tabs({ label, tabs, initial }: TabsProps) {
  const first = tabs[0]?.id;
  const hasInitial = initial !== undefined && tabs.some((tab) => tab.id === initial);
  const [selected, setSelected] = useState<string | undefined>(hasInitial ? initial : first);
  const buttons = useRef<Map<string, HTMLButtonElement>>(new Map());
  const active = tabs.some((tab) => tab.id === selected) ? selected : first;

  const focusTab = (id: string): void => {
    setSelected(id);
    buttons.current.get(id)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = tabs[(index + step + tabs.length) % tabs.length];
    if (next !== undefined) focusTab(next.id);
  };

  return (
    <div className="rf-tabs">
      <div className="rf-tablist" role="tablist" aria-label={label}>
        {tabs.map((tab, index) => {
          const current = tab.id === active;
          return (
            <button
              key={tab.id}
              ref={(node) => { if (node === null) buttons.current.delete(tab.id); else buttons.current.set(tab.id, node); }}
              className="rf-tab"
              type="button"
              role="tab"
              id={`tab-${tab.id}`}
              aria-controls={`panel-${tab.id}`}
              aria-selected={current}
              tabIndex={current ? 0 : -1}
              onClick={() => setSelected(tab.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className="rf-tabpanel"
          role="tabpanel"
          id={`panel-${tab.id}`}
          aria-labelledby={`tab-${tab.id}`}
          tabIndex={0}
          hidden={tab.id !== active}
        >
          {tab.panel}
        </div>
      ))}
    </div>
  );
}

type Tone = 'neutral' | 'success' | 'warning' | 'danger';
const MUI_SEVERITY = { neutral: 'info', success: 'success', warning: 'warning', danger: 'error' } as const;
export function Notice({ tone = 'neutral', title, children }: { readonly tone?: Tone; readonly title?: string; readonly children?: ReactNode }) {
  return (
    <Alert
      className={`rf-notice rf-notice--${tone}`}
      severity={MUI_SEVERITY[tone]}
      role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}
      sx={{ mb: 2 }}
    >
      {title !== undefined && <AlertTitle className="rf-notice__title">{title}</AlertTitle>}
      {children !== undefined && <div className="rf-notice__body">{children}</div>}
    </Alert>
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

const LEVEL_NAMES: Readonly<Record<string, string>> = { not_published: 'Not published', withheld: 'Withheld', public: 'Public' };
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
