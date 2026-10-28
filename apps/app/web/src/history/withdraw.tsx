import { useState } from 'react';
import { Link } from 'react-router';
import { ApiFailure, useApi } from '../api';
import type { ItemView } from '../types';
import { Button, LoadState, Notice, SaveFailure, TextField, useLoad } from '../ui';

/** What the Public_Site will do with the reason, as the preview stated it (R24.10). */
export function publicReasonStatement(reasonPublic: boolean): string {
  return reasonPublic
    ? 'The Public Site shows this record, so it will show the withdrawal date and this reason.'
    : 'The Public Site does not show this record, so it will not show this reason. Members see the withdrawal date and reason.';
}

/**
 * Withdraw a Research_Item with a reason of 1 to 1,000 characters. The Member first sees whether the Public_Site will
 * show the reason, then confirms; the record, its history, and its Disclosure_Level stay (R5.5, R22.6, R24.10).
 */
export function WithdrawDialog({ item, onWithdrawn }: { readonly item: ItemView; readonly onWithdrawn: () => void }) {
  const client = useApi();
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<{ reason: string; reasonPublic: boolean } | undefined>(undefined);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const send = async (confirm: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      const body = { rev: item.rev, reason, ...(confirm && preview ? { confirm: { reasonPublic: preview.reasonPublic } } : {}) };
      const result = await client.post<{ withdrawn: boolean; preview: { reasonPublic: boolean } }>(`/items/${item.id}/withdraw`, body);
      if (result.withdrawn) onWithdrawn();
      else {
        setPreview({ reason, reasonPublic: result.preview.reasonPublic });
        setStale(false);
      }
    } catch (failure) {
      if (failure instanceof ApiFailure && failure.code === 'preview_stale') {
        setPreview({ reason, reasonPublic: (failure.details as { reasonPublic: boolean }).reasonPublic });
        setStale(true);
      } else setError(failure);
    } finally {
      setBusy(false);
    }
  };
  if (item.withdrawal !== null) return <Notice tone="warning" title="This record is already withdrawn." />;
  const fields = error instanceof ApiFailure ? error.issuesFor('reason') : [];
  const checked = preview !== undefined && preview.reason === reason;
  return (
    <section className="rf-stack" role="dialog" aria-label="Withdraw">
      <p>The record, its history, and its disclosure level stay. Members see that it was withdrawn, when, and why.</p>
      <TextField label="Reason for withdrawing" value={reason} onChange={setReason} multiline required maxLength={1000} errors={fields} hint="1 to 1,000 characters." />
      {checked && (
        <Notice tone={preview.reasonPublic ? 'warning' : 'neutral'} title={stale ? 'The record’s disclosure changed. Check the statement again.' : 'What the Public Site will show'}>
          <p>{publicReasonStatement(preview.reasonPublic)}</p>
        </Notice>
      )}
      <SaveFailure error={fields.length > 0 ? undefined : error} />
      <div className="rf-actions">
        {checked
          ? <Button variant="danger" onClick={() => void send(true)} disabled={busy}>Withdraw</Button>
          : <Button variant="primary" onClick={() => void send(false)} disabled={busy}>Continue</Button>}
        <Link className="rf-button rf-button--quiet" to={`/items/${item.id}`}>Cancel</Link>
      </div>
    </section>
  );
}

export function WithdrawPage({ id }: { readonly id: string }) {
  const item = useLoad<{ item: ItemView }>(`/items/${id}`);
  const [done, setDone] = useState(false);
  if (!item.data) return <LoadState error={item.error} />;
  return (
    <div className="rf-stack">
      <h1>{`Withdraw ${item.data.item.title}`}</h1>
      {done
        ? <Notice tone="success" title="The record was withdrawn."><p><Link to={`/items/${id}`}>Back to the record</Link></p></Notice>
        : <WithdrawDialog item={item.data.item} onWithdrawn={() => setDone(true)} />}
    </div>
  );
}
