// Feature: research-collab-cms, Property 106: Research_Question entries are valid and follow their targets
import { beforeEach, describe, expect, it } from 'vitest';
import { GuardedBatch } from '@researchforce/db/batch';
import { readEpoch } from '@researchforce/db/publication-epoch';
import type { Generation } from '@researchforce/db/publication-epoch';
import { unitKey } from '@researchforce/kernel/views';
import type { PublicView, UnitKey } from '@researchforce/kernel/views';
import { BUILT_IN_VALUE_IDS } from '@researchforce/domain/value-sets';
import type { ULID } from '@researchforce/domain/types';
import { byClass, find, findAll, readPage, textOf } from '@researchforce/testing/html';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { TEST_PUBLIC_COPY } from '@researchforce/testing/site';
import { renderSiteBuild } from '../../src/publisher/render';
import { runProjectionSlice } from '../../src/publisher/projection';
import type { ProjectionDeps } from '../../src/publisher/projection';
import { errorOf, itemWorld } from '../items';
import type { ItemView } from '../items';
import { addElement, addProject, addSubmissionRow, resetRecords } from '../units';

/**
 * Validates R50.1, R50.2, R50.4, R50.5, R50.6, R50.7: against an independent model authored from the requirements,
 * the real Workspace API, the real Publisher projection, and the real Public_Site render agree on Research_Questions.
 *
 * (1) Workspace invariants (R50.1, R50.2, R50.6): over randomised questions — random groups, each with random entries
 * naming a random set of readable Research_Items/Attachments of the Project — a created or edited question's STORED
 * groups and entries equal exactly what was submitted (order kept), each entry is an Addresses Cross_Link from the
 * question to its target (`cross_links` rows asserted), and the validation rules refuse an out-of-limit value, an
 * entry whose target is another Project's / deleted / unknown, the SAME target in two entries (saving nothing), and
 * the reserved Addresses label on any link that is not a Question_Group entry.
 *
 * (2) Entries follow their targets (R50.5): once the question and its targets are Public, the question's projected
 * view's Addresses link ends reflect each target's CURRENT public state — a Public target is a link end, a Withheld
 * target is its Disclosure_Line end, and a Not_Published or Restricted target produces no visible end — exactly as
 * `projectDetailed` would. After a target's disclosure changes and the Publisher reprojects (driven through the
 * Cross_Link neighbour expansion, publishing only the TARGET's scope), the materialized question view changes to
 * match the new state.
 *
 * (3) Public rendering (R50.4, R50.6, R50.7): the rendered research_question page shows the question text and each
 * entry as a Cross_Link end, shows the introduction ONLY under Full_Content (never when the question is Summary_Only),
 * and the Project page's Research_Question part orders by the Administrator's `question_order` then newest first; no
 * Not_Published target leaks into the public rendering. The model is authored here, never by reading the Publisher's
 * own SQL back as its own oracle.
 */

const ADDRESSES = BUILT_IN_VALUE_IDS.relationAddresses;
const RELATED = BUILT_IN_VALUE_IDS.relationEvidenceFor; // an ordinary (non-Addresses) relation label
/** The disclosure a target settles on; `withheld` carries a Disclosure_Line, `restricted` stays off the public site. */
type Level = 'public' | 'withheld' | 'not_published' | 'restricted';
const LEVELS: readonly Level[] = ['public', 'withheld', 'not_published', 'restricted'];
const SYNTHETIC_LINE = JSON.stringify({ kindOfMaterial: 'Synthetic material', date: { value: '2026-10-01', approx: false }, partyIds: [] });

const world = itemWorld();
const core = (): D1Database => world.bindings.RF_CORE;
const pub = (): D1Database => world.bindings.RF_PUBLIC;
const priv = (): R2Bucket => world.bindings.RF_PRIVATE_BUCKET;
const NOW = () => world.at;
const deps = (): ProjectionDeps => ({ core: core(), public: pub() });
const LICENCE = { name: 'Synthetic Licence 1.0', url: 'https://licence.example.test/1.0' } as const;
const renderDeps = () => ({ core: core(), public: pub(), privateBucket: priv(), licence: LICENCE, publicCopy: TEST_PUBLIC_COPY, shellAssets: [] });

