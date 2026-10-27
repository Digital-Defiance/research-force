import { describe, expect, it } from 'vitest';
import { newULID } from '@researchforce/domain/identifiers';
import { asTimestamp, asULID } from '@researchforce/domain/types';
import { isFollowUpDue } from '../src/records/kinds/archival';
import { errorOf, itemBody, itemWorld, RELATED, rich, RIGHTS_PUBLIC_DOMAIN, V } from './items';

const OUTCOME_COMPLETE = asULID('0000000000000000000000R002');
import type { ItemView } from './items';

const world = itemWorld();
const linkId = async (originId: string, targetId: string) => (await world.core().prepare('SELECT id FROM cross_links WHERE origin_id = ?1 AND target_id = ?2 AND removed_at IS NULL').bind(originId, targetId).first<string>('id'))!;
const removeLink = (id: string, who: 'author' | 'admin' = 'author') => world.request(who, 'DELETE', `/links/${id}`);
const LAST_EVIDENCE = { rule: 'evidence', message: 'This is the last Evidence_Link that the Finding_Status or Hypothesis_Status needs. Change the status first.' };
const status = async (id: string) => world.core().prepare('SELECT status_value_id AS s FROM research_items WHERE unit_id = ?1').bind(id).first<string>('s');

describe('Findings', () => {
  it('defaults to Open and refuses Confirmed without an Evidence_Link, counting links saved in the same Submission', async () => {
    expect((await world.created('author', 'finding')).statusValueId).toBe(V.findingOpen);
    const refused = await errorOf(await world.create('author', 'finding', itemBody('finding', world.projectId, { statusValueId: V.findingConfirmed })));
    expect(refused.fields).toEqual([{ field: 'statusValueId', rule: 'A Confirmed Finding needs at least one Evidence_Link, which can be added in the same save.' }]);
    const hypothesis = await world.created('author', 'hypothesis');
    const notEvidence = await errorOf(await world.create('author', 'finding', itemBody('finding', world.projectId, { statusValueId: V.findingConfirmed, evidence: [hypothesis.id] })));
    expect(notEvidence.fields?.[0]?.field).toBe('statusValueId');
    const source = await world.created('author', 'source');
    const confirmed = await world.created('author', 'finding', { statusValueId: V.findingConfirmed, evidence: [source.id] });
    expect(await world.core().prepare('SELECT origin_id AS o, target_id AS t, relation_value_id AS r, added_by AS b FROM cross_links WHERE target_id = ?1').bind(confirmed.id).first())
      .toEqual({ o: source.id, t: confirmed.id, r: V.relationEvidenceFor, b: world.ids.author });
  });

  it('counts an Evidence_Link in either direction with an Entry_Section, and refuses removing the last one', async () => {
    const entry = await world.created('author', 'journal_entry');
    const section = (entry['sections'] as { id: string }[])[0]!.id;
    const finding = await world.created('author', 'finding', { links: [{ targetId: section, relationValueId: V.relationEvidenceFor }] });
    expect((await world.edit('author', finding.id, { rev: 1, statusValueId: V.findingConfirmed })).status).toBe(200);
    const only = await linkId(finding.id, section);
    const refused = await errorOf(await removeLink(only, 'admin'));
    expect(refused).toMatchObject({ status: 422, error: 'rule', details: LAST_EVIDENCE });
    const run = await world.created('author', 'run');
    expect((await world.edit('author', finding.id, { rev: 2, evidence: [run.id] })).status).toBe(200);
    expect((await removeLink(only)).status).toBe(200);
    expect((await errorOf(await removeLink(await linkId(run.id, finding.id)))).details).toEqual(LAST_EVIDENCE);
    expect((await world.edit('author', finding.id, { rev: 3, statusValueId: V.findingOpen })).status).toBe(200);
    expect((await removeLink(await linkId(run.id, finding.id))).status).toBe(200);
  });

  it('needs a designated superseding Finding with a Cross_Link to it, and keeps that link while Superseded', async () => {
    const newer = await world.created('author', 'finding');
    const unrelated = await world.created('author', 'finding');
    const older = await world.created('author', 'finding', { links: [{ targetId: unrelated.id }] });
    const missing = await errorOf(await world.edit('author', older.id, { rev: 1, statusValueId: V.findingSuperseded }));
    expect(missing.fields).toEqual([{ field: 'supersededById', rule: 'A Superseded Finding needs the Finding that supersedes it.' }]);
    const unlinked = await errorOf(await world.edit('author', older.id, { rev: 1, statusValueId: V.findingSuperseded, supersededById: newer.id }));
    expect(unlinked.fields).toEqual([{ field: 'supersededById', rule: 'A Superseded Finding needs a Cross_Link to its superseding Finding, which can be added in the same save.' }]);
    const topic = await world.created('author', 'topic');
    for (const supersededById of [older.id, topic.id, newULID(world.at)]) {
      const wrong = await errorOf(await world.edit('author', older.id, { rev: 1, statusValueId: V.findingSuperseded, supersededById, links: [{ targetId: newer.id }, { targetId: topic.id }] }));
      expect(wrong.fields, supersededById).toEqual([{ field: 'supersededById', rule: 'Choose another existing Finding as the superseding Finding.' }]);
    }
    expect((await world.edit('author', older.id, { rev: 1, statusValueId: V.findingSuperseded, supersededById: newer.id, links: [{ targetId: newer.id, relationValueId: RELATED }] })).status).toBe(200);
    expect(await world.view('author', older.id)).toMatchObject({ statusValueId: V.findingSuperseded, supersededById: newer.id });
    const revision = await world.core().prepare("SELECT prev FROM revisions WHERE target_id = ?1 AND kind = 'status_change'").bind(older.id).first<string>('prev');
    expect(JSON.parse(revision!)).toEqual({ statusValueId: V.findingOpen, supersededById: null });
    const refused = await errorOf(await removeLink(await linkId(older.id, newer.id)));
    expect(refused.details).toEqual({ rule: 'superseding', message: 'This link joins a Superseded Finding to its superseding Finding. Change the Finding_Status first.' });
    expect((await removeLink(await linkId(older.id, unrelated.id))).status).toBe(200);
    expect((await world.edit('author', older.id, { rev: 2, statusValueId: V.findingOpen })).status).toBe(200);
    expect((await world.view('author', older.id))).not.toHaveProperty('supersededById');
    expect((await removeLink(await linkId(older.id, newer.id))).status).toBe(200);
    const created = await world.created('author', 'finding', { statusValueId: V.findingSuperseded, supersededById: newer.id, links: [{ targetId: newer.id }] });
    expect(created.supersededById).toBe(newer.id);
  });

  it('needs a reason for Withdrawn at submission and refuses withdrawal by edit', async () => {
    const refused = await errorOf(await world.create('author', 'finding', itemBody('finding', world.projectId, { statusValueId: V.findingWithdrawn, withdrawalReason: '  ' })));
    expect(refused.fields?.map((issue) => issue.field)).toEqual(['withdrawalReason']);
    const withdrawn = await world.created('author', 'finding', { statusValueId: V.findingWithdrawn, withdrawalReason: 'Recorded in error.' });
    expect(withdrawn).toMatchObject({ withdrawalReason: 'Recorded in error.', withdrawal: { at: world.at, by: { id: world.ids.author }, reason: 'Recorded in error.' } });
    const open = await world.created('author', 'finding');
    const byEdit = await errorOf(await world.edit('author', open.id, { rev: 1, statusValueId: V.findingWithdrawn, withdrawalReason: 'By edit.' }));
    expect(byEdit.fields?.map((issue) => issue.field)).toEqual(['statusValueId', 'withdrawalReason']);
    expect(await status(open.id)).toBe(V.findingOpen);
  });
});

