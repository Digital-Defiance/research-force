/**
 * The Design_System tokens (R45.1). `tokens.css` is generated from this module (`npm run design:css`) and a test keeps the two equal, so every
 * typeface, size, colour, and spacing value used in styles has one definition.
 */

export type Scheme = 'light' | 'dark';
export interface SchemeColour { readonly light: string; readonly dark: string }

/** Colours that switch with `prefers-color-scheme`; the page follows the browser's preference live and stores nothing (R45.16). */
export const COLOURS = {
  surface: { light: '#fbfaf7', dark: '#151413' },
  'surface-raised': { light: '#f2efe9', dark: '#221f1d' },
  text: { light: '#1c1b19', dark: '#edebe7' },
  'text-muted': { light: '#57534e', dark: '#aaa49d' },
  /** Borders of controls and other interface elements, at least 3:1 against both surfaces. */
  border: { light: '#78716c', dark: '#8a847d' },
  /** Decorative rules and dividers that carry no meaning. */
  'border-subtle': { light: '#ddd8cf', dark: '#3a3633' },
  danger: { light: '#a3161a', dark: '#ff9a8f' },
  success: { light: '#1d6b34', dark: '#7fd69a' },
  warning: { light: '#7a4a00', dark: '#f0bb5a' },
  info: { light: '#1f4fd1', dark: '#93b6ff' },
} as const satisfies Record<string, SchemeColour>;
export type ColourName = keyof typeof COLOURS;

/** Text on an accent-filled background, such as a primary button. */
export const ON_ACCENT: SchemeColour = { light: '#ffffff', dark: '#151413' };

export interface Accent extends SchemeColour { readonly id: string; readonly name: string }

/** The default accent, used wherever no Project_Accent applies. */
export const DEFAULT_ACCENT: Accent = { id: 'rust', name: 'Rust', light: '#9a3412', dark: '#f4a06b' };

/**
 * The eight Project_Accents an Administrator chooses from (R45.3, R45.4, R45.22). Each keeps at least 4.5:1 for text and 3:1 for interface elements
 * against both surfaces, and under `ON_ACCENT`, in both schemes; a test checks this.
 */
export const PROJECT_ACCENTS: readonly Accent[] = [
  { id: 'oxblood', name: 'Oxblood', light: '#9b1c31', dark: '#f59aa8' },
  { id: 'ochre', name: 'Ochre', light: '#7f5200', dark: '#e8b44c' },
  { id: 'olive', name: 'Olive', light: '#4a6413', dark: '#b0d474' },
  { id: 'green', name: 'Green', light: '#16653a', dark: '#72d49d' },
  { id: 'teal', name: 'Teal', light: '#0e6570', dark: '#66d1d9' },
  { id: 'blue', name: 'Blue', light: '#1f4fd1', dark: '#93b6ff' },
  { id: 'violet', name: 'Violet', light: '#6a2bd0', dark: '#c6a8ff' },
  { id: 'magenta', name: 'Magenta', light: '#9a1850', dark: '#f59cc2' },
];

/** The accent ids that a Project_Accent may hold; anything else is refused (R45.22). */
export const PROJECT_ACCENT_IDS: readonly string[] = PROJECT_ACCENTS.map((accent) => accent.id);
export function isProjectAccent(value: unknown): value is string {
  return typeof value === 'string' && PROJECT_ACCENT_IDS.includes(value);
}
export function projectAccent(id: string | undefined): Accent | undefined {
  return PROJECT_ACCENTS.find((accent) => accent.id === id);
}

/** Font stacks: each designed face, its metric-matched local fallback, then the coverage faces for the blocks R45.13 lists. */
const COVERAGE = ['STIX Two Text', 'Noto Sans', 'Noto Sans Coptic', 'STIX Two Math', 'Noto Sans Math'];
export const FONT_STACKS = {
  body: ['Fraunces', 'Fraunces Fallback', ...COVERAGE],
  ui: ['Inter', 'Inter Fallback', 'Noto Sans', 'Noto Sans Coptic', 'STIX Two Text', 'STIX Two Math', 'Noto Sans Math'],
  mono: ['JetBrains Mono', 'JetBrains Mono Fallback', 'Noto Sans', 'Noto Sans Coptic', 'STIX Two Text', 'STIX Two Math', 'Noto Sans Math'],
  math: ['STIX Two Math', 'STIX Two Text', 'Noto Sans', 'Noto Sans Coptic', 'Noto Sans Math'],
} as const satisfies Record<string, readonly string[]>;
const GENERIC: Record<keyof typeof FONT_STACKS, string> = { body: 'serif', ui: 'sans-serif', mono: 'monospace', math: 'math' };

