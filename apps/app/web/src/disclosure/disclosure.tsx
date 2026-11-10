import { useState } from 'react';
import type { ReactNode } from 'react';
import type { RichText } from '@researchforce/domain/richtext';
import { ApiFailure, useApi } from '../api';
import { useSession } from '../session';
import { RichTextView } from '../editor/RichTextView';
import type { MemberRow } from '../types';
import type {
  ConsentValuesView, DisclosureChangedView, DisclosureDissentListing, DisclosureGateFailure, DisclosureLicenceState,
  DisclosurePreviewDiff, DisclosurePreviewView, DisclosurePublicView, PreviewJobView,
} from '../types';
import { Button, formatDate, levelName, Notice, PersonLink, SaveFailure, SelectField, TextField } from '../ui';
import { disclosureLineBody, DisclosureLineFields, emptyDisclosureLine } from './line';
import type { DisclosureLineValue } from './line';
import { PublicSummaryEditor } from './public-summary';

/** The most units one disclosure change can carry; the kernel's `MAX_CHANGE_UNITS` (R26.7). */
export const MAX_CHANGE_UNITS = 1000;

/** Summary_Only or Full_Content, as the preview and proposals name them. */
const PRESENTATION_NAMES: Readonly<Record<string, string>> = { summary_only: 'Summary only', full_content: 'Full content' };
export const presentationName = (value: string): string => PRESENTATION_NAMES[value] ?? value;

const isRich = (value: unknown): value is RichText => typeof value === 'object' && value !== null && 'text' in value;

/** The exact values a change or Publication_Proposal applies to one Disclosure_Unit, as plain lines (R23.18, R23.20). */
export function ConsentValues({ values }: { readonly values: ConsentValuesView }) {
  const summary = isRich(values.publicSummary) ? values.publicSummary.text : undefined;
  const line = values.disclosureLine === undefined ? undefined : JSON.stringify(values.disclosureLine);
  return (
    <ul className="rf-list">
      <li>{`Disclosure level: ${levelName(values.level)}`}</li>
      {values.presentation !== undefined && <li>{`Public presentation: ${presentationName(values.presentation)}`}</li>}
      {summary !== undefined && summary.trim() !== '' && <li>{`Public summary: ${summary}`}</li>}
      {line !== undefined && <li>{`Disclosure line: ${line}`}</li>}
    </ul>
  );
}

/** One active Confidentiality_Hold with its placer, time, and note (R48.5). */
export function HoldLine({ hold, members }: { readonly hold: { readonly id: string; readonly memberId: string; readonly placedAt: string; readonly note: string }; readonly members: readonly MemberRow[] }) {
  const member = members.find((candidate) => candidate.id === hold.memberId);
  return (
    <li>
      {'Held by '}<PersonLink person={{ id: hold.memberId, displayName: member?.displayName ?? null }} />{` on ${formatDate(hold.placedAt)}`}
      {hold.note.trim() !== '' && <>{': '}{hold.note}</>}
    </li>
  );
}

/** One change entry the dialog previews: a Disclosure_Unit key and the values to publish. */
export interface UnitChange {
  readonly key: string;
  readonly level?: string;
  readonly presentation?: string;
  readonly publicSummary?: RichText | null;
  readonly disclosureLine?: Readonly<Record<string, unknown>> | null;
}
export const changeUnitBody = (change: UnitChange) => ({
  key: change.key,
  ...(change.level === undefined ? {} : { level: change.level }),
  ...(change.presentation === undefined ? {} : { presentation: change.presentation }),
  ...(change.publicSummary === undefined ? {} : { publicSummary: change.publicSummary }),
  ...(change.disclosureLine === undefined ? {} : { disclosureLine: change.disclosureLine }),
});

/** The Consenting_Member of each `owner_consent` failure, so the proposal offer names them (R23.17). */
function consentFailures(failures: readonly DisclosureGateFailure[]): DisclosureGateFailure[] {
  return failures.filter((failure) => failure.reason === 'owner_consent');
}
function holdFailures(failures: readonly DisclosureGateFailure[]): DisclosureGateFailure[] {
  return failures.filter((failure) => failure.reason === 'hold');
}

