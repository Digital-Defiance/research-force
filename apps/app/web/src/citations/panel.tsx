import { useState } from 'react';
import { Link } from 'react-router';
import { API_BASE, useApi } from '../api';
import { CITATION_ROLE_NAMES } from '@researchforce/domain/citations';
import type { CitationRole } from '@researchforce/domain/citations';
import { useSession } from '../session';
import type { ItemView } from '../types';
import { Button, LoadState, Notice, SaveFailure, SelectField, TextField, useLoad } from '../ui';
import { buildLocator, EMPTY_DRAFT, LOCATOR_OPTIONS, ROLE_OPTIONS } from './model';
import type { CitationPage, CitationRow, EvidenceWarning, LegacyReference, LocatorDraft } from './model';
import { useCitationScope } from './scope';

const TARGET_OPTIONS = [{ value: 'source', label: 'A Source' }, { value: 'attachment', label: 'An Attachment' }, { value: 'text', label: 'A stretch of text in a record' }];

function Cited({ row, onRemove }: { readonly row: CitationRow; readonly onRemove?: () => void }) {
  return (
    <li>
      <span className="rf-meta">{`${CITATION_ROLE_NAMES[row.role]}: `}</span>
      <Link to={`/items/${row.targetRecord.rootId}`}>{row.targetLabel}</Link>
      {`, ${row.locatorLabel}`}
      {row.state === 'earlier_version' && <span className="rf-status rf-status--warning">{' Refers to an earlier version'}</span>}
      <span className="rf-meta">{` — cited in ${row.citingField}`}</span>
      {onRemove !== undefined && <>{' '}<Button variant="quiet" label={`Remove the citation of ${row.targetLabel}, ${row.locatorLabel}`} onClick={onRemove}>Remove</Button></>}
    </li>
  );
}

function LocatorFields({ draft, onChange }: { readonly draft: LocatorDraft; readonly onChange: (draft: LocatorDraft) => void }) {
  const set = (key: keyof LocatorDraft) => (value: string) => onChange({ ...draft, [key]: value });
  switch (draft.type) {
    case 'page': return <><TextField label="Page" value={draft.from} onChange={set('from')} /><TextField label="Last page" hint="Optional, for a range." value={draft.to} onChange={set('to')} /></>;
    case 'folio': return <><TextField label="Folio" hint="A number, with r or v, such as 4v." value={draft.from} onChange={set('from')} /><TextField label="Last folio" hint="Optional, for a range." value={draft.to} onChange={set('to')} /></>;
    case 'section': return <><TextField label="Section" value={draft.section} onChange={set('section')} /><TextField label="Paragraph" hint="Optional." value={draft.paragraph} onChange={set('paragraph')} /></>;
    case 'text_range': return <><TextField label="Starts at" hint="UTF-16 code units from the start of the cited text." value={draft.start} onChange={set('start')} /><TextField label="Ends at" value={draft.end} onChange={set('end')} /></>;
    case 'image_region': return (
      <>
        <TextField label="Page of the PDF" hint="Optional; only a PDF has pages." value={draft.page} onChange={set('page')} />
        <TextField label="Left edge" hint="A fraction of the width, 0 to 1." value={draft.x} onChange={set('x')} />
        <TextField label="Top edge" hint="A fraction of the height, 0 to 1." value={draft.y} onChange={set('y')} />
        <TextField label="Region width" value={draft.width} onChange={set('width')} />
        <TextField label="Region height" value={draft.height} onChange={set('height')} />
      </>
    );
    case 'unresolved': return <TextField label="Where it is, in words" hint="Kept as written and marked unresolved until you give a position." value={draft.text} onChange={set('text')} multiline />;
  }
}

