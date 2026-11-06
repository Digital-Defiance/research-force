// Feature: research-collab-cms, Property 19: Public addresses are stable and content-free
import { expect, it } from 'vitest';
import { PUBLIC_PATHS } from '@researchforce/domain/public-paths';
import { RESERVED_PROJECT_SLUGS } from '@researchforce/domain/schemas/people';
import type { ItemKind } from '@researchforce/domain/types';
import { ITEM_KINDS } from '@researchforce/domain/types';
import { projectDetailed } from '@researchforce/kernel/project';
import type { AttachmentView, ProjectView, PublicView, ResearchItemView, WithheldView } from '@researchforce/kernel/views';
import { projectKey } from '@researchforce/kernel/views';
import { checkedSlug, fileFor, KIND_SEGMENTS, paged, projectPaths } from '@researchforce/public-render/paths';
import { workspaceStateArb } from '@researchforce/testing/workspace';
import type { WorkspaceState } from '@researchforce/testing/workspace';
import { fc } from '../../src/fc';

// **Validates: Requirements 29.6, 29.7, 29.8, 39.6, 40.3, 40.8**
//
// A Public address is formed ONLY from the thing it names — the Item_Identifier of a Research_Item or Attachment,
// or the Project_Slug of a Project — plus fixed text that is the same in every address of that shape, and it is
// STABLE: it never changes when the named thing's content, disclosure, or state changes. The two sides of the
// property, driven across randomized inputs:
//
//   - CONTENT-FREE (R29.8, R40.3): every address is a pure function of its Item_Identifier or Project_Slug and
//     fixed segments. `PUBLIC_PATHS.item/attachment/file(id)` and `.project(slug)` and every `projectPaths(slug)`
//     address are built from the id/slug and the fixed segments `/r/`, `/a/`, `/f/`, `/p/`, the `KIND_SEGMENTS`,
//     `/log`, `/withheld`, `/search`, `/submit`, and `/page/{n}` — and nothing else. No title, summary,
//     description, Disclosure_Line, file name, or Party/Member/Submitter name can appear in an address, because
//     the deriving functions never read content. We prove this both at the pure deriving layer (same id/slug ⇒
//     same address, whatever surrounding content is paired with it) and against the projector, which writes the
//     `path`/`download` of each Public or Withheld view: over randomized workspaces, every emitted address equals
//     the address derived from that unit's identifier or that Project's slug alone.
//   - STABLE (R29.7, R40.8): the address for a given identifier/slug is identical on repeated derivation and
//     across differing content/state. R29.7/R40.8 (the address stays assigned to the thing it first named across
//     edits, Withdrawals, Public⇄Withheld, a return after Not_Published, and deletion) reduce, at the pure layer,
//     to "the address is a function of the identifier/slug alone", which is what these assertions establish: two
//     workspaces that differ only in content but share a unit's identifier / a Project's slug produce byte-equal
//     addresses for that unit/Project.
//   - R39.6 (the Project_Slug is fixed once the Project first becomes Public or Withheld, so the whole save is
//     rejected and the slug never changes afterward): the write that sets `slug_fixed_at` and the rejection of a
//     later slug change live in `apps/app/src/disclosure/apply.ts` and are covered by the example suite
//     `apps/app/test/disclosure-apply.test.ts`. At this pure layer we assert the invariant that write exists to
//     maintain: because the Project's public address is a function of its slug alone, as long as the slug is
//     unchanged the address is unchanged across any disclosure or content change — so fixing the slug fixes the
//     address.
//
// The whole property is pure (domain `PUBLIC_PATHS` + `public-render/paths` + the kernel projector's `path`/
// `download`), so it runs the full FC_RUNS with no seeded-table reset and no run cap. `checkedSlug` (rejecting
// reserved and malformed slugs) and `fileFor` (rejecting path traversal) are asserted to keep every address
// well-formed, tying "content-free" to "always a valid, fixed-shape address".

/** A Project_Slug the Public_Site accepts: the `^[a-z0-9][a-z0-9-]{0,39}$` rule, minus the reserved names. */
const reserved = new Set<string>(RESERVED_PROJECT_SLUGS);
const slugArb: fc.Arbitrary<string> = fc
  .stringMatching(/^[a-z0-9][a-z0-9-]{0,39}$/u)
  .filter((slug) => !reserved.has(slug));

/** An opaque Item_Identifier: the kernel and `PUBLIC_PATHS` treat it as text, so any non-empty token stands in. */
const identifierArb: fc.Arbitrary<string> = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_-]{0,30}$/u);

