import { AttachmentPage, AttachFilesForm } from './files/attachment-page';
import { Navigate, Route, Routes, useParams, useSearchParams } from 'react-router';
import { ITEM_KINDS } from '@researchforce/domain/types';
import type { ItemKind } from '@researchforce/domain/types';
import { Dashboard } from './dashboard/dashboard';
import { FeedScreen, SubmissionItemsScreen } from './activity/activity';
import { useApiStatus } from './api';
import { NotificationCentre } from './notifications/centre';
import { DeletePage } from './history/delete';
import { ItemHistoryPage } from './history/history';
import { WithdrawPage } from './history/withdraw';
import { EditItemPage, NewItemPage } from './items/forms/ItemForm';
import { ItemPage } from './items/page';
import { MembersPage } from './people/members';
import { PreferencesPage } from './people/preferences';
import { OwnProfilePage } from './people/profile';
import { ProfilePage } from './people/view';
import { CoverageScreen } from './compute/coverage';
import { DraftsPage } from './drafts/drafts';
import { ProposalPage, ProposalsListPage, ProposeEditPage } from './proposals/proposals';
import { EditProjectPage, ProjectForm } from './projects/form';
import { ProjectHistoryPage } from './projects/history';
import { ProjectsPage } from './projects/list';
import { WorkListScreen } from './work/work-list';
import { MyWorkPage } from './me/dashboard';
import { SavedNavigationPage } from './me/saved';
import { TeamDashboardPage } from './me/team';
import { CitationCurationScreen } from './citations/panel';
import { ReviewQueuePage } from './reviews/reviews';
import { ModerationQueueScreen } from './moderation/queue';
import { OutsideSubmissionScreen } from './moderation/submission';
import { ProposalScreen } from './reviews/proposal';
import { PublicationRequestScreen } from './disclosure/publication-request';
import { ConsentRequestsScreen } from './consent/requests';
import { PartyPage } from './consent/party';
import { UnclassifiedScreen, PublicOverviewScreen } from './disclosure/records';
import { EvidenceEditorScreen } from './evidence/editor';
import { CurationQueueScreen } from './evidence/queue';
import { JournalImportScreen } from './imports/journal';
import { BulkImportScreen } from './imports/bulk';
import { ExportsScreen } from './exports/exports';
import { BackupsScreen } from './exports/backups';
import { DualApprovalsPage } from './reviews/dual';
import { SearchScreen } from './search/search';
import { ProjectLogRoute, ProjectLogScreen } from './projects/log';
import { ArchivalRequestsScreen, CorrespondencesScreen, FindingsScreen, HypothesesScreen, RunsScreen } from './lists/lists';
import { NewReleasePage, ReleasePage, ReleasesListPage } from './releases/releases';
import { PolicyIndexScreen, PolicyPageScreen } from './admin/policy';
import { SettingsScreen } from './admin/settings';
import { ValueSetsScreen } from './admin/value-sets';
import type { MemberRow } from './types';
import { StaleBuildNotice } from './build/stale-build-notice';
import { LoadState, Notice, useLoad } from './ui';

