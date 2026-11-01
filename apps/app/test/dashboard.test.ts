import { describe, expect, it } from 'vitest';
import type { DashboardView, TeamDashboardView } from '../src/records/dashboard';
import { itemWorld, rich } from './items';
import type { ItemView, Who } from './items';
import { addElement, addSubmissionRow } from './units';

/**
 * The My_Work and team dashboards (R58.1, R58.5). The dashboard gathers outstanding work the Workspace
 * does not already serve elsewhere — the Edit_Proposals an authorized editor must resolve, the archival
 * derivations awaiting review, and the viewer's followed Questions — and the Project team dashboard adds
 * the readable Research_Question progress. Every piece is evaluated through the viewer's current
 * Can_Read, so no inaccessible content or count appears, and a lost followed target is a neutral
 * unavailable entry. Reading the dashboard clears no activity flag.
 */

const world = itemWorld();
const restrict = (item: ItemView) => world.core().prepare("UPDATE research_items SET access_level = 'restricted' WHERE unit_id = ?1").bind(item.id).run();
const dashboard = async (who: Who): Promise<DashboardView> => {
  const response = await world.request(who, 'GET', '/me/dashboard');
  if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return response.json<DashboardView>();
};
const team = async (who: Who, projectId: string): Promise<TeamDashboardView> => {
  const response = await world.request(who, 'GET', `/projects/${projectId}/dashboard`);
  if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return response.json<TeamDashboardView>();
};

/** A proposal to change a finding's claim, written against its current revision. */
const claimProposal = (target: ItemView, text: string) => ({ targetId: target.id, baseRev: target.rev, diff: { claim: rich(text), mark: { mark: 'minor_edit' } }, explanation: `Sharper: ${text}` });
const submit = async (who: Who, body: Record<string, unknown>): Promise<string> => {
  const response = await world.request(who, 'POST', '/proposals/edits', body);
  if (response.status !== 201) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json<{ proposal: { id: string } }>()).proposal.id;
};
const followQuestion = async (who: Who, targetId: string) => {
  const response = await world.request(who, 'POST', '/me/follows', { kind: 'question', targetId });
  if (response.status !== 201) throw new Error(`${response.status} ${await response.text()}`);
};

const place = async () => ({ projectId: world.projectId, ownerId: world.ids.author, submissionId: await addSubmissionRow(world.core(), world.ids.author, world.at), now: world.at });
const hash = (digit: string) => digit.repeat(64);
/** A file on a record with a content hash of its own, so a derivation can tell it from the original. */
const file = async (root: ItemView, sha: string) => {
  const unit = await addElement(world.core(), await place(), 'attachment', root.id as never);
  await world.core().prepare('UPDATE attachments SET sha256 = ?2 WHERE unit_id = ?1').bind(unit.id, sha).run();
  return unit;
};
const base = { kind: 'transcription', method: 'Hand transcription' };
const recordDerivation = async (who: Who, body: Record<string, unknown>): Promise<string> => {
  const response = await world.request(who, 'POST', '/derivations', body);
  if (response.status !== 201 && response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json<{ derivation: { id: string } }>()).derivation.id;
};

describe('My_Work dashboard proposals (R58.1)', () => {
  it('lists open proposals of readable records that the viewer did not write, and omits their own', async () => {
    const target = await world.created('author', 'finding');
    const mine = await submit('colleague', claimProposal(target, 'A colleague wrote this.'));
    const other = await world.created('author', 'finding');
    await submit('author', claimProposal(other, 'The author wrote this.'));

    const view = await dashboard('colleague');
    // The colleague sees the proposal the author or admin could resolve, but not one they authored themselves.
    expect(view.proposals.items.map((p) => p.id)).not.toContain(mine);
    const authorView = await dashboard('author');
    expect(authorView.proposals.items.some((p) => p.id === mine)).toBe(true);
    expect(authorView.proposals.total).toBe(authorView.proposals.items.length);
  });

  it('shows no proposal of a record the viewer cannot read, in neither its items nor its count', async () => {
    const target = await world.created('author', 'finding');
    await submit('colleague', claimProposal(target, 'A sharper claim.'));
    await restrict(target);
    // The admin reads everything; the colleague now cannot read the restricted target.
    expect((await dashboard('colleague')).proposals.total).toBe(0);
    expect((await dashboard('colleague')).proposals.items).toEqual([]);
    expect((await dashboard('admin')).proposals.total).toBeGreaterThanOrEqual(1);
  });
});

