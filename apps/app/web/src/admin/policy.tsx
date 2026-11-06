import { useState } from 'react';
import { Link } from 'react-router';
import type { RichText } from '@researchforce/domain/richtext';
import { ApiFailure, useApi } from '../api';
import { usePersistentForm } from '../persist';
import { useSession } from '../session';
import type { ConflictDetails } from '../types';
import { Button, formatDate, LoadState, Notice, RestoredNotice, SaveFailure, SelectField, TextField, useLoad } from '../ui';
import { POLICY_PAGE_LABELS } from './labels';

/** One editable Policy_Section, in its fixed position with its fixed title (R46.32). */
interface PolicySection {
  readonly key: string;
  readonly position: number;
  readonly title: string;
  readonly required: boolean;
  readonly text: RichText;
}
/** A Policy_Page, its fixed sections, the base `rev` an edit starts from, and the Public_Site preview (R46.27). */
interface PolicyPageView {
  readonly page: string;
  readonly title: string;
  readonly rev: number;
  readonly sectionsChangedAt: string | null;
  readonly sections: readonly PolicySection[];
  readonly preview: string;
}
interface HistoryPoint {
  readonly point: string;
  readonly kind: string;
  readonly displayName: string | null;
  readonly at: string;
  readonly reason?: string | null;
  readonly values?: Readonly<Record<string, unknown>>;
  readonly changes?: readonly { readonly field: string; readonly before: unknown; readonly after: unknown }[];
}
interface Difference { readonly field: string; readonly before: unknown; readonly after: unknown }
interface CompareView { readonly from: string; readonly to: string; readonly changes: readonly Difference[] }

const MARK_NAMES: Readonly<Record<string, string>> = { minor_edit: 'Minor edit', correction: 'Correction', creation: 'Creation' };
const asText = (value: unknown): string => (typeof value === 'object' && value !== null && typeof (value as RichText).text === 'string' ? (value as RichText).text : value === null || value === undefined ? '' : String(value));

/** A Policy_Page's section text, rendered exactly as the Public_Site shows it, inside a sandboxed frame (R46.27). */
function PolicyPreview({ html }: { readonly html: string }) {
  return (
    <section className="rf-section" aria-label="Preview of the page as the public site shows it">
      <h3>Preview</h3>
      <p className="rf-meta">This is the page exactly as the public site would present it. Addresses that are removed from public pages are marked here too.</p>
      <iframe className="rf-preview-frame" title="Policy page preview" sandbox="" srcDoc={html} />
    </section>
  );
}

/** The Revisions recorded since the Administrator opened the page, so the edit can be reconciled and retried (R46.28). */
function PolicyConflict({ failure }: { readonly failure: ApiFailure }) {
  const details = failure.details as ConflictDetails | undefined;
  const revisions = details?.revisions ?? [];
  return (
    <Notice tone="warning" title="Another revision of this page was recorded since you opened it. Your input was not saved; it is kept below.">
      {revisions.length > 0 && (
        <ul className="rf-list">
          {revisions.map((revision, index) => (
            <li key={index}>{`${MARK_NAMES[revision.kind] ?? revision.kind} by ${revision.displayName ?? 'a Member without a display name'} at ${formatDate(revision.at)}`}</li>
          ))}
        </ul>
      )}
      <p>Copy anything you need, then reload the page to edit the latest version.</p>
    </Notice>
  );
}

/**
 * The editor for one Policy_Page: the fixed sections with their text, the Public_Site preview, and a confirmation step
 * with a Minor_Edit or Correction mark (and the reason for a Correction) before the change is applied (R46.27). A
 * refusal — a missing mark, an invalid reason, an empty required section, a section over 20,000 characters, or a stale
 * conflict — keeps the input and names what is wrong (R46.28).
 */
