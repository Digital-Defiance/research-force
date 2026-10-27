import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { deleteCharBackward } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import type { RichText } from '@researchforce/domain/richtext';
import { RichTextEditor } from '../src/editor/RichTextEditor';
import type { MentionOptions } from '../src/editor/RichTextEditor';
import { RichTextView } from '../src/editor/RichTextView';

const MENTIONS: MentionOptions = {
  members: [{ id: 'M1', displayName: 'Ada Example' }, { id: 'M2', displayName: 'Ben Sample' }],
  specialties: [{ id: 'S1', name: 'Historian' }],
};

function Harness({ initial, seen, replaceWith }: { initial: RichText; seen: RichText[]; replaceWith?: RichText }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <RichTextEditor label="Body" value={value} mentions={MENTIONS} onChange={(next) => { seen.push(next); setValue(next); }} />
      {replaceWith !== undefined && <button type="button" onClick={() => setValue(replaceWith)}>Replace</button>}
    </>
  );
}

function setup(initial: RichText, replaceWith?: RichText) {
  const seen: RichText[] = [];
  const view = render(<Harness initial={initial} seen={seen} {...(replaceWith === undefined ? {} : { replaceWith })} />);
  const editor = EditorView.findFromDOM(view.container.querySelector('.cm-editor') as HTMLElement)!;
  const select = (anchor: number, head = anchor) => act(() => { editor.dispatch({ selection: { anchor, head } }); });
  const last = () => seen.at(-1)!;
  return { view, editor, select, seen, last };
}

