import { Link } from 'react-router';
import { QUESTION_STATE_NAMES } from '@researchforce/domain/work';
import type { QuestionState } from '@researchforce/domain/work';
import { WorkListScreen } from '../work/work-list';
import type { ProjectRecord, TeamDashboardView, TeamQuestion } from '../types';
import { LoadState, useLoad } from '../ui';

/**
 * A Project's team dashboard (R58.5). It shows the readable work and the Research_Question progress of
 * one Project — work by responsible Member, due date and state, and each Question's lifecycle state and
 * lead — with lossless paging. It shows only authorized context: a record or Question the viewer cannot
 * read contributes no row and no count, and it never publishes participation or access-list information.
 * Outstanding work stays distinct from unseen activity, which the badges track separately.
 */

function QuestionRow({ question }: { readonly question: TeamQuestion }) {
  return (
    <li>
      <Link to={`/items/${question.rootId}`}>{`${question.identifier}: ${question.question}`}</Link>
      <span className="rf-status">{` ${QUESTION_STATE_NAMES[question.state as QuestionState]}`}</span>
      <span className="rf-meta">{` — lead: ${question.leadName ?? 'none'}`}</span>
    </li>
  );
}

/** `/projects/:id/dashboard`: the readable work and Question progress of one Project (R58.5). */
export function TeamDashboardPage({ projectId }: { readonly projectId: string }) {
  const projects = useLoad<{ projects: ProjectRecord[] }>('/projects');
  const name = projects.data?.projects.find((record) => record.id === projectId)?.name;
  const dashboard = useLoad<TeamDashboardView>(`/projects/${projectId}/dashboard`);
  return (
    <div className="rf-stack">
      <h1>{name === undefined ? 'Team dashboard' : `Team dashboard: ${name}`}</h1>
      <p className="rf-meta">Only the work and questions you can read are shown; what has changed since you last looked is counted separately in the badges above.</p>
      <WorkListScreen projectId={projectId} embedded />
      <section className="rf-stack" aria-label="Question progress">
        <h2>Question progress</h2>
        {dashboard.data === undefined ? <LoadState error={dashboard.error} /> : (
          dashboard.data.questions.items.length === 0 ? <p className="rf-meta">No readable question is in this Project.</p> : (
            <>
              <ul className="rf-list">{dashboard.data.questions.items.map((question) => <QuestionRow key={question.rootId} question={question} />)}</ul>
              {dashboard.data.questions.total > dashboard.data.questions.items.length && <p className="rf-meta">{`Showing ${dashboard.data.questions.items.length} of ${dashboard.data.questions.total}.`}</p>}
            </>
          )
        )}
      </section>
    </div>
  );
}