describe('Sources and Runs', () => {
  it('stores a Source’s partial dates as given, its recoverer as a Party, and Unknown rights by default', async () => {
    const party = await world.party();
    const source = await world.created('author', 'source', {
      documentDate: { start: { value: '1943-05', approx: true }, end: { value: '1944', approx: false } }, recoverer: { kind: 'external', id: party },
      archiveOrCollection: 'A synthetic archive', archivalReference: 'SYN-1', reliabilityNote: rich('Synthetic note.'),
    });
    expect(source).toMatchObject({
      sourceKind: 'primary', documentDate: { start: { value: '1943-05', approx: true }, end: { value: '1944', approx: false } }, recoverer: { kind: 'external', id: party },
      rightsStatusId: V.rightsUnknown, archiveOrCollection: 'A synthetic archive', archivalReference: 'SYN-1',
    });
    expect(await world.core().prepare('SELECT item_date_key AS i, log_date_key AS l, log_date_is_creation AS c FROM research_items WHERE unit_id = ?1').bind(source.id).first())
      .toEqual({ i: '1943-05-01', l: '2026-10-27', c: 1 });
    const single = await world.created('author', 'source', { documentDate: { value: '1950', approx: false }, recoverer: { kind: 'member', id: world.ids.colleague }, rightsStatusId: RIGHTS_PUBLIC_DOMAIN });
    expect(single).toMatchObject({ documentDate: { value: '1950', approx: false }, recoverer: { kind: 'member', id: world.ids.colleague }, rightsStatusId: RIGHTS_PUBLIC_DOMAIN });
    const edited = await world.edit('author', single.id, { rev: 1, mark: { mark: 'minor_edit' }, documentDate: null, recoverer: null });
    expect(await edited.json()).toMatchObject({ item: { rev: 2 } });
    const after = await world.view('author', single.id);
    expect(after).not.toHaveProperty('documentDate');
    expect(after).not.toHaveProperty('recoverer');
    const bad = await errorOf(await world.create('author', 'source', itemBody('source', world.projectId, { recoverer: { kind: 'external', id: newULID(world.at) } })));
    expect(bad.fields?.map((issue) => issue.field)).toEqual(['recoverer.id']);
  });

  it('keeps a Run’s times as entered and its counts as digit strings, never numbers', async () => {
    const big = '123456789012345678901234567890';
    const run = await world.created('author', 'run', {
      startTime: '2026-10-01T09:30:15.123456+02:00', endTime: '2026-10-01T23:59:59Z', resumePoint: 'block 17', notes: rich('Synthetic notes.'),
      counts: [{ name: 'keys tested', value: big }, { name: 'hits', value: '0' }, { name: 'padded', value: '007' }],
    });
    expect(run).toMatchObject({ startTime: '2026-10-01T09:30:15.123456+02:00', endTime: '2026-10-01T23:59:59Z', counts: [{ name: 'keys tested', value: big }, { name: 'hits', value: '0' }, { name: 'padded', value: '007' }] });
    expect(await world.core().prepare("SELECT typeof(value) AS t, value FROM run_counts WHERE name = 'keys tested'").first()).toEqual({ t: 'text', value: big });
    expect(await world.core().prepare('SELECT start_key AS k FROM runs WHERE unit_id = ?1').bind(run.id).first('k')).toBe('2026-10-01T07:30:15.123Z');
    for (const [overrides, field] of [
      [{ startTime: '2026-10-01T09:30' }, 'startTime'], [{ endTime: '2026-10-01T07:30:14Z' }, 'endTime'], [{ counts: [{ name: 'n', value: 5 }] }, 'counts.0.value'],
      [{ counts: [{ name: 'n', value: '1' }, { name: 'n', value: '2' }] }, 'counts.1.name'], [{ counts: Array.from({ length: 21 }, (_value, index) => ({ name: `c${index}`, value: '1' })) }, 'counts'],
    ] as const) {
      expect((await errorOf(await world.create('author', 'run', itemBody('run', world.projectId, overrides)))).fields?.map((issue) => issue.field), field).toContain(field);
    }
    expect((await world.edit('author', run.id, { rev: 1, mark: { mark: 'minor_edit' }, counts: [{ name: 'hits', value: '2' }], toolVersion: '1.1', resumePoint: null, outcomeId: OUTCOME_COMPLETE })).status).toBe(200);
    const edited = await world.view('author', run.id);
    expect(edited).toMatchObject({ counts: [{ name: 'hits', value: '2' }], toolVersion: '1.1', outcomeId: OUTCOME_COMPLETE });
    expect(edited).not.toHaveProperty('resumePoint');
    const revisions = await world.core().prepare('SELECT kind, prev FROM revisions WHERE target_id = ?1 ORDER BY kind').bind(run.id).all<{ kind: string; prev: string }>();
    expect(revisions.results.map((row) => [row.kind, Object.keys(JSON.parse(row.prev)).sort()])).toEqual([['minor_edit', ['counts', 'resumePoint', 'toolVersion']], ['status_change', ['outcomeId']]]);
  });
});

