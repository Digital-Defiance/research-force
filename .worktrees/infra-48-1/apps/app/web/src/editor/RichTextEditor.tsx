import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { EditorState, RangeSet, StateEffect, StateField } from '@codemirror/state';
import type { Range } from '@codemirror/state';
import { Decoration, EditorView, keymap, WidgetType } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { LABEL_KIND_NAMES, labelTextFor } from '@researchforce/domain/label-marks';
import type { LabelKind } from '@researchforce/domain/label-marks';
import { ISO_639_1 } from '@researchforce/domain/languages';
import type { RichText, Span, SpanIssue, TextEdit } from '@researchforce/domain/richtext';
import type { FieldIssue } from '../api';
import { Button, Field, SelectField, TextField } from '../ui';
import { addLabel, insertMention, mapChanges, markLanguage, removeSpans, sameRichText, spansAt } from './spans';
import type { LabelChoice, MentionTarget } from './spans';

/** People and Specialties a Mention can name: active Members and Specialties that are not retired (R16.8). */
export interface MentionOptions {
  readonly members: readonly { readonly id: string; readonly displayName: string }[];
  readonly specialties: readonly { readonly id: string; readonly name: string }[];
}

const replaceSpans = StateEffect.define<readonly Span[]>();

/** The spans follow every change to the text through the domain's `applyEdit` (R11.9). */
const spansField = StateField.define<readonly Span[]>({
  create: () => [],
  update(spans, transaction) {
    for (const effect of transaction.effects) if (effect.is(replaceSpans)) return effect.value;
    if (!transaction.docChanged) return spans;
    const changes: TextEdit[] = [];
    transaction.changes.iterChanges((from, to, _fromB, _toB, inserted) => changes.push({ from, to, insert: inserted.toString() }));
    return mapChanges({ text: transaction.startState.doc.toString(), spans }, changes).spans;
  },
});

class LabelCaption extends WidgetType {
  constructor(readonly text: string) { super(); }
  override eq(other: LabelCaption): boolean { return other.text === this.text; }
  override toDOM(): HTMLElement {
    const caption = document.createElement('span');
    caption.className = 'rf-mark-caption';
    caption.textContent = `[${this.text}]`;
    return caption;
  }
}

const isLabel = (span: Span): span is Extract<Span, { k: LabelKind }> => span.k === 'quote' || span.k === 'paraphrase' || span.k === 'source_reported';
const languageName = (code: string): string => (ISO_639_1 as Readonly<Record<string, string>>)[code] ?? code;

/** Each label marks its characters and shows its kind and source next to them; language marks set `lang` (R11.5, R45.6). */
function decorationsFor(spans: readonly Span[]): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const span of spans) {
    const attributes: Record<string, string> = span.k === 'lang' ? { lang: span.lang, title: languageName(span.lang) } : {};
    if (span.k === 'mention') attributes['data-mention'] = 'member' in span && span.member !== undefined ? 'member' : 'specialty';
    ranges.push(Decoration.mark({ class: `rf-mark rf-mark--${span.k}`, attributes }).range(span.s, span.e));
    if (isLabel(span)) ranges.push(Decoration.widget({ widget: new LabelCaption(labelTextFor(span.k, span.source)), side: 1 }).range(span.e));
  }
  return Decoration.set(ranges, true);
}

const decorations = EditorView.decorations.compute([spansField], (state) => decorationsFor(state.field(spansField)));

/** A Mention is one atomic range: the cursor steps over it and deleting removes it whole (R16.8). */
const atomicMentions = EditorView.atomicRanges.of((view) => RangeSet.of(
  view.state.field(spansField).filter((span) => span.k === 'mention').map((span) => Decoration.mark({}).range(span.s, span.e)),
  true,
));

type Dialog = { readonly kind: 'label'; readonly label: LabelKind } | { readonly kind: 'language' } | { readonly kind: 'mention' } | null;

export interface RichTextEditorProps {
  readonly label: string;
  readonly value: RichText;
  readonly onChange: (value: RichText) => void;
  readonly mentions: MentionOptions;
  readonly hint?: string;
  readonly errors?: readonly FieldIssue[];
  readonly required?: boolean;
}

const ISSUE_TEXT = (issues: readonly SpanIssue[]): string => issues.map((issue) => issue.message).join(' ');