/** Arbitrary "content" that must never reach an address: titles, summaries, lines, file names, Party names, etc. */
const contentArb: fc.Arbitrary<string> = fc.string({ minLength: 0, maxLength: 60 });

const kindArb: fc.Arbitrary<ItemKind> = fc.constantFrom<ItemKind>(...ITEM_KINDS);
const pageArb: fc.Arbitrary<number> = fc.integer({ min: 1, max: 500 });

/** The fixed segments an address may contain, and nothing else. */
const FIXED_SEGMENTS: readonly string[] = ['/r/', '/a/', '/f/', '/p/', '/log', '/withheld', '/search', '/submit', '/page/', ...Object.values(KIND_SEGMENTS)];

// CONTENT-FREE, pure deriving layer (R29.8): the item/attachment/file address is a pure function of the
// Item_Identifier and fixed text. Whatever content we pair with an identifier, the address is byte-identical to
// the one derived from the identifier alone, repeated derivation included, and it contains the identifier and the
// one fixed prefix for its shape — never the content.
it('R29.8: item, attachment, and file addresses are a pure function of the Item_Identifier and fixed text', () => {
  fc.assert(fc.property(identifierArb, contentArb, contentArb, (identifier, title, summary) => {
    // A distinctive marker standing in for content that is not part of any fixed prefix or the identifier.
    const titleMarker = `${title}zqtitlezq`;
    const summaryMarker = `${summary}zqsummaryzq`;
    for (const [prefix, derive] of [['/r/', PUBLIC_PATHS.item], ['/a/', PUBLIC_PATHS.attachment], ['/f/', PUBLIC_PATHS.file]] as const) {
      const address = derive(identifier);
      // Stable: repeated derivation gives the same string, and pairing any content with the id changes nothing.
      expect(derive(identifier)).toBe(address);
      // Content-free: exactly the fixed prefix followed by the identifier. The title/summary cannot appear.
      expect(address).toBe(`${prefix}${identifier}`);
      expect(address.includes(identifier)).toBe(true);
      expect(address.includes(titleMarker)).toBe(false);
      expect(address.includes(summaryMarker)).toBe(false);
    }
  }));
});

// CONTENT-FREE, pure deriving layer (R40.3): every Project_Section address is a pure function of the
// Project_Slug and fixed text that is the same for every Project. Over any slug and any content paired with it,
// the page/listing/log/withheld/search/submit addresses equal the ones derived from the slug alone and are built
// only from `/p/`, the slug, the fixed `KIND_SEGMENTS`, `/log`, `/withheld`, `/search`, `/submit`, and `/page/{n}`.
it('R40.3: Project_Section addresses are a pure function of the Project_Slug and fixed text', () => {
  fc.assert(fc.property(slugArb, kindArb, pageArb, contentArb, (slug, kind, page, name) => {
    const base = PUBLIC_PATHS.project(slug);
    const paths = projectPaths(slug);
    expect(paths.page).toBe(base);
    expect(base).toBe(`/p/${slug}`);
    const addresses = [paths.page, paths.listing(kind), paths.listing(kind, page), paths.log(), paths.log(page), paths.withheld(), paths.withheld(page), paths.search, paths.submit];
    // Deriving again from the same slug gives identical addresses (stable), regardless of any content paired.
    const again = projectPaths(slug);
    expect([again.page, again.listing(kind), again.listing(kind, page), again.log(), again.log(page), again.withheld(), again.withheld(page), again.search, again.submit]).toEqual(addresses);
    for (const address of addresses) {
      // Every address begins with the Project's base `/p/{slug}` and contains the slug — the fixed start.
      expect(address.startsWith(base)).toBe(true);
      expect(address.includes(slug)).toBe(true);
      // Stripping the base leaves only fixed segments: nothing after `/p/{slug}` is content, only known text.
      const rest = address.slice(base.length);
      const known = rest === '' || rest === '/search' || rest === '/submit' || rest === '/log' || rest === '/withheld'
        || rest === `/${KIND_SEGMENTS[kind]}` || /^\/log\/page\/\d+$/u.test(rest) || /^\/withheld\/page\/\d+$/u.test(rest)
        || new RegExp(`^/${KIND_SEGMENTS[kind]}/page/\\d+$`, 'u').test(rest);
      expect(known).toBe(true);
    }
    // The address is `/p/{slug}` + fixed text only. A distinctive content string — one that is neither the slug
    // nor a substring of any fixed text — cannot appear in any address, because the deriver never reads content.
    const marker = `${name}zqmarkerzq`;
    for (const address of addresses) expect(address.includes(marker)).toBe(false);
  }));
});

