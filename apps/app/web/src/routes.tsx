import { AttachmentPage, AttachFilesForm } from './files/attachment-page';
import { useMemo } from 'react';
import { Link, Navigate, Route, Routes, useParams, useSearchParams } from 'react-router';
import { ITEM_KIND_NAMES } from '@researchforce/domain/kind-names';
import { ITEM_KINDS } from '@researchforce/domain/types';
import type { ItemKind } from '@researchforce/domain/types';
import { ActivityBadges, FeedScreen, SubmissionItemsScreen } from './activity/activity';
import { useApiStatus } from './api';
import { NotificationCentre } from './notifications/centre';
import { DeletePage } from './history/delete';
import { ItemHistoryPage } from './history/history';
import { WithdrawPage } from './history/withdraw';
import { EditItemPage, NewItemPage } from './items/forms/ItemForm';
import { ItemPage } from './items/page';
import { MembersPage } from './people/members';
import { PreferencesPage } from './people/preferences';
import { OwnProfilePage, ProfileForm } from './people/profile';
import { ProfilePage } from './people/view';
import { EditProjectPage, ProjectForm } from './projects/form';
import { ProjectHistoryPage } from './projects/history';
import { ProjectsPage } from './projects/list';
import { ReviewQueuePage } from './reviews/reviews';
import { SearchScreen } from './search/search';
import { SessionContext, sessionFor } from './session';
import type { Me, Role } from './types';
import { LoadState, Notice, useLoad } from './ui';

/** Workspace-wide notices, shown on every page (R28.9, R28.10). */
export function StatusNotices() {
  const status = useApiStatus();
  return (
    <>
      {status.dailyLimit && <Notice tone="warning" title="Saving is unavailable until 00:00 UTC.">
        <p>A daily limit of the hosting platform was reached. Everything saved before then is unchanged, and reading still works.</p>
      </Notice>}
      {status.frozen && <Notice tone="warning" title="Saving is paused for a backup (about a minute)." />}
    </>
  );
}

/** The header of every Workspace page, with ResearchForce linking to the Workspace start page (R45.2). */
export function Header() {
  return (
    <header className="rf-header">
      <div className="rf-header__inner">
        <Link className="rf-header__brand" to="/">ResearchForce</Link>
        <nav aria-label="Workspace">
          <ul className="rf-nav__list">
            <li><Link className="rf-nav__link" to="/projects">Projects</Link></li>
            <li><Link className="rf-nav__link" to="/search">Search</Link></li>
            <li><Link className="rf-nav__link" to="/members">Members</Link></li>
            <li><Link className="rf-nav__link" to="/reviews">Review queue</Link></li>
            <li><Link className="rf-nav__link" to="/me/profile">Your Profile</Link></li>
            <li><Link className="rf-nav__link" to="/me/preferences">Notification settings</Link></li>
          </ul>
        </nav>
        <ActivityBadges />
      </div>
    </header>
  );
}

function StartPage() {
  return (
    <div className="rf-stack">
      <h1>Workspace</h1>
      <section aria-label="Submit">
        <h2>Submit a new record</h2>
        <ul className="rf-list">
          {ITEM_KINDS.map((kind) => <li key={kind}><Link to={`/items/new/${kind}`}>{ITEM_KIND_NAMES[kind]}</Link></li>)}
        </ul>
      </section>
    </div>
  );
}

const isKind = (value: string | undefined): value is ItemKind => (ITEM_KINDS as readonly string[]).includes(value ?? '');