/** Values that do not change with the colour scheme. */
export const STATIC_TOKENS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.entries(FONT_STACKS).map(([name, stack]) => [`font-${name}`, [...stack.map((family) => `'${family}'`), GENERIC[name as keyof typeof FONT_STACKS]].join(', ')])),
  'font-heading': 'var(--rf-font-body)',
  'font-size-xs': '0.8125rem',
  'font-size-sm': '0.875rem',
  'font-size-ui': '0.9375rem',
  'font-size-body': '1.0625rem',
  'font-size-lg': '1.25rem',
  'font-size-xl': 'clamp(1.375rem, 1.2rem + 0.8vw, 1.625rem)',
  'font-size-2xl': 'clamp(1.625rem, 1.3rem + 1.5vw, 2.125rem)',
  'font-size-3xl': 'clamp(2rem, 1.5rem + 2.4vw, 2.875rem)',
  'font-weight-regular': '400',
  'font-weight-medium': '500',
  'font-weight-semibold': '600',
  'font-weight-bold': '700',
  'line-height-tight': '1.2',
  'line-height-ui': '1.4',
  'line-height-body': '1.6',
  'letter-spacing-caps': '0.06em',
  'space-3xs': '0.125rem',
  'space-2xs': '0.25rem',
  'space-xs': '0.5rem',
  'space-sm': '0.75rem',
  'space-md': '1rem',
  'space-lg': '1.5rem',
  'space-xl': '2rem',
  'space-2xl': '3rem',
  'space-3xl': '4rem',
  'space-page': 'clamp(1rem, 0.5rem + 2.5vw, 2rem)',
  'radius-sm': '0.25rem',
  'radius-md': '0.5rem',
  'radius-pill': '999rem',
  'hairline': '1px',
  'underline-offset': '0.18em',
  'border-width': '1px',
  'border-width-strong': '2px',
  'focus-width': '3px',
  'focus-offset': '2px',
  /** The smallest pointer target, 24 by 24 CSS pixels (WCAG 2.2 target size, R45.5). */
  'target-min': '1.5rem',
  'control-height': '2.75rem',
  'size-full': '100%',
  'width-reading': '68ch',
  'width-page': '72rem',
  'duration-fast': '120ms',
};

/** Breakpoints in rem. CSS custom properties cannot be used in media queries, so stylesheets write these values and a test checks them. */
export const BREAKPOINTS = { sm: 30, md: 48, lg: 64, xl: 80 } as const;

const property = (name: string): string => `--rf-${name}`;
const colourDeclarations = (scheme: Scheme, indent: string): string[] => [
  ...Object.entries(COLOURS).map(([name, value]) => `${indent}${property(`colour-${name}`)}: ${value[scheme]};`),
  `${indent}${property('colour-accent')}: ${DEFAULT_ACCENT[scheme]};`,
  `${indent}${property('colour-on-accent')}: ${ON_ACCENT[scheme]};`,
  `${indent}${property('colour-focus')}: var(--rf-colour-accent);`,
];
const accentRule = (accent: Accent, scheme: Scheme, indent: string): string => `${indent}[data-accent='${accent.id}'] { ${property('colour-accent')}: ${accent[scheme]}; }`;

/** Every custom property that `tokens.css` defines, for checks that styles use only defined tokens. */
export const TOKEN_NAMES: readonly string[] = [
  ...Object.keys(STATIC_TOKENS).map(property),
  ...Object.keys(COLOURS).map((name) => property(`colour-${name}`)),
  property('colour-accent'), property('colour-on-accent'), property('colour-focus'),
];

/** The text of `tokens.css`. Print always uses the light scheme (R45.9). */
export function tokensCss(): string {
  return [
    '/* Generated from tokens.ts by `npm run design:css`. Do not edit by hand. */',
    ':root {',
    '  color-scheme: light dark;',
    ...Object.entries(STATIC_TOKENS).map(([name, value]) => `  ${property(name)}: ${value};`),
    ...colourDeclarations('light', '  '),
    '}',
    '',
    '@media (prefers-color-scheme: dark) {',
    '  :root {',
    ...colourDeclarations('dark', '    '),
    '  }',
    '}',
    '',
    ...PROJECT_ACCENTS.map((accent) => accentRule(accent, 'light', '')),
    '',
    '@media (prefers-color-scheme: dark) {',
    ...PROJECT_ACCENTS.map((accent) => accentRule(accent, 'dark', '  ')),
    '}',
    '',
    '@media print {',
    '  :root {',
    '    color-scheme: light;',
    ...colourDeclarations('light', '    '),
    '  }',
    ...PROJECT_ACCENTS.map((accent) => accentRule(accent, 'light', '  ')),
    '}',
    '',
  ].join('\n');
}