/** Workspace-wide notices, shown on every page (R28.9, R28.10). */
export function StatusNotices() {
  const status = useApiStatus();
  return (
    <>
      <StaleBuildNotice />
      {status.dailyLimit && <Notice tone="warning" title="Saving is unavailable until 00:00 UTC.">
        <p>A daily limit of the hosting platform was reached. Everything saved before then is unchanged, and reading still works.</p>
      </Notice>}
      {status.frozen && <Notice tone="warning" title="Saving is paused for a backup (about a minute)." />}
    </>
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
function ProjectWorkRoute() {
  const { id = '' } = useParams();
  return <WorkListScreen key={id} projectId={id} />;
}
function ProjectDashboardRoute() {
  const { id = '' } = useParams();
  return <TeamDashboardPage key={id} projectId={id} />;
}
function ProjectCitationsRoute() {
  const { id = '' } = useParams();
  return <CitationCurationScreen key={id} projectId={id} />;
}
function ProjectCoverageRoute() {
  const { id = '' } = useParams();
  return <CoverageScreen key={id} projectId={id} />;
}
function SubmissionItemsRoute() {
  const { id = '' } = useParams();
  return <SubmissionItemsScreen key={id} id={id} />;
}
function ReleaseRoute() {
  const { id = '' } = useParams();
  return <ReleasePage key={id} id={id} />;
}
function ProposeEditRoute() {
  const { id = '' } = useParams();
  const [search] = useSearchParams();
  const rebase = search.get('rebase');
  return <ProposeEditPage key={`${id}:${rebase ?? ''}`} rootId={id} rebaseId={rebase ?? undefined} />;
}
function ProposalsListRoute() {
  const { id = '' } = useParams();
  return <ProposalsListPage key={id} rootId={id} />;
}
function ProposalRoute() {
  const { id = '' } = useParams();
  return <ProposalPage key={id} id={id} />;
}
function ProposalRoute2() {
  const { id = '' } = useParams();
  const members = useLoad<{ members: MemberRow[] }>('/members');
  if (!members.data) return <LoadState error={members.error} />;
  return <ProposalScreen key={id} id={id} members={members.data.members} />;
}
function EvidenceEditorRoute() {
  const { id = '' } = useParams();
  return <EvidenceEditorScreen key={id} id={id} />;
}
function PublicationRequestRoute() {
  const { id = '' } = useParams();
  const members = useLoad<{ members: MemberRow[] }>('/members');
  if (!members.data) return <LoadState error={members.error} />;
  return <PublicationRequestScreen key={id} id={id} members={members.data.members} />;
}
/** The opaque address in a notification email: a Root_Item, optionally with the Reply (a Group_Note) to scroll to (R20.6, R41.12). */
function GoRoute() {
  const { ref = '' } = useParams();
  const [root, reply] = ref.split('~');
  return root ? <Navigate to={`/items/${root}${reply ? `#reply-${reply}` : ''}`} replace /> : <NotFound />;
}
function OutsideSubmissionRoute() {
  const { id = '' } = useParams();
  return <OutsideSubmissionScreen key={id} id={id} />;
}
function PartyRoute() {
  const { id = '' } = useParams();
  return <PartyPage key={id} id={id} />;
}
function PolicyPageRoute() {
  const { page = '' } = useParams();
  return <PolicyPageScreen key={page} pageKey={page} />;
}
function NotFound() {
  return <Notice tone="warning" title="This page does not exist." />;
}

export function WorkspaceRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      {/* The Design Suite TopMenu links its built-in "Dashboard" control to /dashboard; alias it to the Workspace start page. */}
      <Route path="/dashboard" element={<Dashboard />} />
      <Route path="/items/new/:kind" element={<NewItemRoute />} />
      <Route path="/attachments/:id" element={<AttachmentRoute />} />
      <Route path="/attachments/:id/version" element={<VersionRoute />} />
      <Route path="/items/:id/files" element={<AttachFilesRoute />} />
      <Route path="/items/:id" element={<ItemRoute />} />
      <Route path="/items/:id/edit" element={<EditItemRoute />} />
      <Route path="/items/:id/history" element={<ItemHistoryRoute />} />
      <Route path="/items/:id/propose" element={<ProposeEditRoute />} />
      <Route path="/items/:id/proposals" element={<ProposalsListRoute />} />
      <Route path="/proposals/:id" element={<ProposalRoute />} />
      <Route path="/publication-proposals/:id" element={<ProposalRoute2 />} />
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
      <Route path="/projects/:id/work" element={<ProjectWorkRoute />} />
      <Route path="/projects/:id/dashboard" element={<ProjectDashboardRoute />} />
      <Route path="/projects/:id/citations" element={<ProjectCitationsRoute />} />
      <Route path="/projects/:id/coverage" element={<ProjectCoverageRoute />} />
      <Route path="/projects/:id/log" element={<ProjectLogRoute />} />
      <Route path="/log" element={<ProjectLogScreen />} />
      <Route path="/lists/findings" element={<FindingsScreen />} />
      <Route path="/lists/runs" element={<RunsScreen />} />
      <Route path="/lists/hypotheses" element={<HypothesesScreen />} />
      <Route path="/lists/correspondences" element={<CorrespondencesScreen />} />
      <Route path="/lists/archival-requests" element={<ArchivalRequestsScreen />} />
      <Route path="/me/work" element={<MyWorkPage />} />
      <Route path="/me/saved" element={<SavedNavigationPage />} />
      <Route path="/me/drafts" element={<DraftsPage />} />
      <Route path="/reviews" element={<ReviewQueuePage />} />
      <Route path="/moderation" element={<ModerationQueueScreen />} />
      <Route path="/moderation/:id" element={<OutsideSubmissionRoute />} />
      <Route path="/publication-requests/:id" element={<PublicationRequestRoute />} />
      <Route path="/parties/:id" element={<PartyRoute />} />
      <Route path="/consent-requests" element={<ConsentRequestsScreen />} />
      <Route path="/disclosure/unclassified" element={<UnclassifiedScreen />} />
      <Route path="/disclosure/public-units" element={<PublicOverviewScreen />} />
      <Route path="/evidence/queue" element={<CurationQueueScreen />} />
      <Route path="/imports/journal" element={<JournalImportScreen />} />
      <Route path="/imports/bulk" element={<BulkImportScreen />} />
      <Route path="/admin/policy" element={<PolicyIndexScreen />} />
      <Route path="/admin/policy/:page" element={<PolicyPageRoute />} />
      <Route path="/admin/settings" element={<SettingsScreen />} />
      <Route path="/admin/value-sets" element={<ValueSetsScreen />} />
      <Route path="/exports" element={<ExportsScreen />} />
      <Route path="/backups" element={<BackupsScreen />} />
      <Route path="/releases" element={<ReleasesListPage />} />
      <Route path="/releases/new" element={<NewReleasePage />} />
      <Route path="/releases/:id" element={<ReleaseRoute />} />
      <Route path="/evidence/units/:id" element={<EvidenceEditorRoute />} />
      <Route path="/dual-approvals" element={<DualApprovalsPage />} />
      <Route path="/search" element={<SearchScreen />} />
      <Route path="/go/:ref" element={<GoRoute />} />
      <Route path="/notifications" element={<NotificationCentre />} />
      <Route path="/activity" element={<FeedScreen />} />
      <Route path="/activity/submissions/:id" element={<SubmissionItemsRoute />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