describe('Hypotheses', () => {
  it('starts Open, and Eliminated needs a scope and an Evidence_Link with a Run or Finding', async () => {
    const run = await world.created('author', 'run');
    const refused = await errorOf(await world.create('author', 'hypothesis', itemBody('hypothesis', world.projectId, { statusValueId: V.hypothesisEliminated, eliminationScope: rich('All of it.'), evidence: [run.id] })));
    expect(refused.fields).toEqual([{ field: 'statusValueId', rule: 'A new Hypothesis starts Open.' }]);
    const hypothesis = await world.created('author', 'hypothesis', { links: [{ targetId: run.id, relationValueId: RELATED }] });
    expect(hypothesis.statusValueId).toBe(V.hypothesisOpen);
    const noScope = await errorOf(await world.edit('author', hypothesis.id, { rev: 1, statusValueId: V.hypothesisEliminated }));
    expect(noScope.fields?.map((issue) => issue.field)).toEqual(['eliminationScope']);
    const source = await world.created('author', 'source');
    const sourceOnly = await errorOf(await world.edit('author', hypothesis.id, { rev: 1, statusValueId: V.hypothesisEliminated, eliminationScope: rich('Keys 0 to 99.'), evidence: [source.id] }));
    expect(sourceOnly.fields).toEqual([{ field: 'statusValueId', rule: 'An Eliminated Hypothesis needs an Evidence_Link with a Run or Finding, which can be added in the same save.' }]);
    expect((await world.edit('author', hypothesis.id, { rev: 1, statusValueId: V.hypothesisEliminated, eliminationScope: rich('Keys 0 to 99.'), evidence: [run.id] })).status).toBe(200);
    expect((await errorOf(await removeLink(await linkId(run.id, hypothesis.id), 'admin'))).details).toEqual(LAST_EVIDENCE);
  });

  it('requires a Correction for a scope change while Eliminated, and a reason for reopening, recording the previous scope', async () => {
    const run = await world.created('author', 'run');
    const hypothesis = await world.created('author', 'hypothesis', { evidence: [run.id] });
    expect((await world.edit('author', hypothesis.id, { rev: 1, statusValueId: V.hypothesisEliminated, eliminationScope: rich('Keys 0 to 99.') })).status).toBe(200);
    const minor = await errorOf(await world.edit('author', hypothesis.id, { rev: 2, mark: { mark: 'minor_edit' }, eliminationScope: rich('Keys 0 to 199.') }));
    expect(minor.fields).toEqual([{ field: 'mark', rule: 'A change to the Elimination Scope of an Eliminated Hypothesis must be marked as a Correction with a reason.' }]);
    expect((await world.edit('author', hypothesis.id, { rev: 2, mark: { mark: 'correction', reason: 'Range was wider.' }, eliminationScope: rich('Keys 0 to 199.') })).status).toBe(200);
    const unreasoned = await errorOf(await world.edit('author', hypothesis.id, { rev: 3, statusValueId: V.hypothesisOpen }));
    expect(unreasoned.fields).toEqual([{ field: 'statusReason', rule: 'Give a reason for reopening the Hypothesis.' }]);
    expect((await world.edit('colleague', hypothesis.id, { rev: 3, statusValueId: V.hypothesisOpen, statusReason: 'Not me.' })).status).toBe(403);
    expect((await world.edit('admin', hypothesis.id, { rev: 3, statusValueId: V.hypothesisOpen, statusReason: 'The run had a bug.' })).status).toBe(200);
    const reopened = await world.view('author', hypothesis.id);
    expect(reopened.statusValueId).toBe(V.hypothesisOpen);
    expect(reopened).not.toHaveProperty('eliminationScope');
    const revision = await world.core().prepare("SELECT member_id AS m, reason, prev FROM revisions WHERE target_id = ?1 AND kind = 'status_change' ORDER BY seq DESC").bind(hypothesis.id).first<{ m: string; reason: string; prev: string }>();
    expect({ ...revision, prev: JSON.parse(revision!.prev) }).toEqual({ m: world.ids.admin, reason: 'The run had a bug.', prev: { statusValueId: V.hypothesisEliminated, eliminationScope: rich('Keys 0 to 199.') } });
    expect((await errorOf(await world.edit('author', hypothesis.id, { rev: 4, mark: { mark: 'minor_edit' }, eliminationScope: rich('Stray.') }))).fields)
      .toEqual([{ field: 'eliminationScope', rule: 'Only an Eliminated Hypothesis has an Elimination Scope.' }]);
    expect((await world.edit('author', hypothesis.id, { rev: 4, mark: { mark: 'minor_edit' }, title: 'Renamed', statusReason: 'No status change.' })).status).toBe(422);
  });
});

