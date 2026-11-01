import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  releaseCslDocument, releaseExportDocument, releaseExportHtml, releasePackageManifest,
} from '@researchforce/domain/release-export';
import type { VersionCitation } from '@researchforce/domain/releases';
import { ApiFailure, useApi } from '../api';
import type { FieldIssue } from '../api';
import { usePersistentForm } from '../persist';
import type {
  ArtifactDrift, ReleaseArtifactView, ReleaseListView, ReleaseState, ReleaseView,
} from '../types';
import { Button, formatDate, LoadState, Notice, SaveFailure, TextField, useLoad } from '../ui';

/**
 * Research_Release screens (R59.1 to R59.5, R60.9). An Administrator creates a draft, preflights its captured artifacts, seals it, and then
 * publishes or withdraws it; a sealed release is read-only and answered with a successor for different contents. Every artifact carries its
 * version-specific Citation_Line, which a Member may copy or export to inert open formats offline. Nothing about an artifact the viewer cannot
 * read is shown: a hidden count stands in its place, and a withdrawn, superseded, or unavailable artifact shows only that it is unavailable,
 * never its title, hash, or kind leaked from a state the viewer may not see (R59.4).
 *
 * External repository/DOI deposit is a SEPARATE, EXPLICIT operator action (R59.5, R60.9). Publishing a release here routes its approved public
 * subset through the Publisher's normal gates; it deposits nothing in an external archive and mints no DOI. Depositing an export into an outside
 * repository, or registering a DOI, is done deliberately by an operator and makes a permanent external copy that this Workspace cannot recall.
 */

const STATE_LABELS: Readonly<Record<ReleaseState, string>> = { draft: 'Draft', sealed: 'Sealed', published: 'Published', withdrawn: 'Withdrawn' };
const STATE_TONES: Readonly<Record<ReleaseState, string>> = { draft: 'rf-status rf-status--warning', sealed: 'rf-status', published: 'rf-status rf-status--success', withdrawn: 'rf-status' };
const KIND_LABELS: Readonly<Record<string, string>> = { record: 'Record', attachment: 'File', citation: 'Citation', package: 'Compute package', provenance: 'Provenance' };
const DRIFT_LABELS: Readonly<Record<ArtifactDrift, string>> = { unchanged: 'Unchanged since sealing', changed: 'Changed since sealing', unavailable: 'Unavailable' };

function StateBadge({ state }: { readonly state: ReleaseState }) {
  return <span className={STATE_TONES[state]}>{STATE_LABELS[state]}</span>;
}

/** The field issues the form does not show against a named field, such as a whole-artifact rule. */
function unplaced(failure: unknown): readonly FieldIssue[] {
  return failure instanceof ApiFailure ? failure.fields : [];
}

/** The version-specific citation a view artifact carries, as the domain type (the API returns exactly this shape). */
function citationOf(artifact: ReleaseArtifactView): VersionCitation {
  return artifact.citation;
}

/* ----------------------------------------------------------------------------------------------- Citation copy and export */

/** Copy text to the clipboard where the browser allows it, telling the reader either way; never throws into the render. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

const BYTES = (text: string): number => new TextEncoder().encode(text).length;

/**
 * Build the four offline export files of a release's readable citations (R59.5): the structured JSON, the CSL-JSON array a reference manager
 * reads, the inert HTML list, and a package manifest naming each file with its byte length and content hash. The manifest's hashes are computed
 * from the same `crypto.subtle` digest the browser offers; the whole set is pure data, executes no code, and round-trips back to these citations.
 */