// STABLE listing paging (R40.3 shape): page 1 is the listing's own address, and page n>1 appends only `/page/{n}`.
// The address depends on the base and the page number alone — never on content — and is identical on repeat.
it('paged: page 1 is the base address and page n>1 appends only the fixed /page/{n} segment', () => {
  fc.assert(fc.property(slugArb, pageArb, (slug, page) => {
    const base = projectPaths(slug).log();
    expect(paged(base, 1)).toBe(base);
    const later = paged(base, page);
    expect(later).toBe(page === 1 ? base : `${base}/page/${page}`);
    expect(paged(base, page)).toBe(later);
  }));
});

/** The address and the identifier/slug a projected view carries, by view tag; `undefined` where a view has no page. */
function addressOf(view: PublicView): { readonly address: string; readonly subject: string } | undefined {
  switch (view.tag) {
    case 'research_item': return { address: (view as ResearchItemView).path, subject: (view as ResearchItemView).identifier };
    case 'attachment': return { address: (view as AttachmentView).path, subject: (view as AttachmentView).identifier };
    case 'project': return { address: (view as ProjectView).path, subject: (view as ProjectView).slug };
    default: return undefined;
  }
}

// CONTENT-FREE against the projector (R29.6, R29.8, R40.3): the projector writes the `path` of every Public or
// Withheld Research_Item / Attachment and the `path`/`download` of every Attachment, and the `path`/`slug` of
// every Public Project, over randomized workspaces whose every text field carries unique content. Each emitted
// address equals the address derived from that unit's Item_Identifier (R29.6: each Public/Withheld Item has a
// Public_URL) or that Project's Project_Slug alone — so the projector's addresses are content-free exactly as the
// pure deriving functions are.
it('R29.6/R29.8/R40.3: every projected path/download is derived from the Item_Identifier or Project_Slug alone', () => {
  fc.assert(fc.property(workspaceStateArb, (state: WorkspaceState) => {
    const { input } = state;
    const { views } = projectDetailed(input);
    const items = new Map(input.units.map((unit) => [unit.id, unit]));
    const projects = new Map(input.projects.map((project) => [project.id, project]));

    for (const [key, view] of views) {
      // A Research_Item's path is /r/{identifier}; an Attachment's is /a/{identifier} and download is /f/{identifier}.
      if (view.tag === 'research_item') {
        const unit = items.get(key.slice(2))!;
        if (unit.type === 'research_item') {
          expect(view.path).toBe(PUBLIC_PATHS.item(unit.item.identifier));
          // The identifier it names is its own — the address is keyed to the unit it first named (R29.7).
          expect(view.path).toBe(`/r/${unit.item.identifier}`);
        }
      } else if (view.tag === 'attachment') {
        const unit = items.get(key.slice(2))!;
        if (unit.type === 'attachment') {
          expect(view.path).toBe(PUBLIC_PATHS.attachment(unit.attachment.identifier));
          expect(view.download).toBe(PUBLIC_PATHS.file(unit.attachment.identifier));
        }
      } else if (view.tag === 'project') {
        const project = projects.get(key.slice(2))!;
        expect(view.path).toBe(PUBLIC_PATHS.project(project.slug));
        expect(view.path).toBe(`/p/${project.slug}`);
      } else if (view.tag === 'withheld') {
        // A Withheld Research_Item, Attachment, or Project still has its own page address, derived the same way.
        const withheld = view as WithheldView;
        if (withheld.path !== undefined) {
          const project = projects.get(key.slice(2));
          if (project) expect(withheld.path).toBe(PUBLIC_PATHS.project(project.slug));
          else {
            const unit = items.get(key.slice(2))!;
            if (unit.type === 'research_item') expect(withheld.path).toBe(PUBLIC_PATHS.item(unit.item.identifier));
            if (unit.type === 'attachment') expect(withheld.path).toBe(PUBLIC_PATHS.attachment(unit.attachment.identifier));
          }
        }
      }
      // Whatever its tag, a projected address contains only fixed segments outside its identifier/slug: the
      // ProjectRef path on item/attachment views is also slug-only, checked below via projectRef.
      const derived = addressOf(view);
      if (derived) {
        expect(derived.address.includes(derived.subject)).toBe(true);
        // The address outside the subject is exactly one fixed prefix: strip the subject once and only fixed text remains.
        const withoutSubject = derived.address.replace(derived.subject, '');
        expect(FIXED_SEGMENTS.includes(withoutSubject)).toBe(true);
      }
    }
  }));
});

