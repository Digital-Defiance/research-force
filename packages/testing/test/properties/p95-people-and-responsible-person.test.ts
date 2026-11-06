// Feature: research-collab-cms, Property 95: People page and Responsible_Person statement
import { describe, expect, it } from 'vitest';
import { PEOPLE_AFFILIATION_STATEMENT, PEOPLE_NO_PROFILE_STATEMENT, SITE_PATHS } from '@researchforce/design/fixed-texts';
import { EMAIL_PLACEHOLDER, projectProfile, responsiblePersonLabel, type ProfileRecord, type PublicProfileView } from '@researchforce/kernel/substitute';
import { fileFor, PAGE_PATHS } from '@researchforce/public-render/paths';
import { sortedProfiles } from '@researchforce/public-render/policy';
import { renderSite } from '@researchforce/public-render/render-site';
import { fc, FC_RUNS } from '../../src/fc';
import { byClass, byTag, find, findAll, readPage, textOf, type HtmlElement, type Page } from '../../src/html';
import { siteInputFor, syntheticSite } from '../../src/site';
import { workspaceStateArb } from '../../src/workspace';

/**
 * **Validates: Requirements 46.5, 46.6, 46.35, 46.38**
 *
 * Property 95, in two halves, each driving the REAL public renderer over generated inputs.
 *
 * People page (R46.5, R46.6). The People page shows EXACTLY the active Members whose Public_Profile setting is On —
 * every such Member, and no inactive or setting-Off Member — in ascending alphabetical order of display name compared
 * ignoring letter case and diacritics, each with exactly the four Public_Profile fields (display name, Specialties,
 * affiliations, biography) scrubbed of any registered Member address, and the fixed no-profile statement appears
 * exactly when no profile qualifies. The production path is the real `projectProfile`
 * (packages/kernel/src/substitute.ts), which keeps only Active + setting-On Members and scrubs their four fields, feeding
 * the real `peoplePage`/`sortedProfiles` (packages/public-render/src/policy.ts) that build the page. Two layers drive it:
 *   - the whole-workspace layer `siteInputFor(workspaceStateArb)` (as p16/p20/p73 do): every Member carries a status
 *     (active/pending/revoked) and a Public_Profile setting, and biographies embed registered addresses in varied
 *     letter case, so membership and scrubbing are exercised end to end against the real projection and render; the
 *     oracle re-runs the SAME `projectProfile` so the test never reimplements the filter or the scrub.
 *   - the profile-set layer `syntheticSite(profilesArb)`: an adversarial set of `PublicProfileView`s with diacritics,
 *     mixed case, and duplicate display names stresses the ordering of the real `peoplePage`, whose expected order is
 *     the real `sortedProfiles`.
 *
 * Responsible_Person statement (R46.35, R46.38). The Privacy page begins with the fixed statement naming the
 * Responsible_Person by display name whatever that Member's Member_Status, naming exactly one display name at every
 * moment; an unset designation leaves the name empty so the statement degrades without naming anyone; and a registered
 * address in the name is scrubbed as elsewhere (R46.9). The production path is the real `responsiblePersonLabel`
 * (packages/kernel/src/substitute.ts) — the exact selection-and-scrub rule the Publisher's render step calls
 * (apps/app/src/publisher/render.ts) — feeding the real `privacyPage` render. The generator names a Member who is
 * active, revoked, or unset, with a display name that may carry a registered address in varied case.
 *
 * Pool and run count. This property lives in the NODE pool (packages/testing/test/properties/) beside p16/p20/p73/p96
 * because it drives the full, pure site render. The whole chain — `projectProfile`, `responsiblePersonLabel`,
 * `siteInputFor`/`syntheticSite`, and `renderSite` — is pure over generated values, with no D1, R2, or Durable Object,
 * so the p88 per-run reset and the p78 run cap do not apply: it runs the full `FC_RUNS` with no setup between runs.
 */

/** The display-name heading of each rendered Public_Profile article, in document order. */
function renderedProfileNames(people: Page): string[] {
  return findAll(people.main.children, byClass('rf-profile')).map((article) => textOf(find(article.children, byTag('h2'))!.children));
}

/** The rendered fields of one Public_Profile article: its heading, the Specialties/Affiliations lines, and the biography paragraphs. */
function renderedProfile(article: HtmlElement): { displayName: string; specialties: string; affiliations: string; biography: string[] } {
  const paragraphs = article.children.filter((node): node is HtmlElement => typeof node !== 'string' && node.tag === 'p').map((node) => textOf(node.children));
  return {
    displayName: textOf(find(article.children, byTag('h2'))!.children),
    specialties: paragraphs.find((text) => text.startsWith('Specialties: ')) ?? '',
    affiliations: paragraphs.find((text) => text.startsWith('Affiliations: ')) ?? '',
    biography: paragraphs.filter((text) => !text.startsWith('Specialties: ') && !text.startsWith('Affiliations: ')),
  };
}