async function buildExports(release: { readonly id: string; readonly name: string }, citations: readonly VersionCitation[]): Promise<{ readonly path: string; readonly text: string; readonly type: string }[]> {
  const exportedAt = new Date().toISOString();
  const json = `${JSON.stringify(releaseExportDocument(release, exportedAt, citations), null, 2)}\n`;
  const csl = `${JSON.stringify(releaseCslDocument(citations), null, 2)}\n`;
  const html = releaseExportHtml(release, exportedAt, citations);
  const files = [
    { path: 'citations.json', text: json, type: 'application/json' },
    { path: 'citations.csl.json', text: csl, type: 'application/json' },
    { path: 'citations.html', text: html, type: 'text/html' },
  ];
  const digest = async (text: string): Promise<string> => {
    const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  };
  // The manifest records each file's hash; it must be built after the hashes are known, so it is assembled with the resolved digests.
  const hashes = new Map(await Promise.all(files.map(async (file) => [file.path, await digest(file.text)] as const)));
  const manifest = releasePackageManifest(release, files.map((file) => ({ path: file.path, text: file.text })), (text) => hashes.get(files.find((file) => file.text === text)!.path)!, BYTES);
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  return [...files, { path: 'manifest.json', text: manifestText, type: 'application/json' }];
}

/** Offer a built export file as a download without navigating away; a no-op where the DOM download API is unavailable. */
function downloadFile(file: { readonly path: string; readonly text: string; readonly type: string }): void {
  try {
    const url = URL.createObjectURL(new Blob([file.text], { type: file.type }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${file.path}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  } catch { /* downloading is a convenience; the citations are also shown on the page */ }
}

/**
 * One artifact's version-specific Citation_Line with copy-to-clipboard and offline export. Copy puts the exact line on the clipboard; the four
 * export buttons build inert open-format files (JSON, CSL-JSON, HTML, and a package manifest) from the release's readable citations and offer
 * each as a download. The export runs entirely in the browser and contacts no external service (R59.5, R60.9).
 */
export function CitationLine({ artifact }: { readonly artifact: ReleaseArtifactView }) {
  const [copied, setCopied] = useState(false);
  const line = artifact.citation.line;
  const copy = async () => { setCopied(await copyText(line)); };
  return (
    <div className="rf-citation">
      <p className="rf-citation-line">{line}</p>
      <div className="rf-actions">
        <Button variant="quiet" onClick={() => void copy()} label={`Copy the citation of ${artifact.identifier ?? KIND_LABELS[artifact.kind]}`}>Copy citation</Button>
        {copied && <span className="rf-meta" role="status">Copied to the clipboard.</span>}
      </div>
    </div>
  );
}

/** The release-wide export of every readable citation to inert open formats, offered as downloads (R59.5, R60.9). */
export function CitationExport({ release }: { readonly release: ReleaseView }) {
  const citations = useMemo(() => release.artifacts.map(citationOf), [release.artifacts]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const exportAll = async () => {
    setBusy(true);
    setDone(null);
    const files = await buildExports({ id: release.id, name: release.name }, citations);
    const wanted = new Set(['citations.json', 'citations.csl.json', 'citations.html', 'manifest.json']);
    for (const file of files) if (wanted.has(file.path)) downloadFile(file);
    setDone(`${files.length} file${files.length === 1 ? '' : 's'}`);
    setBusy(false);
  };
  if (citations.length === 0) return null;
  return (
    <section className="rf-section" aria-label="Export citations">
      <h2>Export citations</h2>
      <p className="rf-meta">Downloads the readable citations as open, offline files: a JSON document, a CSL-JSON array for reference managers, an inert HTML list, and a package manifest. The files run no code and open without this Workspace.</p>
      <div className="rf-actions">
        <Button variant="secondary" onClick={() => void exportAll()} disabled={busy}>Export all citations</Button>
        {done !== null && <span className="rf-meta" role="status">{`Exported ${done}.`}</span>}
      </div>
    </section>
  );
}

/** The standing note that external deposit is a separate, deliberate operator action with permanent-copy implications (R59.5, R60.9). */
export function DepositNote() {
  return (
    <Notice tone="neutral" title="External repository or DOI deposit is a separate step.">
      <p>Publishing a release here routes its approved public snapshot through the normal gates. It does not deposit anything in an external repository and mints no DOI. Depositing an export, or registering a DOI, is a deliberate operator action that makes a permanent external copy this Workspace cannot recall.</p>
    </Notice>
  );
}

/* ----------------------------------------------------------------------------------------------- Artifact and preflight display */

/** Whether a drafted/sealed artifact is clean for preflight: readable, unchanged since capture, and approved for the public subset it claims. */
function artifactFlags(artifact: ReleaseArtifactView): readonly string[] {
  const flags: string[] = [];
  if (artifact.drift === 'unavailable') flags.push('No longer available');
  else if (artifact.drift === 'changed') flags.push('Changed after it was captured');
  if (!artifact.publicApproved) flags.push('Not approved for the public snapshot');
  return flags;
}

/** The preflight summary of a draft: whether every readable artifact is unchanged and approved, so sealing may proceed (R59.5). */
function preflight(release: ReleaseView): { readonly clean: boolean; readonly reasons: readonly string[] } {
  const reasons: string[] = [];
  if (release.artifacts.length === 0) reasons.push('A release needs at least one artifact.');
  for (const artifact of release.artifacts) {
    if (artifact.drift !== 'unchanged') reasons.push(`${artifact.identifier ?? KIND_LABELS[artifact.kind]}: ${DRIFT_LABELS[artifact.drift].toLowerCase()}.`);
  }
  if (release.hiddenArtifacts > 0) reasons.push(`${release.hiddenArtifacts} artifact${release.hiddenArtifacts === 1 ? '' : 's'} you cannot see must be preflighted by someone who can.`);
  return { clean: reasons.length === 0, reasons };
}

function ArtifactRow({ artifact }: { readonly artifact: ReleaseArtifactView }) {
  const flags = artifactFlags(artifact);
  return (
    <li>
      <article className="rf-companion" aria-label={`Artifact ${artifact.identifier ?? KIND_LABELS[artifact.kind]}`}>
        <p>
          <span className="rf-status">{KIND_LABELS[artifact.kind] ?? artifact.kind}</span>{' '}
          {artifact.title ?? artifact.identifier ?? 'Untitled'}{artifact.revision !== null && ` (revision ${artifact.revision})`}
        </p>
        <p className="rf-meta">{`SHA-256 ${artifact.sha256}`}</p>
        <p className="rf-meta">
          <span className="rf-status">{DRIFT_LABELS[artifact.drift]}</span>
          {artifact.publicApproved ? ' · Approved for the public snapshot' : ' · Internal only'}
        </p>
        {flags.length > 0 && <p className="rf-field__error">{flags.join('. ')}.</p>}
        <CitationLine artifact={artifact} />
      </article>
    </li>
  );
}

/** The gap a viewer cannot see, shown as a count with no detail of what was hidden (R59.4). */
function HiddenArtifacts({ count }: { readonly count: number }) {
  if (count === 0) return null;
  return <p className="rf-meta" role="status">{`${count} artifact${count === 1 ? '' : 's'} you cannot see.`}</p>;
}

/* ----------------------------------------------------------------------------------------------- Mutations */

function useRelease(id: string) {
  const loaded = useLoad<{ release: ReleaseView }>(`/releases/${id}`);
  return loaded;
}

/** The draft-stage actions: re-capture artifacts, approve the manifest, and seal when preflight is clean (R59.1, R59.5). */
function DraftActions({ release, onChanged }: { readonly release: ReleaseView; readonly onChanged: () => void }) {
  const client = useApi();
  const [failure, setFailure] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const flight = preflight(release);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setFailure(undefined);
    try { await action(); onChanged(); } catch (error) { setFailure(error); } finally { setBusy(false); }
  };
  const recapture = () => run(() => client.patch(`/releases/${release.id}/artifacts`, { rev: release.snapshotSeq, artifacts: release.artifacts.map((artifact) => ({ kind: artifact.kind, unitId: artifact.unitId, publicApproved: artifact.publicApproved })) }));
  const approveManifest = () => run(() => client.post(`/releases/${release.id}/approvals`, { kind: 'administrator' }));
  const seal = () => run(async () => { await client.post(`/releases/${release.id}/seal`, { rev: release.snapshotSeq }); });
  return (
    <section className="rf-section" aria-label="Preflight and seal">
      <h2>Preflight</h2>
      <SaveFailure error={failure} />
      {unplaced(failure).length > 0 && <Notice tone="danger" title="Correct these before sealing:"><ul>{unplaced(failure).map((issue, index) => <li key={index}>{issue.rule}</li>)}</ul></Notice>}
      {flight.clean
        ? <Notice tone="success" title="Preflight is clean. Every readable artifact is unchanged and approved." />
        : <Notice tone="warning" title="Preflight found issues; sealing is blocked."><ul>{flight.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul></Notice>}
      <div className="rf-actions">
        <Button onClick={() => void recapture()} disabled={busy}>Re-capture artifacts</Button>
        <Button onClick={() => void approveManifest()} disabled={busy}>Approve the manifest</Button>
        <Button variant="primary" onClick={() => void seal()} disabled={busy || !flight.clean}>Seal the release</Button>
      </div>
      <p className="rf-meta">Sealing fixes the manifest for good; different contents need a successor release, not an edit.</p>
    </section>
  );
}

/** The sealed-stage actions: publish, withdraw, and open a successor draft (R59.2, R59.3). */
function SealedActions({ release, onChanged }: { readonly release: ReleaseView; readonly onChanged: () => void }) {
  const client = useApi();
  const navigate = useNavigate();
  const [failure, setFailure] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setFailure(undefined);
    try { await action(); onChanged(); } catch (error) { setFailure(error); } finally { setBusy(false); }
  };
  const publish = () => run(() => client.post(`/releases/${release.id}/publish`, { rev: release.snapshotSeq }));
  const withdraw = () => run(() => client.post(`/releases/${release.id}/withdraw`, { rev: release.snapshotSeq }));
  const successor = async () => {
    setBusy(true);
    setFailure(undefined);
    try {
      const { id } = await client.post<{ id: string }>(`/releases/${release.id}/successor`, {});
      void navigate(`/releases/${id}`);
    } catch (error) { setFailure(error); setBusy(false); }
  };
  return (
    <section className="rf-section" aria-label="Release actions">
      <h2>Actions</h2>
      <SaveFailure error={failure} />
      <div className="rf-actions">
        {release.state === 'sealed' && <Button variant="primary" onClick={() => void publish()} disabled={busy}>Publish</Button>}
        {release.state === 'published' && <Button variant="danger" onClick={() => void withdraw()} disabled={busy}>Withdraw</Button>}
        <Button variant="quiet" onClick={() => void successor()} disabled={busy}>Make a successor release</Button>
      </div>
      <p className="rf-meta">Publishing routes the approved public snapshot through the normal gates; withdrawal removes the public output within the usual removal window. A retained internal snapshot is not permission to keep serving it.</p>
    </section>
  );
}

/* ----------------------------------------------------------------------------------------------- Pages */

interface CreateState { readonly name: string; readonly scope: string; readonly rationale: string; readonly licenceVersion: string }

/** `/releases/new`: create a Research_Release draft, then open its preflight page (R59.1). */
export function NewReleasePage() {
  const client = useApi();
  const navigate = useNavigate();
  const form = usePersistentForm<CreateState>('release:new', () => ({ name: '', scope: '', rationale: '', licenceVersion: '' }));
  const [failure, setFailure] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const errors = failure instanceof ApiFailure ? failure.fields : [];
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFailure(undefined);
    try {
      const { id } = await client.post<{ id: string }>('/releases', { name: form.values.name, scope: form.values.scope, rationale: form.values.rationale, licenceVersion: form.values.licenceVersion });
      form.sent();
      void navigate(`/releases/${id}`);
    } catch (error) { setFailure(error); setBusy(false); }
  };
  return (
    <form className="rf-stack" onSubmit={(event) => void submit(event)} noValidate>
      <h1>New research release</h1>
      <p className="rf-meta">A release captures an exact research state and the evidence it used. It begins as a draft; you preflight and approve it before sealing.</p>
      <SaveFailure error={failure} />
      <TextField label="Name" required value={form.values.name} onChange={(value) => form.set('name', value)} maxLength={200} errors={errors.filter((issue) => issue.field === 'name')} />
      <TextField label="Scope" multiline required value={form.values.scope} onChange={(value) => form.set('scope', value)} maxLength={5000} hint="What this release covers." errors={errors.filter((issue) => issue.field === 'scope')} />
      <TextField label="Rationale" multiline required value={form.values.rationale} onChange={(value) => form.set('rationale', value)} maxLength={20000} hint="Why it is being made." errors={errors.filter((issue) => issue.field === 'rationale')} />
      <TextField label="Content-licence version" required value={form.values.licenceVersion} onChange={(value) => form.set('licenceVersion', value)} maxLength={100} errors={errors.filter((issue) => issue.field === 'licenceVersion')} />
      <div className="rf-actions">
        <Button type="submit" variant="primary" disabled={busy}>Create the draft</Button>
        <Link className="rf-button rf-button--quiet" to="/releases">Cancel</Link>
      </div>
    </form>
  );
}

/** `/releases`: the Administrator's list of releases, newest first, with a link to create one (R59.1). */
export function ReleasesListPage() {
  const page = useLoad<ReleaseListView>('/releases');
  if (!page.data) return <LoadState error={page.error} />;
  const releases = page.data.releases;
  return (
    <div className="rf-stack">
      <h1>Research releases</h1>
      <div className="rf-actions"><Link className="rf-button rf-button--primary" to="/releases/new">New release</Link></div>
      {releases.length === 0 ? <p className="rf-meta">No release has been created.</p> : (
        <ul className="rf-list">
          {releases.map((release) => (
            <li key={release.id}>
              <article className="rf-companion" aria-label={`Release ${release.name}`}>
                <p><Link to={`/releases/${release.id}`}>{release.name}</Link>{' '}<StateBadge state={release.state} /></p>
                <p className="rf-meta">
                  {release.sealedAt !== null ? `Sealed ${formatDate(release.sealedAt)}` : `Snapshot ${formatDate(release.snapshotAt)}`}
                  {release.publishedAt !== null && ` · Published ${formatDate(release.publishedAt)}`}
                  {release.withdrawnAt !== null && ` · Withdrawn ${formatDate(release.withdrawnAt)}`}
                </p>
              </article>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** `/releases/:id`: one release, its artifacts with drift and citations, preflight or sealed actions, export, and the deposit note (R59.1 to R59.5). */
export function ReleasePage({ id }: { readonly id: string }) {
  const loaded = useRelease(id);
  if (!loaded.data) return <LoadState error={loaded.error} />;
  const release = loaded.data.release;
  const draft = release.state === 'draft';
  return (
    <div className="rf-stack">
      <h1>{release.name}</h1>
      <p><StateBadge state={release.state} />{` · Content licence ${release.licenceVersion}`}</p>
      {release.predecessorId !== null && <p className="rf-meta">{'Succeeds '}<Link to={`/releases/${release.predecessorId}`}>an earlier release</Link>.</p>}
      {release.scope !== undefined && (
        <section className="rf-section" aria-label="Scope and rationale">
          <h2>Scope</h2>
          <p>{release.scope}</p>
          <h2>Rationale</h2>
          <p>{release.rationale}</p>
        </section>
      )}
      {release.manifestHash !== null && (
        <section className="rf-section" aria-label="Manifest">
          <h2>Manifest</h2>
          <p className="rf-meta">{`Manifest hash ${release.manifestHash}`}</p>
          {release.publicManifestHash !== null && <p className="rf-meta">{`Public manifest hash ${release.publicManifestHash}`}</p>}
        </section>
      )}
      <section className="rf-section" aria-label="Artifacts">
        <h2>Artifacts</h2>
        {release.artifacts.length === 0 && release.hiddenArtifacts === 0
          ? <p className="rf-meta">This release has no artifacts yet.</p>
          : <ul className="rf-list">{release.artifacts.map((artifact) => <ArtifactRow key={`${artifact.kind}:${artifact.unitId}`} artifact={artifact} />)}</ul>}
        <HiddenArtifacts count={release.hiddenArtifacts} />
      </section>
      <CitationExport release={release} />
      {draft
        ? <DraftActions release={release} onChanged={loaded.reload} />
        : <SealedActions release={release} onChanged={loaded.reload} />}
      <DepositNote />
    </div>
  );
}
