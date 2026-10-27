import { describe, expect, it } from 'vitest';
import { fixedTextIssues, lintCopy, proseLiteralIssues } from '../lint-copy';

const rules = (value: string): string[] => fixedTextIssues('test', value).map((issue) => issue.rule);

describe('fixed text rules', () => {
  it('accept typographic quotation marks and refuse straight ones', () => {
    expect(rules('The group’s “statement” and ‘notes’.')).toEqual([]);
    expect(rules('The group\'s statement.')).toEqual([expect.stringMatching(/typographic/u)]);
    expect(rules('A "quoted" word.')).toEqual([expect.stringMatching(/typographic/u)]);
  });

  it('refuse email addresses, telephone numbers, and postal addresses', () => {
    expect(rules('Write to someone@example.org for help.')).toEqual([expect.stringMatching(/email/u)]);
    expect(rules('Call +44 20 7946 0000 today.')).toEqual([expect.stringMatching(/telephone/u)]);
    expect(rules('Call (555) 123-4567 today.')).toEqual([expect.stringMatching(/telephone/u)]);
    expect(rules('Visit 221 Baker Street in person.')).toEqual([expect.stringMatching(/postal/u)]);
    expect(rules('Send it to PO Box 12.')).toEqual([expect.stringMatching(/postal/u)]);
    expect(rules('The office is in London SW1A 1AA.')).toEqual([expect.stringMatching(/postal/u)]);
  });

  it('let dates, counts, and versions through', () => {
    expect(rules('Updated on 2026-10-27 after 14 days, version 1.2.3, in 1951 and 1960.')).toEqual([]);
  });

  it('refuse wording that asks for or offers money unless it is negated', () => {
    expect(rules('Please donate to keep this site running.')).toEqual([expect.stringMatching(/money/u)]);
    expect(rules('Support our fundraising drive.')).toEqual([expect.stringMatching(/money/u)]);
    expect(rules('Payment is accepted by card.')).toEqual([expect.stringMatching(/money/u)]);
    expect(rules('The group accepts no donations and runs no fundraising.')).toEqual([]);
    expect(rules('It is not sponsored. Donations help.')).toEqual([expect.stringMatching(/money/u)]);
  });
});

describe('prose literals', () => {
  it('flag straight apostrophes and quotation marks in prose shown to people', () => {
    const source = [
      "export const a = 'The item can\\'t be saved right now.';",
      'export const b = \'He said "stop" at the gate.\';',
      'export const c = `Your item’s title is ${"x"} now.`;',
      "export const d = <p>Don't leave this page yet.</p>;",
    ].join('\n');
    expect(proseLiteralIssues('example.tsx', source).map((issue) => issue.where)).toEqual(['example.tsx:1', 'example.tsx:2', 'example.tsx:4']);
  });

  it('leave code-like strings, short strings, and imports alone', () => {
    const source = [
      "import x from 'some-package';",
      "const sql = \"SELECT name FROM items WHERE kind = 'note'\";",
      "const selector = \"a[href='x'] > span\";",
      "const short = \"it's\";",
      "const attribute = 'data-x';",
    ].join('\n');
    expect(proseLiteralIssues('example.ts', source)).toEqual([]);
  });
});

it('finds no issues in the repository', () => {
  expect(lintCopy()).toEqual([]);
});
