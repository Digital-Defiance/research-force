import { useState } from 'react';
import { ApiFailure, useApi } from '../api';
import { Button, Notice, formatDate, useLoad } from '../ui';
interface PublisherState {
  readonly blocked: 'frozen' | 'site_too_large' | null;
  readonly run: { readonly phase: string; readonly startedAt: string } | null;
  readonly queued: boolean;
  readonly lastRun: { readonly startedAt: string | null; readonly finishedAt: string | null; readonly verifiedAt: string | null } | null;
}
const BLOCKED_TEXT = {
  frozen: 'Publishing is paused for a backup or restore. Try again when it has finished.',
  site_too_large: 'The public site is over its size limit, so it cannot be rebuilt here.',
} as const;
/** Why a refused request did not publish, in words about publishing (the generic save failure wording does not fit). */
function refusal(error: unknown): string {
  if (error instanceof ApiFailure) {
    if (error.code === 'frozen') return BLOCKED_TEXT.frozen;
    if (error.code === 'daily_limit') return 'Publishing is unavailable until 00:00 UTC because a daily limit of the hosting platform was reached.';
    if ((error.details as { reason?: string } | undefined)?.reason === 'site_too_large') return BLOCKED_TEXT.site_too_large;
    if (error.code === 'forbidden') return 'Your Role does not permit publishing.';
  }
  return 'The publish could not be requested. Nothing was changed. Try again in a moment.';
}
const lastResult = (run: NonNullable<PublisherState['lastRun']>): string => {
  const started = run.startedAt === null ? 'unknown time' : formatDate(run.startedAt);
  if (run.finishedAt === null) return `The last publish started ${started} and has not finished.`;
  const finished = `The last publish started ${started} and finished ${formatDate(run.finishedAt)}`;
  return run.verifiedAt === null ? `${finished}, not yet verified.` : `${finished}, verified ${formatDate(run.verifiedAt)}.`;
};
/** The Administrator's "Publish now": asks the Publisher to rebuild the public site and shows what it reports. */
export function PublishNow() {
  const client = useApi();
  const state = useLoad<PublisherState>('/publisher');
  const [busy, setBusy] = useState(false);
  const [requested, setRequested] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const data = state.data;
  const request = async () => {
    setBusy(true); setFailure(undefined); setRequested(false);
    try {
      await client.post('/publisher/republish');
      setRequested(true);
    } catch (error) {
      setFailure(refusal(error));
    } finally {
      setBusy(false);
      state.reload();
    }
  };
  return (
    <section className="rf-section" aria-label="Publish now">
      <h3>Publish now</h3>
      <p className="rf-meta">Rebuild the public site from what is already saved. No research, project or publish setting changes.</p>
      {state.error !== undefined && <Notice tone="danger" title="The publishing status could not be loaded." />}
      {data?.blocked != null && <Notice tone="neutral" title={BLOCKED_TEXT[data.blocked]} />}
      {data?.run != null && <p role="status">{`A publish is running (phase: ${data.run.phase}, started ${formatDate(data.run.startedAt)}).`}</p>}
      {data !== undefined && data.run === null && data.lastRun !== null && <p className="rf-meta">{lastResult(data.lastRun)}</p>}
      {data !== undefined && data.run === null && data.lastRun === null && <p className="rf-meta">No publish has been recorded yet.</p>}
      {requested && <Notice tone="success" title="A publish was requested. The public site usually updates within a minute." />}
      {failure !== undefined && <Notice tone="warning" title={failure} />}
      <div className="rf-actions">
        <Button variant="primary" onClick={() => void request()} disabled={busy || data === undefined || data.blocked !== null || data.run !== null}>Publish now</Button>
      </div>
    </section>
  );
}