beforeEach(async () => {
  await core().batch([core().prepare("DELETE FROM outbox WHERE topic = 'publish'"), core().prepare("DELETE FROM counters WHERE k = 'epoch'")]);
  await pub().batch([pub().prepare('DELETE FROM public_views'), pub().prepare('DELETE FROM publish_runs'), pub().prepare('DELETE FROM site_files')]);
});

const groupsOf = (item: ItemView): { id: string; heading: string; entries: { targetId: string }[] }[] =>
  item['groups'] as { id: string; heading: string; entries: { targetId: string }[] }[];

/** The active (not-removed) Addresses Cross_Link targets of a question, in `cross_links` id order. */
async function addressTargets(questionId: string): Promise<string[]> {
  const rows = (await core().prepare(
    'SELECT target_id AS targetId FROM cross_links WHERE origin_id = ?1 AND relation_value_id = ?2 AND removed_at IS NULL ORDER BY id',
  ).bind(questionId, ADDRESSES).all<{ targetId: string }>()).results;
  return rows.map((row) => row.targetId);
}

/** Set a unit's stored disclosure the way a save does (p15's `setLevel`): Withheld writes a line, Restricted hides it. */
async function setLevel(id: ULID, level: Level): Promise<void> {
  const stored = level === 'restricted' ? 'not_published' : level;
  const line = level === 'withheld' ? SYNTHETIC_LINE : null;
  await core().prepare('UPDATE units SET disclosure_level = ?2, disclosure_line = ?3 WHERE id = ?1').bind(id, stored, line).run();
  if (level === 'restricted') await core().prepare("UPDATE research_items SET access_level = 'restricted' WHERE unit_id = ?1").bind(id).run();
  else await core().prepare("UPDATE research_items SET access_level = 'whole_team' WHERE unit_id = ?1").bind(id).run();
}

/**
 * Append one `publish` row at `changeSeq`; an urgent save bumps the epoch in the same batch, as a real
 * confidentiality-affecting save does (R24.16), so the projection is fenced against the current epoch.
 */
async function publish(scope: string, changeSeq: number, urgent: boolean): Promise<void> {
  const batch = new GuardedBatch(core(), { id: null, now: NOW() }, { ignoreFreeze: true });
  if (urgent) batch.bumpEpoch();
  await batch.commit();
  await core().prepare("INSERT INTO outbox (topic, scope, change_seq, created_at) VALUES ('publish', ?1, ?2, ?3)").bind(scope, changeSeq, NOW()).run();
}
/**
 * `beforeEach` fires once per `it`, but a property body runs many times; clear the records and open a fresh Project
 * at the start of each iteration so questions and targets do not accumulate across iterations (as p15 does). The
 * author/colleague/Administrator Members (and their tokens) persist, so `world.created` keeps working.
 */
async function freshProject(options: { readonly isPublic?: boolean } = {}): Promise<ULID> {
  await resetRecords(core());
  await core().batch([core().prepare("DELETE FROM outbox WHERE topic = 'publish'"), core().prepare("DELETE FROM counters WHERE k = 'epoch'")]);
  await pub().batch([pub().prepare('DELETE FROM public_views'), pub().prepare('DELETE FROM publish_runs'), pub().prepare('DELETE FROM site_files')]);
  const projectId = await addProject(core(), world.ids.admin, NOW());
  if (options.isPublic) await core().prepare("UPDATE projects SET disclosure_level = 'public' WHERE id = ?1").bind(projectId).run();
  (world as { projectId: ULID }).projectId = projectId;
  return projectId;
}

