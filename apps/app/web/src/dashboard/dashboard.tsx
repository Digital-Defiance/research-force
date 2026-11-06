import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ITEM_KIND_NAMES } from '@researchforce/domain/kind-names';
import { draftLabel, draftResumeTo } from '../drafts/drafts';
import { SUBMITTABLE_KINDS } from '../items/forms/model';
import { targetLink } from '../reviews/reviews';
import type { DashboardView, DraftPage, FeedPage, ReviewView } from '../types';
import { Card, EmptyState, formatDate, LoadingSkeleton, LoadState, PageHeader, PageLayout, useLoad } from '../ui';
import type { Loaded } from '../ui';

/** How many items a region summarizes before pointing at the full screen (R5.1). */
const PREVIEW = 3;

const ViewAll = ({ to, label }: { readonly to: string; readonly label: string }) => (
  <p><Link to={to} aria-label={`View all ${label}`}>View all</Link></p>
);

/**
 * One dashboard region: a skeleton while loading, the existing `LoadState` on error (never an empty state),
 * an `EmptyState` when the result is empty, and otherwise the summary with a "View all" link (R5.2, R5.3, R5.4).
 * `summary` returns undefined when the resolved payload has nothing to show.
 */
function Region<T>({ heading, to, label, empty, loaded, summary }: {
  readonly heading: string;
  readonly to: string;
  readonly label: string;
  readonly empty: string;
  readonly loaded: Loaded<T>;
  readonly summary: (data: T) => ReactNode | undefined;
}) {
  let body: ReactNode;
  if (loaded.error !== undefined) body = <LoadState error={loaded.error} />;
  else if (loaded.data === undefined) body = <LoadingSkeleton label={`Loading ${label}…`} />;
  else {
    const content = summary(loaded.data);
    body = content === undefined ? <EmptyState message={empty} /> : <>{content}<ViewAll to={to} label={label} /></>;
  }
  return <Card heading={heading} headingHref={to}>{body}</Card>;
}

const reviewLabel = (review: ReviewView): string => {
  if (review.requestType === 'proposal') return 'A Publication Proposal to review';
  if (review.isPublicationRequest) return 'A Publication Request to apply or decline';
  return targetLink(review).name;
};
const reviewTo = (review: ReviewView): string => {
  if (review.requestType === 'proposal') return `/publication-proposals/${review.id}`;
  if (review.isPublicationRequest) return `/publication-requests/${review.id}`;
  return targetLink(review).to;
};

function ReviewsRegion() {
  const queue = useLoad<{ reviews: ReviewView[] }>('/reviews/queue');
  return (
    <Region heading="My reviews" to="/reviews" label="reviews" empty="No reviews are waiting for you." loaded={queue} summary={({ reviews }) => reviews.length === 0 ? undefined : (
      <>
        <p className="rf-meta">{reviews.length === 1 ? '1 review is waiting for you.' : `${reviews.length} reviews are waiting for you.`}</p>
        <ul className="rf-list">{reviews.slice(0, PREVIEW).map((review) => <li key={review.id}><Link to={reviewTo(review)}>{reviewLabel(review)}</Link></li>)}</ul>
      </>
    )} />
  );
}

function DraftsRegion() {
  const page = useLoad<DraftPage>('/drafts');
  return (
    <Region heading="My drafts" to="/me/drafts" label="drafts" empty="You have no saved drafts." loaded={page} summary={({ drafts }) => drafts.length === 0 ? undefined : (
      <>
        <p className="rf-meta">{drafts.length === 1 ? '1 saved draft.' : `${drafts.length} saved drafts.`}</p>
        <ul className="rf-list">{drafts.slice(0, PREVIEW).map((draft) => <li key={draft.id}><Link to={draftResumeTo(draft)}>{draftLabel(draft)}</Link></li>)}</ul>
      </>
    )} />
  );
}

function WorkRegion() {
  const dashboard = useLoad<DashboardView>('/me/dashboard');
  return (
    <Region heading="My work" to="/me/work" label="work" empty="Nothing is waiting for your attention." loaded={dashboard} summary={(view) => {
      const lines = [
        view.proposals.total > 0 && `Proposed edits to resolve: ${view.proposals.total}`,
        view.archival.total > 0 && `Archival follow-ups: ${view.archival.total}`,
        view.questions.length > 0 && `Questions you follow: ${view.questions.length}`,
      ].filter((line): line is string => line !== false);
      return lines.length === 0 ? undefined : <ul className="rf-list">{lines.map((line) => <li key={line}>{line}</li>)}</ul>;
    }} />
  );
}

function ActivityRegion() {
  const feed = useLoad<FeedPage>('/feed');
  return (
    <Region heading="Recent activity" to="/activity" label="activity" empty="There is no recent activity." loaded={feed} summary={({ entries }) => entries.length === 0 ? undefined : (
      <ul className="rf-list">
        {entries.slice(0, PREVIEW).map((entry) => (
          <li key={entry.id}>
            <span>{entry.kind.replaceAll('_', ' ')}</span>
            <span className="rf-meta">{` on ${formatDate(entry.at)}`}</span>
          </li>
        ))}
      </ul>
    )} />
  );
}

/** The Workspace start page: summaries of the viewer's reviews, drafts, work, and recent activity, plus the new-record controls (R5.1-R5.6). */
export function Dashboard() {
  return (
    <PageLayout variant="wide">
      <PageHeader title="Workspace" description="What needs your attention, and what has happened lately." />
      <div className="rf-stack">
        <ReviewsRegion />
        <DraftsRegion />
        <WorkRegion />
        <ActivityRegion />
        <Card heading="Submit a new record">
          <ul className="rf-list">
            {SUBMITTABLE_KINDS.map((kind) => <li key={kind}><Link to={`/items/new/${kind}`}>{ITEM_KIND_NAMES[kind]}</Link></li>)}
          </ul>
        </Card>
      </div>
    </PageLayout>
  );
}