describe('the rich-text editor', () => {
  it('maps labels through every text change and reports text and spans together (R11.9)', () => {
    const { editor, last } = setup({ text: 'one two three', spans: [{ s: 4, e: 7, k: 'quote', source: 'A letter' }] });
    act(() => { editor.dispatch({ changes: { from: 5, insert: 'XX' } }); });
    expect(last()).toEqual({ text: 'one tXXwo three', spans: [{ s: 4, e: 9, k: 'quote', source: 'A letter' }] });
    act(() => { editor.dispatch({ changes: [{ from: 0, to: 4, insert: '' }, { from: 9, to: 15, insert: '!' }] }); });
    expect(last()).toEqual({ text: 'tXXwo!', spans: [{ s: 0, e: 5, k: 'quote', source: 'A letter' }] });
    act(() => { editor.dispatch({ changes: { from: 0, to: 5, insert: '' } }); });
    expect(last()).toEqual({ text: '!', spans: [] });
  });

  it('marks labelled characters with the label kind and source next to them, and language marks with lang (R11.5, R45.6)', () => {
    const { view } = setup({ text: 'quoted text', spans: [{ s: 0, e: 6, k: 'quote', source: 'A letter' }, { s: 7, e: 11, k: 'lang', lang: 'fr' }] });
    expect(view.container.querySelector('.rf-mark--quote')?.textContent).toBe('quoted');
    expect(view.container.querySelector('.rf-mark-caption')?.textContent).toBe('[Quote · A letter]');
    const french = view.container.querySelector('[lang="fr"]');
    expect(french?.textContent).toBe('text');
    expect(french?.getAttribute('title')).toBe('French');
  });

  it('labels the selected characters through the label dialog, and asks for a selection first', () => {
    const { select, last } = setup({ text: 'The archive holds it.', spans: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Label as Quote' }));
    expect(screen.getByRole('alert').textContent).toBe('Select the characters to mark first.');
    select(4, 11);
    fireEvent.click(screen.getByRole('button', { name: 'Label as Quote' }));
    const dialog = screen.getByRole('dialog', { name: 'Label as Quote' });
    fireEvent.click(screen.getByRole('button', { name: 'Apply the label' }));
    expect(screen.getByRole('alert').textContent).toContain('A Quote or Paraphrase needs a non-blank source.');
    fireEvent.change(screen.getByLabelText(/Named source/u), { target: { value: 'A finding aid' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply the label' }));
    expect(dialog.isConnected).toBe(false);
    expect(last().spans).toEqual([{ s: 4, e: 11, k: 'quote', source: 'A finding aid' }]);
    select(0, 3);
    fireEvent.click(screen.getByRole('button', { name: 'Label as Source-reported' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply the label' }));
    expect(last().spans).toEqual([{ s: 0, e: 3, k: 'source_reported' }, { s: 4, e: 11, k: 'quote', source: 'A finding aid' }]);
  });

  it('marks a language chosen by its English name', () => {
    const { select, last } = setup({ text: 'Guten Tag', spans: [] });
    select(0, 9);
    fireEvent.click(screen.getByRole('button', { name: 'Mark language' }));
    const apply = screen.getByRole('button', { name: 'Mark the language' });
    expect((apply as HTMLButtonElement).disabled).toBe(true);
    const language = screen.getByLabelText(/^Language/u) as HTMLSelectElement;
    expect([...language.options].some((option) => option.textContent === 'German' && option.value === 'de')).toBe(true);
    fireEvent.change(language, { target: { value: 'de' } });
    fireEvent.click(apply);
    expect(last().spans).toEqual([{ s: 0, e: 9, k: 'lang', lang: 'de' }]);
  });

  it('inserts a Mention chosen from active Members and Specialties as one atomic range (R16.8)', () => {
    const { editor, select, last, view } = setup({ text: 'Ask  now', spans: [] });
    select(4);
    fireEvent.click(screen.getByRole('button', { name: 'Insert a Mention' }));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Ada Example (Member)', 'Ben Sample (Member)', 'Historian (Specialty)']);
    const query = screen.getByRole('combobox');
    fireEvent.change(query, { target: { value: 'sam' } });
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Ben Sample (Member)']);
    fireEvent.change(query, { target: { value: 'nobody' } });
    expect(view.container.textContent).toContain('No active Member or Specialty matches.');
    fireEvent.change(query, { target: { value: '' } });
    fireEvent.keyDown(query, { key: 'ArrowDown' });
    fireEvent.keyDown(query, { key: 'Enter' });
    expect(last()).toEqual({ text: 'Ask Ben Sample now', spans: [{ s: 4, e: 14, k: 'mention', member: 'M2' }] });
    expect(editor.state.selection.main.head).toBe(14);
    expect(editor.hasFocus).toBe(true);
    // happy-dom dispatches selectionchange synchronously, inside CodeMirror's updates, while the editor has focus.
    act(() => { editor.contentDOM.blur(); });
    act(() => { deleteCharBackward(editor); });
    expect(last()).toEqual({ text: 'Ask  now', spans: [] });
    select(4);
    fireEvent.click(screen.getByRole('button', { name: 'Insert a Mention' }));
    fireEvent.mouseDown(screen.getByRole('option', { name: 'Historian (Specialty)' }));
    expect(last()).toEqual({ text: 'Ask Historian now', spans: [{ s: 4, e: 13, k: 'mention', specialty: 'S1' }] });
  });

  it('removes the marks at the cursor', () => {
    const { select, last, view } = setup({ text: 'abcdef', spans: [{ s: 0, e: 3, k: 'source_reported' }, { s: 1, e: 2, k: 'lang', lang: 'fr' }] });
    select(5);
    fireEvent.click(screen.getByRole('button', { name: 'Remove marks here' }));
    expect(view.container.textContent).toContain('No label, language mark, or Mention is at the cursor.');
    select(1);
    fireEvent.click(screen.getByRole('button', { name: 'Remove marks here' }));
    expect(last().spans).toEqual([]);
  });

  it('shows a value given from outside, such as after a discard', () => {
    const { editor } = setup({ text: 'draft', spans: [] }, { text: 'saved text', spans: [{ s: 0, e: 5, k: 'source_reported' }] });
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    expect(editor.state.doc.toString()).toBe('saved text');
  });

  it('cancels the dialogs without changing the text', () => {
    const { select, seen } = setup({ text: 'abc', spans: [] });
    select(0, 2);
    for (const name of ['Label as Paraphrase', 'Mark language', 'Insert a Mention']) {
      fireEvent.click(screen.getByRole('button', { name }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('dialog')).toBeNull();
    }
    expect(seen).toEqual([]);
  });
});

describe('the rich-text view', () => {
  it('renders Markdown with label marks, label text, and language marks', () => {
    const view = render(<RichTextView value={{ text: 'A *quoted* line', spans: [{ s: 0, e: 15, k: 'quote', source: 'A letter' }, { s: 2, e: 10, k: 'lang', lang: 'de' }] }} />);
    expect(view.container.querySelector('q')).not.toBeNull();
    expect(view.container.querySelector('[lang="de"]')).not.toBeNull();
    expect(view.container.textContent).toContain('A letter');
  });
});
