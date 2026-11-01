import { useState } from 'react';
import { ITEM_KIND_NAMES } from '@researchforce/domain/kind-names';
import type { ItemKind } from '@researchforce/domain/types';
import { useApi } from '../api';
import { useSession } from '../session';
import type { AttachmentMovePreviewView, MemberRow, SearchResultView } from '../types';
import { Button, Notice, SaveFailure, TextField } from '../ui';
import { PreviewSummary } from '../disclosure/disclosure';

/** A destination a move can choose: a Research_Item or Reply the Member Can_Read, as the search returns it. */
interface Destination { readonly id: string; readonly label: string }

/** How a readable search hit names a destination Parent, so the chosen entry reads clearly. */
function destinationName(result: SearchResultView): string {
  const kind = result.unitType === 'reply' ? 'Reply' : ITEM_KIND_NAMES[result.kind as ItemKind] ?? 'Research Item';
  return `${kind}: ${result.title}`;
}

/**
 * Find a destination Parent for the move by searching the records the Member Can_Read, and choose a Research_Item or
 * Reply as the new Parent (R12.12). The search already returns only readable records, so the list holds exactly the
 * Parents the move may name. Editing the destination is not required, so no further gate applies to the choice.
 */
function ParentPicker({ chosenId, onChoose }: { readonly chosenId: string; readonly onChoose: (destination: Destination) => void }) {
  const client = useApi();
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<readonly SearchResultView[] | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const search = async () => {
    if (query.trim() === '') return;
    setFailed(false);
    try {
      const page = await client.get<{ results: SearchResultView[] }>(`/search?q=${encodeURIComponent(query.trim())}`);
      setFound(page.results.filter((result) => result.unitType === 'research_item' || result.unitType === 'reply'));
    } catch {
      setFailed(true);
    }
  };
  return (
    <div className="rf-stack">
      <TextField label="Find the new Parent" value={query} onChange={setQuery} hint="Search for a Research Item or a Reply you can read." />
      <Button onClick={() => void search()}>Search</Button>
      {failed && <p className="rf-field__error">The search failed. Try again.</p>}
      {found !== undefined && (found.length === 0
        ? <p className="rf-meta">No records you can read match.</p>
        : (
          <ul className="rf-list">
            {found.map((result) => (
              <li key={result.id}>
                {destinationName(result)}{' '}
                {result.id === chosenId
                  ? <span className="rf-meta">Chosen as the new Parent</span>
                  : <Button variant="quiet" label={`Choose ${destinationName(result)}`} onClick={() => onChoose({ id: result.id, label: destinationName(result) })}>Choose</Button>}
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

/**
 * Move an Attachment's Version_Chain to another Parent: choose a Research_Item or Reply the Member Can_Read as the new
 * Parent, preview the Public_View change and who gains read access, and confirm with the preview's token when the move
 * widens a Public_View (R12.12, R12.14, R12.15). A move that widens no view applies straight away. Editing the moved
 * Attachment is required, so only a Member with `item.edit` sees it; editing the destination is not required. Offered
 * on every Attachment page, including Attachments of the Unassigned_Attachments_Source.
 */
export function AttachmentMoveDialog({ attachmentId, parentId, members, onMoved }: {
  readonly attachmentId: string;
  readonly parentId: string;
  readonly members: readonly MemberRow[];
  readonly onMoved: () => void;
}) {
  const client = useApi();
  const session = useSession();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<Destination | undefined>(undefined);
  const [preview, setPreview] = useState<AttachmentMovePreviewView | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const [moved, setMoved] = useState(false);
  if (!session.can('item.edit')) return null;

  const run = async (step: () => Promise<void>) => {
    setBusy(true);
    setFailure(undefined);
    try { await step(); } catch (error) { setFailure(error); } finally { setBusy(false); }
  };
  const choose = (next: Destination) => { setTarget(next); setPreview(undefined); setMoved(false); };
  const check = () => run(async () => { setPreview(await client.post<AttachmentMovePreviewView>(`/attachments/${attachmentId}/move/preview`, { parentId: target!.id })); });
  const move = () => run(async () => {
    await client.post(`/attachments/${attachmentId}/move`, { parentId: target!.id, ...(preview?.token == null ? {} : { token: preview.token }) });
    setMoved(true);
    onMoved();
  });

  const chosenId = target?.id ?? '';
  const sameParent = chosenId === parentId;

  return (
    <section className="rf-section" aria-label="Move to another Parent">
      <h2>Move to another Parent</h2>
      {!open && <Button onClick={() => setOpen(true)}>Move to another Parent</Button>}
      {open && (
        <div className="rf-stack">
          <SaveFailure error={failure} />
          {moved && <Notice tone="success" title="The Attachment was moved." />}
          <ParentPicker chosenId={chosenId} onChoose={choose} />
          {target !== undefined && <p className="rf-meta">{`New Parent: ${target.label}`}</p>}
          {sameParent && <Notice tone="warning" title="These Attachments already belong to this Parent." />}
          {preview !== undefined && !moved && (
            <>
              {preview.failures.length > 0 && (
                <Notice tone="danger" title="This move cannot be made, so nothing is moved:">
                  <ul className="rf-list">{preview.failures.map((f, index) => <li key={index}>{f.message}</li>)}</ul>
                </Notice>
              )}
              {preview.leavesRestricted && (
                <Notice tone="warning" title="This move takes these Attachments out of a Restricted Research Item, so more Members will be able to read them." />
              )}
              {preview.widensPublicView
                ? <Notice tone="warning" title="This move adds these Attachments to a public view, so confirm the preview to apply it." />
                : preview.altersPublicView
                  ? <Notice tone="warning" title="This move changes a public view, so confirm the preview to apply it." />
                  : <Notice tone="success" title="This move changes no public view and can be applied without confirmation." />}
              <PreviewSummary diff={preview.diff} members={members} />
            </>
          )}
          <div className="rf-actions">
            <Button onClick={() => void check()} disabled={busy || target === undefined || sameParent}>Check what this changes</Button>
            <Button variant="primary" onClick={() => void move()}
              disabled={busy || target === undefined || sameParent || (preview !== undefined && (preview.failures.length > 0 || (preview.widensPublicView && preview.token === null)))}>
              Move the Attachment
            </Button>
            <Button variant="quiet" onClick={() => { setOpen(false); setPreview(undefined); }}>Cancel</Button>
          </div>
        </div>
      )}
    </section>
  );
}
