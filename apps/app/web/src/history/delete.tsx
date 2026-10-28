import { useState } from 'react';
import { Link } from 'react-router';
import { ITEM_KIND_NAMES } from '@researchforce/domain/kind-names';
import { ApiFailure, useApi } from '../api';
import { useSession } from '../session';
import type { DeletionRecord, ItemView } from '../types';
import { Button, formatDate, LoadState, Notice, PersonLink, SaveFailure, TextField, useLoad } from '../ui';

/** A permanently deleted Item's place: its kind, Item_Identifier, the Administrator, the time, and the reason (R22.7). */
export function DeletedItem({ deletion }: { readonly deletion: DeletionRecord }) {
  return (
    <Notice tone="warning" title={`This ${ITEM_KIND_NAMES[deletion.kind]} was permanently deleted on ${formatDate(deletion.deletedAt)}.`}>
      <dl>
        <dt>Item Identifier</dt><dd>{deletion.identifier}</dd>
        <dt>Deleted by</dt><dd><PersonLink person={deletion.deletedBy} /></dd>
        <dt>Reason</dt><dd>{deletion.reason}</dd>
      </dl>
    </Notice>
  );
}

/** The Deletion record of a request that failed because its Item was permanently deleted. */
export function deletionOf(error: unknown): DeletionRecord | undefined {
  return error instanceof ApiFailure && error.code === 'not_found' ? (error.details as { deletion?: DeletionRecord } | undefined)?.deletion : undefined;
}

const sameIdentifier = (typed: string, identifier: string) => typed.trim().toUpperCase() === identifier;

/**
 * Confirm a permanent deletion: the Administrator types the Item_Identifier and gives a reason of 1 to 1,000
 * characters (R22.7, R22.9; design "Destructive actions").
 */
export function DeleteDialog({ item, onDeleted }: { readonly item: ItemView; readonly onDeleted: () => void }) {
  const client = useApi();
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await client.request('DELETE', `/items/${item.id}`, { identifier: typed, reason });
      onDeleted();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  const issues = (field: string) => (error instanceof ApiFailure ? error.issuesFor(field) : []);
  return (
    <section className="rf-stack" role="dialog" aria-label="Delete permanently">
      <Notice tone="danger" title="Permanent deletion cannot be undone.">
        <p>It removes this record, every Entry Section, Attachment, Reply, and Dissent Note under it, and all their revisions. Their files are deleted from storage within 24 hours.</p>
        <p>Members see only the kind, the Item Identifier, who deleted it, when, and the reason. The Item Identifier is never issued again.</p>
      </Notice>
      <TextField label="Type the Item Identifier to confirm" hint={`The Item Identifier is ${item.identifier}.`} value={typed} onChange={setTyped} required errors={issues('identifier')} />
      <TextField label="Reason for the deletion" value={reason} onChange={setReason} multiline required maxLength={1000} errors={issues('reason')} hint="1 to 1,000 characters." />
      <SaveFailure error={error instanceof ApiFailure && error.fields.length > 0 ? undefined : error} />
      <div className="rf-actions">
        <Button variant="danger" onClick={() => void remove()} disabled={busy || !sameIdentifier(typed, item.identifier)}>Delete permanently</Button>
        <Link className="rf-button rf-button--quiet" to={`/items/${item.id}`}>Cancel</Link>
      </div>
    </section>
  );
}

export function DeletePage({ id }: { readonly id: string }) {
  const session = useSession();
  const item = useLoad<{ item: ItemView }>(`/items/${id}`);
  const [done, setDone] = useState(false);
  if (done) return <Notice tone="success" title="The record was permanently deleted."><p><Link to="/">Back to the Workspace</Link></p></Notice>;
  if (!session.can('item.delete')) return <Notice tone="warning" title="Only Administrators delete records permanently." />;
  if (!item.data) {
    const deletion = deletionOf(item.error);
    return deletion === undefined ? <LoadState error={item.error} /> : <DeletedItem deletion={deletion} />;
  }
  return (
    <div className="rf-stack">
      <h1>{`Delete ${item.data.item.title} permanently`}</h1>
      <DeleteDialog item={item.data.item} onDeleted={() => setDone(true)} />
    </div>
  );
}
