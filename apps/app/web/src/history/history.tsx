import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import type { RichText, Span } from '@researchforce/domain/richtext';
import { RichTextView } from '../editor/RichTextView';
import { KIND_FIELDS } from '../items/forms/model';
import { useApi } from '../api';
import { useSession } from '../session';
import type { FieldDifference, HistoryEntry, HistoryStateView, ItemHistoryView, ItemView, WordPart } from '../types';
import { Button, formatDate, levelName, LoadState, Notice, PersonLink, SaveFailure, SelectField, useLoad } from '../ui';

export const REVISION_KIND_NAMES: Readonly<Record<string, string>> = {
  creation: 'Creation', minor_edit: 'Minor edit', correction: 'Correction', status_change: 'Status change', withdrawal: 'Withdrawal',
  disclosure_change: 'Disclosure change', restoration: 'Restoration', deletion: 'Deletion',
};
const UNIT_FIELD_LABELS: Readonly<Record<string, string>> = {
  title: 'Title', logSummary: 'Log Summary', sections: 'Entry Sections', disclosureLevel: 'Disclosure level', classificationState: 'Classification',
  disclosureLine: 'Disclosure line', publicPresentation: 'Public presentation', withdrawnAt: 'Withdrawn on', withdrawnBy: 'Withdrawn by', withdrawalReason: 'Withdrawal reason',
};

/** The name of a field of this kind of Item, or of an Entry_Section by its position in `order`. */
export function fieldLabel(item: Pick<ItemView, 'kind'>, field: string, order: readonly string[] = []): string {
  if (field === 'sections.order') return 'Order of the Entry Sections';
  if (field.startsWith('sections.')) {
    const index = order.indexOf(field.slice('sections.'.length));
    return index < 0 ? 'A removed Entry Section' : `Entry Section ${index + 1}`;
  }
  return KIND_FIELDS[item.kind].find((spec) => spec.name === field)?.label ?? UNIT_FIELD_LABELS[field] ?? field;
}

const isRich = (value: unknown): value is RichText => typeof value === 'object' && value !== null && typeof (value as RichText).text === 'string' && Array.isArray((value as RichText).spans);
/** A stored value as text, for values without a richer view. */
export function plainValue(field: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return 'none';
  if (field === 'disclosureLevel' && typeof value === 'string') return levelName(value);
  if (field === 'withdrawnAt' && typeof value === 'string') return formatDate(value);
  if (isRich(value)) return value.text;
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return value.join(', ');
  return JSON.stringify(value);
}

/** Added words underlined and removed words struck through, each also marked as an insertion or deletion. */
export function WordChanges({ parts }: { readonly parts: readonly WordPart[] }) {
  return (
    <p className="rf-diff">
      {parts.map((part, index) => (part.added ? <ins key={index} className="rf-diff__added">{part.value}</ins>
        : part.removed ? <del key={index} className="rf-diff__removed">{part.value}</del> : <span key={index}>{part.value}</span>))}
    </p>
  );
}

const SPAN_NAMES: Readonly<Record<string, string>> = { quote: 'Quote', paraphrase: 'Paraphrase', source_reported: 'Reported source', lang: 'Language', mention: 'Mention' };
function describeSpan(span: unknown): string {
  const value = span as Partial<Span> & { source?: string; lang?: string };
  const what = SPAN_NAMES[value.k ?? ''] ?? String(value.k);
  const detail = value.source ?? value.lang;
  return `${what} on characters ${(value.s ?? 0) + 1} to ${value.e ?? 0}${detail === undefined ? '' : ` (${detail})`}`;
}

