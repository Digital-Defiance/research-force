import { describe, expect, it } from 'vitest';
import { assertPublicCopy, type InstallationPublicCopy } from '@researchforce/design/installation';
import { RESEARCHFORCE_PUBLIC_COPY } from '@researchforce/design/researchforce-copy';
import { renderExport } from '../src/export/render-export';
import { renderSite } from '../src/render-site';
import { site } from './fixtures';
import type { SiteInput } from '../src/site';

/**
 * A synthetic second installation whose domain-facing identity differs from ResearchForce.org in every respect: a
 * different masthead name and strapline, a different Mission, different About prose and Principles, different policy
 * statements, a different first Project, and a different content licence. This is the "visibly different synthetic
 * bundle" the design requires; nothing here is drawn from `docs/instance/researchforce-org-content.md`.
 */
const SECOND_COPY: InstallationPublicCopy = {
  version: '2026-07-07',
  name: 'Meridian Observatory',
  strapline: 'Charts of the southern sky, kept open',
  mission: {
    heading: 'What we do',
    paragraphs: ['Meridian Observatory is a volunteer group that measures and publishes positions of southern-sky objects and keeps every plate and every reduction on the record.'],
  },
  about: [
    'Meridian Observatory is a volunteer group of amateur and professional astronomers in the southern hemisphere.',
    'Our one current survey tracks a family of slow-moving minor planets, and every observation, reduction, and rejected plate stays in the archive.',
  ],
  principles: [
    { name: 'Measure twice', text: 'Every position is reduced by two people independently before it is published.' },
    { name: 'Keep the plates', text: 'Rejected and failed plates stay in the archive with the reason they were set aside.' },
    { name: 'Credit the observer', text: 'Whoever took the plate is named on every result derived from it.' },
    { name: 'Open skies', text: 'Anyone may reuse our charts under the stated licence and send us corrections.' },
  ],
};

/** The second installation's SiteInput: the synthetic bundle, a different content licence, and a renamed first Project. */
function secondInstallation(overrides: Partial<SiteInput> = {}): SiteInput {
  return site({
    publicCopy: assertPublicCopy(SECOND_COPY),
    licence: { name: 'Observatory Open Charts Licence 2.0', url: 'https://charts.example.test/licence/2.0' },
    ...overrides,
  });
}

/** The ResearchForce.org organizational wording that must never leak into another installation's output. */
const RESEARCHFORCE_WORDING: readonly string[] = [
  RESEARCHFORCE_PUBLIC_COPY.name,
  RESEARCHFORCE_PUBLIC_COPY.strapline,
  ...RESEARCHFORCE_PUBLIC_COPY.mission.paragraphs,
  ...RESEARCHFORCE_PUBLIC_COPY.about,
  ...RESEARCHFORCE_PUBLIC_COPY.principles.flatMap((principle) => [principle.name, principle.text]),
];

describe('the synthetic second installation renders its own bundle', () => {
  const files = new Map(renderSite(secondInstallation()).map((file) => [file.file, file]));
  const home = files.get('index.html')!.content;
  const about = files.get('about.html')!.content;

  it('shows the synthetic masthead name and strapline on the home page and in the header of every page', () => {
    expect(home).toContain('Meridian Observatory');
    expect(home).toContain('Charts of the southern sky, kept open');
    for (const [name, file] of files) {
      if (!name.endsWith('.html')) continue;
      expect(file.content).toContain('Meridian Observatory');
    }
  });

  it('presents the Mission statement before Featured Projects on the home page (R40.1 order preserved)', () => {
    expect(home).toContain('What we do');
    expect(home).toContain('Meridian Observatory is a volunteer group that measures');
    expect(home.indexOf('What we do')).toBeLessThan(home.indexOf('Featured projects'));
    expect(home.indexOf('Meridian Observatory is a volunteer group that measures')).toBeLessThan(home.indexOf('Featured projects'));
  });

  it('presents the ordered Principles in order on the About page', () => {
    const positions = SECOND_COPY.principles.map((principle) => about.indexOf(principle.name));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions]).toEqual([...positions].sort((a, b) => a - b));
    // The fixed legal/status section still precedes the Principles.
    expect(about.indexOf('Status of the group')).toBeLessThan(about.indexOf('Principles'));
  });

  it('uses the synthetic content licence in the export LICENSE.txt, never the software MIT licence', () => {
    const exportFiles = new Map(renderExport(secondInstallation(), { startedAt: '2026-07-08T00:00:00.000Z', scope: 'Whole public archive' }).map((file) => [file.path, file]));
    const licence = exportFiles.get('LICENSE.txt')!.content;
    expect(licence).toContain('Observatory Open Charts Licence 2.0');
    expect(licence).toContain('https://charts.example.test/licence/2.0');
    expect(licence).not.toContain('MIT');
  });
});

describe('no ResearchForce.org organizational wording leaks into the synthetic installation', () => {
  it('finds none of the ResearchForce masthead, strapline, Mission, About prose, or Principles in any rendered page', () => {
    for (const file of renderSite(secondInstallation())) {
      if (!file.file.endsWith('.html')) continue;
      for (const wording of RESEARCHFORCE_WORDING) {
        expect(file.content.includes(wording), `${file.file} leaked: ${wording.slice(0, 40)}`).toBe(false);
      }
    }
  });

  it('finds none of it in the export pages or the archive data', () => {
    for (const file of renderExport(secondInstallation(), { startedAt: '2026-07-08T00:00:00.000Z', scope: 'Whole public archive' })) {
      for (const wording of RESEARCHFORCE_WORDING) {
        expect(file.content.includes(wording), `${file.path} leaked: ${wording.slice(0, 40)}`).toBe(false);
      }
    }
  });
});

describe('an unconfigured or partial public copy or content licence refuses generation', () => {
  it('refuses when the public copy is missing', () => {
    expect(() => assertPublicCopy(undefined)).toThrow(/not configured completely/u);
  });

  it('refuses when the public copy is partial (a blank masthead name)', () => {
    expect(() => assertPublicCopy({ ...SECOND_COPY, name: '   ' })).toThrow(/name/u);
    expect(() => assertPublicCopy({ ...SECOND_COPY, principles: [] })).toThrow(/Principles/u);
  });

  it('builds a SiteInput only from a validated bundle, so renderSite cannot run with an invalid one', () => {
    // The SiteInput's publicCopy is a ValidatedInstallationPublicCopy; the only way to obtain one is assertPublicCopy,
    // which refuses a partial bundle. A render therefore never sees an unconfigured copy or a ResearchForce.org fallback.
    const rendered = renderSite(secondInstallation());
    expect(rendered.length).toBeGreaterThan(0);
    expect(() => secondInstallation({ publicCopy: assertPublicCopy({ ...SECOND_COPY, strapline: '' }) })).toThrow(/strapline/u);
  });
});
