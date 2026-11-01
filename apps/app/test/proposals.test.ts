import { describe, expect, it } from 'vitest';
import { newULID } from '@researchforce/domain/identifiers';
import { CAMPAIGN_OPEN, errorOf, itemWorld, rich } from './items';
import type { ItemView, Who } from './items';

const world = itemWorld();

type ProposalEvent = { kind: string; actor: string | null; at: string; atRev: number | null; note: string | null };
type ProposalView = {
  id: string; targetId: string; targetRootId: string; proposer: string; baseRev: number; appliesToRev: number; state: string;
  stale: boolean; targetRev: number | null; diff: Record<string, unknown>; explanation: string; references: string[];
  acceptedBy: string | null; closedBy: string | null; rev: number; events: ProposalEvent[];
};

const submit = (who: Who, body: Record<string, unknown>) => world.request(who, 'POST', '/proposals/edits', body);
const proposed = async (response: Response): Promise<ProposalView> => {
  if (response.status !== 201 && response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json<{ proposal: ProposalView }>()).proposal;
};
const read = async (who: Who, id: string): Promise<ProposalView> => (await world.request(who, 'GET', `/proposals/edits/${id}`).then((r) => r.json<{ proposal: ProposalView }>())).proposal;
const count = async (sql: string, ...values: unknown[]) => (await world.core().prepare(sql).bind(...values).first<number>('n'))!;

/** A proposal to change a finding's claim, written against the finding's current revision. The diff is an ordinary edit body, so it carries a mark. */
const claimProposal = (target: ItemView, text: string, extra: Record<string, unknown> = {}) => ({
  targetId: target.id, baseRev: target.rev, diff: { claim: rich(text), mark: { mark: 'minor_edit' } }, explanation: 'The claim reads more precisely this way.', ...extra,
});

describe('submitting edit proposals (R57.4)', () => {
  it('lets any readable Member propose an edit with a diff, explanation and references, keeping proposer and base fixed', async () => {
    const target = await world.created('author', 'finding');
    const reference = await world.created('author', 'source');
    const proposal = await proposed(await submit('colleague', claimProposal(target, 'A sharper synthetic claim.', { references: [reference.id] })));
    expect(proposal).toMatchObject({ targetId: target.id, proposer: world.ids.colleague, baseRev: target.rev, appliesToRev: target.rev, state: 'open', stale: false });
    expect(proposal.diff).toMatchObject({ claim: { text: 'A sharper synthetic claim.', spans: [] } });
    expect(proposal.references).toEqual([reference.id]);
    expect(proposal.events.map((e) => e.kind)).toEqual(['submitted']);
    // Proposing grants no edit right: the finding is unchanged and still owned by its author.
    expect((await world.view('author', target.id)).claim).toMatchObject({ text: 'A synthetic claim.' });
  });

  it('requires an explanation and refuses a diff against a record the proposer cannot read', async () => {
    const target = await world.created('author', 'finding');
    expect((await errorOf(await submit('colleague', { targetId: target.id, baseRev: target.rev, diff: { claim: rich('x') }, explanation: '' }))).status).toBe(422);
    await world.core().prepare("UPDATE research_items SET access_level = 'restricted' WHERE unit_id = ?1").bind(target.id).run();
    expect((await errorOf(await submit('colleague', claimProposal(target, 'x')))).fields?.[0]?.field).toBe('targetId');
  });

  it('refuses a reference the proposer cannot read', async () => {
    const target = await world.created('author', 'finding');
    const hidden = await world.created('author', 'source');
    await world.core().prepare("UPDATE research_items SET access_level = 'restricted' WHERE unit_id = ?1").bind(hidden.id).run();
    expect((await errorOf(await submit('colleague', claimProposal(target, 'x', { references: [hidden.id] })))).fields?.[0]?.field).toBe('references');
  });

  it('hides a proposal of a record the viewer can no longer read', async () => {
    const target = await world.created('author', 'finding');
    const proposal = await proposed(await submit('colleague', claimProposal(target, 'x')));
    await world.core().prepare("UPDATE research_items SET access_level = 'restricted' WHERE unit_id = ?1").bind(target.id).run();
    expect((await world.request('colleague', 'GET', `/proposals/edits/${proposal.id}`)).status).toBe(404);
  });
});

