import { describe, expect, it } from 'vitest';
import { GuardedBatch, GuardViolation } from '@researchforce/db/batch';
import { newULID } from '@researchforce/domain/identifiers';
import { guardLogSummaryOwner } from '../src/records/log-summary';
import { CAMPAIGN_OPEN, errorOf, itemBody, itemWorld, rich } from './items';
import type { ItemView } from './items';

const world = itemWorld();
const sectionIds = (item: ItemView) => (item['sections'] as { id: string }[]).map((section) => section.id);
const sectionTexts = (item: ItemView) => (item['sections'] as { content: { text: string } }[]).map((section) => section.content.text);
const counts = async () => JSON.stringify((await world.core().batch(['units', 'research_items', 'journal_entries', 'entry_sections', 'submissions', 'replies', 'revisions', 'cross_links']
  .map((table) => world.core().prepare(`SELECT count(*) AS n FROM ${table}`)))).map((result) => result.results));

describe('Journal_Entries', () => {
  it('stores the whole entry as one Submission with the Owner, Credit, Project, and each unit’s disclosure', async () => {
    const response = await world.create('author', 'journal_entry', itemBody('journal_entry', world.projectId, {
      logSummary: undefined, statusValueId: CAMPAIGN_OPEN, phaseId: 'P-7', startDate: { value: '2026-09', approx: true }, endDate: { value: '2026-10-02', approx: false },
      relatedMemberIds: [world.ids.colleague, world.ids.admin],
    }));
    expect(response.status).toBe(201);
    const { item } = await response.json<{ item: ItemView }>();
    expect(item).toMatchObject({
      kind: 'journal_entry', title: 'A synthetic journal_entry', rev: 1, createdAt: world.at, statusValueId: CAMPAIGN_OPEN, phaseId: 'P-7',
      startDate: { value: '2026-09', approx: true }, endDate: { value: '2026-10-02', approx: false }, relatedMemberIds: [world.ids.colleague, world.ids.admin],
      project: { id: world.projectId, name: expect.stringMatching(/^Synthetic project/u) },
      owner: { id: world.ids.author, displayName: `Member ${world.ids.author}`, specialties: [{ id: expect.any(String), name: 'Historian' }] },
      credit: [{ member: { id: world.ids.author, displayName: `Member ${world.ids.author}` } }],
      disclosure: { level: 'not_published', effective: 'not_published' }, withdrawal: null, groupNote: null,
    });
    expect(item.identifier).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/u);
    expect(item).not.toHaveProperty('logSummary');
    expect(sectionTexts(item)).toEqual(['First synthetic section.', 'Second synthetic section.']);
    expect((item['sections'] as { disclosure: unknown }[]).map((section) => section.disclosure)).toEqual([{ level: 'not_published', effective: 'not_published' }, { level: 'not_published', effective: 'not_published' }]);
    const submission = await world.core().prepare('SELECT s.member_id AS m, s.completed_at AS c, s.has_group_note AS g FROM submissions s JOIN units u ON u.submission_id = s.id WHERE u.id = ?1').bind(item.id).first();
    expect(submission).toEqual({ m: world.ids.author, c: world.at, g: 0 });
    expect(await world.core().prepare("SELECT count(*) AS n FROM units WHERE root_id = ?1 AND unit_type = 'entry_section' AND submission_id = (SELECT submission_id FROM units WHERE id = ?1)").bind(item.id).first('n')).toBe(2);
    expect(await world.core().prepare('SELECT item_date_key AS i, log_date_key AS l, log_date_is_creation AS c FROM research_items WHERE unit_id = ?1').bind(item.id).first())
      .toEqual({ i: '2026-09-01', l: '2026-09-01', c: 0 });
  });

  it('refuses an entry without sections, with a blank title or section, or with the end before the start, storing nothing', async () => {
    const before = await counts();
    const refusals = [
      [{ sections: [] }, 'sections'], [{ title: '   ' }, 'title'], [{ sections: [{ content: rich(' ') }] }, 'sections.0.content.text'],
      [{ startDate: { value: '2026-10-02', approx: false }, endDate: { value: '2026-10-01', approx: false } }, 'endDate'],
      [{ statusValueId: newULID(world.at) }, 'statusValueId'], [{ sections: [{ id: newULID(world.at), content: rich('Named.') }] }, 'sections.0.id'],
    ] as const;
    for (const [overrides, field] of refusals) {
      const error = await errorOf(await world.create('author', 'journal_entry', itemBody('journal_entry', world.projectId, overrides)));
      expect(error.status, field).toBe(422);
      expect(error.fields?.map((issue) => issue.field), field).toContain(field);
    }
    expect(await counts()).toBe(before);
  });

  it('keeps each surviving section’s unit, level, classification, Revisions, and links through add, change, reorder, and remove', async () => {
    const entry = await world.created('author', 'journal_entry', { sections: ['One.', 'Two.', 'Three.', 'Four.'].map((text) => ({ content: rich(text) })) });
    const [one, two, three, four] = sectionIds(entry) as [string, string, string, string];
    await world.core().prepare("UPDATE units SET disclosure_level = 'public', classification_state = 'classified' WHERE id = ?1").bind(two).run();
    await world.core().prepare("INSERT INTO revisions (id, target_type, target_id, root_id, kind, member_id, at, prev, seq) VALUES (?1, 'unit', ?2, ?3, 'disclosure_change', ?4, ?5, '{}', 0)")
      .bind(newULID(world.at), two, entry.id, world.ids.admin, world.at).run();
    const other = await world.created('author', 'topic');
    expect((await world.request('author', 'POST', '/links', { originId: other.id, targetId: two })).status).toBe(201);

    const response = await world.edit('author', entry.id, {
      rev: entry.rev, mark: { mark: 'minor_edit' },
      sections: [{ id: three, content: rich('Three.') }, { content: rich('New.') }, { id: two, content: rich('Two, changed.') }, { id: four, content: rich('Four.') }],
    });
    expect(response.status).toBe(200);
    const { item } = await response.json<{ item: ItemView }>();
    expect(sectionTexts(item)).toEqual(['Three.', 'New.', 'Two, changed.', 'Four.']);
    expect(sectionIds(item)).toEqual([three, expect.any(String), two, four]);
    expect((item['sections'] as { rev: number }[]).map((section) => section.rev)).toEqual([2, 1, 2, 1]);
    expect(await world.core().prepare('SELECT actor_id AS a FROM units WHERE id = ?1').bind(three).first('a')).toBe(world.ids.author);
    expect(await world.core().prepare('SELECT disclosure_level AS l, classification_state AS c, position AS p FROM units WHERE id = ?1').bind(two).first()).toEqual({ l: 'public', c: 'classified', p: 2 });
    expect(await world.core().prepare("SELECT count(*) AS n FROM revisions WHERE target_id = ?1 AND kind = 'disclosure_change'").bind(two).first('n')).toBe(1);
    expect(await world.core().prepare('SELECT count(*) AS n FROM cross_links WHERE target_id = ?1 AND removed_at IS NULL').bind(two).first('n')).toBe(1);
    expect(await world.core().prepare('SELECT count(*) AS n FROM units WHERE id = ?1').bind(one).first('n')).toBe(0);
    expect(await world.core().prepare('SELECT count(*) AS n FROM entry_sections WHERE unit_id = ?1').bind(one).first('n')).toBe(0);
    const revision = await world.core().prepare("SELECT kind, member_id AS m, prev FROM revisions WHERE target_id = ?1 AND kind = 'minor_edit'").bind(entry.id).first<{ kind: string; m: string; prev: string }>();
    expect(revision?.m).toBe(world.ids.author);
    expect(JSON.parse(revision!.prev)).toEqual({ sections: { order: [one, two, three, four], content: { [one]: rich('One.'), [two]: rich('Two.') } } });
    expect(item.rev).toBe(2);
  });

  it('saves metadata edits as a Minor_Edit or Correction and the Campaign_Status as a Status_Change', async () => {
    const entry = await world.created('author', 'journal_entry', { phaseId: 'P-1', relatedMemberIds: [world.ids.colleague] });
    const response = await world.edit('author', entry.id, {
      rev: 1, mark: { mark: 'minor_edit' }, phaseId: 'P-2', statusValueId: CAMPAIGN_OPEN, startDate: { value: '2026-10', approx: false }, endDate: { value: '2026-10-20', approx: true },
      relatedMemberIds: [world.ids.admin, world.ids.author],
    });
    expect(response.status).toBe(200);
    expect((await world.view('colleague', entry.id))).toMatchObject({
      phaseId: 'P-2', statusValueId: CAMPAIGN_OPEN, startDate: { value: '2026-10', approx: false }, endDate: { value: '2026-10-20', approx: true }, relatedMemberIds: [world.ids.admin, world.ids.author],
    });
    expect(await world.core().prepare('SELECT item_date_key AS i FROM research_items WHERE unit_id = ?1').bind(entry.id).first('i')).toBe('2026-10-01');
    const revisions = await world.core().prepare('SELECT kind, prev FROM revisions WHERE target_id = ?1 ORDER BY kind').bind(entry.id).all<{ kind: string; prev: string }>();
    expect(revisions.results.map((row) => [row.kind, JSON.parse(row.prev)])).toEqual([
      ['minor_edit', { phaseId: 'P-1', startDate: null, endDate: null, relatedMemberIds: [world.ids.colleague] }],
      ['status_change', { statusValueId: null }],
    ]);
    expect((await world.edit('author', entry.id, { rev: 2, mark: { mark: 'minor_edit' }, relatedMemberIds: null, phaseId: null, statusValueId: null })).status).toBe(200);
    const cleared = await world.view('author', entry.id);
    for (const field of ['relatedMemberIds', 'phaseId', 'statusValueId']) expect(cleared, field).not.toHaveProperty(field);
    const plain = await world.created('author', 'journal_entry');
    expect((await world.edit('author', plain.id, { rev: 1, mark: { mark: 'minor_edit' }, title: 'Renamed', relatedMemberIds: [] })).status).toBe(200);
    expect(JSON.parse((await world.core().prepare('SELECT prev FROM revisions WHERE target_id = ?1').bind(plain.id).first<string>('prev'))!)).toEqual({ title: 'A synthetic journal_entry' });
  });

  it('refuses removing every section, a section of another entry, and a stale edit, and changes nothing', async () => {
    const entry = await world.created('author', 'journal_entry');
    const other = await world.created('author', 'journal_entry');
    expect((await errorOf(await world.edit('author', entry.id, { rev: 1, mark: { mark: 'minor_edit' }, sections: [] }))).fields?.[0]?.field).toBe('sections');
    const foreign = await errorOf(await world.edit('author', entry.id, { rev: 1, mark: { mark: 'minor_edit' }, sections: [{ id: sectionIds(other)[0], content: rich('Moved.') }] }));
    expect(foreign.fields).toEqual([{ field: 'sections.0.id', rule: 'This Entry Section does not belong to this Journal Entry.' }]);
    expect((await world.edit('author', entry.id, { rev: 1, mark: { mark: 'minor_edit' }, title: 'Renamed' })).status).toBe(200);
    const stale = await errorOf(await world.edit('author', entry.id, { rev: 1, mark: { mark: 'minor_edit' }, title: 'Again' }));
    expect(stale).toMatchObject({ status: 409, error: 'conflict', details: { rev: 2, revisions: [{ kind: 'minor_edit', memberId: world.ids.author }] } });
    expect(await world.view('author', entry.id)).toMatchObject({ title: 'Renamed', rev: 2 });
    expect(sectionIds(await world.view('author', other.id))).toEqual(sectionIds(other));
  });

  it('lets an entry above the caps shrink or keep its size but not grow (R4.4)', async () => {
    const entry = await world.created('author', 'journal_entry', { sections: Array.from({ length: 5000 }, (_value, index) => ({ content: rich(`S${index}`) })) });
    const sections = (entry['sections'] as { id: string; content: unknown }[]).map(({ id, content }) => ({ id, content }));
    const grown = await errorOf(await world.edit('author', entry.id, { rev: 1, mark: { mark: 'minor_edit' }, sections: [...sections, { content: rich('One more.') }] }));
    expect(grown.fields?.map((issue) => issue.field)).toEqual(['sections']);
    await world.core().prepare("UPDATE entry_sections SET text = 'X' WHERE unit_id = ?1").bind(sections[0]!.id).run();
    await world.core().prepare(`INSERT INTO units (id, unit_type, project_id, root_id, parent_id, position, owner_id, credit, submission_id, created_at, updated_seq)
      SELECT ?2, unit_type, project_id, root_id, parent_id, 5000, owner_id, credit, submission_id, created_at, 0 FROM units WHERE id = ?1`).bind(sections[0]!.id, newULID(world.at)).run();
    await world.core().prepare("INSERT INTO entry_sections (unit_id, text) SELECT id, 'Imported extra.' FROM units WHERE position = 5000 AND root_id = ?1").bind(entry.id).run();
    const current = await world.view('author', entry.id);
    const all = (current['sections'] as { id: string; content: unknown }[]).map(({ id, content }) => ({ id, content }));
    expect(all).toHaveLength(5001);
    expect((await world.edit('author', entry.id, { rev: current.rev, mark: { mark: 'minor_edit' }, sections: all.map((section, index) => (index === 1 ? { ...section, content: rich('Changed.') } : section)) })).status).toBe(200);
  }, 30_000);
});

