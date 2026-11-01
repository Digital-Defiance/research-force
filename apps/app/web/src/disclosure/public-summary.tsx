import { useState } from 'react';
import type { RichText } from '@researchforce/domain/richtext';
import { RichTextEditor } from '../editor/RichTextEditor';
import { EMPTY_RICH_TEXT } from '../editor/spans';
import { mentionOptions } from '../discussion/thread';
import { useSession } from '../session';
import type { MemberRow } from '../types';
import { Button, Notice } from '../ui';

const isEmpty = (value: RichText | undefined): boolean => value === undefined || value.text.trim() === '';

/**
 * The text the Public_Summary editor pre-fills with when the Administrator first opens it (R41.13): the values a
 * Publication_Request being applied proposes, else the Item's existing Public_Summary when it is not empty, else the
 * Item's Log_Summary with its text and labels, else empty text. Nothing is saved until the Administrator saves, and
 * the saved Public_Summary is a separate text that no later Log_Summary change alters.
 */
export function prefillSummary(publicSummary: RichText | undefined, logSummary: RichText | undefined, proposed: RichText | undefined): RichText {
  if (!isEmpty(proposed)) return proposed!;
  if (!isEmpty(publicSummary)) return publicSummary!;
  if (!isEmpty(logSummary)) return logSummary!;
  return EMPTY_RICH_TEXT;
}

/**
 * Edit a Research_Item's Public_Summary with the rich-text editor, pre-filled as `prefillSummary` describes (R23.4,
 * R41.13). The Administrator opens the editor, changes the pre-filled text, and the current text is reported to the
 * caller, which sends it with the disclosure change; closing the editor clears the value so the change carries no
 * Public_Summary. `proposed` carries the values a Publication_Request being applied proposes.
 */
export function PublicSummaryEditor({ value, publicSummary, logSummary, proposed, members, onChange }: {
  readonly value: RichText | undefined;
  readonly publicSummary?: RichText;
  readonly logSummary?: RichText;
  /** The Public_Summary a Publication_Request being applied proposes, pre-filled instead of the Log_Summary (R41.13). */
  readonly proposed?: RichText;
  readonly members: readonly MemberRow[];
  readonly onChange: (value: RichText | undefined) => void;
}) {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const mentions = mentionOptions(members, session.me.specialtyOptions);
  const source = isEmpty(publicSummary)
    ? !isEmpty(proposed) ? 'the values this request proposes' : !isEmpty(logSummary) ? 'the Log Summary' : undefined
    : undefined;

  const start = () => {
    onChange(prefillSummary(publicSummary, logSummary, proposed));
    setOpen(true);
  };
  const stop = () => {
    onChange(undefined);
    setOpen(false);
  };

  if (!open) {
    return (
      <section className="rf-section" aria-label="Public summary">
        <Button onClick={start}>Edit the public summary</Button>
      </section>
    );
  }
  return (
    <section className="rf-section" aria-label="Public summary">
      {source !== undefined && <Notice tone="neutral" title={`The public summary was pre-filled from ${source}. Nothing is saved until you apply the change.`} />}
      <RichTextEditor label="Public summary" value={value ?? EMPTY_RICH_TEXT} onChange={onChange} mentions={mentions}
        hint="At most 2,000 characters. Saved as a separate text that no later Log Summary change alters." />
      <div className="rf-actions"><Button variant="quiet" onClick={stop}>Do not change the public summary</Button></div>
    </section>
  );
}