describe('Correspondences', () => {
  const parties = (...list: { kind: 'member' | 'external'; id: string; consent?: string }[]) => list;

  it('records one Consent_Status per External_Party, initially Not_Asked, and needs two distinct Parties', async () => {
    const party = await world.party();
    const item = await world.created('author', 'correspondence', { parties: parties({ kind: 'member', id: world.ids.author }, { kind: 'external', id: party }) });
    expect(item['parties']).toEqual([{ kind: 'member', id: world.ids.author }, { kind: 'external', id: party, consent: 'not_asked' }]);
    expect(await world.core().prepare('SELECT party_kind AS k, consent_status AS c FROM correspondence_parties ORDER BY position').all().then((rows) => rows.results))
      .toEqual([{ k: 'member', c: null }, { k: 'external', c: 'not_asked' }]);
    const one = await errorOf(await world.create('author', 'correspondence', itemBody('correspondence', world.projectId, { parties: parties({ kind: 'external', id: party }) })));
    expect(one.fields?.map((issue) => issue.field)).toEqual(['parties']);
    const twice = await errorOf(await world.create('author', 'correspondence', itemBody('correspondence', world.projectId, { parties: parties({ kind: 'external', id: party }, { kind: 'external', id: party, consent: 'granted' }) })));
    expect(twice.fields?.map((issue) => issue.field)).toEqual(['parties.1']);
    const future = await errorOf(await world.create('author', 'correspondence', itemBody('correspondence', world.projectId, { date: { value: '2026-10-28', approx: false }, parties: parties({ kind: 'member', id: world.ids.author }, { kind: 'external', id: party }) })));
    expect(future.fields?.map((issue) => issue.field)).toEqual(['date']);
  });

  it('withholds a Public Correspondence in the same save when an External_Party lacks a Granted consent', async () => {
    const [granted, added] = [await world.party(), await world.party()];
    const item = await world.created('author', 'correspondence', { parties: parties({ kind: 'member', id: world.ids.author }, { kind: 'external', id: granted, consent: 'granted' }) });
    await world.core().prepare("UPDATE units SET disclosure_level = 'public' WHERE id = ?1").bind(item.id).run();
    expect((await world.edit('colleague', item.id, { rev: 1, mark: { mark: 'minor_edit' }, title: 'Not mine' })).status).toBe(403);
    const response = await world.edit('author', item.id, {
      rev: 1, mark: { mark: 'minor_edit' },
      parties: parties({ kind: 'member', id: world.ids.author }, { kind: 'external', id: granted, consent: 'granted' }, { kind: 'external', id: added }),
    });
    expect(response.status).toBe(200);
    const line = { kindOfMaterial: 'correspondence', date: { value: '2026-10-01', approx: false }, partyIds: [world.ids.author, granted, added] };
    expect((await response.json<{ item: ItemView }>()).item.disclosure).toEqual({ level: 'withheld', effective: 'private', line });
    const revisions = await world.core().prepare('SELECT kind, member_id AS m, prev FROM revisions WHERE target_id = ?1 ORDER BY kind').bind(item.id).all<{ kind: string; m: string; prev: string }>();
    expect(revisions.results.map((row) => ({ ...row, prev: JSON.parse(row.prev) }))).toEqual([
      { kind: 'disclosure_change', m: world.ids.author, prev: { disclosureLevel: 'public', disclosureLine: null } },
      { kind: 'minor_edit', m: world.ids.author, prev: { parties: [{ kind: 'member', id: world.ids.author }, { kind: 'external', id: granted, consent: 'granted' }] } },
    ]);
    expect(await world.core().prepare('SELECT rev FROM units WHERE id = ?1').bind(item.id).first('rev')).toBe(2);
  });

  it('withholds a Public Correspondence that loses a Granted consent, and leaves a Private one alone', async () => {
    const party = await world.party();
    const body = { parties: parties({ kind: 'member', id: world.ids.author }, { kind: 'external', id: party, consent: 'granted' }) };
    const [shown, hidden] = [await world.created('author', 'correspondence', body), await world.created('author', 'correspondence', body)];
    await world.core().prepare("UPDATE units SET disclosure_level = 'public' WHERE id = ?1").bind(shown.id).run();
    const refusing = { rev: 1, mark: { mark: 'minor_edit' }, parties: parties({ kind: 'member', id: world.ids.author }, { kind: 'external', id: party, consent: 'refused' }) };
    expect((await world.edit('author', shown.id, refusing)).status).toBe(200);
    expect((await world.edit('author', hidden.id, refusing)).status).toBe(200);
    expect((await world.view('author', shown.id)).disclosure.level).toBe('withheld');
    expect((await world.view('author', hidden.id))['parties']).toEqual(refusing.parties);
    expect((await world.view('author', hidden.id)).disclosure.level).toBe('private');
    expect((await world.edit('author', shown.id, { rev: 2, mark: { mark: 'minor_edit' }, title: 'Still withheld' })).status).toBe(200);
  });
});