describe('Log_Summaries and Group_Notes', () => {
  it('requires a Log_Summary at submission for every kind except Journal_Entry and Topic', async () => {
    for (const kind of ['finding', 'hypothesis', 'source', 'run'] as const) {
      const error = await errorOf(await world.create('author', kind, itemBody(kind, world.projectId, { logSummary: rich('  ') })));
      expect(error.fields, kind).toContainEqual({ field: 'logSummary', rule: 'This kind requires a Log Summary of 1 to 2000 Unicode code points.' });
    }
    expect((await world.create('author', 'topic', itemBody('topic', world.projectId, { logSummary: undefined }))).status).toBe(201);
  });

  it('refuses any Log_Summary change by another Member, even an Administrator, together with the rest of the request', async () => {
    const finding = await world.created('author', 'finding');
    for (const logSummary of [rich('Rewritten by someone else.'), rich('Synthetic summary of a finding.', [{ k: 'paraphrase', s: 0, e: 9, source: 'Someone' }]), null]) {
      const response = await world.edit('admin', finding.id, { rev: 1, mark: { mark: 'minor_edit' }, title: 'Also renamed', logSummary });
      expect(response.status).toBe(403);
    }
    const unchanged = await world.view('admin', finding.id);
    expect(unchanged).toMatchObject({ title: 'A synthetic finding', logSummary: rich('Synthetic summary of a finding.'), rev: 1 });
    expect((await world.edit('admin', finding.id, { rev: 1, mark: { mark: 'minor_edit' }, title: 'Renamed by an Administrator', logSummary: rich('Synthetic summary of a finding.') })).status).toBe(200);
  });

  it('lets the Owner change but not remove a Log_Summary, recording the previous text and labels', async () => {
    const finding = await world.created('author', 'finding', { logSummary: rich('Original summary.', [{ k: 'quote', s: 0, e: 8, source: 'A synthetic source' }]) });
    for (const logSummary of [null, rich(' \n ')]) {
      const error = await errorOf(await world.edit('author', finding.id, { rev: 1, mark: { mark: 'minor_edit' }, logSummary }));
      expect(error.fields).toEqual([{ field: 'logSummary', rule: 'An existing Log Summary can be changed but not removed.' }]);
    }
    expect((await world.edit('author', finding.id, { rev: 1, mark: { mark: 'correction', reason: 'Clearer wording.' }, logSummary: rich('Better summary.') })).status).toBe(200);
    const revision = await world.core().prepare("SELECT reason, prev FROM revisions WHERE target_id = ?1 AND kind = 'correction'").bind(finding.id).first<{ reason: string; prev: string }>();
    expect(revision?.reason).toBe('Clearer wording.');
    expect(JSON.parse(revision!.prev)).toEqual({ logSummary: rich('Original summary.', [{ k: 'quote', s: 0, e: 8, source: 'A synthetic source' }]) });
    const topic = await world.created('author', 'topic', { logSummary: undefined });
    expect((await world.edit('author', topic.id, { rev: 1, mark: { mark: 'minor_edit' }, logSummary: rich('Added later.') })).status).toBe(200);
    expect(JSON.parse((await world.core().prepare("SELECT prev FROM revisions WHERE target_id = ?1").bind(topic.id).first<{ prev: string }>())!.prev)).toEqual({ logSummary: null });
  });

  it('re-checks Log_Summary ownership inside the batch', async () => {
    const finding = await world.created('author', 'finding');
    const attempt = guardLogSummaryOwner(new GuardedBatch(world.core(), { id: world.ids.admin, now: world.at }), finding.id, world.ids.admin);
    await expect(attempt.commit()).rejects.toSatisfy((error) => error instanceof GuardViolation && error.code === 'log_summary_owner');
    await guardLogSummaryOwner(new GuardedBatch(world.core(), { id: world.ids.author, now: world.at }), finding.id, world.ids.author).commit();
  });

  it('posts a non-empty Group_Note first in the Thread, owned and credited by the submitter, in the same Submission', async () => {
    const item = await world.created('colleague', 'finding', { groupNote: rich('Please check the caveat.') });
    expect(item.groupNote).toMatchObject({ text: rich('Please check the caveat.'), owner: { id: world.ids.colleague }, withdrawn: false, disclosure: { level: 'not_published', effective: 'not_published' } });
    const row = await world.core().prepare(`SELECT u.unit_type AS t, u.parent_id AS p, u.root_id AS r, u.position AS pos, u.owner_id AS o, u.credit, u.submission_id = i.submission_id AS same, r2.is_group_note AS g, s.has_group_note AS hg
      FROM units u JOIN replies r2 ON r2.unit_id = u.id JOIN units i ON i.id = u.root_id JOIN submissions s ON s.id = i.submission_id WHERE u.root_id = ?1 AND u.unit_type = 'reply'`).bind(item.id).first();
    expect(row).toEqual({ t: 'reply', p: item.id, r: item.id, pos: 0, o: world.ids.colleague, credit: JSON.stringify([{ member: world.ids.colleague }]), same: 1, g: 1, hg: 1 });
    const blank = await world.created('colleague', 'finding', { groupNote: rich('  \n') });
    expect(blank.groupNote).toBeNull();
    expect(await world.core().prepare('SELECT has_group_note AS g FROM submissions s JOIN units u ON u.submission_id = s.id WHERE u.id = ?1').bind(blank.id).first('g')).toBe(0);
    const tooLong = await errorOf(await world.create('colleague', 'finding', itemBody('finding', world.projectId, { groupNote: rich('x'.repeat(50_001)) })));
    expect(tooLong.fields?.map((issue) => issue.field)).toEqual(['groupNote.text']);
  });

  it('refuses Group_Note, Project, and kind changes through an item edit', async () => {
    const item = await world.created('author', 'finding');
    const error = await errorOf(await world.edit('author', item.id, { rev: 1, groupNote: rich('Late.'), projectId: newULID(world.at), kind: 'topic' }));
    expect(error.fields?.map((issue) => issue.field)).toEqual(['kind', 'projectId', 'groupNote']);
  });
});