function NewItemRoute() {
  const { kind } = useParams();
  const [search] = useSearchParams();
  return isKind(kind) ? <NewItemPage key={kind} kind={kind} search={search} /> : <NotFound />;
}
function AttachmentRoute() { const { id = '' } = useParams(); return <AttachmentPage key={id} id={id} />; }
function AttachFilesRoute() { const { id = '' } = useParams(); return <AttachFilesForm key={id} parentId={id} />; }
function VersionRoute() { const { id = '' } = useParams(); return <AttachFilesForm key={id} supersedesId={id} />; }
function ItemRoute() {
  const { id = '' } = useParams();
  return <ItemPage key={id} id={id} />;
}
function EditItemRoute() {
  const { id = '' } = useParams();
  return <EditItemPage key={id} id={id} />;
}
function ItemHistoryRoute() {
  const { id = '' } = useParams();
  return <ItemHistoryPage key={id} id={id} />;
}
function WithdrawRoute() {
  const { id = '' } = useParams();
  return <WithdrawPage key={id} id={id} />;
}
function DeleteRoute() {
  const { id = '' } = useParams();
  return <DeletePage key={id} id={id} />;
}
function ProfileRoute() {
  const { id = '' } = useParams();
  return <ProfilePage key={id} id={id} />;
}
function EditProjectRoute() {
  const { id = '' } = useParams();
  return <EditProjectPage key={id} id={id} />;
}
function ProjectHistoryRoute() {
  const { id = '' } = useParams();
  return <ProjectHistoryPage key={id} id={id} />;
}
function SubmissionItemsRoute() {
  const { id = '' } = useParams();
  return <SubmissionItemsScreen key={id} id={id} />;
}
/** The opaque address in a notification email: a Root_Item, optionally with the Reply (a Group_Note) to scroll to (R20.6, R41.12). */
function GoRoute() {
  const { ref = '' } = useParams();
  const [root, reply] = ref.split('~');
  return root ? <Navigate to={`/items/${root}${reply ? `#reply-${reply}` : ''}`} replace /> : <NotFound />;
}
function NotFound() {
  return <Notice tone="warning" title="This page does not exist." />;
}

export function WorkspaceRoutes() {
  return (
    <Routes>
      <Route path="/" element={<StartPage />} />
      <Route path="/items/new/:kind" element={<NewItemRoute />} />
      <Route path="/attachments/:id" element={<AttachmentRoute />} />
      <Route path="/attachments/:id/version" element={<VersionRoute />} />
      <Route path="/items/:id/files" element={<AttachFilesRoute />} />
      <Route path="/items/:id" element={<ItemRoute />} />
      <Route path="/items/:id/edit" element={<EditItemRoute />} />
      <Route path="/items/:id/history" element={<ItemHistoryRoute />} />
      <Route path="/items/:id/withdraw" element={<WithdrawRoute />} />
      <Route path="/items/:id/delete" element={<DeleteRoute />} />
      <Route path="/members" element={<MembersPage />} />
      <Route path="/members/:id" element={<ProfileRoute />} />
      <Route path="/me/profile" element={<OwnProfilePage />} />
      <Route path="/me/preferences" element={<PreferencesPage />} />
      <Route path="/projects" element={<ProjectsPage />} />
      <Route path="/projects/new" element={<ProjectForm />} />
      <Route path="/projects/:id/edit" element={<EditProjectRoute />} />
      <Route path="/projects/:id/history" element={<ProjectHistoryRoute />} />
      <Route path="/reviews" element={<ReviewQueuePage />} />
      <Route path="/search" element={<SearchScreen />} />
      <Route path="/go/:ref" element={<GoRoute />} />
      <Route path="/notifications" element={<NotificationCentre />} />
      <Route path="/activity" element={<FeedScreen />} />
      <Route path="/activity/submissions/:id" element={<SubmissionItemsRoute />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

/** The signed-in Workspace: header, notices, and either the requested page or, while the Profile is incomplete, the Profile form (R3.6). */
export function Workspace() {
  const status = useApiStatus();
  const me = useLoad<Me>('/me');
  const roles = useLoad<{ roles: Role[] }>('/roles');
  const session = useMemo(() => (me.data && roles.data ? sessionFor(me.data, roles.data.roles, me.reload) : null), [me.data, roles.data, me.reload]);
  const gated = session !== null && (session.me.missing.length > 0 || status.profileMissing !== null);
  return (
    <>
      <a className="rf-skip-link" href="#main">Skip to the main content</a>
      <Header />
      <main className="rf-main" id="main">
        <StatusNotices />
        {session === null ? <LoadState error={me.error ?? roles.error} /> : (
          <SessionContext.Provider value={session}>
            {gated ? <ProfileForm me={session.me} onSaved={me.reload} /> : <WorkspaceRoutes />}
          </SessionContext.Provider>
        )}
      </main>
    </>
  );
}
