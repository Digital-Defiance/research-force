import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import arial from '@capsizecss/metrics/arial';
import courierNew from '@capsizecss/metrics/courierNew';
import fraunces from '@capsizecss/metrics/fraunces';
import georgia from '@capsizecss/metrics/georgia';
import inter from '@capsizecss/metrics/inter';
import jetBrainsMono from '@capsizecss/metrics/jetBrainsMono';
import subsetFont from 'subset-font';

/**
 * Copies the Design_System typefaces into `packages/design/fonts` and writes `packages/design/src/font-faces.ts` (R45.13, R45.17, R45.20).
 *
 * The designed faces come from Fontsource, split by Fontsource's `unicode-range` subsets. Noto Sans and Noto Sans Coptic fill the characters of the
 * R45.13 blocks that those faces lack; Noto Sans is cut from the full upstream file, because the Google Fonts subsets leave some of those characters
 * out. Run with network access: `npm run design:fonts`.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const out = join(root, 'packages/design/fonts');
const require = createRequire(import.meta.url);
const GOOGLE_FONTS_COMMIT = 'ddf386ba1b9fbc6b2c818f1ddcd9148f54ced94b';
const upstream = (path: string): string => `https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_COMMIT}/${path}`;

interface Face { family: string; file: string; style: 'normal' | 'italic'; weight: string; unicodeRange?: string }
interface Fallback { family: string; local: string[]; sizeAdjust: string; ascentOverride: string; descentOverride: string; lineGapOverride: string; unicodeRange: string }
interface Licence { families: string[]; file: string }

interface Designed { family: string; pkg: string; prefix: string; subsets: string[]; italic: boolean; weight: string; licence: string }
const DESIGNED: Designed[] = [
  { family: 'Fraunces', pkg: '@fontsource-variable/fraunces', prefix: 'fraunces', subsets: ['latin', 'latin-ext', 'vietnamese'], italic: true, weight: '100 900', licence: 'fraunces' },
  { family: 'Inter', pkg: '@fontsource-variable/inter', prefix: 'inter', subsets: ['latin', 'latin-ext', 'greek', 'greek-ext', 'cyrillic', 'cyrillic-ext', 'vietnamese'], italic: true, weight: '100 900', licence: 'inter' },
  { family: 'JetBrains Mono', pkg: '@fontsource-variable/jetbrains-mono', prefix: 'jetbrains-mono', subsets: ['latin', 'latin-ext', 'greek', 'cyrillic', 'cyrillic-ext', 'vietnamese'], italic: true, weight: '100 800', licence: 'jetbrains-mono' },
  { family: 'STIX Two Text', pkg: '@fontsource-variable/stix-two-text', prefix: 'stix-two-text', subsets: ['latin', 'latin-ext', 'greek', 'cyrillic', 'cyrillic-ext', 'vietnamese'], italic: true, weight: '400 700', licence: 'stix-two' },
];

/** Gap fillers cut from Noto Sans: one file per group of R45.13 blocks, so a page loads only the groups it uses. */
const NOTO_GROUPS: { name: string; ranges: [number, number][] }[] = [
  { name: 'latin-ext-b', ranges: [[0x0180, 0x024f]] },
  { name: 'greek-cyrillic', ranges: [[0x0370, 0x03ff], [0x0400, 0x04ff]] },
  { name: 'symbols', ranges: [[0x2000, 0x206f], [0x2070, 0x209f], [0x20a0, 0x20cf], [0x2190, 0x21ff], [0x2200, 0x22ff]] },
];
const COPTIC_IN_GREEK: [number, number] = [0x03e2, 0x03ef];
/** Noto Sans Math fills the arrows that neither Noto Sans nor STIX Two contains. */
const ARROWS: [number, number] = [0x2190, 0x21ff];

const hex = (code: number): string => code.toString(16).toUpperCase().padStart(4, '0');
const rangeText = (ranges: readonly [number, number][]): string => ranges.map(([from, to]) => `U+${hex(from)}-${hex(to)}`).join(',');
const charsOf = (ranges: readonly [number, number][]): string => ranges.flatMap(([from, to]) => Array.from({ length: to - from + 1 }, (_, index) => String.fromCodePoint(from + index))).join('');
const percent = (value: number): string => `${(value * 100).toFixed(2)}%`;