describe('Archival_Requests and Topics', () => {
  it('records the archive and contact as Parties, and the Sent and Replied rules', async () => {
    const archive = await world.party('A synthetic archive');
    const base = { archiveOrDesk: { kind: 'external', id: archive }, contact: { kind: 'member', id: world.ids.colleague } };
    const sentWithoutDate = await errorOf(await world.create('author', 'archival_request', itemBody('archival_request', world.projectId, { ...base, statusValueId: V.archivalSent })));
    expect(sentWithoutDate.fields?.map((issue) => issue.field)).toEqual(['dateSent']);
    const request = await world.created('author', 'archival_request', { ...base, statusValueId: V.archivalSent, dateSent: { value: '2026-09-01', approx: false }, channel: 'email' });
    expect(request).toMatchObject({ ...base, statusValueId: V.archivalSent, dateSent: { value: '2026-09-01', approx: false }, channel: 'email' });
    const replied = await errorOf(await world.edit('author', request.id, { rev: 1, statusValueId: V.archivalReplied }));
    expect(replied.fields?.map((issue) => issue.field)).toEqual(['replyDate', 'replyContent']);
    const early = await errorOf(await world.edit('author', request.id, { rev: 1, mark: { mark: 'minor_edit' }, statusValueId: V.archivalReplied, replyDate: { value: '2026-08-31', approx: false }, replyContent: rich('Yes.') }));
    expect(early.fields?.map((issue) => issue.field)).toEqual(['replyDate']);
    expect((await world.edit('author', request.id, { rev: 1, mark: { mark: 'minor_edit' }, statusValueId: V.archivalReplied, replyDate: { value: '2026-10-20', approx: false }, replyContent: rich('Records found.') })).status).toBe(200);
    expect(await world.view('author', request.id)).toMatchObject({ replyDate: { value: '2026-10-20', approx: false }, replyContent: rich('Records found.'), groupNote: null });
    expect(await world.core().prepare('SELECT count(*) AS n FROM replies').first('n')).toBe(0);
  });

  it('marks a Sent request Follow_Up_Due after the interval in the Owner’s time zone', () => {
    const now = asTimestamp('2026-10-31T23:30:00.000Z');
    const sent = { statusValueId: V.archivalSent, dateSent: { value: '2026-10-01', approx: false }, withdrawn: false };
    expect(isFollowUpDue(sent, 30, 'UTC', now)).toBe(true);
    expect(isFollowUpDue(sent, 31, 'UTC', now)).toBe(false);
    expect(isFollowUpDue(sent, 31, 'Pacific/Kiritimati', now)).toBe(true);
    expect(isFollowUpDue(sent, 30, 'America/Los_Angeles', now)).toBe(true);
    expect(isFollowUpDue({ ...sent, dateSent: { value: '2026-10-02', approx: false } }, 30, 'America/Los_Angeles', now)).toBe(false);
    expect(isFollowUpDue({ ...sent, withdrawn: true }, 30, 'UTC', now)).toBe(false);
    expect(isFollowUpDue({ ...sent, statusValueId: V.archivalReplied }, 30, 'UTC', now)).toBe(false);
    expect(isFollowUpDue({ ...sent, dateSent: null }, 30, 'UTC', now)).toBe(false);
  });

  it('stores a Topic’s title and body without a Log_Summary', async () => {
    const topic = await world.created('colleague', 'topic', { logSummary: undefined, body: rich('What should we test next?') });
    expect(topic).toMatchObject({ kind: 'topic', title: 'A synthetic topic', body: rich('What should we test next?') });
    expect((await errorOf(await world.create('colleague', 'topic', itemBody('topic', world.projectId, { body: rich(' ') })))).fields?.map((issue) => issue.field)).toEqual(['body.text']);
    expect((await world.edit('colleague', topic.id, { rev: 1, mark: { mark: 'minor_edit' }, body: rich('What next, then?') })).status).toBe(200);
    expect((await world.view('author', topic.id))['body']).toEqual(rich('What next, then?'));
  });
});
