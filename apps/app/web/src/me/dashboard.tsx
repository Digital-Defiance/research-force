import { Link } from 'react-router';
import { QUESTION_STATE_NAMES } from '@researchforce/domain/work';
import type { QuestionState } from '@researchforce/domain/work';
import { ReviewQueuePage } from '../reviews/reviews';
import { DraftsPage } from '../drafts/drafts';
import { WorkListScreen } from '../work/work-list';
import type { DashboardArchival, DashboardProposal, DashboardQuestion, DashboardView } from '../types';
import { formatDate, LoadState, Notice, useLoad } from '../ui';

/**
 * The My_Work page (R58.1, R58.5). It brings together the outstanding work a Member owes attention
 * without their having to read every activity entry: the work assigned, awaiting their answer, due or
 * blocked; the reviews they may complete; the archival derivations still needing review; the Edit_
 * Proposals an authorized editor must resolve; the Research_Questions they follow; and their own durable
 * drafts. Each section is a link into the record's own screen. Every piece respects the viewer's current
 * Can_Read: a record they lost access to contributes no content and no count, and a followed Question
 * whose target became unreadable is a neutral unavailable entry rather than a name (R58.1, R58.4).
 *
 * Outstanding work is kept apart from unseen activity. This page shows what is still to be done; the New
 * and Updated flags, counted in the header badges, are the separate concern of what has changed since a
 * Member last looked. Listing work here reads no flag and clears none, so opening the page is never
 * mistaken for opening the work (R58.5).
 */

const REVIEW_STATE_LABELS: Readonly<Record<DashboardArchival['reviewState'], string>> = { unreviewed: 'Needs review', disputed: 'Disputed' };

/** An Edit_Proposal that may require the viewer, linking to its review screen; a stale one needs the proposer's rebase first (R57.5). */
function ProposalRow({ proposal }: { readonly proposal: DashboardProposal }) {
  return (
    <li>
      <Link to={`/proposals/${proposal.id}`}>{proposal.explanation.slice(0, 120) || 'Proposed edit'}</Link>
      <span className="rf-meta">{` — on ${proposal.identifier}: ${proposal.title}, proposed ${formatDate(proposal.createdAt)}`}</span>
      {proposal.stale && <span className="rf-status rf-status--warning">{' Needs rebase'}</span>}
    </li>
  );
}

/** An archival derivation still needing independent review, linking to its output record (R55.3, R58.1). */
function ArchivalRow({ entry }: { readonly entry: DashboardArchival }) {
  return (
    <li>
      <Link to={`/items/${entry.rootId}`}>{`${entry.identifier}: ${entry.title}`}</Link>
      <span className="rf-meta">{` — ${entry.kind} derivation`}</span>
      <span className={entry.reviewState === 'disputed' ? 'rf-status rf-status--warning' : 'rf-status rf-status--info'}>{` ${REVIEW_STATE_LABELS[entry.reviewState]}`}</span>
    </li>
  );
}

/**
 * A followed Research_Question. A readable one links to the Question and shows its lifecycle state; one
 * the viewer can no longer read keeps its place as a neutral unavailable entry, naming nothing and
 * linking nowhere, so the viewer learns only that they followed something (R58.4).
 */
function QuestionRow({ question }: { readonly question: DashboardQuestion }) {
  if (!question.available || question.rootId === null) {
    return <li className="rf-meta">A followed question you can no longer see.</li>;
  }
  return (
    <li>
      <Link to={`/items/${question.rootId}`}>{`${question.identifier}: ${question.question}`}</Link>
      {question.state !== null && <span className="rf-status">{` ${QUESTION_STATE_NAMES[question.state as QuestionState]}`}</span>}
    </li>
  );
}

/** The proposals, archival follow-ups and followed Questions the Workspace serves only for this page (R58.1). */
function OutstandingSections({ view }: { readonly view: DashboardView }) {
  return (
    <>
      <section className="rf-stack" aria-label="Proposed edits to resolve">
        <h2>Proposed edits to resolve</h2>
        {view.proposals.items.length === 0 ? <p className="rf-meta">No proposed edit is waiting for your decision.</p> : (
          <>
            <ul className="rf-list">{view.proposals.items.map((proposal) => <ProposalRow key={proposal.id} proposal={proposal} />)}</ul>
            {view.proposals.total > view.proposals.items.length && <p className="rf-meta">{`Showing ${view.proposals.items.length} of ${view.proposals.total}.`}</p>}
          </>
        )}
        <p className="rf-meta">Only an editor authorized for every field a proposal changes can accept or decline it.</p>
      </section>
      <section className="rf-stack" aria-label="Archival follow-ups">
        <h2>Archival follow-ups</h2>
        {view.archival.items.length === 0 ? <p className="rf-meta">No derivation is waiting for a review.</p> : (
          <>
            <ul className="rf-list">{view.archival.items.map((entry) => <ArchivalRow key={entry.id} entry={entry} />)}</ul>
            {view.archival.total > view.archival.items.length && <p className="rf-meta">{`Showing ${view.archival.items.length} of ${view.archival.total}.`}</p>}
          </>
        )}
      </section>
      <section className="rf-stack" aria-label="Questions you follow">
        <h2>Questions you follow</h2>
        {view.questions.length === 0 ? <p className="rf-meta">You follow no questions.</p> : (
          <ul className="rf-list">{view.questions.map((question) => <QuestionRow key={question.followId} question={question} />)}</ul>
        )}
      </section>
    </>
  );
}

/** `/me/work`: the My_Work dashboard, drawing every outstanding section through current access (R58.1, R58.5). */
export function MyWorkPage() {
  const dashboard = useLoad<DashboardView>('/me/dashboard');
  return (
    <div className="rf-stack">
      <h1>My work</h1>
      <Notice tone="neutral" title="What is still to be done.">
        <p>This page shows outstanding work. What has changed since you last looked is counted separately in the badges at the top of every page; opening this page clears none of them.</p>
      </Notice>
      <WorkListScreen embedded />
      <section className="rf-stack" aria-label="Reviews you can complete">
        <h2>Reviews you can complete</h2>
        <ReviewQueuePage embedded />
      </section>
      {dashboard.data === undefined ? <LoadState error={dashboard.error} /> : <OutstandingSections view={dashboard.data} />}
      <section className="rf-stack" aria-label="Your drafts">
        <h2>Your drafts</h2>
        <DraftsPage embedded />
      </section>
    </div>
  );
}