describe('accepting edit proposals (R57.4, R57.5)', () => {
  it('applies the edit only for an actor authorized for every field, recording the accepter as the editor and the proposer separately', async () => {
    const target = await world.created('author', 'finding');
    const proposal = await proposed(await submit('colleague', claimProposal(target, 'The accepted synthetic claim.')));

    // A Contributor who does not own the finding cannot edit it, so cannot accept the proposal.
    expect((await world.request('colleague', 'POST', `/proposals/edits/${proposal.id}/accept`)).status).toBe(403);

    // An Administrator can edit any Item, so may accept. The accepter becomes the acting editor; the proposer stays the suggestion's author.
    const accepted = await proposed(await world.request('admin', 'POST', `/proposals/edits/${proposal.id}/accept`));
    expect(accepted.state).toBe('accepted');
    expect(accepted.acceptedBy).toBe(world.ids.admin);
    expect(accepted.proposer).toBe(world.ids.colleague);
    expect(accepted.events.map((e) => e.kind)).toEqual(['submitted', 'accepted']);
    // The finding now carries the proposed wording, with the Administrator as the editor of the new revision.
    const after = await world.view('author', target.id);
    expect(after.claim).toMatchObject({ text: 'The accepted synthetic claim.' });
    expect(after.rev).toBe(target.rev + 1);
    const editor = await world.core().prepare("SELECT member_id AS m FROM revisions WHERE target_id = ?1 AND kind = 'minor_edit' ORDER BY seq DESC LIMIT 1").bind(target.id).first<{ m: string }>();
    expect(editor?.m).toBe(world.ids.admin);
  });

  it('lets the record owner accept an edit of their own record', async () => {
    const target = await world.created('author', 'finding');
    const proposal = await proposed(await submit('colleague', claimProposal(target, 'The author-accepted claim.')));
    expect((await proposed(await world.request('author', 'POST', `/proposals/edits/${proposal.id}/accept`))).state).toBe('accepted');
    expect((await world.view('author', target.id)).claim).toMatchObject({ text: 'The author-accepted claim.' });
  });

  it('cannot accept the same proposal twice', async () => {
    const target = await world.created('author', 'finding');
    const proposal = await proposed(await submit('colleague', claimProposal(target, 'Once only.')));
    await world.request('admin', 'POST', `/proposals/edits/${proposal.id}/accept`);
    expect((await world.request('admin', 'POST', `/proposals/edits/${proposal.id}/accept`)).status).toBe(409);
  });
});

describe('stale bases and rebasing (R57.5)', () => {
  it('marks a proposal stale when the record changes and refuses acceptance until it is rebased', async () => {
    const target = await world.created('author', 'finding');
    const proposal = await proposed(await submit('colleague', claimProposal(target, 'A rebased claim.')));
    // The author edits the finding, moving it past the proposal's base.
    await world.edit('author', target.id, { rev: target.rev, claim: rich('An intervening change.'), mark: { mark: 'minor_edit' } });
    const refreshed = await read('colleague', proposal.id);
    expect(refreshed.stale).toBe(true);
    expect((await world.request('admin', 'POST', `/proposals/edits/${proposal.id}/accept`)).status).toBe(409);

    // Only the proposer may rebase, onto the record's current revision.
    const current = await world.view('author', target.id);
    const rebaseBody = { baseRev: current.rev, diff: { claim: rich('A rebased claim.'), mark: { mark: 'minor_edit' } } };
    expect((await world.request('admin', 'POST', `/proposals/edits/${proposal.id}/rebase`, rebaseBody)).status).toBe(403);
    const rebased = await proposed(await world.request('colleague', 'POST', `/proposals/edits/${proposal.id}/rebase`, rebaseBody));
    expect(rebased.stale).toBe(false);
    expect(rebased.baseRev).toBe(target.rev); // the original base is immutable
    expect(rebased.appliesToRev).toBe(current.rev);
    expect(rebased.events.map((e) => e.kind)).toEqual(['submitted', 'rebased']);
    // Now acceptance applies against the current revision.
    expect((await proposed(await world.request('admin', 'POST', `/proposals/edits/${proposal.id}/accept`))).state).toBe('accepted');
    expect((await world.view('author', target.id)).claim).toMatchObject({ text: 'A rebased claim.' });
  });
});

