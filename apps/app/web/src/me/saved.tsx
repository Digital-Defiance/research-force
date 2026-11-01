import { useState } from 'react';
import { Link } from 'react-router';
import { useApi } from '../api';
import type { BookmarkView, FollowView, SavedSearchFilters, SavedSearchView, SearchResultView } from '../types';
import { Button, LoadState, Notice, TextField, useLoad } from '../ui';

/**
 * Bookmark, Saved_Search and Follow management (R58.2, R58.3, R58.4). These are a Member's own working
 * aids, visible only to them. The screen lists each in the Member's chosen order and lets them rename,
 * reorder, delete, and (for a Saved_Search) rerun it through their current authorization.
 *
 * Saved navigation can lose access. When the record a Bookmark or Follow points at is deleted or the
 * Member can no longer read it, the entry is not quietly dropped and never names what it now is: it
 * keeps its place as a neutral unavailable entry, so the Member sees that they saved something without
 * learning anything hidden (R58.4). A Saved_Search holds the query the Member wrote and never a stored
 * result, so rerunning it returns only what the Member may currently read.
 */

/** Move an entry up or down one place by rewriting the whole order (R58.2). */
function reordered(ids: readonly string[], id: string, delta: number): string[] {
  const from = ids.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) return [...ids];
  const next = [...ids];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

