import { Link } from 'react-router';
import type { ProjectHistoryEntry } from '../types';
import { formatDate, levelName, LoadState, useLoad } from '../ui';

const KIND_NAMES: Readonly<Record<string, string>> = {
  creation: 'Creation', minor_edit: 'Minor edit', correction: 'Correction', status_change: 'Status change', disclosure_change: 'Disclosure change', restoration: 'Restoration',
};
const FIELD_NAMES: Readonly<Record<string, string>> = {
  name: 'Name', description: 'Short description', slug: 'Project Slug', featured: 'Featured', accent: 'Accent colour', position: 'Position',
  disclosureLevel: 'Disclosure level', disclosureLine: 'Disclosure line',
};

function show(field: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return 'none';
  if (field === 'disclosureLevel' && typeof value === 'string') return levelName(value);
  if (field === 'position' && typeof value === 'number') return String(value + 1);
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** The Project's creation and every Revision, newest first, with who made each, when, and each changed field before and after (R39.18). */
export function ProjectHistory({ entries }: { readonly entries: readonly ProjectHistoryEntry[] }) {
  return (
    <ol className="rf-list">
      {entries.map((entry, index) => (
        <li key={index} className="rf-section">
          <p>
            <strong>{KIND_NAMES[entry.kind] ?? entry.kind}</strong>{' by '}
            <Link to={`/members/${entry.memberId}`}>{entry.displayName ?? 'a Member without a display name'}</Link>
            {` at ${formatDate(entry.at)}`}
          </p>
          {entry.reason !== undefined && entry.reason !== null && <p>{`Reason: ${entry.reason}`}</p>}
          {entry.changes !== undefined && (
            <ul>{entry.changes.map((change) => <li key={change.field}>{`${FIELD_NAMES[change.field] ?? change.field}: ${show(change.field, change.before)} → ${show(change.field, change.after)}`}</li>)}</ul>
          )}
          {entry.values !== undefined && (
            <ul>{Object.entries(entry.values).map(([field, value]) => <li key={field}>{`${FIELD_NAMES[field] ?? field}: ${show(field, value)}`}</li>)}</ul>
          )}
        </li>
      ))}
    </ol>
  );
}

export function ProjectHistoryPage({ id }: { readonly id: string }) {
  const history = useLoad<{ history: ProjectHistoryEntry[] }>(`/projects/${id}/history`);
  if (!history.data) return <LoadState error={history.error} />;
  return (
    <div className="rf-stack">
      <h1>Project history</h1>
      <ProjectHistory entries={history.data.history} />
    </div>
  );
}
