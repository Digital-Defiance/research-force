import { FALLBACK_FACES, FONT_FACES, FONT_LICENCES } from './font-faces';

/** One self-hosted font file and the characters a browser may use it for (R45.13, R45.17). */
export interface FontFace {
  readonly family: string;
  /** File name in `packages/design/fonts`. */
  readonly file: string;
  readonly style: 'normal' | 'italic';
  readonly weight: string;
  /** Absent when the face may be used for any character it contains. */
  readonly unicodeRange?: string;
}

/** A local system face resized to the metrics of a designed face, so that swapping in the designed face does not shift layout (R45.8). */
export interface FallbackFace {
  readonly family: string;
  readonly local: readonly string[];
  readonly sizeAdjust: string;
  readonly ascentOverride: string;
  readonly descentOverride: string;
  readonly lineGapOverride: string;
  readonly unicodeRange: string;
}

/** A licence text that must accompany copies of the named families, such as in a Public_Archive_Export (R45.20). */
export interface FontLicence {
  readonly families: readonly string[];
  /** Path relative to `packages/design/fonts`. */
  readonly file: string;
}

export { FALLBACK_FACES, FONT_FACES, FONT_LICENCES };

/** Every file a page or export needs to show the Design_System typefaces: the font files and their licence texts. */
export function fontAssetFiles(): string[] {
  return [...FONT_FACES.map((face) => face.file), ...FONT_LICENCES.map((licence) => licence.file)];
}

/** The text of `fonts.css`, with font URLs relative to `base`. */
export function fontsCss(base = '../fonts/'): string {
  const faces = FONT_FACES.map((face) => [
    '@font-face {',
    `  font-family: '${face.family}';`,
    `  src: url('${base}${face.file}') format('woff2');`,
    `  font-style: ${face.style};`,
    `  font-weight: ${face.weight};`,
    '  font-display: swap;',
    ...(face.unicodeRange === undefined ? [] : [`  unicode-range: ${face.unicodeRange};`]),
    '}',
  ].join('\n'));
  const fallbacks = FALLBACK_FACES.map((face) => [
    '@font-face {',
    `  font-family: '${face.family}';`,
    `  src: ${face.local.map((name) => `local('${name}')`).join(', ')};`,
    `  size-adjust: ${face.sizeAdjust};`,
    `  ascent-override: ${face.ascentOverride};`,
    `  descent-override: ${face.descentOverride};`,
    `  line-gap-override: ${face.lineGapOverride};`,
    `  unicode-range: ${face.unicodeRange};`,
    '}',
  ].join('\n'));
  return ['/* Generated from fonts.ts and font-faces.ts by `npm run design:css`. Do not edit by hand. */', ...faces, ...fallbacks, ''].join('\n\n');
}
