// Feature: research-collab-cms, Property 7: Not_Published and nonexistent are indistinguishable
import { expect, it } from 'vitest';
import { PUBLIC_PATHS } from '@researchforce/domain/public-paths';
import { ITEM_KINDS, type Level } from '@researchforce/domain/types';
import { projectDetailed } from '@researchforce/kernel/project';
import { projectKey, unitKey } from '@researchforce/kernel/views';
import { PAGE_PATHS, checkedSlug, projectPaths } from '@researchforce/public-render/paths';
import { renderSite } from '@researchforce/public-render/render-site';
import { fc } from '../../src/fc';
import { siteInputFor } from '../../src/site';
import { canariesIn, workspaceStateArb } from '../../src/workspace';

/**
 * A static host serves the file it holds for a served page address, and the one not-found page for every other
 * address (R24.7, R40.10). This mirrors that resolution so two requests can be compared byte for byte: a request
 * for a Not_Published (or no-public-trace) address and a request for an address that names nothing must return
 * the identical response.
 */
const makeResolver = (served: ReadonlyMap<string, string>, notFound: string) => (path: string): string => served.get(path) ?? notFound;

/** Every public address, formed only from a Project_Slug and fixed text, through which a Project could be reached (R40.3, R40.10). */
function projectAddresses(slug: string): string[] {
  let checked: string;
  try {
    checked = checkedSlug(slug);
  } catch {
    // A slug the renderer would reject forms no served Project_Section address; only the bare project path can be requested.
    return [PUBLIC_PATHS.project(slug)];
  }
  const paths = projectPaths(checked);
  return [paths.page, paths.log(), paths.withheld(), paths.search, paths.submit, ...ITEM_KINDS.map((kind) => paths.listing(kind))];
}

it('serves no page for a Not_Published unit or Project and returns the same not-found response as for a nonexistent address', () => {
  fc.assert(fc.property(workspaceStateArb, (state) => {
    const { input } = state;
    const projection = projectDetailed(input);

    // Build the Public_Site exactly as one deploy writes it, then index its pages by address.
    const served = new Map<string, string>();
    for (const file of renderSite(siteInputFor(state))) if (file.path !== undefined) served.set(file.path, file.content);

    // The single not-found page the host serves for every address it holds no page for.
    const notFound = served.get(PAGE_PATHS.notFound);
    expect(notFound, 'the site builds a /404 page').toBeDefined();
    const resolve = makeResolver(served, notFound!);

    // Addresses no identifier or slug in the workspace forms, standing for things that never existed.
    const nonexistentAddresses = [
      PUBLIC_PATHS.item('MISSING-R-999999'), PUBLIC_PATHS.attachment('MISSING-A-999999'), PUBLIC_PATHS.project('no-such-project-999999'),
    ];
    for (const address of nonexistentAddresses) expect(served.has(address), `nonexistent ${address} is served`).toBe(false);
    const nonexistentResponse = resolve(nonexistentAddresses[0]!);
    // Every nonexistent address yields the very same response.
    for (const address of nonexistentAddresses) expect(resolve(address)).toBe(nonexistentResponse);

    // Not one canary of any unit or Project reaches the not-found response: it is fixed text (R24.7).
    expect(canariesIn(nonexistentResponse).filter((token) => state.canaries.has(token))).toEqual([]);

    const levelOf = (key: string): Level | undefined => projection.levels.get(key);

    for (const project of input.projects) {
      if (levelOf(projectKey(project.id)) !== 'not_published') continue;
      for (const address of projectAddresses(project.slug)) {
        expect(served.has(address), `Not_Published Project address ${address} is served`).toBe(false);
        expect(resolve(address), `Not_Published Project address ${address}`).toBe(nonexistentResponse);
      }
    }

    for (const unit of input.units) {
      if (levelOf(unitKey(unit.id)) !== 'not_published') continue;
      const addresses = unit.type === 'research_item'
        ? [PUBLIC_PATHS.item(unit.item.identifier)]
        : unit.type === 'attachment'
          ? [PUBLIC_PATHS.attachment(unit.attachment.identifier)]
          : [];
      for (const address of addresses) {
        expect(served.has(address), `Not_Published unit address ${address} is served`).toBe(false);
        expect(resolve(address), `Not_Published unit address ${address}`).toBe(nonexistentResponse);
      }
    }
  }));
});