/** Each field that differs between two points, with both values and the marked words and labels (R22.4). */
export function Comparison({ item, differences, order }: { readonly item: Pick<ItemView, 'kind'>; readonly differences: readonly FieldDifference[]; readonly order: readonly string[] }) {
  if (differences.length === 0) return <p className="rf-meta">Nothing differs between these two points.</p>;
  return (
    <>
      <p className="rf-meta">Added words are underlined and removed words are struck through.</p>
      <ul className="rf-list">
        {differences.map((difference) => (
          <li key={difference.field} className="rf-section">
            <h3>{fieldLabel(item, difference.field, order)}</h3>
            {difference.words === undefined
              ? <p>{`${plainValue(difference.field, difference.before)} → ${plainValue(difference.field, difference.after)}`}</p>
              : <WordChanges parts={difference.words} />}
            {difference.labels !== undefined && (
              <ul>
                {difference.labels.removed.map((span, index) => <li key={`r${index}`}>{`Label removed: ${describeSpan(span)}`}</li>)}
                {difference.labels.added.map((span, index) => <li key={`a${index}`}>{`Label added: ${describeSpan(span)}`}</li>)}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

const entryName = (entry: HistoryEntry) => `${REVISION_KIND_NAMES[entry.kind] ?? entry.kind}, ${formatDate(entry.at)}`;

/** The creation and every Revision, newest first, with who, when, what kind, the reason, and the fields it changed (R22.3). */
export function HistoryList({ item, entries, selected, onSelect }: {
  readonly item: ItemView; readonly entries: readonly HistoryEntry[]; readonly selected: string | undefined; readonly onSelect: (point: string) => void;
}) {
  const order = (item.sections ?? []).map((section) => section.id);
  const restoredName = (point: string) => {
    const target = entries.find((entry) => entry.id === point);
    return target === undefined ? 'an earlier point' : entryName(target);
  };
  return (
    <ol className="rf-list">
      {entries.map((entry) => (
        <li key={entry.id} className="rf-section">
          <p>
            <strong>{REVISION_KIND_NAMES[entry.kind] ?? entry.kind}</strong>
            {entry.sectionId !== null && ` of ${fieldLabel(item, `sections.${entry.sectionId}`, order)}`}
            {' by '}<PersonLink person={{ id: entry.memberId, displayName: entry.displayName }} />{` at ${formatDate(entry.at)}`}
          </p>
          {entry.restoredPoint !== null && <p>{`Restored to: ${restoredName(entry.restoredPoint)}`}</p>}
          {entry.reason !== null && <p>{`Reason: ${entry.reason}`}</p>}
          {entry.fields.length > 0 && <p className="rf-meta">{`Changed: ${entry.fields.map((field) => fieldLabel(item, field)).join(', ')}`}</p>}
          <Button variant="quiet" onClick={() => onSelect(entry.id)} disabled={selected === entry.id}>
            {selected === entry.id ? 'Shown below' : 'Show the record as it was after this'}
          </Button>
        </li>
      ))}
    </ol>
  );
}

function StateValue({ field, value }: { readonly field: string; readonly value: unknown }): ReactNode {
  return isRich(value) ? <RichTextView value={value} /> : plainValue(field, value);
}

/** The Item as it stood immediately after one point (R22.3). */
export function StateView({ item, state, onRestoreSection }: {
  readonly item: ItemView; readonly state: HistoryStateView; readonly onRestoreSection?: (sectionId: string) => void;
}) {
  const sections = (state.item['sections'] ?? []) as readonly { id: string; content: RichText }[];
  const fields = Object.entries(state.item).filter(([field]) => field !== 'sections');
  return (
    <>
      <dl>{fields.map(([field, value]) => <div key={field}><dt>{fieldLabel(item, field)}</dt><dd><StateValue field={field} value={value} /></dd></div>)}</dl>
      {sections.length > 0 && (
        <section aria-label="Entry Sections at this point">
          <h3>Entry Sections</h3>
          {sections.map((section, index) => (
            <section key={section.id} aria-label={`Entry Section ${index + 1} at this point`}>
              <RichTextView value={section.content} />
              {state.sections[section.id]?.['disclosureLevel'] !== undefined && <p className="rf-meta">{`Disclosure level: ${plainValue('disclosureLevel', state.sections[section.id]!['disclosureLevel'])}`}</p>}
              {onRestoreSection !== undefined && <Button variant="quiet" onClick={() => onRestoreSection(section.id)}>{`Restore Entry Section ${index + 1} only`}</Button>}
            </section>
          ))}
        </section>
      )}
    </>
  );
}

/**
 * Confirm a Restoration: content returns to the point, and status, withdrawal, and disclosure stay; a new Restoration
 * Revision is recorded and no Revision is removed (R22.5, R23.15, R41.14).
 */
export function RestoreDialog({ item, point, pointName, sectionId, onCancel, onRestored }: {
  readonly item: ItemView; readonly point: string; readonly pointName: string; readonly sectionId?: string;
  readonly onCancel: () => void; readonly onRestored: (restored: boolean) => void;
}) {
  const client = useApi();
  const session = useSession();
  const [error, setError] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const owner = session.me.member.id === item.owner.id;
  const restore = async () => {
    setBusy(true);
    try {
      const result = await client.post<{ restored: boolean }>(`/items/${item.id}/restore`, { rev: item.rev, point, ...(sectionId === undefined ? {} : { sectionId }) });
      onRestored(result.restored);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="rf-section" role="dialog" aria-label="Restore">
      <h2>{sectionId === undefined ? 'Restore this version' : 'Restore this Entry Section'}</h2>
      <p>{`The content returns to how it was after: ${pointName}. Status, withdrawal, and disclosure stay as they are now.`}</p>
      {sectionId === undefined && !owner && <p>The Log Summary stays as it is, because only the Owner restores it.</p>}
      <p>An Entry Section that comes back starts Not published. A new Restoration revision is recorded and no revision is removed.</p>
      <SaveFailure error={error} />
      <div className="rf-actions">
        <Button variant="primary" onClick={() => void restore()} disabled={busy}>Restore</Button>
        <Button variant="quiet" onClick={onCancel}>Cancel</Button>
      </div>
    </section>
  );
}

/** Which Members may restore: the Owner or an Administrator (R2.4, R22.5). */
function canRestore(session: ReturnType<typeof useSession>, item: ItemView): boolean {
  return session.me.member.id === item.owner.id || session.me.member.roleId === ROLE_IDS.administrator;
}

/** An Item's history: the Revisions, the state after a chosen point, comparisons, and Restoration. */
export function ItemHistoryPage({ id }: { readonly id: string }) {
  const session = useSession();
  const item = useLoad<{ item: ItemView }>(`/items/${id}`);
  const [point, setPoint] = useState<string | undefined>(undefined);
  const history = useLoad<ItemHistoryView>(`/items/${id}/history${point === undefined ? '' : `?point=${encodeURIComponent(point)}`}`);
  const [range, setRange] = useState({ from: '', to: '' });
  const [compared, setCompared] = useState<{ from: string; to: string } | undefined>(undefined);
  const comparison = useLoad<{ differences: FieldDifference[] }>(compared === undefined ? undefined : `/items/${id}/compare?from=${encodeURIComponent(compared.from)}&to=${encodeURIComponent(compared.to)}`);
  const [restoring, setRestoring] = useState<{ sectionId?: string } | undefined>(undefined);
  const [outcome, setOutcome] = useState<string | undefined>(undefined);
  if (!item.data || !history.data) return <LoadState error={item.error ?? history.error} />;
  const current = item.data.item;
  const { entries, state } = history.data;
  const order = (current.sections ?? []).map((section) => section.id);
  const options = entries.map((entry) => ({ value: entry.id, label: entryName(entry) }));
  const pointEntry = entries.find((entry) => entry.id === point);
  const restored = (changed: boolean) => {
    setRestoring(undefined);
    setOutcome(changed ? 'The Restoration was saved.' : 'Nothing differs from that point, so nothing was saved.');
    item.reload();
    history.reload();
  };
  return (
    <div className="rf-stack">
      <header>
        <p className="rf-meta"><Link to={`/items/${id}`}>{`Back to ${current.title}`}</Link></p>
        <h1>{`History of ${current.title}`}</h1>
      </header>
      {outcome !== undefined && <Notice tone="success" title={outcome} />}
      <section aria-label="Compare two points">
        <h2>Compare two points</h2>
        <SelectField label="From" value={range.from} options={options} placeholder="Choose a point" onChange={(from) => setRange({ ...range, from })} />
        <SelectField label="To" value={range.to} options={options} placeholder="Choose a point" onChange={(to) => setRange({ ...range, to })} />
        <Button onClick={() => setCompared(range)} disabled={range.from === '' || range.to === ''}>Compare</Button>
        {compared !== undefined && (comparison.data ? <Comparison item={current} differences={comparison.data.differences} order={order} /> : <LoadState error={comparison.error} />)}
      </section>
      {point !== undefined && state !== undefined && pointEntry !== undefined && (
        <section className="rf-section" aria-label="The record at the chosen point">
          <h2>{`The record after: ${entryName(pointEntry)}`}</h2>
          <StateView item={current} state={state} {...(canRestore(session, current) ? { onRestoreSection: (sectionId: string) => setRestoring({ sectionId }) } : {})} />
          {canRestore(session, current) && <Button onClick={() => setRestoring({})}>Restore this version</Button>}
          {restoring !== undefined && (
            <RestoreDialog item={current} point={point} pointName={entryName(pointEntry)} {...(restoring.sectionId === undefined ? {} : { sectionId: restoring.sectionId })}
              onCancel={() => setRestoring(undefined)} onRestored={restored} />
          )}
        </section>
      )}
      <section aria-label="Revisions">
        <h2>Revisions</h2>
        <HistoryList item={current} entries={entries} selected={point} onSelect={(next) => { setPoint(next); setRestoring(undefined); setOutcome(undefined); }} />
      </section>
    </div>
  );
}
