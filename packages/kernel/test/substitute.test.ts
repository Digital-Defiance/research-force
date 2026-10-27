import { describe, expect, it } from 'vitest';
import { partialDate } from '@researchforce/domain/dates';
import { EMAIL_PLACEHOLDER, UNNAMED_PARTY, emailMatcher, partyDirectory, prefillCorrespondenceLine, projectPolicyText, projectProfile, scrubRichText, scrubText } from '../src/substitute';
import { rich, state } from './fixtures';

const profile = { displayName: 'Ada Example', specialties: ['Archives'], affiliations: ['A society'], biography: 'Mail ADA@example.test for notes.', publicProfile: true, status: 'active' as const };

describe('substitute', () => {
  it('prefills a Correspondence Disclosure_Line with Generic_Labels, falling back when the label is blank', () => {
    const input = state([], { parties: [{ id: 'p1', name: 'Hidden', doNotName: true, genericLabel: '  ' }, { id: 'p2', name: 'Named', doNotName: false }] });
    const prefill = prefillCorrespondenceLine({
      kind: 'correspondence', date: partialDate('1944-02'), channel: 'post', direction: 'sent', content: rich('x'),
      parties: [{ kind: 'external', id: 'p1' }, { kind: 'external', id: 'p2' }, { kind: 'member', id: 'member-2' }],
    }, partyDirectory(input));
    expect(prefill.line).toEqual({ kindOfMaterial: 'correspondence', date: partialDate('1944-02'), partyIds: ['p1', 'p2', 'member-2'] });
    expect(prefill.view.parties).toEqual([UNNAMED_PARTY, 'Named', 'Ben Example']);
  });

  it('prefers the longer address where one contains another, ignoring letter case', () => {
    const matcher = emailMatcher(['a@b.test', 'xa@b.test.org']);
    expect(scrubText('to XA@B.TEST.ORG and a@b.test', matcher)).toEqual({
      text: `to ${EMAIL_PLACEHOLDER} and ${EMAIL_PLACEHOLDER}`,
      ranges: [{ start: 3, end: 3 + EMAIL_PLACEHOLDER.length }, { start: 8 + EMAIL_PLACEHOLDER.length, end: 8 + 2 * EMAIL_PLACEHOLDER.length }],
    });
  });

  it('moves label boundaries inside an address to the placeholder edges and shifts later labels', () => {
    const text = 'see a@b.test then more';
    const scrubbed = scrubRichText({ text, spans: [{ k: 'lang', s: 6, e: 8, lang: 'de' }, { k: 'lang', s: 18, e: 22, lang: 'fr' }] }, emailMatcher(['a@b.test']));
    const shift = EMAIL_PLACEHOLDER.length - 'a@b.test'.length;
    expect(scrubbed.value).toEqual({
      text: `see ${EMAIL_PLACEHOLDER} then more`,
      spans: [{ k: 'lang', s: 4, e: 4 + EMAIL_PLACEHOLDER.length, lang: 'de' }, { k: 'lang', s: 18 + shift, e: 22 + shift, lang: 'fr' }],
    });
  });

  it('projects exactly the four Public_Profile fields, with addresses removed', () => {
    const projected = projectProfile(profile, ['ada@example.test']);
    expect(projected?.view).toEqual({ displayName: 'Ada Example', specialties: ['Archives'], affiliations: ['A society'], biography: `Mail ${EMAIL_PLACEHOLDER} for notes.` });
    expect(projected?.marks).toEqual([{ path: ['biography'], start: 5, end: 5 + EMAIL_PLACEHOLDER.length }]);
  });

  it('projects no profile while the setting is Off or the Member is not Active', () => {
    expect(projectProfile({ ...profile, publicProfile: false }, [])).toBeUndefined();
    expect(projectProfile({ ...profile, status: 'revoked' }, [])).toBeUndefined();
  });

  it('removes addresses from Policy_Section text and marks each replacement', () => {
    const projected = projectPolicyText(rich('Write to ADA@example.test or ada@EXAMPLE.test.'), ['ada@example.test']);
    expect(projected.text.text).toBe(`Write to ${EMAIL_PLACEHOLDER} or ${EMAIL_PLACEHOLDER}.`);
    const second = 'Write to '.length + EMAIL_PLACEHOLDER.length + ' or '.length;
    expect(projected.marks).toEqual([{ start: 9, end: 9 + EMAIL_PLACEHOLDER.length }, { start: second, end: second + EMAIL_PLACEHOLDER.length }]);
    expect(projectPolicyText(rich('No addresses.'), [])).toEqual({ text: rich('No addresses.'), marks: [] });
  });
});