/** One Bookmark: its name and order controls, and a link to its target or, for a lost one, a neutral note (R58.2, R58.4). */
function BookmarkRow({ bookmark, index, count, onReorder, onReload }: {
  readonly bookmark: BookmarkView; readonly index: number; readonly count: number; readonly onReorder: (delta: number) => void; readonly onReload: () => void;
}) {
  const client = useApi();
  const [name, setName] = useState(bookmark.name);
  const [renaming, setRenaming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const act = async (run: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try { await run(); } catch (failure) { setError(failure); } finally { setBusy(false); }
  };
  const rename = () => act(async () => { await client.patch(`/me/bookmarks/${bookmark.id}`, { name }); setRenaming(false); onReload(); });
  const remove = () => act(async () => { await client.delete(`/me/bookmarks/${bookmark.id}`); onReload(); });
  return (
    <li>
      <article className="rf-companion" aria-label={`Bookmark: ${bookmark.name}`}>
        {renaming ? (
          <div className="rf-stack">
            <TextField label="Bookmark name" value={name} onChange={setName} maxLength={100} required />
            <div className="rf-actions">
              <Button variant="primary" onClick={() => void rename()} disabled={busy}>Save name</Button>
              <Button variant="quiet" onClick={() => { setName(bookmark.name); setRenaming(false); }} disabled={busy}>Cancel</Button>
            </div>
          </div>
        ) : (
          <p>
            <strong>{bookmark.name}</strong>{' — '}
            {bookmark.available && bookmark.targetId !== null
              ? <Link to={`/items/${bookmark.targetId}`}>Open</Link>
              : <span className="rf-meta">A record you can no longer see.</span>}
          </p>
        )}
        {error !== undefined && <Notice tone="danger" title="This action could not be completed. Try again." />}
        {!renaming && (
          <div className="rf-actions">
            <Button onClick={() => setRenaming(true)} disabled={busy}>Rename</Button>
            <Button onClick={() => onReorder(-1)} disabled={busy || index === 0} label={`Move ${bookmark.name} up`}>Move up</Button>
            <Button onClick={() => onReorder(1)} disabled={busy || index === count - 1} label={`Move ${bookmark.name} down`}>Move down</Button>
            <Button variant="danger" onClick={() => void remove()} disabled={busy}>Delete</Button>
          </div>
        )}
      </article>
    </li>
  );
}

function Bookmarks() {
  const client = useApi();
  const list = useLoad<{ bookmarks: BookmarkView[] }>('/me/bookmarks');
  const [error, setError] = useState<unknown>(undefined);
  if (list.data === undefined) return <LoadState error={list.error} />;
  const bookmarks = list.data.bookmarks;
  const reorder = async (id: string, delta: number) => {
    setError(undefined);
    const order = reordered(bookmarks.map((entry) => entry.id), id, delta);
    try { await client.put('/me/bookmarks/order', { order }); list.reload(); } catch (failure) { setError(failure); }
  };
  return (
    <section className="rf-stack" aria-label="Bookmarks">
      <h2>Bookmarks</h2>
      <p className="rf-meta">Only you can see your bookmarks. A bookmark whose record you can no longer read keeps its place but shows nothing about it.</p>
      {error !== undefined && <Notice tone="danger" title="The order could not be saved. Try again." />}
      {bookmarks.length === 0 ? <p className="rf-meta">You have no bookmarks.</p> : (
        <ul className="rf-list">
          {bookmarks.map((bookmark, index) => (
            <BookmarkRow key={bookmark.id} bookmark={bookmark} index={index} count={bookmarks.length}
              onReorder={(delta) => void reorder(bookmark.id, delta)} onReload={list.reload} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** A rerun of a Saved_Search through current authorization; it returns only readable results (R58.4). */
function SavedSearchResults({ id }: { readonly id: string }) {
  const page = useLoad<{ results: SearchResultView[]; next: string | null; filters: SavedSearchFilters }>(`/me/searches/${id}/results`);
  if (page.data === undefined) return <LoadState error={page.error} />;
  if (page.data.results.length === 0) return <p className="rf-meta">No result you can read matches this search now.</p>;
  return (
    <ul className="rf-list" aria-label="Saved search results">
      {page.data.results.map((result, index) => (
        <li key={`${result.id}:${index}`}><Link to={`/items/${result.rootId}`}>{result.title}</Link></li>
      ))}
    </ul>
  );
}

function searchSummary(filters: SavedSearchFilters): string {
  const parts = [filters.q ? `"${filters.q}"` : 'any text'];
  if (filters.kind) parts.push(`kind ${filters.kind}`);
  if (filters.level) parts.push(`level ${filters.level}`);
  return parts.join(', ');
}

/** One Saved_Search: rename/reorder/delete and a run that reruns it through current authorization (R58.4). */
function SavedSearchRow({ search, index, count, onReorder, onReload }: {
  readonly search: SavedSearchView; readonly index: number; readonly count: number; readonly onReorder: (delta: number) => void; readonly onReload: () => void;
}) {
  const client = useApi();
  const [name, setName] = useState(search.name);
  const [renaming, setRenaming] = useState(false);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const act = async (run: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try { await run(); } catch (failure) { setError(failure); } finally { setBusy(false); }
  };
  const rename = () => act(async () => { await client.patch(`/me/searches/${search.id}`, { name }); setRenaming(false); onReload(); });
  const remove = () => act(async () => { await client.delete(`/me/searches/${search.id}`); onReload(); });
  return (
    <li>
      <article className="rf-companion" aria-label={`Saved search: ${search.name}`}>
        {renaming ? (
          <div className="rf-stack">
            <TextField label="Saved search name" value={name} onChange={setName} maxLength={100} required />
            <div className="rf-actions">
              <Button variant="primary" onClick={() => void rename()} disabled={busy}>Save name</Button>
              <Button variant="quiet" onClick={() => { setName(search.name); setRenaming(false); }} disabled={busy}>Cancel</Button>
            </div>
          </div>
        ) : (
          <p><strong>{search.name}</strong>{' — '}<span className="rf-meta">{searchSummary(search.filters)}</span></p>
        )}
        {error !== undefined && <Notice tone="danger" title="This action could not be completed. Try again." />}
        {!renaming && (
          <div className="rf-actions">
            <Button variant="primary" onClick={() => setRunning((shown) => !shown)} disabled={busy}>{running ? 'Hide results' : 'Run search'}</Button>
            <Button onClick={() => setRenaming(true)} disabled={busy}>Rename</Button>
            <Button onClick={() => onReorder(-1)} disabled={busy || index === 0} label={`Move ${search.name} up`}>Move up</Button>
            <Button onClick={() => onReorder(1)} disabled={busy || index === count - 1} label={`Move ${search.name} down`}>Move down</Button>
            <Button variant="danger" onClick={() => void remove()} disabled={busy}>Delete</Button>
          </div>
        )}
        {running && <SavedSearchResults id={search.id} />}
      </article>
    </li>
  );
}

function SavedSearches() {
  const client = useApi();
  const list = useLoad<{ searches: SavedSearchView[] }>('/me/searches');
  const [error, setError] = useState<unknown>(undefined);
  if (list.data === undefined) return <LoadState error={list.error} />;
  const searches = list.data.searches;
  const reorder = async (id: string, delta: number) => {
    setError(undefined);
    const order = reordered(searches.map((entry) => entry.id), id, delta);
    try { await client.put('/me/searches/order', { order }); list.reload(); } catch (failure) { setError(failure); }
  };
  return (
    <section className="rf-stack" aria-label="Saved searches">
      <h2>Saved searches</h2>
      <p className="rf-meta">A saved search keeps the query you wrote, never its results. Running it searches again with your current access, so it never shows anything you can no longer read.</p>
      {error !== undefined && <Notice tone="danger" title="The order could not be saved. Try again." />}
      {searches.length === 0 ? <p className="rf-meta">You have no saved searches.</p> : (
        <ul className="rf-list">
          {searches.map((search, index) => (
            <SavedSearchRow key={search.id} search={search} index={index} count={searches.length}
              onReorder={(delta) => void reorder(search.id, delta)} onReload={list.reload} />
          ))}
        </ul>
      )}
    </section>
  );
}

const EMAIL_LABELS: Readonly<Record<FollowView['email'], string>> = { immediate: 'Emailed immediately', daily_digest: 'In the daily digest', off: 'No email' };

/** One Follow: a link to the followed record or, for a lost one, a neutral note, with its delivery and an unfollow (R58.3, R58.4). */
function FollowRow({ follow, onReload }: { readonly follow: FollowView; readonly onReload: () => void }) {
  const client = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const unfollow = async () => {
    setBusy(true);
    setError(undefined);
    try { await client.delete(`/me/follows/${follow.id}`); onReload(); } catch (failure) { setError(failure); } finally { setBusy(false); }
  };
  return (
    <li>
      <article className="rf-companion" aria-label="Followed record">
        <p>
          {follow.available && follow.targetId !== null
            ? <Link to={`/items/${follow.targetId}`}>{follow.kind === 'question' ? 'A question you follow' : 'A record you follow'}</Link>
            : <span className="rf-meta">A record you follow but can no longer see.</span>}
          {' '}<span className="rf-meta">{`— ${EMAIL_LABELS[follow.email]}, in-app ${follow.inApp ? 'on' : 'off'}`}</span>
        </p>
        {error !== undefined && <Notice tone="danger" title="This action could not be completed. Try again." />}
        <div className="rf-actions"><Button variant="danger" onClick={() => void unfollow()} disabled={busy}>Unfollow</Button></div>
      </article>
    </li>
  );
}

function Follows() {
  const list = useLoad<{ follows: FollowView[] }>('/me/follows');
  if (list.data === undefined) return <LoadState error={list.error} />;
  const follows = list.data.follows;
  return (
    <section className="rf-stack" aria-label="Records you follow">
      <h2>Records you follow</h2>
      <p className="rf-meta">Following a record does not grant you access to it; a record you can no longer read keeps its place but shows nothing about it.</p>
      {follows.length === 0 ? <p className="rf-meta">You follow no records.</p> : (
        <ul className="rf-list">{follows.map((follow) => <FollowRow key={follow.id} follow={follow} onReload={list.reload} />)}</ul>
      )}
    </section>
  );
}

/** `/me/saved`: the Member's own bookmarks, saved searches and follows, managed in one place (R58.2, R58.3, R58.4). */
export function SavedNavigationPage() {
  return (
    <div className="rf-stack">
      <h1>Saved navigation</h1>
      <Bookmarks />
      <SavedSearches />
      <Follows />
    </div>
  );
}