function CitationForm({ item, onSaved }: { readonly item: ItemView; readonly onSaved: () => void }) {
  const client = useApi();
  const [citingField, setCitingField] = useState('claim');
  const [targetType, setTargetType] = useState('source');
  const [targetId, setTargetId] = useState('');
  const [targetField, setTargetField] = useState('');
  const [role, setRole] = useState<CitationRole>('supports');
  const [draft, setDraft] = useState<LocatorDraft>(EMPTY_DRAFT);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const save = async () => {
    const locator = buildLocator(draft);
    if (typeof locator === 'string') { setProblem(locator); return; }
    setProblem(undefined);
    try {
      await client.post('/citations', {
        citingUnitId: item.id, citingField, role, locator,
        target: { type: targetType, unitId: targetId.trim(), ...(targetType === 'text' ? { field: targetField.trim() } : {}) },
      });
      setError(undefined); setTargetId(''); setDraft(EMPTY_DRAFT);
      onSaved();
    } catch (failure) { setError(failure); }
  };
  return (
    <section aria-label="Cite evidence">
      <h3>Cite evidence</h3>
      <TextField label="Field that cites" hint="The field of this record the citation supports, such as claim." value={citingField} onChange={setCitingField} />
      <SelectField label="Cites" value={targetType} options={TARGET_OPTIONS} onChange={setTargetType} />
      <TextField label="Identifier of the cited record" hint="The identifier of the Source, Attachment, or record." value={targetId} onChange={setTargetId} />
      {targetType === 'text' && <TextField label="Cited field" value={targetField} onChange={setTargetField} />}
      <SelectField label="What it does" value={role} options={ROLE_OPTIONS} onChange={(value) => setRole(value as CitationRole)} />
      <SelectField label="Where in it" value={draft.type} options={LOCATOR_OPTIONS} onChange={(value) => setDraft({ ...draft, type: value as LocatorDraft['type'] })} />
      <LocatorFields draft={draft} onChange={setDraft} />
      {problem !== undefined && <p className="rf-field__error" role="alert">{problem}</p>}
      <div className="rf-actions"><Button variant="primary" onClick={() => { void save(); }}>Record this citation</Button></div>
      <SaveFailure error={error} />
    </section>
  );
}

/** Quiet when a list cannot be loaded: the record itself still shows. */
function useQuiet<T>(path: string): T | undefined {
  return useLoad<T>(path).data;
}

/**
 * The evidence a record cites, the records that cite it, the labels that name a source only in words, and what a publication preview would
 * warn about. A citation with an end the Member cannot read is not here, and nothing says that one exists (R54.4 to R54.6).
 */
export function CitationsPanel({ item }: { readonly item: ItemView }) {
  const client = useApi();
  const session = useSession();
  const scope = useCitationScope();
  const backlinks = useQuiet<CitationPage>(`/citations?targetRootId=${item.id}`);
  const references = useQuiet<{ references: LegacyReference[] }>(`/citations/references/${item.id}`);
  const warnings = useQuiet<{ warnings: EvidenceWarning[] }>(`/citations/warnings/${item.id}`);
  const [error, setError] = useState<unknown>(undefined);
  const canEdit = session.can('item.edit');
  const remove = async (row: CitationRow) => {
    try { await client.delete(`/citations/${row.id}`); setError(undefined); scope.reload(); } catch (failure) { setError(failure); }
  };
  const label = (id: string) => scope.citations.find((row) => row.id === id);
  return (
    <section className="rf-section" aria-label="Evidence citations">
      <h2>Evidence citations</h2>
      {scope.citations.length === 0 ? <p className="rf-meta">This record cites no evidence you can read.</p>
        : <ul className="rf-list">{scope.citations.map((row) => <Cited key={row.id} row={row} {...(canEdit ? { onRemove: () => { void remove(row); } } : {})} />)}</ul>}
      <SaveFailure error={error} />
      {warnings !== undefined && warnings.warnings.length > 0 && (
        <Notice tone="warning" title="A publication preview would warn about this evidence. A citation is not permission to publish.">
          <ul className="rf-list">{warnings.warnings.map((warning) => {
            const row = label(warning.citationId);
            return <li key={`${warning.citationId}-${warning.kind}`}>{`${row === undefined ? 'A citation' : `${row.targetLabel}, ${row.locatorLabel}`}: ${warning.message}`}</li>;
          })}</ul>
        </Notice>
      )}
      {references !== undefined && references.references.length > 0 && (
        <section aria-label="Labels naming a source in words">
          <h3>Labels naming a source in words</h3>
          <p className="rf-meta">These stay as written. Edit the record and choose a cited passage in the label to link one.</p>
          <ul className="rf-list">{references.references.map((reference) => <li key={reference.field}>{`${reference.field}: ${reference.source} — “${reference.text}”`}</li>)}</ul>
        </section>
      )}
      <section aria-label="Cited by">
        <h3>Cited by</h3>
        {backlinks === undefined || backlinks.citations.length === 0 ? <p className="rf-meta">No record you can read cites this one.</p>
          : <ul className="rf-list">{backlinks.citations.map((row) => (
            <li key={row.id}>
              <Link to={`/items/${row.citing.rootId}`}>{`${row.citing.identifier}: ${row.citing.title}`}</Link>
              {`, ${row.locatorLabel} (${CITATION_ROLE_NAMES[row.role]})`}
              {row.state === 'earlier_version' && <span className="rf-status rf-status--warning">{' Refers to an earlier version'}</span>}
            </li>
          ))}</ul>}
      </section>
      <p className="rf-actions">
        <a href={`${API_BASE}/citations/export?citingRootId=${item.id}`}>Download these citations (JSON)</a>
        {' '}<a href={`${API_BASE}/citations/export?citingRootId=${item.id}&format=csl-json`}>Download the cited records (CSL-JSON)</a>
      </p>
      {canEdit && <CitationForm item={item} onSaved={scope.reload} />}
    </section>
  );
}

