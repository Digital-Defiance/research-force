import { describe, expect, it } from 'vitest';
import { RESPONSE_TARGET_DAYS } from '@researchforce/domain/moderation';
import { text } from '@researchforce/domain/tree';
import {
  COPYRIGHT_STATEMENT, CORRECTIONS_STATEMENT, FIXED_TEXTS, FORM_LINK_TEXT, LICENCE_STATEMENT, POLICY_PAGES, PRIVACY_RESPONSIBLE_PERSON, fillTemplate,
  formLink, latestVersion, licenceLink, placeholdersOf,
} from '../src/fixed-texts';
import { renderToString } from '../src/render-string';

const sentences = (paragraph: string): string[] => paragraph.split(/(?<=[.!?])\s+(?=[A-Z{])/u).filter((sentence) => sentence.trim() !== '');

describe('fixed texts', () => {
  it('each have a unique id, a valid version date, and non-empty paragraphs', () => {
    expect(new Set(FIXED_TEXTS.map((item) => item.id)).size).toBe(FIXED_TEXTS.length);
    for (const item of FIXED_TEXTS) {
      expect(item.version).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(new Date(`${item.version}T00:00:00Z`).toISOString().slice(0, 10)).toBe(item.version);
      expect(item.paragraphs.length).toBeGreaterThan(0);
      for (const paragraph of item.paragraphs) expect(paragraph.trim()).toBe(paragraph);
    }
    expect(latestVersion(FIXED_TEXTS)).toBe(FIXED_TEXTS.map((item) => item.version).sort().at(-1));
  });

  it('use typographic quotation marks and apostrophes only', () => {
    for (const item of FIXED_TEXTS) for (const paragraph of item.paragraphs) expect(paragraph).not.toMatch(/["']/u);
  });

  it('keep the copyright statement to at most three sentences with the licence as a parameter', () => {
    const [paragraph] = COPYRIGHT_STATEMENT.paragraphs;
    expect(COPYRIGHT_STATEMENT.paragraphs).toHaveLength(1);
    expect(sentences(paragraph!).length).toBeLessThanOrEqual(3);
    expect(placeholdersOf(paragraph!)).toEqual(['licence']);
    expect(LICENCE_STATEMENT.paragraphs.flatMap(placeholdersOf)).toEqual(['licence']);
  });

  it('state the Response_Target from the domain constant', () => {
    expect(CORRECTIONS_STATEMENT.paragraphs.join(' ')).toContain(`within ${RESPONSE_TARGET_DAYS} days`);
  });

  it('fill every placeholder and refuse to leave one unfilled', () => {
    const licence = { name: 'Example Licence 1.0', url: 'https://licences.example/1.0' };
    const filled = renderToString({ kind: 'fragment', children: fillTemplate(COPYRIGHT_STATEMENT.paragraphs[0]!, { licence: licenceLink(licence) }) });
    expect(filled).toContain('under the <a href="https://licences.example/1.0" rel="license">Example Licence 1.0</a>.');
    expect(filled).not.toMatch(/[{}]/u);
    const privacy = fillTemplate(PRIVACY_RESPONSIBLE_PERSON.paragraphs[0]!, { name: 'R. Person', form: formLink() });
    expect(renderToString({ kind: 'fragment', children: privacy })).toBe(
      `R. Person is the person responsible for this site and its processing of personal data. To contact R. Person, use the <a href="/submit/removal/general">${FORM_LINK_TEXT}</a>.`,
    );
    expect(() => fillTemplate('Hello {name}.', {})).toThrow(/\{name\}/u);
    expect(fillTemplate('No placeholders.', { name: text('x') })).toEqual([text('No placeholders.')]);
  });

  it('list the six Policy_Pages in footer order', () => {
    expect(POLICY_PAGES.map((page) => page.title)).toEqual(['About', 'People', 'Methods', 'Licence', 'Privacy', 'Corrections']);
  });
});