/** Drain the publish outbox to quiescence under the current epoch (a few bounded slices, like the DO's loop). */
async function drain(): Promise<void> {
  for (let slice = 0; slice < 32; slice += 1) {
    const gen: Generation = { run: `drain-${slice}`, epoch: await readEpoch(core()) };
    const result = await runProjectionSlice(deps(), gen, NOW());
    if (!result.more && result.processed === 0) break;
  }
}

/** The current open Public_View of a unit key, parsed from its canonical JSON, or undefined when the unit has none. */
async function currentView(key: UnitKey): Promise<PublicView | undefined> {
  const row = await pub().prepare('SELECT view_json AS viewJson FROM public_views WHERE unit_key = ?1 AND valid_to_at IS NULL').bind(key).first<{ viewJson: string }>();
  return row === null ? undefined : (JSON.parse(row.viewJson) as PublicView);
}

/** The read content of a rendered page at a site path, fetched from `rf-private/build/{hash}` via the manifest. */
async function pageContent(path: string): Promise<string | undefined> {
  const row = await pub().prepare('SELECT hash FROM site_files WHERE path = ?1').bind(path).first<{ hash: string }>();
  if (row === null) return undefined;
  const object = await priv().get(`build/${row.hash}`);
  return object === null ? undefined : object.text();
}

/**
 * The model of the question's projected Addresses ends, authored from each target's level (R50.5). A Public target
 * contributes a `link` end that names its title; a Withheld target contributes a `withheld` end; a Not_Published or
 * Restricted target contributes nothing. The order is the entries' order, as the links are written and projected.
 */
interface Target { readonly id: ULID; readonly identifier: string | null; readonly title: string; level: Level }
type ExpectedEnd = { kind: 'link'; title: string } | { kind: 'withheld' };
function expectedEnds(entryTargets: readonly Target[]): ExpectedEnd[] {
  return entryTargets.flatMap((target): ExpectedEnd[] => {
    if (target.level === 'public') return [{ kind: 'link', title: target.title }];
    if (target.level === 'withheld') return [{ kind: 'withheld' }];
    return [];
  });
}

/** The Addresses ends a projected Research_Question view actually carries (outgoing Addresses links only). */
function projectedEnds(view: PublicView | undefined): ExpectedEnd[] {
  if (view === undefined || view.tag !== 'research_item') return [];
  return (view.links ?? []).flatMap((link): ExpectedEnd[] => {
    if (link.direction !== 'outgoing' || link.relation?.id !== ADDRESSES) return [];
    const target = link.target;
    if (target.tag === 'withheld') return [{ kind: 'withheld' }];
    if (target.tag === 'link') return [{ kind: 'link', title: target.title }];
    return [];
  });
}