describe('item routes', () => {
  it('computes each unit’s Effective_Disclosure over the Project and Root_Item', async () => {
    const entry = await world.created('author', 'journal_entry', { groupNote: rich('A note.') });
    const [first] = sectionIds(entry);
    await world.core().batch([
      world.core().prepare("UPDATE projects SET disclosure_level = 'public'"),
      world.core().prepare("UPDATE units SET disclosure_level = 'public' WHERE id IN (?1, ?2)").bind(entry.id, first),
      world.core().prepare("UPDATE research_items SET public_presentation = 'full_content' WHERE unit_id = ?1").bind(entry.id),
    ]);
    const item = await world.view('colleague', entry.id);
    expect(item.disclosure).toEqual({ level: 'public', effective: 'public' });
    expect((item['sections'] as { disclosure: unknown }[]).map((section) => section.disclosure)).toEqual([{ level: 'public', effective: 'public' }, { level: 'not_published', effective: 'not_published' }]);
    expect(item.groupNote?.disclosure).toEqual({ level: 'not_published', effective: 'not_published' });
    await world.core().prepare("UPDATE projects SET disclosure_level = 'withheld', disclosure_line = '{}'").run();
    expect((await world.view('colleague', entry.id)).disclosure).toEqual({ level: 'public', effective: 'not_published' });
  });

  it('answers 404 for unknown kinds, unknown items, and another Member’s unfinished Submission', async () => {
    expect((await world.create('author', 'journal_entry' as never, {})).status).toBe(422);
    expect((await world.request('author', 'POST', '/items/journal_entry', {})).status).toBe(404);
    expect((await world.request('author', 'GET', `/items/${newULID(world.at)}`)).status).toBe(404);
    expect((await world.request('author', 'GET', '/items/not-an-id')).status).toBe(404);
    const item = await world.created('author', 'topic');
    await world.core().prepare('UPDATE submissions SET completed_at = NULL').run();
    expect((await world.request('colleague', 'GET', `/items/${item.id}`)).status).toBe(404);
    expect((await world.request('colleague', 'PATCH', `/items/${item.id}`, { rev: 1, title: 'X' })).status).toBe(404);
    expect((await world.request('author', 'GET', `/items/${item.id}`)).status).toBe(200);
  });

  it('needs item.correct for a Correction and link.add for links, and item.create or topic.create to submit', async () => {
    const response = await world.request('admin', 'POST', '/roles', { name: 'Editor', permissions: { 'item.create': 'any', 'item.edit': 'own' } });
    const { role } = await response.json<{ role: { id: string } }>();
    await world.core().prepare('UPDATE members SET role_id = ?2 WHERE id = ?1').bind(world.ids.colleague, role.id).run();
    expect((await world.create('colleague', 'topic', itemBody('topic', world.projectId))).status).toBe(403);
    const item = await world.created('colleague', 'finding');
    const other = await world.created('author', 'topic');
    expect((await world.create('colleague', 'finding', itemBody('finding', world.projectId, { links: [{ targetId: other.id }] }))).status).toBe(403);
    expect((await world.create('colleague', 'finding', itemBody('finding', world.projectId, { evidence: [other.id] }))).status).toBe(403);
    expect((await world.edit('colleague', item.id, { rev: 1, mark: { mark: 'correction', reason: 'Wrong claim.' }, claim: rich('Fixed.') })).status).toBe(403);
    expect((await world.edit('colleague', item.id, { rev: 1, evidence: [other.id] })).status).toBe(403);
    expect((await world.edit('colleague', item.id, { rev: 1, mark: { mark: 'minor_edit' }, claim: rich('Typo fixed.') })).status).toBe(200);
    expect((await world.view('author', item.id))['claim']).toEqual(rich('Typo fixed.'));
  });

  it('needs an existing Project, saying when an Administrator must first create one (R39.3)', async () => {
    const missing = await errorOf(await world.create('author', 'topic', itemBody('topic', world.projectId, { projectId: undefined, title: ' ' })));
    expect(missing.fields).toEqual([{ field: 'projectId', rule: 'Choose a Project for the Research Item.' }, { field: 'title', rule: expect.any(String) }]);
    await world.core().prepare('DELETE FROM projects').run();
    const none = await errorOf(await world.create('author', 'topic', itemBody('topic', world.projectId)));
    expect(none.fields).toEqual([{ field: 'projectId', rule: 'A Project is required, and none exists yet: an Administrator must first create one.' }]);
  });

  it('refuses edits by a Contributor who does not own the Item', async () => {
    const item = await world.created('author', 'topic');
    expect((await world.edit('colleague', item.id, { rev: 1, mark: { mark: 'minor_edit' }, title: 'Taken over' })).status).toBe(403);
    expect((await world.edit('admin', item.id, { rev: 1, mark: { mark: 'minor_edit' }, title: 'Fixed by an Administrator' })).status).toBe(200);
    expect((await world.edit('author', item.id, { rev: 2, mark: { mark: 'minor_edit' } })).status).toBe(200);
    expect((await world.view('author', item.id)).rev).toBe(2);
  });
});