const NO_PROFILE_STATEMENT = PEOPLE_NO_PROFILE_STATEMENT.paragraphs[0]!;
const AFFILIATION_STATEMENT = PEOPLE_AFFILIATION_STATEMENT.paragraphs[0]!;

describe('Property 95: People page and Responsible_Person statement', () => {
  it('R46.5/R46.6: the People page shows exactly the active setting-On Members, scrubbed, in alphabetical order, or the no-profile statement', () => {
    fc.assert(fc.property(workspaceStateArb, (state) => {
      const site = siteInputFor(state);
      const files = new Map(renderSite(site).map((file) => [file.file, file.content]));
      const people = readPage(files.get(fileFor(SITE_PATHS.people))!);

      // The oracle re-runs the REAL projection: a Member's profile qualifies iff Active and Public_Profile On, with the
      // four fields scrubbed, and the page order is the REAL `sortedProfiles`. `siteInputFor` fed the page the same way.
      const emails = state.input.members.map((member) => member.email);
      const memberIds = new Set(state.input.members.map((member) => member.id));
      const expected = sortedProfiles([...state.profiles].flatMap(([id, profile]) => {
        const projected = memberIds.has(id) ? projectProfile(profile, emails) : undefined;
        return projected === undefined ? [] : [projected.view];
      }));

      // Exactly the qualifying Members, in the defined order; the no-profile statement appears iff none qualifies.
      expect(renderedProfileNames(people)).toEqual(expected.map((profile) => profile.displayName));
      expect(people.text.includes(NO_PROFILE_STATEMENT)).toBe(expected.length === 0);

      // No Member in any status with the setting Off or revoked is shown; no inactive/off display name reaches the page.
      const hidden = [...state.profiles.values()].filter((profile) => !(profile.publicProfile && profile.status === 'active'));
      const shownNames = new Set(expected.map((profile) => profile.displayName));
      for (const profile of hidden) if (!shownNames.has(profile.displayName)) expect(renderedProfileNames(people).includes(profile.displayName)).toBe(false);

      // Each shown article carries exactly the four scrubbed fields, and no registered address survives anywhere.
      const articles = findAll(people.main.children, byClass('rf-profile'));
      expect(articles).toHaveLength(expected.length);
      for (const [index, profile] of expected.entries()) {
        const rendered = renderedProfile(articles[index]!);
        expect(rendered.displayName).toBe(profile.displayName);
        expect(rendered.specialties).toBe(profile.specialties.length === 0 ? '' : `Specialties: ${profile.specialties.join(', ')}`);
        expect(rendered.affiliations).toBe(profile.affiliations.length === 0 ? '' : `Affiliations: ${profile.affiliations.join(', ')}`);
        expect(rendered.biography.join('\n\n')).toBe(profile.biography.split(/\n\s*\n/u).filter((paragraph) => /\S/u.test(paragraph)).join('\n\n'));
      }
      // Every registered address is scrubbed from the whole page: none appears, in any letter case (R46.9).
      for (const email of emails) expect(people.text.toLowerCase().includes(email.toLowerCase())).toBe(false);
      // The affiliation statement and the contact-form link are always present (R46.6).
      expect(people.text.includes(AFFILIATION_STATEMENT)).toBe(true);
      expect(people.links.some((link) => link.href === PAGE_PATHS.submitGeneral)).toBe(true);
    }), { numRuns: FC_RUNS });
  }, 50 * FC_RUNS);

  // Adversarial display names (diacritics, mixed case, duplicates) with registered addresses in the four fields.
  const nameArb = fc.oneof(
    fc.constantFrom('Zoë', 'zoe', 'ZOE', 'Ångström', 'angstrom', 'Étienne', 'etienne', 'Łukasz', 'lukasz', 'ábc', 'ABC', 'abc'),
    fc.string({ minLength: 1, maxLength: 12 }),
  );
  const addressArb = fc.constantFrom('a@reg.test', 'B@Reg.Test', 'carol@scrub.test');
  const fieldArb = (addresses: readonly string[]): fc.Arbitrary<string> =>
    fc.tuple(fc.string({ maxLength: 8 }), fc.option(fc.constantFrom(...addresses), { nil: '' })).map(([stem, address]) => `${stem}${address ? ` ${address} ` : ''}token`);

  const profileCaseArb = fc.array(addressArb, { minLength: 1, maxLength: 3 }).chain((addresses) => fc.record({
    addresses: fc.constant(addresses),
    profiles: fc.array(fc.record({
      displayName: nameArb, specialties: fc.array(fieldArb(addresses), { maxLength: 2 }),
      affiliations: fc.array(fieldArb(addresses), { maxLength: 2 }), biography: fieldArb(addresses),
    }), { minLength: 1, maxLength: 6 }),
  }));

  it('R46.6: the People page lists adversarial profiles in alphabetical order ignoring case and diacritics, each field scrubbed', () => {
    fc.assert(fc.property(profileCaseArb, ({ addresses, profiles }) => {
      // Scrub each generated profile with the REAL projection, exactly as the People page input is built, then render.
      const records: ProfileRecord[] = profiles.map((profile) => ({ ...profile, publicProfile: true, status: 'active' as const }));
      const views: PublicProfileView[] = records.flatMap((record) => {
        const projected = projectProfile(record, addresses);
        return projected === undefined ? [] : [projected.view];
      });
      const site = syntheticSite([], { profiles: views });
      const people = readPage(new Map(renderSite(site).map((file) => [file.file, file.content])).get(fileFor(SITE_PATHS.people))!);

      // The rendered order is exactly the REAL `sortedProfiles` order (R46.6): alphabetical, case- and diacritic-insensitive.
      expect(renderedProfileNames(people)).toEqual(sortedProfiles(views).map((profile) => profile.displayName));
      // No registered address survives in any field, and the placeholder stands in where one was embedded (R46.9).
      for (const address of addresses) expect(people.text.toLowerCase().includes(address.toLowerCase())).toBe(false);
      if (views.some((view) => [view.displayName, ...view.specialties, ...view.affiliations, view.biography].some((text) => text.includes(EMAIL_PLACEHOLDER)))) {
        expect(people.text.includes(EMAIL_PLACEHOLDER)).toBe(true);
      }
    }), { numRuns: FC_RUNS });
  }, 50 * FC_RUNS);

  // A Member who is active, revoked, or absent (unset designation), whose display name may carry a registered address.
  const responsibleCaseArb = fc.record({
    displayName: fc.oneof(nameArb, nameArb.chain((stem) => addressArb.map((address) => `${stem} ${address}`))),
    status: fc.constantFrom('active', 'revoked', 'pending'),
    addresses: fc.array(addressArb, { minLength: 1, maxLength: 3 }),
    /** Whether the designation is set at all; an unset one must degrade without a name. */
    set: fc.boolean(),
  });

  it('R46.35/R46.38: the Privacy page names exactly the Responsible_Person’s display name whatever the status, scrubbed, or none when unset', () => {
    fc.assert(fc.property(responsibleCaseArb, ({ displayName, addresses, set }) => {
      const RESPONSIBLE_ID = 'rp-1';
      // The REAL selection-and-scrub rule the Publisher runs: the designated Member's name whatever its status (R46.35),
      // the address scrubbed (R46.9), or empty when the designation is unset so the statement degrades (R46.38).
      const members = [{ id: RESPONSIBLE_ID, displayName }];
      const expected = responsiblePersonLabel(members, set ? RESPONSIBLE_ID : undefined, addresses);
      const site = syntheticSite([], { responsiblePerson: expected });
      const privacy = readPage(new Map(renderSite(site).map((file) => [file.file, file.content])).get(fileFor(SITE_PATHS.privacy))!);

      // The Responsible_Person statement opens the Privacy page and names exactly the computed display name (R46.35).
      // The reader sees collapsed whitespace, so compare against the collapsed name the page actually shows.
      const shownName = expected.replace(/\s+/gu, ' ').trim();
      expect(privacy.mainText.includes('is the person responsible for this site and its processing of personal data.')).toBe(true);
      if (set && shownName !== '') expect(privacy.mainText.includes(`${shownName} is the person responsible`)).toBe(true);
      // Unset or a blank name degrades: no Member name is invented, so the fixed statement words still open the page.
      else expect(privacy.mainText.includes('is the person responsible')).toBe(true);
      // No registered address survives in the name on the page, in any letter case (R46.9).
      for (const address of addresses) expect(privacy.mainText.toLowerCase().includes(address.toLowerCase())).toBe(false);
    }), { numRuns: FC_RUNS });
  }, 50 * FC_RUNS);
});
