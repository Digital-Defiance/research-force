import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { FlagMark, useFlagSnapshot, useRecordViews } from '../activity/activity';
import { useApi } from '../api';
import { useSession } from '../session';
import { Button, formatDate, LoadState, Notice, SaveFailure, SelectField, TextField, useLoad } from '../ui';
import type { ValueSets } from '../types';
import { FilePreview } from './preview';
import { UploadFields, useUploads } from './upload';
interface ChainEntry { id: string; title: string; position: number; uploadedAt: string; ownerId: string; displayName: string | null; viewed: boolean; last: boolean; flag: 'new' | 'updated' | null; supersedesId: string | null }
interface Attachment { id: string; parentId: string; rootId: string; ownerId: string; displayName: string | null; rev: number; identifier: string; title: string; fileKind: string; originalName: string; sizeBytes: number; caption: string | null; origin: string; uploadedAt: string; rightsStatusId: string; rightsStatus: string; permitsPublication: boolean; rightsHolder: string | null; rightsTerms: string | null; level: string; flag: 'new' | 'updated' | null }
export interface AttachmentData { attachment: Attachment; chain: ChainEntry[] }
export function DownloadButton({ id }: { readonly id: string }) {
  const client = useApi(); const [failure, setFailure] = useState<unknown>();
  return <><Button onClick={() => { void client.post<{ url: string }>(`/files/${id}/link`).then((link) => { const a = document.createElement('a'); a.href = link.url; a.rel = 'noreferrer'; a.click(); }, setFailure); }}>Download full file</Button><SaveFailure error={failure} /></>;
}
export function SupersessionNotice({ successor }: { readonly successor: { id: string; uploadedAt: string } | undefined }) {
  if (!successor) return null;
  return <Notice tone="warning" title={`A later version was uploaded on ${formatDate(successor.uploadedAt)}.`}><Link to={`/attachments/${successor.id}`}>Open the superseding Attachment</Link></Notice>;
}
export function AttachFilesForm({ parentId, supersedesId }: { readonly parentId?: string; readonly supersedesId?: string }) {
  const uploads = useUploads(`attach:${supersedesId ?? parentId ?? 'new'}`); const client = useApi(); const navigate = useNavigate();
  const [failure, setFailure] = useState<unknown>(); const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<{ id: string; title: string } | null>(null);
  const [target, setTarget] = useState(supersedesId);
  return <form className="rf-stack" onSubmit={(event) => { event.preventDefault(); if (uploads.guard() || uploads.files.length === 0 || (target && uploads.files.length !== 1)) return; setBusy(true); setFailure(undefined);
    void client.post<{ ids: string[] }>('/attachments', { ...(target ? { supersedesId: target } : { parentId }), files: uploads.selected() }).then((result) => { uploads.sent(); void navigate(`/attachments/${result.ids[0]}`); }, (error: unknown) => {
      setFailure(error); if (typeof error === 'object' && error !== null && 'details' in error) setLast((error.details as { last?: { id: string; title: string } } | undefined)?.last ?? null);
    }).finally(() => setBusy(false)); }}>
    <h2>{target ? 'Add a new version' : 'Attach files'}</h2><SaveFailure error={failure} />
    {last && <Notice tone="warning" title={`The last version is ${last.title}.`}><Button onClick={() => { setTarget(last.id); setLast(null); }}>Use the last version as the target</Button></Notice>}
    {target && <p>The new version starts Not Published with Rights Status Unknown. The earlier file stays available.</p>}
    <UploadFields uploads={uploads} /><Button type="submit" variant="primary" disabled={busy || uploads.files.length === 0 || uploads.reasons.length > 0 || (target !== undefined && uploads.files.length !== 1)}>Submit files</Button>
  </form>;
}
export function AttachmentList({ parentId }: { readonly parentId: string }) {
  const loaded = useLoad<{ attachments: { id: string; title: string; originalName: string; sizeBytes: number; flag: 'new' | 'updated' | null }[] }>(`/items/${parentId}/attachments`);
  const session = useSession();
  const entries = loaded.data?.attachments ?? []; const flagOf = useFlagSnapshot(entries);
  useRecordViews(loaded.data ? entries.map((entry) => entry.id) : undefined);
  return <section className="rf-section" aria-label="Attachments"><h2>Attachments</h2>
    {loaded.data ? <ul className="rf-list">{entries.map((file) => <li key={file.id}><Link to={`/attachments/${file.id}`}>{file.title}</Link>{` (${file.originalName}, ${file.sizeBytes} bytes) `}<FlagMark flag={flagOf(file.id)} /></li>)}</ul> : <LoadState error={loaded.error} />}
    {session.can('attachment.upload') && <Link to={`/items/${parentId}/files`}>Attach files</Link>}
  </section>;
}
function MetadataForm({ attachment, onSaved }: { readonly attachment: Attachment; readonly onSaved: () => void }) {
  const client = useApi(); const values = useLoad<{ valueSets: ValueSets }>('/value-sets');
  const [metadata, setMetadata] = useState({ title: attachment.title, caption: attachment.caption ?? '', origin: attachment.origin, rightsStatusId: attachment.rightsStatusId, rightsHolder: attachment.rightsHolder ?? '', rightsTerms: attachment.rightsTerms ?? '' });
  const [mark, setMark] = useState(''); const [reason, setReason] = useState(''); const [failure, setFailure] = useState<unknown>(); const [busy, setBusy] = useState(false);
  return <form className="rf-stack" onSubmit={(event) => { event.preventDefault(); setBusy(true); void client.patch(`/attachments/${attachment.id}`, { rev: attachment.rev, metadata, mark: { mark, ...(reason ? { reason } : {}) } }).then(onSaved, setFailure).finally(() => setBusy(false)); }}>
    <h2>Edit Attachment metadata</h2><SaveFailure error={failure} />
    {(['title', 'caption', 'origin', 'rightsHolder', 'rightsTerms'] as const).map((field) => <TextField key={field} label={{ title: 'Title', caption: 'Caption', origin: 'Origin', rightsHolder: 'Rights holder', rightsTerms: 'Rights terms' }[field]} value={metadata[field]} onChange={(value) => setMetadata((old) => ({ ...old, [field]: value }))} required={field === 'title' || field === 'origin'} multiline={field !== 'title'} />)}
    <SelectField label="Rights Status" value={metadata.rightsStatusId} options={(values.data?.valueSets.rights_status ?? []).filter((v) => !v.retired || v.id === attachment.rightsStatusId).map((v) => ({ value: v.id, label: v.name }))} onChange={(rightsStatusId) => setMetadata((old) => ({ ...old, rightsStatusId }))} />
    <SelectField label="Kind of edit" required value={mark} placeholder="Choose Minor edit or Correction" options={[{ value: 'minor_edit', label: 'Minor edit' }, { value: 'correction', label: 'Correction' }]} onChange={setMark} />
    {mark === 'correction' && <TextField label="Reason" required value={reason} onChange={setReason} />}
    <Button type="submit" disabled={busy || !mark}>Save metadata</Button>
  </form>;
}
export function AttachmentPage({ id }: { readonly id: string }) {
  const loaded = useLoad<AttachmentData>(`/attachments/${id}`); const session = useSession();
  const [editing, setEditing] = useState(false);
  const entries = loaded.data ? [{ id, flag: loaded.data.attachment.flag }, ...loaded.data.chain] : []; const flagOf = useFlagSnapshot(entries);
  useRecordViews(loaded.data ? [id] : undefined);
  if (!loaded.data) return <LoadState error={loaded.error} />;
  const { attachment: a, chain } = loaded.data;
  const successor = chain.find((entry) => entry.supersedesId === id);
  const editScope = session.roles.find((role) => role.id === session.me.member.roleId)?.permissions['item.edit'];
  const canEdit = editScope === 'any' || (editScope === 'own' && session.me.member.id === a.ownerId);
  return <article className="rf-stack"><header><p className="rf-meta">{`Attachment ${a.identifier}`}</p><h1>{a.title}</h1><FlagMark flag={flagOf(id)} /></header>
    <SupersessionNotice successor={successor} /><p><Link to={`/items/${a.rootId}`}>Open the Research Item</Link></p>
    <dl><dt>Original file name</dt><dd>{a.originalName}</dd><dt>File kind</dt><dd>{a.fileKind}</dd><dt>Size</dt><dd>{`${a.sizeBytes} bytes`}</dd>
      <dt>Credit</dt><dd><Link to={`/members/${a.ownerId}`}>{a.displayName ?? a.ownerId}</Link></dd><dt>Origin</dt><dd>{a.origin}</dd><dt>Caption</dt><dd>{a.caption ?? 'None'}</dd><dt>Uploaded</dt><dd>{formatDate(a.uploadedAt)}</dd>
      <dt>Rights Status</dt><dd>{`${a.rightsStatus} — ${a.permitsPublication ? 'permits publication' : 'does not permit publication'}`}</dd><dt>Rights holder</dt><dd>{a.rightsHolder ?? 'Not recorded'}</dd><dt>Rights terms</dt><dd>{a.rightsTerms ?? 'Not recorded'}</dd><dt>Disclosure</dt><dd>{a.level.replaceAll('_', ' ')}</dd></dl>
    <DownloadButton id={id} /><FilePreview file={a} />
    <section className="rf-section"><h2>Versions</h2><ol>{chain.map((entry) => <li key={entry.id}><Link to={`/attachments/${entry.id}`}>{entry.title}</Link>{' '}<FlagMark flag={flagOf(entry.id)} />{` — version ${entry.position}, uploaded ${formatDate(entry.uploadedAt)} by ${entry.displayName ?? entry.ownerId}${entry.viewed ? ' (viewing)' : ''}${entry.last ? ' (last)' : ''}`}</li>)}</ol></section>
    {canEdit && <div className="rf-actions"><Link to={`/attachments/${id}/version`}>Add a new version</Link><Button onClick={() => setEditing((old) => !old)}>Edit metadata</Button></div>}
    {editing && <MetadataForm attachment={a} onSaved={() => { setEditing(false); loaded.reload(); }} />}
  </article>;
}
