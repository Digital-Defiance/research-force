import { useState } from 'react';
import { useApi } from '../api';
import { useSession } from '../session';
import type { MemberRow, MovePreviewView, ProjectRecord } from '../types';
import { Button, LoadState, Notice, SaveFailure, SelectField, useLoad } from '../ui';
import { HoldLine, PreviewSummary } from './disclosure';

/**
 * Move a Research_Item to another Project: choose the target Project, preview the Public_View change, and confirm with
 * the preview's token when the move alters a view (R34.7-adjacent, R39.12, R39.13). A move that alters no Public_View
 * needs no confirmation and applies straight away. Only a Member with `item.move` sees it.
 */
export function MoveDialog({ itemId, projectId, members, onMoved }: {
  readonly itemId: string;
  readonly projectId: string;
  readonly members: readonly MemberRow[];
  readonly onMoved: () => void;
}) {
  const client = useApi();
  const session = useSession();
  const projects = useLoad<{ projects: ProjectRecord[] }>('/projects');
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState('');
  const [preview, setPreview] = useState<MovePreviewView | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const [moved, setMoved] = useState(false);
  if (!session.can('item.move')) return null;

  const run = async (step: () => Promise<void>) => {
    setBusy(true);
    setFailure(undefined);
    try { await step(); } catch (error) { setFailure(error); } finally { setBusy(false); }
  };
  const choose = (next: string) => { setTarget(next); setPreview(undefined); setMoved(false); };
  const check = () => run(async () => { setPreview(await client.post<MovePreviewView>(`/items/${itemId}/move/preview`, { projectId: target })); });
  const move = () => run(async () => {
    await client.post(`/items/${itemId}/move`, { projectId: target, ...(preview?.token == null ? {} : { token: preview.token }) });
    setMoved(true);
    onMoved();
  });

  const options = (projects.data?.projects ?? []).filter((project) => project.id !== projectId).map((project) => ({ value: project.id, label: project.name }));

  return (
    <section className="rf-section" aria-label="Move to another Project">
      <h2>Move to another Project</h2>
      {!open && <Button onClick={() => setOpen(true)}>Move to another Project</Button>}
      {open && (projects.data === undefined ? <LoadState error={projects.error} /> : (
        <div className="rf-stack">
          <SaveFailure error={failure} />
          {moved && <Notice tone="success" title="The record was moved." />}
          <SelectField label="Target Project" value={target} placeholder="Choose a Project" options={options} onChange={choose} />
          {preview !== undefined && !moved && (
            <>
              {preview.failures.length > 0 && (
                <Notice tone="danger" title="This move cannot be made, so nothing is moved:">
                  <ul className="rf-list">{preview.failures.map((f, index) => <li key={index}>{f.message}</li>)}</ul>
                </Notice>
              )}
              {preview.holds.length > 0 && (
                <Notice tone="warning" title="A Confidentiality Hold covers this record:">
                  <ul className="rf-list">{preview.holds.map((hold) => <HoldLine key={hold.id} hold={hold} members={members} />)}</ul>
                </Notice>
              )}
              {preview.altersPublicView
                ? <Notice tone="warning" title="This move changes the public view, so confirm the preview to apply it." />
                : <Notice tone="success" title="This move changes no public view and can be applied without confirmation." />}
              <PreviewSummary diff={preview.diff} members={members} />
            </>
          )}
          <div className="rf-actions">
            <Button onClick={() => void check()} disabled={busy || target === ''}>Check what this changes</Button>
            <Button variant="primary" onClick={() => void move()}
              disabled={busy || target === '' || (preview !== undefined && (preview.failures.length > 0 || (preview.altersPublicView && preview.token === null)))}>
              Move the record
            </Button>
            <Button variant="quiet" onClick={() => { setOpen(false); setPreview(undefined); }}>Cancel</Button>
          </div>
        </div>
      ))}
    </section>
  );
}
