import { useMemo } from 'react';
import { toReact } from '@researchforce/design/react';
import type { RichText } from '@researchforce/domain/richtext';
import { renderNotes } from '@researchforce/markdown/overlay';
import { renderRichText } from '@researchforce/markdown/render';

/** A stored text with its Markdown, labels and their sources, language marks, and Mentions, as every renderer shows them (R11.5, R45.6). */
export function RichTextView({ value }: { readonly value: RichText }) {
  const rendered = useMemo(() => {
    const { tree, notes } = renderRichText(value);
    const footnotes = renderNotes(notes);
    return { body: toReact(tree), notes: footnotes === undefined ? null : toReact(footnotes) };
  }, [value]);
  return <div className="rf-rich">{rendered.body}{rendered.notes}</div>;
}
