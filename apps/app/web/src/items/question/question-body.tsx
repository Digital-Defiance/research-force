import { Link } from 'react-router';
import type { RichText } from '@researchforce/domain/richtext';
import { RichTextView } from '../../editor/RichTextView';
import type { ItemView } from '../../types';
import { kindName } from './kind-name';
import type { EntryDetail } from './model';

interface StoredGroup { readonly id: string; readonly heading: string; readonly entries: readonly { readonly targetId: string }[] }

/** The question, its introduction, and its groups; entries the viewer cannot read are not in the response (R50.3). */
export function QuestionBody({ item }: { readonly item: ItemView }) {
  const groups = (item['groups'] ?? []) as readonly StoredGroup[];
  const details = (item['entryDetails'] ?? {}) as Readonly<Record<string, EntryDetail>>;
  const introduction = item['introduction'] as RichText | undefined;
  return (
    <section className="rf-section" aria-label="Research Question">
      <h2>Question</h2>
      <p className="rf-question">{String(item['question'] ?? '')}</p>
      {introduction !== undefined && introduction.text.trim() !== '' && <section aria-label="Introduction"><h3>Introduction</h3><RichTextView value={introduction} /></section>}
      {groups.map((group) => (
        <section key={group.id} aria-label={group.heading}>
          <h3>{group.heading}</h3>
          {group.entries.length === 0 ? <p className="rf-meta">No entries in this group.</p> : (
            <ul className="rf-list">
              {group.entries.map((entry) => {
                const detail = details[entry.targetId];
                if (detail === undefined) return null;
                return (
                  <li key={entry.targetId}>
                    <Link to={detail.kind === 'attachment' ? `/attachments/${entry.targetId}` : `/items/${entry.targetId}`}>
                      {`${kindName(detail.kind)}${detail.identifier === null ? '' : ` ${detail.identifier}`}: ${detail.title}`}
                    </Link>
                    {detail.status !== undefined && <span className="rf-status">{` ${detail.status}`}</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ))}
    </section>
  );
}
