// Feature: research-collab-cms, Property 94: Project_Accents apply only to their Project and only from the palette
import { expect, it } from 'vitest';
import { isProjectAccent, PROJECT_ACCENT_IDS } from '@researchforce/design/tokens';
import type { PublicView } from '@researchforce/kernel/views';
import { renderSite } from '@researchforce/public-render/render-site';
import { fc } from '../../src/fc';
import { readPage } from '../../src/html';
import { siteInputFor } from '../../src/site';
import { workspaceStateArb } from '../../src/workspace';

/** A palette accent, a colour outside the palette, or none. */
const accentArb = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...PROJECT_ACCENT_IDS) },
  { weight: 1, arbitrary: fc.constantFrom('#ff0000', 'red', 'accent-unknown', '') },
  { weight: 1, arbitrary: fc.constant(undefined) },
);

/** The accent a page's Project gives it: a Public Project's section, or the Project of a public Research_Item or Attachment page. */
function ownAccent(views: readonly PublicView[], path: string): string | undefined {
  for (const view of views) {
    if (view.tag === 'project' && (path === view.path || path.startsWith(`${view.path}/`))) return view.accent;
    if ((view.tag === 'research_item' || view.tag === 'attachment') && view.path === path) return view.project.accent;
  }
  return undefined;
}

it('a Project_Accent from the palette replaces the default accent exactly on its Project_Section and its Items’ and Attachments’ pages', () => {
  fc.assert(fc.property(workspaceStateArb, fc.array(accentArb, { minLength: 3, maxLength: 3 }), (state, accents) => {
    const projects = state.input.projects.map((project, index) => {
      const { accent: _token, ...rest } = project;
      const accent = accents[index];
      return accent === undefined ? rest : { ...rest, accent };
    });
    const site = siteInputFor({ ...state, input: { ...state.input, projects } });
    const views = [...site.views.values()];
    let accented = 0;
    for (const file of renderSite(site)) {
      if (file.path === undefined) continue;
      const own = ownAccent(views, file.path);
      const expected = own !== undefined && isProjectAccent(own) ? own : undefined;
      const actual = readPage(file.content).body.attributes.get('data-accent');
      expect(actual, file.path).toBe(expected);
      if (expected !== undefined) accented++;
    }
    const publicPalette = views.some((view) => view.tag === 'project' && view.accent !== undefined && isProjectAccent(view.accent));
    expect(accented > 0).toBe(publicPalette);
  }));
});