/** How a Public_View reads in the preview: its own page for a Public unit, or a Disclosure_Line for a Withheld one (R23.6, R24.4). */
function viewLabel(view: DisclosurePublicView | undefined): ReactNode {
  if (view === undefined) return 'Not shown on the public site.';
  if (view.tag === 'withheld') {
    const line = view.line;
    const parties = line && line.parties.length > 0 ? `; parties: ${line.parties.join(', ')}` : '';
    return line ? `Disclosure line only — ${line.kindOfMaterial}${line.note ? ` (${line.note})` : ''}${parties}` : 'Disclosure line only.';
  }
  const title = typeof view.title === 'string' ? view.title : view.identifier ?? view.key;
  return `Shown on the public site: ${title}`;
}

/** The Public_Views the change alters, each with its view before and after (R23.6). */
export function ChangedViews({ changed }: { readonly changed: readonly DisclosureChangedView[] }) {
  if (changed.length === 0) return <p className="rf-meta">This change alters no public view.</p>;
  return (
    <section className="rf-section" aria-label="Changed public views">
      <h3>Public views this changes</h3>
      <ul className="rf-list">
        {changed.map((entry) => (
          <li key={entry.key}>
            <p className="rf-meta">{'Now: '}{viewLabel(entry.before)}</p>
            <p>{'After: '}{viewLabel(entry.after)}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The Party names the resulting Public_Views would show (R23.6). */
export function PartyNames({ names }: { readonly names: readonly string[] }) {
  return (
    <section className="rf-section" aria-label="Party names shown">
      <h3>Party names newly shown</h3>
      {names.length === 0 ? <p className="rf-meta">No Party name is newly shown.</p> : <ul className="rf-list">{names.map((name) => <li key={name}>{name}</li>)}</ul>}
    </section>
  );
}

/** The Dissent_Notes on a Log_Summary the change presents that would not themselves be Public (R23.16). */
export function DissentNotesPreview({ dissent, members }: { readonly dissent: readonly DisclosureDissentListing[]; readonly members: readonly MemberRow[] }) {
  if (dissent.length === 0) return null;
  const withNotes = dissent.filter((entry) => entry.notes.length > 0);
  return (
    <section className="rf-section" aria-label="Dissent notes not public">
      <h3>Dissent notes that will not be public</h3>
      {withNotes.length === 0 ? <p className="rf-meta">No Dissent Note on the shown Log Summaries would stay off the public site.</p> : (
        <ul className="rf-list">
          {withNotes.flatMap((entry) => entry.notes.map((note) => (
            <li key={note.key}>
              <p className="rf-meta">{'By '}<PersonLink person={{ id: note.authorId, displayName: note.author === '' ? (members.find((m) => m.id === note.authorId)?.displayName ?? null) : note.author }} />{` — ${levelName(note.effective)}`}</p>
              <RichTextView value={note.text} />
            </li>
          )))}
        </ul>
      )}
    </section>
  );
}

/** The credited Members and whether each has a Licence_Agreement for the current Content_Licence (R46.16). */
export function LicenceStates({ licences }: { readonly licences: readonly DisclosureLicenceState[] }) {
  if (licences.length === 0) return null;
  return (
    <section className="rf-section" aria-label="Licence agreement states">
      <h3>Credited members’ licence agreements</h3>
      <ul className="rf-list">
        {licences.map((licence) => (
          <li key={licence.memberId}>
            <PersonLink person={{ id: licence.memberId, displayName: licence.displayName }} />
            {': '}<span className={licence.agreed ? 'rf-status rf-status--success' : 'rf-status rf-status--warning'}>{licence.agreed ? 'Has a licence agreement' : 'No licence agreement'}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The full preview of a disclosure change: the changed views, Party names, Dissent_Notes, and Licence_Agreement states (R23.6, R23.16, R46.16). */
export function PreviewSummary({ diff, members }: { readonly diff: DisclosurePreviewDiff; readonly members: readonly MemberRow[] }) {
  return (
    <>
      <ChangedViews changed={diff.changed ?? []} />
      <PartyNames names={diff.partyNames ?? []} />
      <DissentNotesPreview dissent={diff.dissent ?? []} members={members} />
      <LicenceStates licences={diff.licences ?? []} />
    </>
  );
}

/** A `withheld` offer on a gate failure: re-preview the change as Withheld with a Disclosure_Line instead (R23.6, R33.7, R34.2). */
function WithheldOffer({ failures, onWithhold }: { readonly failures: readonly DisclosureGateFailure[]; readonly onWithhold: (line: Readonly<Record<string, unknown>>) => void }) {
  const [open, setOpen] = useState(false);
  const [line, setLine] = useState<DisclosureLineValue>(emptyDisclosureLine);
  const offered = failures.filter((failure) => failure.offerWithheld);
  if (offered.length === 0) return null;
  return (
    <section className="rf-section" aria-label="Apply as Withheld instead">
      <Notice tone="warning" title="This cannot be made Public, but it can be Withheld with a Disclosure line instead:">
        <ul className="rf-list">{offered.map((failure, index) => <li key={index}>{failure.message}</li>)}</ul>
      </Notice>
      {!open ? <Button onClick={() => setOpen(true)}>Apply as Withheld instead</Button> : (
        <div className="rf-stack">
          <DisclosureLineFields value={line} onChange={setLine} />
          <div className="rf-actions">
            <Button variant="primary" onClick={() => onWithhold(disclosureLineBody(line))}>Check the Withheld change</Button>
            <Button variant="quiet" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Change one or many Disclosure_Units' publication values: preview the change, show the full diff (changed views, Party
 * names, Dissent_Notes that will not be Public, credited Members' Licence_Agreement states) and any gate failures, apply
 * the previewed change with its token, offer a Withheld fallback on a blocking failure, offer the Consenting_Member(s) a
 * Publication_Proposal on an `owner_consent` failure, and show a covering Confidentiality_Hold (R23.6, R23.16, R23.17,
 * R23.18, R33.7, R34.2, R46.16, R48.4, R48.5). A change above a few hundred units runs as a job the dialog polls and pages.
 */
export function DisclosureDialog({ title, units, members, onCancel, onProposed, onApplied }: {
  readonly title: string;
  readonly units: readonly UnitChange[];
  readonly members: readonly MemberRow[];
  readonly onCancel: () => void;
  readonly onProposed: () => void;
  /** Present when the change can be applied directly (not only proposed); called once the apply commits. */
  readonly onApplied?: () => void;
}) {
  const client = useApi();
  const [preview, setPreview] = useState<DisclosurePreviewView | undefined>(undefined);
  const [page, setPage] = useState<{ index: number; pages: number; jobId: string } | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<number | undefined>(undefined);
  const [applied, setApplied] = useState(false);
  /** A Withheld fallback the Member chose instead of the original values: every unit becomes Withheld with this line. */
  const [withheld, setWithheld] = useState<readonly UnitChange[] | undefined>(undefined);

  const current = withheld ?? units;

  const run = async (step: () => Promise<void>) => {
    setBusy(true);
    setFailure(undefined);
    try {
      await step();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  };

  /** Poll a large preview job until it completes, then read its first page of changed views. */
  const pollJob = async (jobId: string): Promise<void> => {
    for (;;) {
      const view = await client.get<PreviewJobView>(`/disclosure/preview/jobs/${jobId}?page=0`);
      if (view.state === 'failed') throw new ApiFailure(0, 'internal');
      if (view.state === 'complete' && view.diff) {
        setPreview({ diff: view.diff, failures: view.failures ?? [], token: view.token ?? null, holds: [] });
        setPage({ index: view.page ?? 0, pages: view.pages ?? 1, jobId });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  };

  const check = (changes: readonly UnitChange[]) => run(async () => {
    setSent(undefined);
    setApplied(false);
    setPage(undefined);
    const result = await client.post<DisclosurePreviewView>('/disclosure/preview', { units: changes.map(changeUnitBody) });
    if (result.job !== undefined) { await pollJob(result.job.id); return; }
    setPreview(result);
  });

  const loadPage = (jobId: string, index: number) => run(async () => {
    const view = await client.get<PreviewJobView>(`/disclosure/preview/jobs/${jobId}?page=${index}`);
    if (view.diff) {
      setPreview((prev) => (prev ? { ...prev, diff: view.diff!, token: view.token ?? prev.token, failures: view.failures ?? prev.failures } : prev));
      setPage({ index: view.page ?? index, pages: view.pages ?? 1, jobId });
    }
  });

  const apply = (token: string) => run(async () => {
    await client.post('/disclosure/apply', { token });
    setApplied(true);
    onApplied?.();
  });

  const sendProposals = () => run(async () => {
    const result = await client.post<{ proposals: readonly string[] }>('/reviews/proposals', {
      units: current.map(changeUnitBody),
      ...(note.trim() === '' ? {} : { note }),
    });
    setSent(result.proposals.length);
    onProposed();
  });

  /** Re-preview the current units as Withheld with the Member's Disclosure_Line (R34.2, R33.7). */
  const applyAsWithheld = (line: Readonly<Record<string, unknown>>) => {
    const next = units.map((unit) => ({ key: unit.key, level: 'withheld', disclosureLine: line }));
    setWithheld(next);
    void check(next);
  };

  const consents = preview === undefined ? [] : consentFailures(preview.failures);
  const holds = preview === undefined ? [] : holdFailures(preview.failures);
  const otherFailures = preview === undefined ? [] : preview.failures.filter((f) => f.reason !== 'owner_consent' && f.reason !== 'hold');
  const consentingMembers = [...new Set(consents.flatMap((failure) => (failure.memberId === undefined ? [] : [failure.memberId])))];
  const canApply = onApplied !== undefined && preview !== undefined && preview.failures.length === 0 && preview.token !== null;

  if (applied) {
    return (
      <section className="rf-section" role="dialog" aria-label={title}>
        <h2>{title}</h2>
        <Notice tone="success" title="The change was applied." />
        <div className="rf-actions"><Button variant="quiet" onClick={onCancel}>Close</Button></div>
      </section>
    );
  }

  return (
    <section className="rf-section" role="dialog" aria-label={title}>
      <h2>{title}</h2>
      {withheld !== undefined && <Notice tone="neutral" title="Previewing this change as Withheld with a Disclosure line." />}
      <SaveFailure error={failure} />
      {sent !== undefined && (
        <Notice tone="success" title={sent === 1 ? 'A Publication Proposal was sent to the Consenting Member.' : `${sent} Publication Proposals were sent.`}>
          <p>Each addressed Member can approve or decline it from their review queue.</p>
        </Notice>
      )}
      {preview !== undefined && sent === undefined && (
        <>
          {preview.failures.length === 0
            ? <Notice tone="success" title={onApplied !== undefined ? 'This change can be applied.' : 'This change can be applied with no Owner consent needed.'} />
            : <Notice tone="warning" title="This change cannot be applied yet, so none of it is applied." />}
          <PreviewSummary diff={preview.diff} members={members} />
          {page !== undefined && page.pages > 1 && (
            <div className="rf-actions" aria-label="Preview pages">
              <Button disabled={busy || page.index === 0} onClick={() => loadPage(page.jobId, page.index - 1)}>Previous page</Button>
              <span className="rf-meta">{`Page ${page.index + 1} of ${page.pages}`}</span>
              <Button disabled={busy || page.index >= page.pages - 1} onClick={() => loadPage(page.jobId, page.index + 1)}>Next page</Button>
            </div>
          )}
          {otherFailures.length > 0 && (
            <Notice tone="danger" title="These stop the change:">
              <ul className="rf-list">{otherFailures.map((f, index) => <li key={index}>{f.message}{f.details && f.details.length > 0 && <ul className="rf-list">{f.details.map((detail, at) => <li key={at}>{detail}</li>)}</ul>}</li>)}</ul>
            </Notice>
          )}
          <WithheldOffer failures={preview.failures} onWithhold={applyAsWithheld} />
          {holds.length > 0 && (
            <section className="rf-section" aria-label="Confidentiality holds">
              <Notice tone="warning" title="A Confidentiality Hold covers part of this change:">
                <ul className="rf-list">{preview.holds.map((hold) => <HoldLine key={hold.id} hold={hold} members={members} />)}</ul>
                {holds.map((f, index) => <p key={index}>{f.message}</p>)}
              </Notice>
            </section>
          )}
          {consents.length > 0 && (
            <section className="rf-section" aria-label="Owner consent needed">
              <Notice tone="warning" title="The Owner’s consent is needed to publish this, so you can offer them a Publication Proposal:">
                <ul className="rf-list">
                  {consents.map((f, index) => (
                    <li key={index}>
                      {f.memberId === undefined ? f.message : <>{f.message} (<PersonLink person={{ id: f.memberId, displayName: members.find((m) => m.id === f.memberId)?.displayName ?? null }} />)</>}
                    </li>
                  ))}
                </ul>
              </Notice>
              <p className="rf-meta">
                {consentingMembers.length === 1
                  ? 'A Publication Proposal with these values is addressed to the Consenting Member by name.'
                  : 'One Publication Proposal with these values is addressed to each Consenting Member by name.'}
              </p>
              <TextField label="Note to the Consenting Member" multiline value={note} onChange={setNote} maxLength={2000} hint="Optional; at most 2,000 characters." />
              <div className="rf-actions">
                <Button variant="primary" onClick={() => void sendProposals()} disabled={busy}>Send a Publication Proposal</Button>
              </div>
            </section>
          )}
          {canApply && (
            <div className="rf-actions">
              <Button variant="primary" onClick={() => apply(preview.token!)} disabled={busy}>Apply this change</Button>
            </div>
          )}
        </>
      )}
      <div className="rf-actions">
        <Button onClick={() => void check(current)} disabled={busy}>Check what this changes</Button>
        <Button variant="quiet" onClick={onCancel}>Close</Button>
      </div>
    </section>
  );
}

export const LEVEL_OPTIONS = [
  { value: 'not_published', label: 'Not published' },
  { value: 'withheld', label: 'Withheld' },
  { value: 'public', label: 'Public' },
];
const PRESENTATION_OPTIONS = [
  { value: 'summary_only', label: 'Summary only' },
  { value: 'full_content', label: 'Full content' },
];

/**
 * The Administrator affordance on an Item page to change the Item's own Disclosure_Level, Public_Presentation, and (when
 * widening) its Public_Summary and, for Withheld, its Disclosure_Line, then preview and apply the change. The preview
 * offers a Publication_Proposal on an Owner-consent failure, a Withheld fallback on a blocking failure, and shows a
 * covering Confidentiality_Hold (R23.6, R23.17, R23.18, R41.13). Only an Administrator with `disclosure.set` sees it.
 */
export function DisclosureChange({ itemId, level, presentation, publicSummary, logSummary, members, onProposed, onApplied }: {
  readonly itemId: string;
  readonly level: string;
  readonly presentation?: string;
  /** The Item's current Public_Summary, so the editor pre-fills from it or from the Log_Summary when empty (R41.13). */
  readonly publicSummary?: RichText;
  readonly logSummary?: RichText;
  readonly members: readonly MemberRow[];
  readonly onProposed: () => void;
  readonly onApplied?: () => void;
}) {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const [nextLevel, setNextLevel] = useState(level);
  const [nextPresentation, setNextPresentation] = useState(presentation ?? 'summary_only');
  const [summary, setSummary] = useState<RichText | undefined>(undefined);
  const [line, setLine] = useState<DisclosureLineValue>(emptyDisclosureLine);
  if (!session.can('disclosure.set')) return null;

  const change: UnitChange = {
    key: `u:${itemId}`,
    level: nextLevel,
    ...(nextLevel === 'public' ? { presentation: nextPresentation } : {}),
    ...(nextLevel === 'public' && summary !== undefined ? { publicSummary: summary } : {}),
    ...(nextLevel === 'withheld' ? { disclosureLine: disclosureLineBody(line) } : {}),
  };
  return (
    <section className="rf-section" aria-label="Change disclosure">
      <h2>Change disclosure</h2>
      {!open && <Button onClick={() => setOpen(true)}>Change disclosure</Button>}
      {open && (
        <div className="rf-stack">
          <SelectField label="Disclosure level" value={nextLevel} options={LEVEL_OPTIONS} onChange={setNextLevel} />
          {nextLevel === 'public' && <SelectField label="Public presentation" value={nextPresentation} options={PRESENTATION_OPTIONS} onChange={setNextPresentation} />}
          {nextLevel === 'public' && (
            <PublicSummaryEditor
              value={summary}
              {...(publicSummary === undefined ? {} : { publicSummary })}
              {...(logSummary === undefined ? {} : { logSummary })}
              members={members}
              onChange={setSummary}
            />
          )}
          {nextLevel === 'withheld' && <DisclosureLineFields value={line} onChange={setLine} />}
          <DisclosureDialog
            key={`${nextLevel}:${nextPresentation}`}
            title="Change disclosure"
            units={[change]}
            members={members}
            onCancel={() => setOpen(false)}
            onProposed={onProposed}
            {...(onApplied === undefined ? {} : { onApplied })}
          />
        </div>
      )}
    </section>
  );
}