/** A Project's citations whose locator is still in words, to be given a position, replaced, or removed (R54.6). */
export function CitationCurationScreen({ projectId }: { readonly projectId: string }) {
  const client = useApi();
  const session = useSession();
  const [pages, setPages] = useState<{ rows: readonly CitationRow[]; next: string | null | undefined }>({ rows: [], next: undefined });
  const first = useLoad<CitationPage>(`/citations?projectId=${projectId}&unresolved=1`);
  const [error, setError] = useState<unknown>(undefined);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  if (!first.data) return <LoadState error={first.error} />;
  const rows = [...first.data.citations, ...pages.rows].filter((row) => !removed.has(row.id));
  const next = pages.next === undefined ? first.data.next : pages.next;
  const more = async () => {
    try {
      const page = await client.get<CitationPage>(`/citations?projectId=${projectId}&unresolved=1&after=${next!}`);
      setPages({ rows: [...pages.rows, ...page.citations], next: page.next });
    } catch (failure) { setError(failure); }
  };
  const remove = async (row: CitationRow) => {
    try { await client.delete(`/citations/${row.id}`); setRemoved(new Set([...removed, row.id])); } catch (failure) { setError(failure); }
  };
  return (
    <div className="rf-stack">
      <h1>Citations to resolve</h1>
      <p className="rf-meta">These citations say where the passage is only in words. Open the record that cites to give a position; nothing here is guessed.</p>
      {rows.length === 0 ? <p>No unresolved citations.</p> : (
        <ul className="rf-list">{rows.map((row) => (
          <li key={row.id}>
            <Link to={`/items/${row.citing.rootId}`}>{`${row.citing.identifier}: ${row.citing.title}`}</Link>
            {` cites `}<Link to={`/items/${row.targetRecord.rootId}`}>{row.targetLabel}</Link>{`: ${row.locatorLabel}`}
            {session.can('item.edit') && <>{' '}<Button variant="quiet" label={`Remove the citation of ${row.targetLabel}`} onClick={() => { void remove(row); }}>Remove</Button></>}
          </li>
        ))}</ul>
      )}
      {next !== null && <div className="rf-actions"><Button onClick={() => { void more(); }}>Show more</Button></div>}
      <SaveFailure error={error} />
      <p><a href={`${API_BASE}/citations/export?projectId=${projectId}`}>Download this Project’s citations (JSON)</a></p>
    </div>
  );
}
