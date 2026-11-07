import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderSite } from '../src/render-site';
import { site } from './fixtures';
/**
 * The site-shell scripts bind to the markup this package renders, but the packages cannot import each other, so a
 * rename on one side silently breaks the forms. This reads each script's source and requires every static attribute
 * it looks up to be present on the page it runs on.
 */
const forms = { siteKey: '0xSITEKEY', submitOrigin: 'https://submit.example.org', filesOrigin: 'https://files.example.org' };
const files = new Map(renderSite(site({ forms })).map((file) => [file.file, file.content]));
const SHELL = new URL('../../../apps/site-shell/src/', import.meta.url);
/** Attributes the scripts create on elements they build themselves, or only read when the page offers them. */
const DYNAMIC = new Set(['file-action', 'file-id', 'file-progress', 'file-state', 'consent-item', 'consent-element', 'field-error', 'field-error="name"', 'project-id']);
const kebab = (name: string): string => name.replace(/[A-Z]/gu, (char) => `-${char.toLowerCase()}`);
function attributesRead(script: string): string[] {
  const source = readFileSync(new URL(script, SHELL), 'utf8');
  const selectors = [...source.matchAll(/(?:querySelector|querySelectorAll)(?:<[^>]+>)?\('([^']*)'\)/gu)].flatMap((match) => [...match[1]!.matchAll(/\[data-([a-z-]+)/gu)].map((attr) => attr[1]!));
  const dataset = [...source.matchAll(/form\.dataset\['(\w+)'\]/gu)].map((match) => kebab(match[1]!));
  return [...new Set([...selectors, ...dataset])].filter((name) => !DYNAMIC.has(name));
}
describe('site-shell scripts and rendered form pages agree', () => {
  const cases: [string, string[]][] = [
    ['form.ts', ['submit.html', 'p/alpha/submit.html']],
    ['respond.ts', ['respond.html']],
    ['consent.ts', ['consent.html', 'consent/change.html']],
  ];
  for (const [script, pages] of cases) {
    it(`${script} finds every attribute it reads`, () => {
      const wanted = attributesRead(script);
      expect(wanted).toContain('turnstile');
      for (const file of pages) {
        const html = files.get(file)!;
        for (const name of wanted) {
          // Per-mode and per-variant attributes are checked by the page tests; the consent field exists on the answer page only.
          if (file === 'consent/change.html' && /^consent-(elements|one-answer|label-field)$/u.test(name)) continue;
          if (file !== 'p/alpha/submit.html' && name === 'submit-project') continue;
          if (name === 'submit-type' || name === 'submit-general') continue;
          expect(html, `${file} lacks data-${name} read by ${script}`).toContain(`data-${name}`);
        }
      }
    });
  }
  it('binds each script to a page that loads it', () => {
    expect(files.get('submit.html')).toContain('/assets/form.js');
    expect(files.get('respond.html')).toContain('/assets/respond.js');
    expect(files.get('consent.html')).toContain('/assets/consent.js');
    expect(files.get('consent/change.html')).toContain('/assets/consent.js');
  });
});