interface Metrics { ascent: number; descent: number; lineGap: number; unitsPerEm: number; xWidthAvg: number }
function fallback(family: string, local: string[], primary: Metrics, system: Metrics, unicodeRange: string): Fallback {
  const sizeAdjust = (primary.xWidthAvg / primary.unitsPerEm) / (system.xWidthAvg / system.unitsPerEm);
  return {
    family: `${family} Fallback`, local, sizeAdjust: percent(sizeAdjust),
    ascentOverride: percent(primary.ascent / primary.unitsPerEm / sizeAdjust),
    descentOverride: percent(Math.abs(primary.descent) / primary.unitsPerEm / sizeAdjust),
    lineGapOverride: percent(primary.lineGap / primary.unitsPerEm / sizeAdjust),
    unicodeRange,
  };
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function main(): Promise<void> {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'licences'), { recursive: true });
  const faces: Face[] = [];
  const licences: Licence[] = [];
  const primaryRanges = new Map<string, string>();

  for (const font of DESIGNED) {
    const base = dirname(require.resolve(`${font.pkg}/package.json`));
    const unicode = JSON.parse(readFileSync(join(base, 'unicode.json'), 'utf8')) as Record<string, string>;
    for (const style of font.italic ? (['normal', 'italic'] as const) : (['normal'] as const)) {
      for (const subset of font.subsets) {
        const file = `${font.prefix}-${subset}-wght-${style}.woff2`;
        copyFileSync(join(base, 'files', file), join(out, file));
        const unicodeRange = unicode[subset];
        if (unicodeRange === undefined) throw new Error(`${font.pkg} has no unicode range for ${subset}`);
        faces.push({ family: font.family, file, style, weight: font.weight, unicodeRange });
      }
    }
    primaryRanges.set(font.family, font.subsets.map((subset) => unicode[subset]).join(','));
    if (!licences.some((licence) => licence.file === `licences/${font.licence}.txt`)) {
      copyFileSync(join(base, 'LICENSE'), join(out, 'licences', `${font.licence}.txt`));
      licences.push({ families: [font.family], file: `licences/${font.licence}.txt` });
    } else {
      licences.find((licence) => licence.file === `licences/${font.licence}.txt`)!.families.push(font.family);
    }
  }

  const math = dirname(require.resolve('@fontsource/stix-two-math/package.json'));
  copyFileSync(join(math, 'files', 'stix-two-math-latin-400-normal.woff2'), join(out, 'stix-two-math-400-normal.woff2'));
  faces.push({ family: 'STIX Two Math', file: 'stix-two-math-400-normal.woff2', style: 'normal', weight: '400' });
  licences.find((licence) => licence.file === 'licences/stix-two.txt')!.families.push('STIX Two Math');

  const notoSource = await download(upstream('ofl/notosans/NotoSans%5Bwdth,wght%5D.ttf'));
  for (const group of NOTO_GROUPS) {
    const file = `noto-sans-${group.name}-wght-normal.woff2`;
    writeFileSync(join(out, file), await subsetFont(notoSource, charsOf(group.ranges), { targetFormat: 'woff2', variationAxes: { wdth: 100 } }));
    faces.push({ family: 'Noto Sans', file, style: 'normal', weight: '100 900', unicodeRange: rangeText(group.ranges) });
  }
  writeFileSync(join(out, 'licences', 'noto-sans.txt'), await download(upstream('ofl/notosans/OFL.txt')));
  licences.push({ families: ['Noto Sans'], file: 'licences/noto-sans.txt' });

  const mathSource = await download(upstream('ofl/notosansmath/NotoSansMath-Regular.ttf'));
  writeFileSync(join(out, 'noto-sans-math-arrows-400-normal.woff2'), await subsetFont(mathSource, charsOf([ARROWS]), { targetFormat: 'woff2' }));
  faces.push({ family: 'Noto Sans Math', file: 'noto-sans-math-arrows-400-normal.woff2', style: 'normal', weight: '400', unicodeRange: rangeText([ARROWS]) });
  writeFileSync(join(out, 'licences', 'noto-sans-math.txt'), await download(upstream('ofl/notosansmath/OFL.txt')));
  licences.push({ families: ['Noto Sans Math'], file: 'licences/noto-sans-math.txt' });

  const coptic = dirname(require.resolve('@fontsource/noto-sans-coptic/package.json'));
  const copticSource = readFileSync(join(coptic, 'files', 'noto-sans-coptic-coptic-400-normal.woff2'));
  writeFileSync(join(out, 'noto-sans-coptic-greek-400-normal.woff2'), await subsetFont(copticSource, charsOf([COPTIC_IN_GREEK]), { targetFormat: 'woff2' }));
  faces.push({ family: 'Noto Sans Coptic', file: 'noto-sans-coptic-greek-400-normal.woff2', style: 'normal', weight: '400', unicodeRange: rangeText([COPTIC_IN_GREEK]) });
  copyFileSync(join(coptic, 'LICENSE'), join(out, 'licences', 'noto-sans-coptic.txt'));
  licences.push({ families: ['Noto Sans Coptic'], file: 'licences/noto-sans-coptic.txt' });

  const fallbacks: Fallback[] = [
    fallback('Fraunces', ['Georgia', 'Times New Roman'], fraunces, georgia, primaryRanges.get('Fraunces')!),
    fallback('Inter', ['Arial', 'Helvetica'], inter, arial, primaryRanges.get('Inter')!),
    fallback('JetBrains Mono', ['Courier New'], jetBrainsMono, courierNew, primaryRanges.get('JetBrains Mono')!),
  ];

  const module = [
    '// Generated by tools/vendor-fonts.ts (npm run design:fonts). Do not edit by hand.',
    "import type { FallbackFace, FontFace, FontLicence } from './fonts';",
    '',
    `export const FONT_FACES: readonly FontFace[] = ${JSON.stringify(faces, null, 2)};`,
    '',
    `export const FALLBACK_FACES: readonly FallbackFace[] = ${JSON.stringify(fallbacks, null, 2)};`,
    '',
    `export const FONT_LICENCES: readonly FontLicence[] = ${JSON.stringify(licences, null, 2)};`,
    '',
  ].join('\n');
  writeFileSync(join(root, 'packages/design/src/font-faces.ts'), module);
  if (!existsSync(join(out, 'licences', 'stix-two.txt'))) throw new Error('The STIX Two licence is missing.');
  process.stdout.write(`Fonts written: ${faces.length} faces, ${fallbacks.length} fallback faces, ${licences.length} licences\n`);
}

await main();
