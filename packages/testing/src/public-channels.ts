import { canonicalJson } from '@researchforce/kernel/views';
import { project } from '@researchforce/kernel/project';
import { projectProfile } from '@researchforce/kernel/substitute';
import { renderSite } from '@researchforce/public-render/render-site';
import { buildSearchIndex } from '@researchforce/search-public/build';
import { siteInputFor } from './site';
import type { WorkspaceState } from './workspace';

/** One piece of output a public reader or crawler can obtain. */
export interface PublicArtifact { readonly name: string; readonly content: string; }

/** A route by which data reaches the public. Every channel that produces public output registers here so Property 5 checks it. */
export interface PublicChannel { readonly name: string; artifacts(state: WorkspaceState): Iterable<PublicArtifact>; }

const kernelViews: PublicChannel = {
  name: 'kernel public views',
  *artifacts(state) {
    for (const [key, view] of project(state.input)) yield { name: key, content: canonicalJson(view) };
  },
};

const kernelProfiles: PublicChannel = {
  name: 'kernel public profiles',
  *artifacts(state) {
    const emails = state.input.members.map((member) => member.email);
    for (const [id, profile] of state.profiles) {
      const projected = projectProfile(profile, emails);
      if (projected) yield { name: `profile:${id}`, content: canonicalJson(projected.view) };
    }
  },
};

/** Every page template, the sitemap, and robots.txt, as one Public_Site build writes them. */
const publicSite: PublicChannel = {
  name: 'public site pages',
  *artifacts(state) {
    for (const file of renderSite(siteInputFor(state))) yield { name: file.file, content: file.content };
  },
};

/** The manifest, term buckets, and document shards of the static public search index. */
const publicSearchIndex: PublicChannel = {
  name: 'public search index',
  *artifacts(state) {
    for (const file of buildSearchIndex(project(state.input))) yield { name: file.file, content: file.content };
  },
};

export const PUBLIC_CHANNELS: readonly PublicChannel[] = [kernelViews, kernelProfiles, publicSite, publicSearchIndex];