// STABLE against content change (R29.7, R40.8, and the invariant R39.6 maintains): the Project's public address is
// a function of its slug alone, so fixing the slug fixes the address. Over randomized workspaces, re-projecting
// the SAME input after changing every Project's and unit's content — names, descriptions, titles, summaries,
// Disclosure_Lines — leaves every unit's `path`/`download` and every Project's `path` byte-identical, because we
// keep each identifier and slug unchanged. This is R29.7/R40.8 at the pure layer: the address never moves while
// the identifier/slug it names holds, no matter what the content does.
it('R29.7/R40.8/R39.6: changing content while keeping identifiers and slugs leaves every address unchanged', () => {
  fc.assert(fc.property(workspaceStateArb, contentArb, (state: WorkspaceState, extra) => {
    const { input } = state;
    const before = projectDetailed(input).views;

    // Rewrite content everywhere, keeping each Item_Identifier and Project_Slug (and disclosure levels) fixed.
    const mutated = {
      ...input,
      projects: input.projects.map((project) => ({ ...project, name: `${project.name}${extra}X`, description: `${project.description}${extra}Y` })),
      units: input.units.map((unit) => {
        if (unit.type === 'research_item') return { ...unit, item: { ...unit.item, title: `${unit.item.title}${extra}T` } };
        if (unit.type === 'attachment') return { ...unit, attachment: { ...unit.attachment, title: `${unit.attachment.title}${extra}F` } };
        return unit;
      }),
    };
    const after = projectDetailed(mutated).views;

    // The set of addressable views is the same, and each shared view's address is unchanged by the content edit.
    for (const [key, view] of before) {
      const derivedBefore = addressOf(view);
      if (!derivedBefore) continue;
      const laterView = after.get(key);
      expect(laterView).toBeDefined();
      const derivedAfter = addressOf(laterView!);
      expect(derivedAfter?.address).toBe(derivedBefore.address);
    }
  }));
});

// Every projected view's Project reference (the `project` on item/attachment views) is also a slug-only address,
// so the address of each Project's page and references to it are formed only from the Project_Slug (R40.3, R40.8).
it('R40.3/R40.8: the Project reference on every view is the slug-only Project address', () => {
  fc.assert(fc.property(workspaceStateArb, (state: WorkspaceState) => {
    const { views } = projectDetailed(state.input);
    const projects = new Map(state.input.projects.map((project) => [project.id, project]));
    for (const view of views.values()) {
      if (view.tag !== 'research_item' && view.tag !== 'attachment') continue;
      const ref = (view as ResearchItemView | AttachmentView).project;
      // The ProjectRef path and the project view's own path both come from PUBLIC_PATHS.project(slug).
      expect(ref.path).toBe(PUBLIC_PATHS.project(ref.slug));
      expect(ref.path).toBe(`/p/${ref.slug}`);
      // The referenced slug is the referenced Project's own slug, matching projectKey — no content enters here.
      const project = [...projects.values()].find((candidate) => projectKey(candidate.id) === ref.key);
      if (project) expect(ref.slug).toBe(project.slug);
    }
  }));
});

// Addresses are always WELL-FORMED, which is what lets them be content-free: `checkedSlug` rejects the site's own
// reserved names and any slug that breaks the Project_Slug rule, so a Project_Section address is only ever formed
// from a usable slug (R40.3), and `fileFor` rejects path traversal and empty paths, so no content can smuggle a
// `..` or an absolute escape into the static file an address maps to.
it('R40.3: checkedSlug admits only usable Project_Slugs, and fileFor refuses traversal, keeping addresses well-formed', () => {
  // Accepts a usable slug unchanged.
  fc.assert(fc.property(slugArb, (slug) => {
    expect(checkedSlug(slug)).toBe(slug);
    expect(projectPaths(slug).page).toBe(`/p/${slug}`);
  }));
  // Rejects every reserved name.
  for (const name of RESERVED_PROJECT_SLUGS) expect(() => checkedSlug(name)).toThrow(RangeError);
  // Rejects slugs that break the Project_Slug rule (upper case, leading hyphen, spaces, slashes, over length, empty).
  for (const bad of ['', 'Upper', '-lead', 'has space', 'a/b', 'x'.repeat(41)]) expect(() => checkedSlug(bad)).toThrow(RangeError);
  // fileFor refuses traversal and non-rooted paths, so the file an address maps to cannot escape its tree.
  for (const bad of ['', 'relative', '/a/../b', '//host']) expect(() => fileFor(bad)).toThrow(RangeError);
  // A well-formed address maps to a fixed, traversal-free static file.
  fc.assert(fc.property(slugArb, (slug) => {
    expect(fileFor(projectPaths(slug).page)).toBe(`p/${slug}.html`);
  }));
});
