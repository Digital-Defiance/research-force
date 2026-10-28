import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BUILT_IN_VALUE_IDS, LOCKED_VALUE_IDS } from '@researchforce/domain/value-sets';
import { ItemDetails, ItemPage } from '../src/items/page';
import type { ItemPageData } from '../src/items/page';
import type { ItemView, LinkEntry } from '../src/types';
import { fakeApi, MEMBER_ID, OTHER_ID, renderScreen } from './helpers';
import { MEMBERS, makeItem, PARTY, RELIABILITY_HIGH, rich, RUN_COMPLETE, RUN_PARTIAL, VALUE_SETS } from './fixtures';

const data = (item: ItemView, extra: Partial<ItemPageData> = {}): ItemPageData => ({ item, valueSets: VALUE_SETS, parties: [PARTY], members: MEMBERS, links: [], backlinks: [], thread: [], ...extra });
const show = (item: ItemView, extra: Partial<ItemPageData> = {}) => renderScreen(<ItemDetails data={data(item, extra)} />, { client: fakeApi({}).client });
const terms = (section: HTMLElement) => [...section.querySelectorAll('dt')].map((term) => [term.textContent, term.nextElementSibling?.textContent]);

describe('the item page', () => {
  it('shows a Finding’s status and Scope_Caveat with its claim, and the superseding Finding with the status (R5.6, R5.10)', () => {
    show(makeItem({ kind: 'finding', claim: rich('The tiles repeat.'), scopeCaveat: rich('Only for the sample.'), statusValueId: BUILT_IN_VALUE_IDS.findingSuperseded, supersededById: 'NEWER' }));
    const claim = screen.getByRole('region', { name: 'Claim' });
    expect(claim.textContent).toContain('The tiles repeat.');
    expect(terms(claim)).toEqual([['Finding status', 'Superseded'], ['Superseded by', 'The superseding Finding'], ['Scope caveat', 'Only for the sample.']]);
    expect(within(claim).getByRole('link', { name: 'The superseding Finding' }).getAttribute('href')).toBe('/items/NEWER');
  });

  it('shows a Source’s kind and reliability together (R6.3)', () => {
    show(makeItem({ kind: 'source', sourceKind: 'primary', reliabilityId: RELIABILITY_HIGH, archiveOrCollection: 'Box 4', recoverer: { kind: 'external', id: PARTY.id } }));
    expect(terms(screen.getByRole('region', { name: 'Source kind and reliability' }))).toEqual([['Source kind', 'Primary'], ['Reliability', 'High']]);
    expect(terms(screen.getByRole('region', { name: 'Fields' }))).toEqual([['Archive or collection', 'Box 4'], ['Recoverer', 'County Archive']]);
  });

  it('shows a Run’s Resume_Point, or that none is recorded, with a Partial, Suspended, or Stopped outcome (R7.4)', () => {
    const run = (outcomeId: string, resumePoint?: string) => makeItem({ kind: 'run', outcomeId, ...(resumePoint === undefined ? {} : { resumePoint }), counts: [{ name: 'tiles', value: '9' }] });
    const partial = show(run(RUN_PARTIAL));
    expect(terms(screen.getByRole('region', { name: 'Run outcome' }))).toEqual([['Run outcome', 'Partial'], ['Resume point', 'No resume point is recorded.']]);
    partial.unmount();
    const resumable = show(run(RUN_PARTIAL, 'Tile 1200'));
    expect(terms(screen.getByRole('region', { name: 'Run outcome' }))).toEqual([['Run outcome', 'Partial'], ['Resume point', 'Tile 1200']]);
    expect(terms(screen.getByRole('region', { name: 'Fields' }))).toEqual([['Counts', 'tiles: 9']]);
    resumable.unmount();
    show(run(RUN_COMPLETE));
    expect(terms(screen.getByRole('region', { name: 'Run outcome' }))).toEqual([['Run outcome', 'Complete']]);
  });

  it('shows the Elimination_Scope immediately after an Eliminated status (R8.3)', () => {
    const eliminated = show(makeItem({ kind: 'hypothesis', statement: rich('It was the river.'), statusValueId: LOCKED_VALUE_IDS.hypothesisEliminated, eliminationScope: rich('The whole river, 1940 to 1945.') }));
    const block = screen.getByRole('region', { name: 'Hypothesis status' });
    expect(terms(block)).toEqual([['Hypothesis status', 'Eliminated'], ['Elimination scope', 'The whole river, 1940 to 1945.']]);
    expect(block.querySelector('dt + dd + dt')?.textContent).toBe('Elimination scope');
    eliminated.unmount();
    show(makeItem({ kind: 'hypothesis', statusValueId: LOCKED_VALUE_IDS.hypothesisOpen, eliminationScope: rich('Old scope.') }));
    expect(terms(screen.getByRole('region', { name: 'Hypothesis status' }))).toEqual([['Hypothesis status', 'Open']]);
  });

  it('links the Owner and every credited Member to their Profiles, with the Owner’s Specialties (R3.5)', () => {
    show(makeItem({ kind: 'topic', credit: [{ member: { id: MEMBER_ID, displayName: 'Ada Example' } }, { member: { id: OTHER_ID, displayName: 'Ben Sample' } }, { outside: { name: 'A visitor' } }, { imported: 'Journal author' }] }));
    const people = screen.getByRole('region', { name: 'Owner and Credit' });
    expect(within(people).getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Ada Example', `/members/${MEMBER_ID}`], ['Ada Example', `/members/${MEMBER_ID}`], ['Ben Sample', `/members/${OTHER_ID}`],
    ]);
    expect(people.textContent).toContain('(Historian)');
    expect(people.textContent).toContain('A visitor');
    expect(people.textContent).toContain('Journal author');
  });

  it('names the Project and shows the Disclosure_Level and Effective_Disclosure of the item and its sections (R23.9, R39.15)', () => {
    const view = show(makeItem({
      kind: 'journal_entry', disclosure: { level: 'public', effective: 'withheld', line: 'Kept back for now.' },
      sections: [{ id: 'S1', content: rich('First section.'), rev: 1, disclosure: { level: 'private', effective: 'private' } }],
    }));
    expect(view.container.textContent).toContain('Project: Synthetic project');
    expect(view.container.textContent).toContain('Disclosure level: Public; effective disclosure: Withheld');
    expect(view.container.textContent).toContain('Kept back for now.');
    expect(screen.getByRole('region', { name: 'Entry Section 1' }).textContent).toContain('Disclosure level: Private; effective disclosure: Private');
  });

  it('shows the Log_Summary with its author, or that none is recorded, and the Group_Note labelled first in the Thread (R41.9)', () => {
    const owner = { id: OTHER_ID, displayName: 'Ben Sample' };
    const view = show(makeItem({
      kind: 'finding', logSummary: rich('What this adds.'),
      groupNote: { id: 'G', rev: 1, text: rich('Please check the caveat.'), owner, withdrawn: false, disclosure: { level: 'withheld', effective: 'withheld' } },
    }), { thread: [
      { id: 'R', parentId: 'IT', postedAt: '2026-10-20T09:00:00.000Z', isGroupNote: false, rev: 1, owner, text: rich('An earlier reply.'), withdrawal: null },
      { id: 'G', parentId: 'IT', postedAt: '2026-10-20T10:00:00.000Z', isGroupNote: true, rev: 1, owner, text: rich('Please check the caveat.'), withdrawal: null },
    ] });
    const summary = screen.getByRole('region', { name: 'Log Summary' });
    expect(summary.textContent).toBe('Log SummaryBy Ada ExampleWhat this adds.');
    const thread = screen.getByRole('region', { name: 'Thread' });
    expect(thread.querySelector('.rf-status')?.textContent).toBe('Group Note');
    expect(thread.textContent).toContain('Please check the caveat.');
    expect(within(thread).getAllByRole('article').map((article) => article.getAttribute('aria-label'))).toEqual(['Group Note by Ben Sample', 'Reply by Ben Sample']);
    expect(within(thread).getAllByRole('link', { name: 'Ben Sample' })).toHaveLength(2);
    expect(thread.textContent).toContain('Disclosure level: Withheld');
    view.unmount();
    show(makeItem({ kind: 'journal_entry', logSummary: rich('  ') }));
    expect(screen.getByRole('region', { name: 'Log Summary' }).textContent).toBe('Log SummaryNo Log Summary is recorded.');
  });

  it('shows Cross_Links and Backlinks with their labels, the other end, Source companions, and notices (R15.3, R6.3)', () => {
    const entry = (id: string, end: LinkEntry['end'], relation: LinkEntry['relation'] = { id: 'R', name: 'Discusses' }): LinkEntry => ({
      id, relation, addedBy: { id: MEMBER_ID, displayName: 'Ada Example' }, addedAt: '2026-10-01T00:00:00.000Z', end,
    });
    show(makeItem({ kind: 'topic' }), {
      links: [
        entry('L1', { id: 'SRC', rootId: 'SRC', kind: 'source', title: 'A register', identifier: 'RF-0009', withdrawn: false, source: { sourceKind: 'primary', reliability: 'High' } }),
        entry('L2', { id: 'SEC', rootId: 'JE', kind: 'entry_section', title: 'A journal entry', identifier: 'RF-0003', withdrawn: true }, null),
      ],
      backlinks: [entry('L3', { id: 'GONE', kind: 'run', title: null, identifier: 'RF-0004', withdrawn: false, deletedAt: '2026-10-02T00:00:00.000Z' })],
    });
    const links = screen.getByRole('region', { name: 'Cross-links' });
    expect(within(links).getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')])).toEqual([['Source RF-0009: A register', '/items/SRC'], ['Entry Section of RF-0003: A journal entry', '/items/JE']]);
    expect(links.textContent).toContain('Discusses');
    expect(links.textContent).toContain('(Primary source; reliability: High)');
    expect(links.textContent).toContain('This record has been withdrawn.');
    const backlinks = screen.getByRole('region', { name: 'Backlinks' });
    expect(within(backlinks).queryAllByRole('link')).toEqual([]);
    expect(backlinks.textContent).toContain('Run RF-0004');
    expect(backlinks.textContent).toContain('This record was permanently deleted on 2026-10-02 00:00 UTC.');
  });

  it('shows a withdrawal notice, Correspondence parties with consent, and links for new records in the same Project', () => {
    show(makeItem({
      kind: 'correspondence', withdrawal: { at: '2026-10-05T12:00:00.000Z', by: { id: OTHER_ID, displayName: 'Ben Sample' }, reason: 'Duplicate.' },
      date: { value: '1944-06-06', approx: false }, direction: 'received', parties: [{ kind: 'member', id: MEMBER_ID }, { kind: 'external', id: PARTY.id, consent: 'granted' }],
    }));
    expect(screen.getAllByRole('alert')[0]!.textContent).toBe('Withdrawn on 2026-10-05 12:00 UTCBy Ben Sample: Duplicate.');
    expect(terms(screen.getByRole('region', { name: 'Fields' }))).toEqual([['Date', '1944-06-06'], ['Direction', 'Received'], ['Parties', 'Ada ExampleCounty Archive (consent: granted)']]);
    const submit = screen.getByRole('region', { name: 'Submit from here' });
    expect(within(submit).getByRole('link', { name: 'Finding' }).getAttribute('href')).toBe('/items/new/finding?unit=01J0000000000000000000IT01');
  });

  it('loads every page of Cross_Links and Backlinks', async () => {
    const item = makeItem({ kind: 'topic' });
    const end = (n: number) => ({ id: `E${n}`, rootId: `E${n}`, kind: 'topic', title: `Topic ${n}`, identifier: `RF-1${n}`, withdrawn: false });
    const link = (n: number): LinkEntry => ({ id: `L${n}`, relation: null, addedBy: { id: MEMBER_ID, displayName: null }, addedAt: '2026-10-01T00:00:00.000Z', end: end(n) });
    const api = fakeApi({
      [`GET /items/${item.id}`]: { item }, 'GET /value-sets': { valueSets: VALUE_SETS }, 'GET /parties': { parties: [] }, 'GET /members': { members: MEMBERS },
      [`GET /links?origin=${item.id}`]: { entries: [link(1)], next: 'L1' }, [`GET /links?origin=${item.id}&after=L1`]: { entries: [link(2)], next: null },
      [`GET /links?target=${item.id}`]: { entries: [], next: null }, [`GET /items/${item.id}/thread`]: { replies: [] },
    });
    renderScreen(<ItemPage id={item.id} />, { client: api.client });
    const links = await screen.findByRole('region', { name: 'Cross-links' });
    expect(within(links).getAllByRole('link').map((element) => element.textContent)).toEqual(['Topic RF-11: Topic 1', 'Topic RF-12: Topic 2']);
  });
});