function PolicyEditor({ page, canEdit, onSaved }: { readonly page: PolicyPageView; readonly canEdit: boolean; readonly onSaved: () => void }) {
  const client = useApi();
  const initialTexts = Object.fromEntries(page.sections.map((section) => [section.key, section.text.text]));
  const form = usePersistentForm<{ texts: Record<string, string>; mark: string; reason: string }>(`policy:${page.page}`, { texts: initialTexts, mark: '', reason: '' });
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);

  const setText = (key: string, value: string) => form.set('texts', { ...form.values.texts, [key]: value });
  const changed = page.sections.some((section) => (form.values.texts[section.key] ?? '') !== section.text.text);

  const apply = async () => {
    setFailure(undefined);
    try {
      // Changed section text starts fresh labels: editing the plain text invalidates the stored span offsets, and the
      // Workspace offers no label control here; an unchanged section keeps its stored text and labels verbatim.
      const sections = page.sections.map((section) => {
        const next = form.values.texts[section.key] ?? '';
        return { key: section.key, text: next === section.text.text ? section.text : { text: next, spans: [] } };
      });
      const mark = form.values.mark === 'correction' ? { mark: 'correction', reason: form.values.reason } : { mark: form.values.mark };
      await client.put(`/policy/${page.page}`, { rev: page.rev, mark, sections });
      form.sent();
      setConfirming(false);
      onSaved();
    } catch (error) {
      setFailure(error);
      setConfirming(false);
    }
  };

  const fieldErrors = (field: string) => (failure instanceof ApiFailure ? failure.issuesFor(field) : []);
  const conflict = failure instanceof ApiFailure && failure.code === 'conflict';

  if (!canEdit) {
    return (
      <div className="rf-stack">
        {page.sections.map((section) => (
          <section key={section.key} className="rf-section" aria-label={section.title}>
            <h3>{section.title}</h3>
            <p className="rf-policy-text">{section.text.text === '' ? <span className="rf-meta">No text</span> : section.text.text}</p>
          </section>
        ))}
      </div>
    );
  }

  return (
    <form className="rf-stack" onSubmit={(event) => { event.preventDefault(); setConfirming(true); }} noValidate aria-label={`Edit the ${page.title} page`}>
      {form.restored && <RestoredNotice onDiscard={form.discard} />}
      {conflict && <PolicyConflict failure={failure} />}
      <SaveFailure error={failure} />
      {page.sections.map((section, index) => (
        <TextField
          key={section.key}
          label={`${section.title}${section.required ? '' : ' (optional)'}`}
          multiline
          required={section.required}
          value={form.values.texts[section.key] ?? ''}
          onChange={(value) => setText(section.key, value)}
          errors={fieldErrors(`sections.${index}.text`)}
          hint="Up to 20,000 characters."
        />
      ))}
      <SelectField
        label="This change is a"
        required
        value={form.values.mark}
        placeholder="Choose a mark"
        options={[{ value: 'minor_edit', label: 'Minor edit' }, { value: 'correction', label: 'Correction' }]}
        onChange={(mark) => form.set('mark', mark)}
        errors={fieldErrors('mark')}
      />
      {form.values.mark === 'correction' && (
        <TextField label="Reason for the correction" required value={form.values.reason} maxLength={1000} onChange={(reason) => form.set('reason', reason)} errors={fieldErrors('reason')} hint="1 to 1,000 characters." />
      )}
      <PolicyPreview html={page.preview} />
      {confirming
        ? (
          <section className="rf-section" role="dialog" aria-label="Confirm the policy change">
            <p>Apply this change to the {page.title} page? The preview above is what the public will see.</p>
            <div className="rf-actions">
              <Button variant="primary" onClick={() => void apply()} disabled={!changed}>Confirm and apply</Button>
              <Button variant="quiet" onClick={() => setConfirming(false)}>Keep editing</Button>
            </div>
          </section>
        )
        : (
          <div className="rf-actions">
            <Button type="submit" variant="primary" disabled={!changed}>Review and apply</Button>
          </div>
        )}
    </form>
  );
}

const pointName = (entry: HistoryPoint): string => `${MARK_NAMES[entry.kind] ?? entry.kind}, ${formatDate(entry.at)}`;

