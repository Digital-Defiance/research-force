import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as fontkit from 'fontkit';
import { FALLBACK_FACES, FONT_FACES, FONT_LICENCES, fontAssetFiles, fontsCss } from '../src/fonts';
import { FONT_STACKS } from '../src/tokens';
import { REQUIRED_BLOCKS, UNICODE_VERSION } from './unicode-blocks';

const fonts = new URL('../fonts/', import.meta.url);
const characterSets = new Map<string, ReadonlySet<number>>();
function characters(file: string): ReadonlySet<number> {
  let known = characterSets.get(file);
  if (!known) {
    const font = fontkit.create(readFileSync(new URL(file, fonts)));
    known = new Set('characterSet' in font ? font.characterSet : []);
    characterSets.set(file, known);
  }
  return known;
}

function parseRange(range: string | undefined): (code: number) => boolean {
  if (range === undefined) return () => true;
  const parts = range.split(',').map((part) => {
    const [from, to = from] = part.trim().replace(/^U\+/iu, '').split('-');
    return [Number.parseInt(from!, 16), Number.parseInt(to!, 16)] as const;
  });
  return (code) => parts.some(([from, to]) => code >= from && code <= to);
}

/** Whether some designed face of the stack shows the character: the file contains it and the face's `unicode-range` lets the browser use it. */
function covered(stack: readonly string[], code: number): boolean {
  return FONT_FACES.some((face) => face.style === 'normal' && stack.includes(face.family) && parseRange(face.unicodeRange)(code) && characters(face.file).has(code));
}

describe('font files and licences (R45.17, R45.20)', () => {
  it('ships every face file and licence, under the SIL Open Font License', () => {
    for (const file of fontAssetFiles()) expect(existsSync(new URL(file, fonts)), file).toBe(true);
    for (const licence of FONT_LICENCES) expect(readFileSync(new URL(licence.file, fonts), 'utf8')).toMatch(/SIL Open Font License, Version 1\.1/u);
  });

  it('covers every family with a licence and defines every family a stack names', () => {
    const licensed = new Set(FONT_LICENCES.flatMap((licence) => licence.families));
    for (const face of FONT_FACES) expect(licensed.has(face.family), face.family).toBe(true);
    const defined = new Set([...FONT_FACES.map((face) => face.family), ...FALLBACK_FACES.map((face) => face.family)]);
    for (const family of Object.values(FONT_STACKS).flat()) expect(defined.has(family), family).toBe(true);
  });

  it('swaps faces in without blocking text and keeps fonts.css equal to the generated text', () => {
    const css = readFileSync(new URL('../src/fonts.css', import.meta.url), 'utf8');
    expect(css, 'Run `npm run design:css` after changing fonts.ts or font-faces.ts.').toBe(fontsCss());
    expect(css.match(/font-display: swap/gu)).toHaveLength(FONT_FACES.length);
    expect(css.match(/size-adjust:/gu)).toHaveLength(FALLBACK_FACES.length);
  });
});

describe(`character coverage at Unicode ${UNICODE_VERSION} (R45.13)`, () => {
  it.each(Object.entries(FONT_STACKS))('the %s stack shows every graphic character of the listed blocks in a Design_System typeface', (_name, stack) => {
    const missing = REQUIRED_BLOCKS.flatMap((block) => block.ranges.flatMap(([from, to]) => {
      const gaps: string[] = [];
      for (let code = from; code <= to; code++) if (!covered(stack, code)) gaps.push(`${block.name} U+${code.toString(16).toUpperCase().padStart(4, '0')}`);
      return gaps;
    }));
    expect(missing).toEqual([]);
  });

  it('checks the whole of each listed block', () => {
    expect(REQUIRED_BLOCKS.map((block) => block.name)).toEqual([
      'Basic Latin', 'Latin-1 Supplement', 'Latin Extended-A', 'Latin Extended-B', 'Greek and Coptic', 'Cyrillic', 'General Punctuation',
      'Superscripts and Subscripts', 'Currency Symbols', 'Arrows', 'Mathematical Operators',
    ]);
    const total = REQUIRED_BLOCKS.reduce((sum, block) => sum + block.ranges.reduce((count, [from, to]) => count + to - from + 1, 0), 0);
    expect(total).toBe(1444);
  });
});
