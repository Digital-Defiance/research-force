import { Link } from 'react-router';
import type { ProfileView } from '../types';
import { formatDate, LoadState, Notice, useLoad } from '../ui';

const UNIT_NAMES: Readonly<Record<string, string>> = { research_item: 'Research Item', attachment: 'Attachment', reply: 'Reply' };

/** Any Member's Profile and their up to 20 most recent Submissions, newest first, each linking to the Items it added (R3.4). */
export function ProfileDetails({ view }: { readonly view: ProfileView }) {
  const { profile } = view;
  return (
    <article className="rf-stack">
      <h1>{profile?.displayName ?? 'A Member without a Profile yet'}</h1>
      {view.member.status === 'revoked' && <Notice tone="warning" title="This Member’s access has been revoked." />}
      {profile !== null && (
        <dl>
          <dt>Specialties</dt><dd>{profile.specialties.map((specialty) => specialty.name).join(', ')}</dd>
          <dt>Affiliations</dt><dd>{profile.affiliations.length === 0 ? 'None' : <ul className="rf-list">{profile.affiliations.map((affiliation) => <li key={affiliation}>{affiliation}</li>)}</ul>}</dd>
          <dt>Short biography</dt><dd>{profile.biography === '' ? 'None' : profile.biography}</dd>
          <dt>Time zone</dt><dd>{profile.timeZone}</dd>
        </dl>
      )}
      <section className="rf-section" aria-label="Recent Submissions">
        <h2>Recent Submissions</h2>
        {view.submissions.length === 0 ? <p className="rf-meta">No Submissions yet.</p> : (
          <ol className="rf-list">
            {view.submissions.map((submission) => (
              <li key={submission.id}>
                <p>{formatDate(submission.completedAt)}</p>
                <ul>
                  {submission.items.map((item) => (
                    <li key={item.id}><Link to={`/items/${item.rootId}`}>{`${UNIT_NAMES[item.unitType] ?? item.unitType} ${item.id}`}</Link></li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        )}
      </section>
    </article>
  );
}

export function ProfilePage({ id }: { readonly id: string }) {
  const view = useLoad<ProfileView>(`/members/${id}/profile`);
  return view.data ? <ProfileDetails view={view.data} /> : <LoadState error={view.error} />;
}
