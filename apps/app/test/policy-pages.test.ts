import { beforeEach, describe, expect, it } from 'vitest';
import { fc } from '@researchforce/testing/fc';
import { TEST_PUBLIC_COPY } from '@researchforce/testing/site';
import { retentionRows } from '@researchforce/domain/retention';
import { asTimestamp } from '@researchforce/domain/types';
import type { PublicProfileView } from '@researchforce/kernel/substitute';
import { METHODS_SET_KINDS, POLICY_PAGE_KEYS, type MethodsInput, type MethodsValue, type PolicyPageKey } from '@researchforce/public-render/site';
import {
  advancedGeneratedRows, generatedHash, pageGeneratedContent, pageLastUpdated, policyLastUpdated,
  type GeneratedContent, type PolicyPageState, type StoredGenerated,
} from '../src/publisher/policy-pages';
import { loadSiteInput, renderSiteBuild } from '../src/publisher/render';
import { itemWorld } from './items';

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const emptyMethods = (): MethodsInput => ({
  values: Object.fromEntries(METHODS_SET_KINDS.map((kind) => [kind, [] as MethodsValue[]])) as unknown as MethodsInput['values'],
  terms: [],
});
const profile = (displayName: string, biography = ''): PublicProfileView => ({ displayName, specialties: [], affiliations: [], biography });
const LICENCE = { name: 'Synthetic Licence 1.0', url: 'https://licence.example.test/1.0' } as const;

/** The whole-site generated content with every page's inputs empty, so one field can be varied per test. */
const emptyGenerated = (): GeneratedContent => ({ profiles: [], methods: emptyMethods(), licence: LICENCE, retention: [], responsiblePerson: '' });

const stored = (hash: string | null, changedAt: string | null): StoredGenerated => ({ hash, changedAt });
const state = (overrides: Partial<Record<PolicyPageKey, PolicyPageState>> = {}): Record<PolicyPageKey, PolicyPageState> =>
  Object.fromEntries(POLICY_PAGE_KEYS.map((key): [PolicyPageKey, PolicyPageState] => [
    key, overrides[key] ?? { sectionChangedAt: null, stored: stored(null, null) },
  ])) as Record<PolicyPageKey, PolicyPageState>;

const NOW = asTimestamp('2026-10-27T18:00:00.000Z');
const TODAY = '2026-10-27';

// ---------------------------------------------------------------------------
// Pure last-updated logic (R46.29).
// ---------------------------------------------------------------------------

describe('a Policy_Page generated-content hash', () => {
  it('maps each generated input to the page that presents it, and nothing to About or Corrections', () => {
    const base = emptyGenerated();
    const content = pageGeneratedContent(base);
    // People hashes the profiles; Methods the value sets and terms; Licence the name; Privacy the retention and
    // Responsible_Person; About and Corrections present no generated content.
    expect(generatedHash(content.people)).not.toBe(generatedHash(pageGeneratedContent({ ...base, profiles: [profile('Ada Synth')] }).people));
    const withValue: MethodsValue = { id: 'v1', name: 'Open', description: 'An open campaign.', retired: false };
    const changedMethods: MethodsInput = { ...emptyMethods(), values: { ...emptyMethods().values, campaign_status: [withValue] } };
    expect(generatedHash(content.methods)).not.toBe(generatedHash(pageGeneratedContent({ ...base, methods: changedMethods }).methods));
    expect(generatedHash(content.licence)).not.toBe(generatedHash(pageGeneratedContent({ ...base, licence: { name: 'Other 2.0', url: LICENCE.url } }).licence));
    expect(generatedHash(content.privacy)).not.toBe(generatedHash(pageGeneratedContent({ ...base, responsiblePerson: 'Ada Synth' }).privacy));
    expect(generatedHash(content.privacy)).not.toBe(generatedHash(pageGeneratedContent({ ...base, retention: retentionRows() }).privacy));
    // About and Corrections have no generated content, so changing any whole-site input leaves their hashes equal.
    expect(generatedHash(content.about)).toBe(generatedHash(pageGeneratedContent({ ...base, profiles: [profile('Ada Synth')], responsiblePerson: 'x' }).about));
    expect(generatedHash(content.corrections)).toBe(generatedHash(pageGeneratedContent({ ...base, retention: retentionRows() }).corrections));
  });

  it('is stable under object key order, so equal content hashes equally', () => {
    const a = generatedHash({ name: LICENCE.name, url: LICENCE.url });
    const b = generatedHash({ url: LICENCE.url, name: LICENCE.name });
    expect(a).toBe(b);
  });
});