describe('My_Work dashboard archival follow-ups (R58.1, R55.3)', () => {
  it('lists unreviewed and disputed derivations the viewer can read and hides a lost one', async () => {
    const finding = await world.created('author', 'finding');
    const scan = await file(finding, hash('a'));
    const transcript = await file(finding, hash('b'));
    const id = await recordDerivation('author', { ...base, output: { type: 'attachment', unitId: transcript.id }, inputs: [{ type: 'attachment', unitId: scan.id }], text: 'Der Brief.' });

    const view = await dashboard('colleague');
    expect(view.archival.items.some((entry) => entry.id === id)).toBe(true);
    expect(view.archival.items.find((entry) => entry.id === id)).toMatchObject({ reviewState: 'unreviewed', rootId: finding.id });

    await restrict(finding);
    const after = await dashboard('colleague');
    expect(after.archival.items.some((entry) => entry.id === id)).toBe(false);
    expect(after.archival.total).toBe(0);
  });
});

describe('My_Work dashboard followed Questions (R58.1, R58.4)', () => {
  it('lists readable followed Questions with their state and shows a lost one as a neutral unavailable entry', async () => {
    const question = await world.created('author', 'research_question');
    await followQuestion('colleague', question.id as string);

    const view = await dashboard('colleague');
    expect(view.questions).toHaveLength(1);
    expect(view.questions[0]).toMatchObject({ available: true, rootId: question.id, state: 'open' });
    expect(view.questions[0]!.question).toBe('What did the synthetic tiles show?');

    await restrict(question);
    const after = await dashboard('colleague');
    expect(after.questions).toHaveLength(1);
    expect(after.questions[0]).toMatchObject({ available: false, rootId: null, identifier: null, question: null, state: null });
  });
});

describe('My_Work dashboard and flags (R58.5)', () => {
  it('reads the dashboard without clearing any New or Updated flag', async () => {
    const question = await world.created('author', 'research_question');
    await followQuestion('colleague', question.id as string);
    // The author's new Question flags the colleague; reading the dashboard must not clear that flag.
    const flagsBefore = await world.core().prepare('SELECT count(*) AS n FROM flags WHERE member_id = ?1').bind(world.ids.colleague).first<number>('n');
    await dashboard('colleague');
    const flagsAfter = await world.core().prepare('SELECT count(*) AS n FROM flags WHERE member_id = ?1').bind(world.ids.colleague).first<number>('n');
    expect(flagsAfter).toBe(flagsBefore);
  });
});

describe('team dashboard (R58.5)', () => {
  it('lists the readable Research_Question progress of a Project and omits an unreadable one from items and count', async () => {
    const open = await world.created('author', 'research_question');
    const restricted = await world.created('author', 'research_question');
    await restrict(restricted);

    const adminView = await team('admin', world.projectId);
    expect(adminView.questions.items.map((q) => q.rootId).sort()).toEqual([open.id, restricted.id].sort());

    const colleagueView = await team('colleague', world.projectId);
    expect(colleagueView.questions.items.map((q) => q.rootId)).toEqual([open.id]);
    expect(colleagueView.questions.total).toBe(1);
    expect(colleagueView.questions.items[0]).toMatchObject({ state: 'open', question: 'What did the synthetic tiles show?' });
  });

  it('404s a dashboard of a Project that does not exist', async () => {
    expect((await world.request('author', 'GET', '/projects/0000000000000000000000PX01/dashboard')).status).toBe(404);
  });
});
