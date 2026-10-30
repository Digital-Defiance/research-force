import { useMemo } from 'react';
import { toReact } from '@researchforce/design/react';
import type { RichText } from '@researchforce/domain/richtext';
import { LabelNotes, renderNotes } from '@researchforce/markdown/overlay';
import { renderRichText } from '@researchforce/markdown/render';
import { useCitationScope } from '../citations/scope';

/** A stored text with its Markdown, labels and their sources and cited locators, language marks, and Mentions, as every renderer shows them (R11.5, R45.6, R54.4). */
export function RichTextView({ value }: { readonly value: RichText }) {
  const { locators } = useCitationScope();
  const rendered = useMemo(() => {
    const { tree, notes } = renderRichText(value, new LabelNotes(undefined, locators));
    const footnotes = renderNotes(notes);
    return { body: toReact(tree), notes: footnotes === undefined ? null : toReact(footnotes) };
  }, [value, locators]);
  return <div className="rf-rich">{rendered.body}{rendered.notes}</div>;
}