/** The page's creation and every Revision, with comparisons between two points, as for an Item (R22.3, R22.4, R46.27). */
function PolicyHistory({ pageKey, pageTitle }: { readonly pageKey: string; readonly pageTitle: string }) {
  const history = useLoad<{ history: HistoryPoint[] }>(`/policy/${pageKey}/history`);
  const [range, setRange] = useState({ from: '', to: '' });
  const [compared, setCompared] = useState<{ from: string; to: string } | undefined>(undefined);
  const comparison = useLoad<CompareView>(compared === undefined ? undefined : `/policy/${pageKey}/compare?from=${encodeURIComponent(compared.from)}&to=${encodeURIComponent(compared.to)}`);
  if (!history.data) return <LoadState error={history.error} />;
  const entries = history.data.history;
  const options = entries.map((entry) => ({ value: entry.point, label: pointName(entry) }));
  return (
    <div className="rf-stack">
      <section aria-label="Compare two points">
        <h3>Compare two points</h3>
        <SelectField label="From" value={range.from} options={options} placeholder="Choose a point" onChange={(from) => setRange({ ...range, from })} />
        <SelectField label="To" value={range.to} options={options} placeholder="Choose a point" onChange={(to) => setRange({ ...range, to })} />
        <div className="rf-actions"><Button onClick={() => setCompared(range)} disabled={range.from === '' || range.to === ''}>Compare</Button></div>
        {compared !== undefined && (comparison.data
          ? (comparison.data.changes.length === 0
            ? <p className="rf-meta">Nothing differs between these two points.</p>
            : (
              <ul className="rf-list">
                {comparison.data.changes.map((difference) => (
                  <li key={difference.field} className="rf-section">
                    <h4>{difference.field}</h4>
                    <p>{`${asText(difference.before) || 'none'} → ${asText(difference.after) || 'none'}`}</p>
                  </li>
                ))}
              </ul>
            ))
          : <LoadState error={comparison.error} />)}
      </section>
      <section aria-label={`History of the ${pageTitle} page`}>
        <h3>History</h3>
        <ol className="rf-list">
          {entries.map((entry) => (
            <li key={entry.point} className="rf-section">
              <p><strong>{MARK_NAMES[entry.kind] ?? entry.kind}</strong>{entry.displayName === null ? '' : ` by ${entry.displayName}`}{` at ${formatDate(entry.at)}`}</p>
              {entry.reason !== null && entry.reason !== undefined && <p>{`Reason: ${entry.reason}`}</p>}
              {entry.changes !== undefined && entry.changes.length > 0 && <p className="rf-meta">{`Changed: ${entry.changes.map((change) => change.field).join(', ')}`}</p>}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

/** `/admin/policy/:page`: edit one Policy_Page's section text with a preview, confirmation, history, and comparisons (R46.27). */
export function PolicyPageScreen({ pageKey }: { readonly pageKey: string }) {
  const { can } = useSession();
  const page = useLoad<PolicyPageView>(`/policy/${pageKey}`);
  const [outcome, setOutcome] = useState<string | undefined>(undefined);
  if (!page.data) return <LoadState error={page.error} />;
  const canEdit = can('policy.edit');
  const saved = () => { setOutcome('The change was applied. The public site re-renders shortly.'); page.reload(); };
  return (
    <div className="rf-stack">
      <header>
        <p className="rf-meta">
          <Link to="/admin/policy">Back to the policy pages</Link>
          {page.data.sectionsChangedAt !== null && ` — last changed ${formatDate(page.data.sectionsChangedAt)}`}
        </p>
        <h1>{`${page.data.title} page`}</h1>
      </header>
      {outcome !== undefined && <Notice tone="success" title={outcome} />}
      {!canEdit && <Notice tone="neutral" title="Your Role does not permit editing policy pages. You can read the sections and history below." />}
      <PolicyEditor page={page.data} canEdit={canEdit} onSaved={saved} />
      <PolicyHistory pageKey={pageKey} pageTitle={page.data.title} />
    </div>
  );
}

/** `/admin/policy`: the six Policy_Pages, each a link to its editor (R46.2, R46.27). */
export function PolicyIndexScreen() {
  return (
    <div className="rf-stack">
      <h1>Policy pages</h1>
      <p className="rf-meta">The six public policy pages. Each page has fixed sections; you can change their text, preview the result, and confirm.</p>
      <ul className="rf-list">
        {POLICY_PAGE_LABELS.map((label) => (
          <li key={label.key}><Link to={`/admin/policy/${label.key}`}>{label.title}</Link></li>
        ))}
      </ul>
    </div>
  );
}