export function RichTextEditor({ label, value, onChange, mentions, hint, errors = [], required = false }: RichTextEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const emitted = useRef<RichText>(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [dialog, setDialog] = useState<Dialog>(null);
  const [message, setMessage] = useState<string | null>(null);
  const labelId = useId();
  const errorId = `${labelId}-error`;
  const hintId = `${labelId}-hint`;

  useEffect(() => {
    const parent = host.current;
    if (parent === null) return undefined;
    const editor = new EditorView({
      parent,
      state: EditorState.create({
        doc: value.text,
        extensions: [
          spansField.init(() => value.spans), decorations, atomicMentions, history(), keymap.of([...defaultKeymap, ...historyKeymap]), markdown(), EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-labelledby': labelId, 'aria-multiline': 'true', role: 'textbox', ...(required ? { 'aria-required': 'true' } : {}) }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged && update.startState.field(spansField) === update.state.field(spansField)) return;
            const next = { text: update.state.doc.toString(), spans: update.state.field(spansField) };
            emitted.current = next;
            onChangeRef.current(next);
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  // The editor is created once; later values arrive through the effect below.
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (editor === null || sameRichText(value, emitted.current)) return;
    emitted.current = value;
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value.text }, effects: replaceSpans.of(value.spans) });
  }, [value]);

  const current = (): { richText: RichText; from: number; to: number } | undefined => {
    const editor = view.current;
    if (editor === null) return undefined;
    const { from, to } = editor.state.selection.main;
    return { richText: { text: editor.state.doc.toString(), spans: editor.state.field(spansField) }, from, to };
  };
  const setSpans = (spans: readonly Span[]) => view.current?.dispatch({ effects: replaceSpans.of(spans) });
  const needsSelection = (): boolean => {
    const selection = current();
    if (selection === undefined || selection.from === selection.to) {
      setMessage('Select the characters to mark first.');
      return false;
    }
    return true;
  };
  const open = (next: Exclude<Dialog, null>) => {
    setMessage(null);
    if (next.kind === 'mention' || needsSelection()) setDialog(next);
  };
  const applyResult = (result: { richText: RichText; issues: readonly SpanIssue[] }) => {
    if (result.issues.length > 0) {
      setMessage(ISSUE_TEXT(result.issues));
      return;
    }
    setSpans(result.richText.spans);
    setDialog(null);
    setMessage(null);
  };
  const removeMarks = () => {
    const selection = current();
    if (selection === undefined) return;
    const indices = spansAt(selection.richText, selection.from, selection.to);
    if (indices.length === 0) {
      setMessage('No label, language mark, or Mention is at the cursor.');
      return;
    }
    setSpans(removeSpans(selection.richText, indices).spans);
    setMessage(null);
  };
  const chooseMention = (target: MentionTarget) => {
    const selection = current();
    const editor = view.current;
    if (selection === undefined || editor === null) return;
    const { richText, end } = insertMention(selection.richText, selection.from, selection.to, target);
    editor.dispatch({
      changes: { from: selection.from, to: selection.to, insert: target.name },
      effects: replaceSpans.of(richText.spans),
      selection: { anchor: end },
    });
    setDialog(null);
    editor.focus();
  };

  return (
    <div className={errors.length > 0 ? 'rf-field rf-field--invalid' : 'rf-field'}>
      <span className="rf-field__label" id={labelId}>
        {label}
        {required && <span className="rf-field__required"> (required)</span>}
      </span>
      {hint !== undefined && <p className="rf-field__hint" id={hintId}>{hint}</p>}
      {errors.length > 0 && <p className="rf-field__error" id={errorId}>{errors.map((issue) => issue.rule).join(' ')}</p>}
      <div className="rf-actions" role="toolbar" aria-label={`Marks for ${label}`}>
        {(['quote', 'paraphrase', 'source_reported'] as const).map((kind) => (
          <Button key={kind} variant="quiet" onClick={() => open({ kind: 'label', label: kind })}>{`Label as ${LABEL_KIND_NAMES[kind]}`}</Button>
        ))}
        <Button variant="quiet" onClick={() => open({ kind: 'language' })}>Mark language</Button>
        <Button variant="quiet" onClick={() => open({ kind: 'mention' })}>Insert a Mention</Button>
        <Button variant="quiet" onClick={removeMarks}>Remove marks here</Button>
      </div>
      {message !== null && <p className="rf-field__error" role="alert">{message}</p>}
      {dialog?.kind === 'label' && <LabelDialog kind={dialog.label} onCancel={() => setDialog(null)} onApply={(choice) => {
        const selection = current();
        if (selection) applyResult(addLabel(selection.richText, selection.from, selection.to, choice));
      }} />}
      {dialog?.kind === 'language' && <LanguageDialog onCancel={() => setDialog(null)} onApply={(code) => {
        const selection = current();
        if (selection) applyResult(markLanguage(selection.richText, selection.from, selection.to, code));
      }} />}
      {dialog?.kind === 'mention' && <MentionPicker options={mentions} onCancel={() => setDialog(null)} onChoose={chooseMention} />}
      <div className="rf-editor" ref={host} aria-describedby={[hint === undefined ? '' : hintId, errors.length > 0 ? errorId : ''].filter(Boolean).join(' ') || undefined} />
    </div>
  );
}

function LabelDialog({ kind, onApply, onCancel }: { readonly kind: LabelKind; readonly onApply: (choice: LabelChoice) => void; readonly onCancel: () => void }) {
  const [source, setSource] = useState('');
  const optional = kind === 'source_reported';
  return (
    <div role="dialog" aria-label={`Label as ${LABEL_KIND_NAMES[kind]}`}>
      <TextField label="Named source" value={source} onChange={setSource} maxLength={300} required={!optional}
        hint={optional ? 'Optional, up to 300 characters.' : '1 to 300 characters.'} />
      <div className="rf-actions">
        <Button variant="primary" onClick={() => onApply(kind === 'source_reported' ? { k: kind, source } : { k: kind, source })}>Apply the label</Button>
        <Button variant="quiet" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

const LANGUAGE_OPTIONS = Object.entries(ISO_639_1 as Readonly<Record<string, string>>)
  .map(([code, name]) => ({ value: code, label: name }))
  .sort((a, b) => a.label.localeCompare(b.label, 'en'));

function LanguageDialog({ onApply, onCancel }: { readonly onApply: (code: string) => void; readonly onCancel: () => void }) {
  const [code, setCode] = useState('');
  return (
    <div role="dialog" aria-label="Mark language">
      <SelectField label="Language" value={code} options={LANGUAGE_OPTIONS} onChange={setCode} placeholder="Choose a language" required />
      <div className="rf-actions">
        <Button variant="primary" disabled={code === ''} onClick={() => onApply(code)}>Mark the language</Button>
        <Button variant="quiet" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

interface PickerEntry { readonly key: string; readonly label: string; readonly target: MentionTarget }

/** Offers only active Members and Specialties that are not retired; a Mention exists only when chosen here (R16.8). */
export function MentionPicker({ options, onChoose, onCancel }: { readonly options: MentionOptions; readonly onChoose: (target: MentionTarget) => void; readonly onCancel: () => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const entries = useMemo<PickerEntry[]>(() => {
    const needle = query.trim().toLowerCase();
    const all: PickerEntry[] = [
      ...options.members.map((member) => ({ key: `m:${member.id}`, label: `${member.displayName} (Member)`, target: { member: member.id, name: member.displayName } })),
      ...options.specialties.map((specialty) => ({ key: `s:${specialty.id}`, label: `${specialty.name} (Specialty)`, target: { specialty: specialty.id, name: specialty.name } })),
    ];
    return needle === '' ? all : all.filter((entry) => entry.target.name.toLowerCase().includes(needle));
  }, [options, query]);
  const choose = (entry: PickerEntry | undefined) => { if (entry) onChoose(entry.target); };
  return (
    <div role="dialog" aria-label="Insert a Mention">
      <Field label="Mention a Member or Specialty">
        {({ id }) => (
          <input className="rf-input" id={id} role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list" value={query}
            aria-activedescendant={entries[active] ? `${listId}-${active}` : undefined}
            onChange={(event) => { setQuery(event.target.value); setActive(0); }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') { event.preventDefault(); setActive((index) => Math.min(index + 1, entries.length - 1)); }
              if (event.key === 'ArrowUp') { event.preventDefault(); setActive((index) => Math.max(index - 1, 0)); }
              if (event.key === 'Enter') { event.preventDefault(); choose(entries[active]); }
              if (event.key === 'Escape') onCancel();
            }} />
        )}
      </Field>
      <ul className="rf-picker" id={listId} role="listbox" aria-label="Members and Specialties">
        {entries.map((entry, index) => (
          <li key={entry.key} id={`${listId}-${index}`} role="option" aria-selected={index === active} onMouseDown={(event) => { event.preventDefault(); choose(entry); }}>{entry.label}</li>
        ))}
      </ul>
      {entries.length === 0 && <p className="rf-meta">No active Member or Specialty matches.</p>}
      <Button variant="quiet" onClick={onCancel}>Cancel</Button>
    </div>
  );
}
