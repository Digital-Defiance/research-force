import { describe, expect, it } from 'vitest';
import { partialDate } from '@researchforce/domain/dates';
import { BUILT_IN_VALUE_IDS } from '@researchforce/domain/value-sets';
import { projectDetailed } from '../src/project';
import { EMAIL_PLACEHOLDER } from '../src/substitute';
import type { CorrespondenceParty } from '../src/input';
import { LINE, RESTRICTED, attachment, dissent, id, item, project, rich, section, state } from './fixtures';

const PROJECT_REF = { key: 'p:project-1', name: project.name, slug: project.slug, path: '/p/synthetic' };

const correspondence = (id: string, parties: CorrespondenceParty[], unit = {}) => item(id, {
  kind: 'correspondence', date: partialDate('1944-02-03'), channel: 'post', direction: 'received', content: rich('Letter text'), parties,
}, unit);

describe('project', () => {
  it('gives Summary_Only items no slot for fields, sections, replies, or the Log_Summary', () => {
    const projection = projectDetailed(state([
      item('a', { kind: 'journal_entry', presentation: 'summary_only', publicSummary: rich('Shown'), logSummary: rich('Hidden log') }),
      section('s', 'a', 'Hidden section'),
    ]));
    const view = projection.views.get('u:a');
    expect(view).toMatchObject({ tag: 'research_item', publicSummary: { text: 'Shown' } });
    expect(view).not.toHaveProperty('full');
    expect(projection.views.has('u:s')).toBe(false);
    expect(projection.levels.get('u:s')).toBe('private');
  });

  it('shows only the Disclosure_Line for a Withheld unit, and makes its descendants Private', () => {
    const projection = projectDetailed(state([item('a', { kind: 'topic', body: rich('Body') }, { level: 'withheld', disclosureLine: { ...LINE, partyIds: [id('party-2')] } }), section('s', 'a', 'Text')]));
    expect(projection.views.get('u:a')).toEqual({
      tag: 'withheld', key: 'u:a', path: '/r/RI-a', line: { kindOfMaterial: 'letters', date: LINE.date, parties: ['Open Archive'] }, project: PROJECT_REF,
    });
    expect(projection.views.has('u:s')).toBe(false);
  });

  it('shows the Generic_Label of a Do_Not_Name party in fields and Disclosure_Lines', () => {
    const projection = projectDetailed(state([
      correspondence('a', [{ kind: 'external', id: 'party-1', consent: 'granted' }, { kind: 'external', id: 'party-2', consent: 'granted' }]),
      item('b', { kind: 'topic', body: rich('Body') }, { level: 'withheld', disclosureLine: { ...LINE, partyIds: [id('party-1')] } }),
    ]));
    expect(projection.views.get('u:a')).toMatchObject({ full: { fields: expect.arrayContaining([{ key: 'parties', value: { t: 'parties', value: ['a private correspondent', 'Open Archive'] } }]) } });
    expect(projection.views.get('u:b')).toMatchObject({ line: { parties: ['a private correspondent'] } });
    expect(JSON.stringify([...projection.views.values()])).not.toContain('Hidden Person');
  });

  it('replaces registered Member addresses in any letter case and keeps labels on the same characters', () => {
    const text = 'Write to BEN@example.TEST now';
    const projection = projectDetailed(state([
      item('a', { kind: 'journal_entry', logSummary: rich('Log') }),
      section('s', 'a', text, { text: { text, spans: [{ k: 'lang', s: 9, e: 25, lang: 'en' }, { k: 'mention', s: 0, e: 5, member: 'member-1' }] } }),
    ]));
    const placeholderEnd = 9 + EMAIL_PLACEHOLDER.length;
    expect(projection.views.get('u:s')).toMatchObject({ text: { text: `Write to ${EMAIL_PLACEHOLDER} now`, spans: [{ k: 'lang', s: 9, e: placeholderEnd, lang: 'en' }] } });
    expect(projection.emailMarks.get('u:s')).toEqual([{ path: ['text', 'text'], start: 9, end: placeholderEnd }]);
  });

  it('points a superseded Attachment at the last later Public version', () => {
    const projection = projectDetailed(state([
      item('a', { kind: 'topic', body: rich('Body') }),
      attachment('f1', 'a'), attachment('f2', 'a', { supersedesId: 'f1', uploadedAt: '2026-02-07T09:00:00.000Z' as never }),
      attachment('f3', 'a', { supersedesId: 'f2' }, { level: 'private' }),
    ]));
    expect(projection.views.get('u:f1')).toMatchObject({ supersededBy: { key: 'u:f2', path: '/a/AT-f2', uploadedOn: '2026-02-07' } });
    expect(projection.views.get('u:f2')).not.toHaveProperty('supersededBy');
    expect(projection.views.get('u:f1')).toMatchObject({ rights: { licenceCovers: true }, download: '/f/AT-f1' });
  });

  it('projects a Public Correspondence without Granted consent as Withheld with its pre-filled line, and reports the breach', () => {
    const projection = projectDetailed(state([
      correspondence('a', [{ kind: 'external', id: 'party-1', consent: 'requested' }, { kind: 'member', id: 'member-1' }]),
      attachment('f', 'a'),
    ]));
    expect(projection.views.get('u:a')).toEqual({
      tag: 'withheld', key: 'u:a', path: '/r/RI-a', line: { kindOfMaterial: 'correspondence', date: partialDate('1944-02-03'), parties: ['a private correspondent', 'Ada Example'] }, project: PROJECT_REF,
    });
    expect(projection.levels.get('u:f')).toBe('private');
    expect(projection.invariantBreaches).toEqual([expect.objectContaining({ key: 'u:a', code: 'consent' })]);
  });

  it('projects a Public Attachment whose Rights_Status does not permit publication as Withheld', () => {
    const projection = projectDetailed(state([item('a', { kind: 'topic', body: rich('Body') }), attachment('f', 'a', { rightsStatusId: RESTRICTED, fileKind: 'image' })]));
    expect(projection.views.get('u:f')).toEqual({ tag: 'withheld', key: 'u:f', path: '/a/AT-f', line: { kindOfMaterial: 'image', date: partialDate('2026-02-03'), parties: [] }, project: PROJECT_REF });
    expect(projection.invariantBreaches).toEqual([expect.objectContaining({ key: 'u:f', code: 'rights' })]);
  });

  it('makes a Withheld Project without a Disclosure_Line Private', () => {
    const projection = projectDetailed({ ...state([item('a', { kind: 'topic', body: rich('Body') })]), projects: [{ ...project, level: 'withheld' }] });
    expect(projection.views.size).toBe(0);
    expect(projection.invariantBreaches).toEqual([expect.objectContaining({ key: 'p:project-1', code: 'missing_line' })]);
  });

  it('shows non-withdrawn Dissent_Notes under Full_Content and marks earlier wording', () => {
    const projection = projectDetailed(state([
      item('a', { kind: 'finding', logSummary: rich('Log summary') }),
      dissent('d1', 'a', 'Same wording'), dissent('d2', 'a', 'Older wording', { concernedSummary: rich('An earlier summary') }),
      dissent('d3', 'a', 'Withdrawn', { withdrawal: { at: '2026-02-06T00:00:00.000Z' as never, reason: 'Resolved' } }),
    ]));
    expect(projection.views.get('u:d1')).toMatchObject({ author: 'Ben Example', earlierWording: false });
    expect(projection.views.get('u:d2')).toMatchObject({ earlierWording: true });
    expect(projection.views.has('u:d3')).toBe(false);
    expect(projection.views.get('u:a')).toMatchObject({ full: { dissent: [{ key: 'u:d1' }, { key: 'u:d2' }] } });
  });

  it('shows a Cross_Link to a Withheld unit as its Disclosure_Line and leaves out links to Private units', () => {
    const projection = projectDetailed(state([
      item('a', { kind: 'topic', body: rich('Body') }),
      item('b', { kind: 'topic', body: rich('Body') }, { level: 'withheld', disclosureLine: LINE }),
      item('c', { kind: 'topic', body: rich('Body') }, { level: 'private' }),
    ], { links: [{ id: 'l1', originId: 'a', targetId: 'b' }, { id: 'l2', originId: 'c', targetId: 'a' }] }));
    expect(projection.views.get('u:a')).toMatchObject({
      links: [{ direction: 'outgoing', target: { tag: 'withheld', key: 'u:b', path: '/r/RI-b', line: { kindOfMaterial: 'letters' } } }],
    });
  });

  it('notes the Superseding Finding of a Superseded Finding', () => {
    const projection = projectDetailed(state([
      item('a', { kind: 'finding', statusValueId: BUILT_IN_VALUE_IDS.findingSuperseded, supersededById: 'b' }),
      item('b', { kind: 'finding' }),
    ]));
    expect(projection.views.get('u:a')).toMatchObject({ status: { kind: 'finding', status: { name: 'Superseded' }, supersededBy: { tag: 'link', key: 'u:b', title: 'Title b' } } });
  });
});