describe('one page last-updated date', () => {
  const content = pageGeneratedContent(emptyGenerated()).licence;

  it('takes the max of the section-change date and the generated-content change date', () => {
    // Section changed after the stored generated change: the section date wins.
    const result = pageLastUpdated('2026-10-20T09:00:00.000Z', stored(generatedHash(content), '2026-10-10'), content, NOW);
    expect(result.changedOn).toBe('2026-10-20');
    // Generated content changed (hash differs) today, after the section date: the generated date wins.
    const changed = pageLastUpdated('2026-10-20T09:00:00.000Z', stored('stale-hash', '2026-10-10'), content, NOW);
    expect(changed.changedOn).toBe(TODAY);
  });

  it('keeps the stored date when the generated content is unchanged, so a rebuild does not re-advance it', () => {
    const hash = generatedHash(content);
    const first = pageLastUpdated(null, stored(hash, '2026-10-05'), content, NOW);
    expect(first.changedOn).toBe('2026-10-05');
    expect(first.advanced).toBe(false);
    expect(first.generatedHash).toBe(hash);
    expect(first.generatedChangedAt).toBe('2026-10-05');
  });

  it('advances to the build date and flags the change when the generated content differs from the stored hash', () => {
    const result = pageLastUpdated(null, stored('old-hash', '2026-10-01'), content, NOW);
    expect(result.changedOn).toBe(TODAY);
    expect(result.advanced).toBe(true);
    expect(result.generatedHash).toBe(generatedHash(content));
    expect(result.generatedChangedAt).toBe(TODAY);
  });

  it('never advances without a build clock, so a preview or export shows the last published date', () => {
    const result = pageLastUpdated('2026-10-02T00:00:00.000Z', stored('old-hash', '2026-10-05'), content, undefined);
    // No clock: the stored generated date stands even though the hash differs, and nothing is flagged to persist.
    expect(result.changedOn).toBe('2026-10-05');
    expect(result.advanced).toBe(false);
  });
});

describe('every page last-updated', () => {
  it('advances only the page whose generated content changed, and lists just that page to persist', () => {
    const base = emptyGenerated();
    // Seed every page's stored hash to its current (empty) content, then change only the People profiles.
    const content = pageGeneratedContent(base);
    const seeded = state(Object.fromEntries(POLICY_PAGE_KEYS.map((key): [PolicyPageKey, PolicyPageState] => [
      key, { sectionChangedAt: '2026-10-01T00:00:00.000Z', stored: stored(generatedHash(content[key]), '2026-10-01') },
    ])) as Record<PolicyPageKey, PolicyPageState>);
    const site: GeneratedContent = { ...base, profiles: [profile('Ada Synth')] };
    const computed = policyLastUpdated(site, seeded, NOW);
    expect(computed.people.changedOn).toBe(TODAY);
    expect(computed.people.advanced).toBe(true);
    // No other page's generated content changed, so they keep their stored date.
    for (const key of POLICY_PAGE_KEYS.filter((k) => k !== 'people')) {
      expect(computed[key].changedOn).toBe('2026-10-01');
      expect(computed[key].advanced).toBe(false);
    }
    expect(advancedGeneratedRows(computed).map((row) => row.pageKey)).toEqual(['people']);
  });

  it('persists nothing when a rebuild sees the same content as the last build (idempotent)', () => {
    const base: GeneratedContent = { ...emptyGenerated(), profiles: [profile('Ada Synth')], retention: retentionRows(), responsiblePerson: 'Ada Synth' };
    const content = pageGeneratedContent(base);
    const seeded = state(Object.fromEntries(POLICY_PAGE_KEYS.map((key): [PolicyPageKey, PolicyPageState] => [
      key, { sectionChangedAt: null, stored: stored(generatedHash(content[key]), '2026-10-01') },
    ])) as Record<PolicyPageKey, PolicyPageState>);
    const computed = policyLastUpdated(base, seeded, asTimestamp('2027-01-01T00:00:00.000Z'));
    expect(advancedGeneratedRows(computed)).toEqual([]);
    for (const key of POLICY_PAGE_KEYS) expect(computed[key].changedOn).toBe('2026-10-01');
  });
});

