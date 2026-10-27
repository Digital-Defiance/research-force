import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BREAKPOINTS, COLOURS, DEFAULT_ACCENT, ON_ACCENT, PROJECT_ACCENTS, PROJECT_ACCENT_IDS, TOKEN_NAMES, isProjectAccent, projectAccent, tokensCss, type Scheme } from '../src/tokens';

const src = new URL('../src/', import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, src), 'utf8');

function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  return [value >> 16, (value >> 8) & 255, value & 255]
    .map((channel) => { const c = channel / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
}
/** WCAG 2.2 contrast ratio. */
function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

const SCHEMES: readonly Scheme[] = ['light', 'dark'];
const SURFACES = ['surface', 'surface-raised'] as const;

describe('tokens', () => {
  it('keeps tokens.css equal to the generated text', () => {
    expect(read('tokens.css'), 'Run `npm run design:css` after changing tokens.ts.').toBe(tokensCss());
  });

  it('uses only defined tokens in every stylesheet', () => {
    const sheets = ['components.css', ...readdirSync(new URL('../../../apps/app/web/src/', import.meta.url)).filter((name) => name.endsWith('.css')).map((name) => join('../../../apps/app/web/src/', name))];
    const defined = new Set(TOKEN_NAMES);
    for (const sheet of sheets) {
      const used = [...read(sheet).matchAll(/var\((--rf-[\w-]+)/gu)].map((match) => match[1]!);
      expect(used.filter((name) => !defined.has(name)), sheet).toEqual([]);
    }
  });

  it('writes media queries only at the Design_System breakpoints', () => {
    const widths = [...read('components.css').matchAll(/\((?:min|max)-width:\s*([\d.]+)rem\)/gu)].map((match) => Number(match[1]));
    expect(widths.length).toBeGreaterThan(0);
    for (const width of widths) expect(Object.values(BREAKPOINTS)).toContain(width);
  });

  it('defines eight distinct Project_Accents apart from the default, and accepts only those ids', () => {
    expect(PROJECT_ACCENTS).toHaveLength(8);
    expect(new Set(PROJECT_ACCENT_IDS).size).toBe(8);
    expect(PROJECT_ACCENT_IDS).not.toContain(DEFAULT_ACCENT.id);
    for (const id of PROJECT_ACCENT_IDS) expect(isProjectAccent(id) && projectAccent(id)?.id).toBe(id);
    for (const value of [DEFAULT_ACCENT.id, 'Teal', '#0e6570', '', undefined, 3]) expect(isProjectAccent(value)).toBe(false);
  });
});

describe('contrast (R45.4, R45.5, R45.22)', () => {
  it.each([DEFAULT_ACCENT, ...PROJECT_ACCENTS].flatMap((accent) => SCHEMES.map((scheme) => [accent.id, scheme, accent[scheme]] as const)))(
    'accent %s in the %s scheme keeps 4.5:1 for text and 3:1 for interface elements',
    (_id, scheme, colour) => {
      for (const surface of SURFACES) {
        expect(contrast(colour, COLOURS[surface][scheme])).toBeGreaterThanOrEqual(4.5);
        expect(contrast(colour, COLOURS[surface][scheme])).toBeGreaterThanOrEqual(3);
      }
      expect(contrast(ON_ACCENT[scheme], colour)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it.each(SCHEMES)('keeps text, status, and control border colours readable in the %s scheme', (scheme) => {
    for (const surface of SURFACES) {
      for (const name of ['text', 'text-muted', 'danger', 'success', 'warning', 'info'] as const) expect(contrast(COLOURS[name][scheme], COLOURS[surface][scheme]), name).toBeGreaterThanOrEqual(4.5);
      expect(contrast(COLOURS.border[scheme], COLOURS[surface][scheme])).toBeGreaterThanOrEqual(3);
    }
  });
});