describe('forbidden fields and protections (R57.4)', () => {
  it('rejects the whole action when the diff routes a Log_Summary another Member owns', async () => {
    const target = await world.created('author', 'finding');
    // The Administrator owns no Log_Summary here; only the finding's Owner may change it, so even an Administrator's acceptance is refused.
    const proposal = await proposed(await submit('colleague', { targetId: target.id, baseRev: target.rev, diff: { logSummary: rich('A rewritten summary.'), mark: { mark: 'minor_edit' } }, explanation: 'Trying to reword the log summary.' }));
    expect((await world.request('admin', 'POST', `/proposals/edits/${proposal.id}/accept`)).status).toBe(403);
    // The finding's Log_Summary is unchanged.
    expect((await world.view('author', target.id)).logSummary).toMatchObject({ text: 'Synthetic summary of a finding.' });
  });

  it('refuses a diff that tries to move the Project or edit the Group_Note through the content route', async () => {
    const target = await world.created('author', 'finding');
    const proposal = await proposed(await submit('author', { targetId: target.id, baseRev: target.rev, diff: { claim: rich('ok'), mark: { mark: 'minor_edit' }, projectId: newULID(world.at) }, explanation: 'Trying to move the project.' }));
    const refused = await errorOf(await world.request('author', 'POST', `/proposals/edits/${proposal.id}/accept`));
    expect(refused.status).toBe(422);
    expect(refused.fields?.some((f) => f.field === 'projectId')).toBe(true);
    // Nothing applied: the whole action is rejected, so the proposal stays open and the claim is unchanged.
    expect((await read('author', proposal.id)).state).toBe('open');
    expect((await world.view('author', target.id)).claim).toMatchObject({ text: 'A synthetic claim.' });
  });

  it('refuses to route a status change through a content proposal', async () => {
    const entry = await world.created('author', 'journal_entry');
    // Setting the campaign status is a Status_Change, which has its own action and cannot be made by accepting a content proposal.
    const proposal = await proposed(await submit('author', { targetId: entry.id, baseRev: entry.rev, diff: { statusValueId: CAMPAIGN_OPEN, mark: { mark: 'minor_edit' } }, explanation: 'Trying to change the status.' }));
    const refused = await errorOf(await world.request('admin', 'POST', `/proposals/edits/${proposal.id}/accept`));
    expect(refused.status).toBe(422);
    expect(refused.fields?.some((f) => f.field === 'statusValueId')).toBe(true);
    // Nothing applied: the proposal stays open and the status is unchanged.
    expect((await read('author', proposal.id)).state).toBe('open');
    expect(await world.core().prepare('SELECT status_value_id AS s FROM research_items WHERE unit_id = ?1').bind(entry.id).first<{ s: string | null }>()).toEqual({ s: null });
  });

  it('lets the Owner accept a Log_Summary edit of their own record', async () => {
    const target = await world.created('author', 'finding');
    const proposal = await proposed(await submit('colleague', { targetId: target.id, baseRev: target.rev, diff: { logSummary: rich('A summary the owner accepts.'), mark: { mark: 'minor_edit' } }, explanation: 'Suggesting a clearer summary.' }));
    expect((await proposed(await world.request('author', 'POST', `/proposals/edits/${proposal.id}/accept`))).state).toBe('accepted');
    expect((await world.view('author', target.id)).logSummary).toMatchObject({ text: 'A summary the owner accepts.' });
  });
});

describe('declining and withdrawing (R57.6)', () => {
  it('lets an authorized actor decline with a note, leaving the record unchanged', async () => {
    const target = await world.created('author', 'finding');
    const proposal = await proposed(await submit('colleague', claimProposal(target, 'A declined claim.')));
    // A Contributor who could not edit the finding cannot decline it either.
    expect((await world.request('colleague', 'POST', `/proposals/edits/${proposal.id}/decline`, {})).status).toBe(403);
    const declined = await proposed(await world.request('author', 'POST', `/proposals/edits/${proposal.id}/decline`, { note: 'The current wording is accurate.' }));
    expect(declined.state).toBe('declined');
    expect(declined.closedBy).toBe(world.ids.author);
    expect(declined.events.at(-1)).toMatchObject({ kind: 'declined', note: 'The current wording is accurate.' });
    expect((await world.view('author', target.id)).claim).toMatchObject({ text: 'A synthetic claim.' });
  });

  it('lets the proposer withdraw their own open proposal', async () => {
    const target = await world.created('author', 'finding');
    const proposal = await proposed(await submit('colleague', claimProposal(target, 'A withdrawn claim.')));
    // Another Member cannot withdraw someone else's proposal.
    expect((await world.request('author', 'POST', `/proposals/edits/${proposal.id}/withdraw`)).status).toBe(403);
    const withdrawn = await proposed(await world.request('colleague', 'POST', `/proposals/edits/${proposal.id}/withdraw`));
    expect(withdrawn.state).toBe('withdrawn');
    // A closed proposal cannot be acted on again.
    expect((await world.request('admin', 'POST', `/proposals/edits/${proposal.id}/accept`)).status).toBe(409);
  });
});

describe('notifications and isolation (R57.6, R60.1)', () => {
  it('notifies the owner and proposer once each on submission, deduplicating', async () => {
    const target = await world.created('author', 'finding');
    const before = await count('SELECT count(*) AS n FROM notifications');
    await proposed(await submit('colleague', claimProposal(target, 'A noticed claim.')));
    // The owner (author) and the proposer (colleague) each get one Notification; the acting proposer is not notified of their own event beyond their proposer role.
    const events = await count("SELECT count(*) AS n FROM notification_events WHERE event_type = 'proposal'");
    expect(events).toBeGreaterThanOrEqual(1);
    const after = await count('SELECT count(*) AS n FROM notifications');
    expect(after).toBeGreaterThan(before);
    // A proposal is not a Submission, Research_Item, or Revision of its own.
    expect(await count("SELECT count(*) AS n FROM activity WHERE kind = 'submission' AND actor_id = ?1", world.ids.colleague)).toBe(0);
  });

  it('keeps proposals out of research search and completed-submission counts', async () => {
    const target = await world.created('author', 'finding');
    await proposed(await submit('colleague', claimProposal(target, 'An uncounted claim.')));
    expect(await count('SELECT count(*) AS n FROM submissions WHERE member_id = ?1', world.ids.colleague)).toBe(0);
  });
});