describe('the last-updated date property (R46.29)', () => {
  const day = fc.integer({ min: 1, max: 28 }).map((d) => `2026-10-${String(d).padStart(2, '0')}`);
  it('is at least the section-change date, and advances the generated date only on a hash change', () => {
    fc.assert(fc.property(
      day, day, fc.string({ maxLength: 8 }), fc.boolean(),
      (sectionDay, storedDay, name, matches) => {
        const content = pageGeneratedContent({ ...emptyGenerated(), responsiblePerson: name }).privacy;
        const storedHash = matches ? generatedHash(content) : 'a-different-hash';
        const result = pageLastUpdated(`${sectionDay}T00:00:00.000Z`, stored(storedHash, storedDay), content, NOW);
        // The last-updated date is never earlier than the section-change date.
        expect(result.changedOn >= sectionDay).toBe(true);
        if (matches) {
          // Unchanged content keeps the stored date and persists nothing.
          expect(result.advanced).toBe(false);
          expect(result.generatedChangedAt).toBe(storedDay);
          expect(result.changedOn).toBe(sectionDay > storedDay ? sectionDay : storedDay);
        } else {
          // Changed content advances to today and flags a persist.
          expect(result.advanced).toBe(true);
          expect(result.generatedChangedAt).toBe(TODAY);
        }
      },
    ));
  });
});

// ---------------------------------------------------------------------------
// Through the Publisher's loader and build against live rf-core/rf-public.
// ---------------------------------------------------------------------------

const world = itemWorld();
const core = () => world.core();
const pub = () => world.bindings.RF_PUBLIC;
const priv = () => world.bindings.RF_PRIVATE_BUCKET;
const renderDeps = () => ({ core: core(), public: pub(), privateBucket: priv(), licence: LICENCE, publicCopy: TEST_PUBLIC_COPY, shellAssets: [] });

const peopleRow = async (): Promise<{ hash: string | null; changedAt: string | null }> => {
  const row = await core().prepare('SELECT generated_hash AS hash, generated_changed_at AS changedAt FROM policy_pages WHERE page_key = ?1').bind('people').first<{ hash: string | null; changedAt: string | null }>();
  return row ?? { hash: null, changedAt: null };
};
const showProfile = async (memberId: string): Promise<void> => {
  await core().prepare('UPDATE profiles SET public_profile = 1 WHERE member_id = ?1').bind(memberId).run();
};

beforeEach(async () => {
  await pub().batch([pub().prepare('DELETE FROM public_views'), pub().prepare('DELETE FROM publish_runs'), pub().prepare('DELETE FROM site_files')]);
});

describe('the Publisher build', () => {
  it('records the People page generated hash and advances its last-updated date when a Public_Profile appears', async () => {
    // The seed stamps the section date with the real clock, so pin it to keep the test independent of today's date.
    await core().prepare('UPDATE policy_pages SET sections_changed_at = ?1').bind(world.at).run();
    // First build with no public profiles: it records a hash and a date for the People page.
    await renderSiteBuild(renderDeps(), world.at);
    const first = await peopleRow();
    expect(first.hash).not.toBeNull();
    expect(first.changedAt).toBe('2026-10-27');

    // A rebuild with the same content does not advance the date (idempotent).
    await renderSiteBuild({ ...renderDeps() }, asTimestamp('2026-11-05T00:00:00.000Z'));
    const stable = await peopleRow();
    expect(stable.hash).toBe(first.hash);
    expect(stable.changedAt).toBe(first.changedAt);

    // Turn a Member's Public_Profile On: the People page's generated content changes, so the date advances.
    await showProfile(world.ids.author);
    await renderSiteBuild({ ...renderDeps() }, asTimestamp('2026-11-10T00:00:00.000Z'));
    const advanced = await peopleRow();
    expect(advanced.hash).not.toBe(first.hash);
    expect(advanced.changedAt).toBe('2026-11-10');

    // The loaded site input shows the advanced date on the People page.
    const input = await loadSiteInput({ core: core(), public: pub(), licence: LICENCE, publicCopy: TEST_PUBLIC_COPY });
    expect(input.policy.people.changedOn).toBe('2026-11-10');
  });

  it('shows the last published date through a read-only load without advancing it', async () => {
    await renderSiteBuild(renderDeps(), world.at);
    const before = await peopleRow();
    // A read-only load (no build clock) must not write the hash/date even if it recomputes them.
    await loadSiteInput({ core: core(), public: pub(), licence: LICENCE, publicCopy: TEST_PUBLIC_COPY });
    const after = await peopleRow();
    expect(after).toEqual(before);
  });
});