describe('Property 106: Research_Question entries are valid and follow their targets', () => {
  // --- (1) Workspace invariants: stored groups/entries, Addresses Cross_Links, and the validation refusals. --------
  it('stores a question’s groups and entries as Addresses Cross_Links and refuses invalid submissions (R50.1, R50.2, R50.6)', async () => {
    // A random set of targets (Research_Items and Attachments of the Project), then random groups whose entries draw
    // from that set without repeating a target (the schema forbids a repeat, which a separate case checks).
    const plan = fc.record({
      targetKinds: fc.array(fc.constantFrom('finding', 'source', 'hypothesis', 'attachment') as fc.Arbitrary<'finding' | 'source' | 'hypothesis' | 'attachment'>, { minLength: 1, maxLength: 5 }),
      // For each group: a heading and a subset of the target indices, each at most once across the whole question.
      groups: fc.array(fc.record({ heading: fc.integer({ min: 1, max: 9999 }).map((n) => `Group ${n}`), entryIndices: fc.array(fc.nat({ max: 4 }), { maxLength: 5 }) }), { minLength: 1, maxLength: 3 }),
    });

    await fc.assert(fc.asyncProperty(plan, async (spec) => {
      await freshProject();
      // Create the target set: Research_Items through the API, Attachments directly under a Research_Item of the
      // Project (building an Attachment through the API needs a prior upload row, which this invariant does not test).
      const targets: ULID[] = [];
      let parent: ULID | undefined;
      let submissionId: ULID | undefined;
      for (const kind of spec.targetKinds) {
        if (kind === 'attachment') {
          parent ??= (await world.created('author', 'finding')).id;
          submissionId ??= await addSubmissionRow(core(), world.ids.author, NOW());
          const place = { projectId: world.projectId, ownerId: world.ids.author, submissionId, now: NOW() };
          targets.push((await addElement(core(), place, 'attachment', parent)).id);
        } else {
          targets.push((await world.created('author', kind)).id);
        }
      }

      // The submitted groups, each entry a distinct target drawn in order (dropping repeats so this case is valid).
      const used = new Set<string>();
      const submitted = spec.groups.map((group) => ({
        heading: group.heading,
        entries: group.entryIndices.flatMap((index) => {
          const id = targets[index % targets.length]!;
          if (used.has(id)) return [];
          used.add(id);
          return [{ targetId: id }];
        }),
      }));

      const created = await world.created('author', 'research_question', { groups: submitted });
      const stored = groupsOf(created);
      // The stored groups and entries equal what was submitted, in order (R50.1).
      expect(stored.map((group) => [group.heading, group.entries.map((entry) => entry.targetId)]))
        .toEqual(submitted.map((group) => [group.heading, group.entries.map((entry) => entry.targetId)]));
      // Every entry is an active Addresses Cross_Link from the question to its target (R50.2).
      const entryTargets = submitted.flatMap((group) => group.entries.map((entry) => entry.targetId));
      expect([...await addressTargets(created.id as string)].sort()).toEqual([...entryTargets].sort());

      // A duplicate target in two entries saves nothing and names the second (R50.6).
      if (targets.length >= 1) {
        const dup = await errorOf(await world.create('author', 'research_question', {
          projectId: world.projectId, title: 'Dup', question: 'Why twice?',
          groups: [{ heading: 'A', entries: [{ targetId: targets[0]! }] }, { heading: 'B', entries: [{ targetId: targets[0]! }] }],
        }));
        expect(dup.status).toBe(422);
        expect(dup.fields?.map((field) => field.field)).toEqual(['groups.1.entries.0.targetId']);
      }
    }), { numRuns: Math.min(FC_RUNS, 20) });
  }, 4000 * FC_RUNS);

  // --- (1b) The reserved Addresses label is refused for any link that is not a Question_Group entry (R50.2). --------
  it('refuses the reserved Addresses label on a link that is not a Question_Group entry (R50.2)', async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom('finding', 'hypothesis', 'source') as fc.Arbitrary<'finding' | 'hypothesis' | 'source'>, async (kind) => {
      await freshProject();
      const a = await world.created('author', kind);
      const b = await world.created('author', 'finding');
      // A plain Cross_Link with the Addresses label between two ordinary items is refused with the reserved-label rule.
      const refused = await errorOf(await world.request('author', 'POST', '/links', { originId: a.id, targetId: b.id, relationValueId: ADDRESSES }));
      expect(refused.status).toBe(422);
      expect(refused.fields?.some((field) => field.rule.includes('reserved for the entries of a Research Question'))).toBe(true);
      // No Addresses Cross_Link was written.
      expect(await addressTargets(a.id as string)).toEqual([]);
      // The same two ends with an ordinary label are accepted, so the refusal is about the label, not the ends.
      const ok = await world.request('author', 'POST', '/links', { originId: a.id, targetId: b.id, relationValueId: RELATED });
      expect(ok.status).toBe(201);
    }), { numRuns: Math.min(FC_RUNS, 10) });
  }, 2000 * FC_RUNS);

  // --- (2) The projected question view's entry ends follow each target's current public state (R50.5). -------------
  it('projects each entry end by its target’s current public state and re-renders through neighbour expansion (R50.5)', async () => {
    const plan = fc.record({
      // The targets and their initial levels; at least one so the question has an entry.
      targets: fc.array(fc.record({ kind: fc.constantFrom('finding', 'hypothesis', 'source') as fc.Arbitrary<'finding' | 'hypothesis' | 'source'>, level: fc.constantFrom(...LEVELS) }), { minLength: 1, maxLength: 4 }),
      // A later re-level of one target (by index), to drive the neighbour-expansion re-render of the question page.
      change: fc.record({ index: fc.nat({ max: 3 }), level: fc.constantFrom(...LEVELS) }),
    });

    await fc.assert(fc.asyncProperty(plan, async (spec) => {
      await freshProject({ isPublic: true });
      const targets: Target[] = [];
      for (const target of spec.targets) {
        const item = await world.created('author', target.kind);
        targets.push({ id: item.id, identifier: (item['identifier'] as string | null) ?? null, title: item.title as string, level: target.level });
      }
      // One group holding every target as an entry, in order.
      const question = await world.created('author', 'research_question', { groups: [{ heading: 'Evidence', entries: targets.map((target) => ({ targetId: target.id })) }] });

      // Make the question Public (Full_Content) and set each target's initial level, then project the whole Project.
      await setLevel(question.id, 'public');
      for (const target of targets) await setLevel(target.id, target.level);
      await publish(`project:${world.projectId}`, 1, false);
      await drain();

      // The projected question view's Addresses ends equal the model of each target's CURRENT level.
      expect(projectedEnds(await currentView(unitKey(question.id)))).toEqual(expectedEnds(targets));

      // Re-level one target and publish ONLY that target's scope; the question re-renders via neighbour expansion.
      const changed = targets[spec.change.index % targets.length]!;
      const wasVisible = changed.level === 'public' || changed.level === 'withheld';
      await setLevel(changed.id, spec.change.level);
      changed.level = spec.change.level;
      await publish(`unit:${changed.id}`, 2, wasVisible || spec.change.level === 'public' || spec.change.level === 'withheld');
      await drain();

      // The materialized question view now reflects the changed target's new public state (R50.5).
      expect(projectedEnds(await currentView(unitKey(question.id)))).toEqual(expectedEnds(targets));
    }), { numRuns: Math.min(FC_RUNS, 15) });
  }, 6000 * FC_RUNS);

  // --- (3) The rendered research_question page and the Project page's Research_Question part (R50.4, R50.6, R50.7). -
  it('renders the question, its entry ends, the introduction only under Full_Content, and the ordered Project part (R50.4, R50.6, R50.7)', async () => {
    const plan = fc.record({
      targets: fc.array(fc.record({ kind: fc.constantFrom('finding', 'hypothesis') as fc.Arbitrary<'finding' | 'hypothesis'>, level: fc.constantFrom(...LEVELS) }), { minLength: 1, maxLength: 4 }),
      fullContent: fc.boolean(), // whether the Full_Content question shows its introduction
      // An Administrator order that may name the second question first; the rest follow newest-first by Item_Date.
      orderSummaryFirst: fc.boolean(),
    });

    await fc.assert(fc.asyncProperty(plan, async (spec) => {
      await freshProject({ isPublic: true });
      const slug = (await core().prepare('SELECT slug FROM projects WHERE id = ?1').bind(world.projectId).first<{ slug: string }>())!.slug;
      const intro = 'The introduction to the night route.';
      const targets: Target[] = [];
      for (const target of spec.targets) {
        const item = await world.created('author', target.kind, { title: `Target ${targetTitle(targets.length)}` });
        targets.push({ id: item.id, identifier: (item['identifier'] as string | null) ?? null, title: item.title as string, level: target.level });
      }

      // Two questions of the Project so the ordering has something to order: the main one (newer Item_Date) and a
      // second, earlier one. Their Item_Date keys are set directly so newest-first is deterministic.
      const main = await world.created('author', 'research_question', {
        title: 'The night route question', question: 'What really happened on the night route?', introduction: { text: intro, spans: [] },
        groups: [{ heading: 'Evidence', entries: targets.map((target) => ({ targetId: target.id })) }],
      });
      const earlier = await world.created('author', 'research_question', { title: 'The route choice question', question: 'Why was the route chosen at all?', groups: [] });
      // A Research_Question's Item_Date is its creation instant; set the two to distinct days so newest-first is
      // deterministic (main newer than earlier), independent of the random tiebreak on equal dates.
      await core().prepare("UPDATE units SET created_at = '2026-10-27T10:00:00.000Z' WHERE id = ?1").bind(main.id).run();
      await core().prepare("UPDATE units SET created_at = '2026-10-20T10:00:00.000Z' WHERE id = ?1").bind(earlier.id).run();
      // The main question is Public; Full_Content or Summary_Only decides whether the introduction shows (R50.4).
      await core().prepare('UPDATE research_items SET public_presentation = ?2 WHERE unit_id = ?1').bind(main.id, spec.fullContent ? 'full_content' : 'summary_only').run();
      await setLevel(main.id, 'public');
      await setLevel(earlier.id, 'public');
      for (const target of targets) await setLevel(target.id, target.level);

      // An optional Administrator order that puts the earlier question first.
      if (spec.orderSummaryFirst) {
        const rev = (await core().prepare('SELECT rev FROM projects WHERE id = ?1').bind(world.projectId).first<{ rev: number }>())!.rev;
        const ordered = await world.request('admin', 'PATCH', `/projects/${world.projectId}`, { rev, questionOrder: [earlier.id] });
        if (ordered.status !== 200) throw new Error(`question_order ${ordered.status} ${await ordered.text()}`);
      }

      await publish(`project:${world.projectId}`, 1, false);
      await drain();
      await renderSiteBuild(renderDeps(), NOW());

      // The research_question page shows the question text and each Public entry's title; a Withheld entry is a
      // Disclosure_Line; no Not_Published/Restricted target's title or identifier leaks (R50.4, R50.7).
      const html = await pageContent(`/r/${main['identifier']}.html`);
      expect(html).toBeDefined();
      const questionPage = readPage(html!);
      expect(questionPage.mainText).toContain('What really happened on the night route?');
      for (const target of targets) {
        if (target.level === 'public') expect(questionPage.mainText).toContain(target.title);
        else if (target.identifier !== null) expect(questionPage.mainText).not.toContain(target.identifier);
      }
      if (targets.some((target) => target.level === 'withheld')) {
        const links = find(questionPage.main.children, byClass('rf-links'));
        expect(textOf(links?.children ?? [])).toContain('Synthetic material');
      }

      // The introduction shows only under Full_Content (R50.4).
      if (spec.fullContent) expect(questionPage.mainText).toContain(intro);
      else expect(questionPage.mainText).not.toContain(intro);

      // The Project page lists the Public Research_Questions in the Administrator order, then newest-first by date.
      const projectHtml = await pageContent(`/p/${slug}.html`);
      expect(projectHtml).toBeDefined();
      const projectPage = readPage(projectHtml!);
      const part = find(projectPage.main.children, byClass('rf-project__questions'))!;
      const titles = findAll(part.children, byClass('rf-listing__title')).map((node) => textOf(node.children));
      const mainTitle = main['title'] as string;
      const earlierTitle = earlier['title'] as string;
      expect(titles).toEqual(spec.orderSummaryFirst ? [earlierTitle, mainTitle] : [mainTitle, earlierTitle]);
    }), { numRuns: Math.min(FC_RUNS, 12) });
  }, 8000 * FC_RUNS);
});

/** A short distinct suffix so generated target titles differ. */
function targetTitle(index: number): string {
  return `${String.fromCharCode(65 + (index % 26))}${index}`;
}
