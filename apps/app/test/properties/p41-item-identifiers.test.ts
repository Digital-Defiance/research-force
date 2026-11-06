// Feature: research-collab-cms, Property 41: Item_Identifiers are well-formed, unique, and never reused
import { describe, expect, it } from 'vitest';
import { attachments, researchItems, units } from '@researchforce/db/schema/core';
import { isItemIdentifier, itemIdentifierKey, ITEM_ID_FORMAT, newItemIdentifier, newULID } from '@researchforce/domain/identifiers';
import { BUILT_IN_VALUE_IDS } from '@researchforce/domain/value-sets';
import type { ULID } from '@researchforce/domain/types';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { commitWithIdentifiers } from '../../src/records/submissions';
import type { IdentifierSource } from '../../src/records/submissions';
import { itemWorld } from '../items';
import { addProject, addSubmissionRow, deleteUnit, resetRecords } from '../units';

/**
 * Validates R15.1, R15.6.
 *
 * Property 41: every Item_Identifier the Research_CMS assigns is well-formed, unique, and never reused.
 *
 *  - R15.1 — the System assigns a Research_Item or Attachment a permanent, globally unique Item_Identifier of twelve
 *            random Crockford base-32 characters in groups of four (e.g. `K7QM-3XRW-9DPA`).
 *  - R15.6 — the registry of issued identifiers keeps every row, so an identifier is never reissued, even after the
 *            permanent deletion of the Item it named.
 *
 * Chosen layer. The single production path that assigns identifiers is `commitWithIdentifiers`
 * (apps/app/src/records/submissions.ts): it draws identifiers from `newItemIdentifier`, de-duplicates them within one
 * batch, registers each in the `identifiers` table (primary key = the lower-case form), and retries the whole batch on
 * a registry collision. Every create handler (items, attachments, replies, moderation acceptances) goes through it. So
 * this property drives the REAL `commitWithIdentifiers` against rf-core D1 and reads back the stored rows — it never
 * reimplements generation or the uniqueness rule. The canonical 14-character HTTP-assigned identifier is also checked
 * end to end through the real create handler (`world.created`).
 *
 * Adversarial randomness. To force the de-duplication and the registry-collision retry that enforce uniqueness and
 * non-reuse, some runs feed `commitWithIdentifiers` a biased `IdentifierSource` that returns colliding or
 * already-registered identifiers before yielding fresh ones. The source still produces identifiers through the real
 * `newItemIdentifier`, so no new scheme is invented.
 *
 * p88 PATTERN: every fast-check run FIRST resets the records (the named D1 is shared across runs in the Workers pool),
 * while the `identifiers` registry is intentionally left intact across the whole property so a non-reuse violation can
 * only show up as a reissued row. p78 CAP: numRuns is Math.min(FC_RUNS, 40) because each run commits real batches.
 */

const CANONICAL = /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/;
const EXPECTED_LENGTH = ITEM_ID_FORMAT.groups.reduce((sum, length) => sum + length, 0) + ITEM_ID_FORMAT.groups.length - 1;

const world = itemWorld();

interface Place { readonly projectId: ULID; readonly ownerId: ULID; readonly submissionId: ULID; readonly now: typeof world.at }

/**
 * Create `count` Research_Items and `attachmentCount` Attachments through the real identifier-issuing path,
 * `commitWithIdentifiers`. Attachments are rooted under the first Research_Item, satisfying the `units_root_shape`
 * check the real create handlers also satisfy. Returns the identifier map the production code issued.
 */
async function createUnits(place: Place, count: number, attachmentCount: number, issue?: IdentifierSource): Promise<ReadonlyMap<ULID, string>> {
  const effectiveItems = Math.max(count, attachmentCount > 0 ? 1 : 0);
  const itemIds = Array.from({ length: effectiveItems }, () => newULID(place.now));
  const attachmentIds = Array.from({ length: attachmentCount }, () => newULID(place.now));
  const rootId = itemIds[0];
  return commitWithIdentifiers(world.core(), { id: place.ownerId, now: place.now }, [...itemIds, ...attachmentIds], (batch, issued) => {
    for (const id of itemIds) {
      batch.insert(units, { id, unitType: 'research_item', projectId: place.projectId, rootId: id, ownerId: place.ownerId, credit: [{ member: place.ownerId }], submissionId: place.submissionId, createdAt: place.now });
      batch.insert(researchItems, { unitId: id, kind: 'finding', itemIdentifier: issued.get(id)!, projectId: place.projectId, title: `Item ${id}`, itemDateKey: '2026-10-27', logDateKey: '2026-10-27' });
    }
    for (const id of attachmentIds) {
      batch.insert(units, { id, unitType: 'attachment', projectId: place.projectId, rootId: rootId!, parentId: rootId!, ownerId: place.ownerId, credit: [{ member: place.ownerId }], submissionId: place.submissionId, createdAt: place.now });
      batch.insert(attachments, { unitId: id, itemIdentifier: issued.get(id)!, title: `Attachment ${id}`, fileKind: 'pdf', originalName: 'synthetic.pdf', sizeBytes: 10, sha256: '0'.repeat(64), r2Key: `synthetic/${id}`, origin: 'upload', uploadedAt: place.now, rightsStatusId: BUILT_IN_VALUE_IDS.rightsOwnWork, chainId: id });
    }
  }, issue === undefined ? {} : { issue });
}

describe('Property 41 (R15.1): every assigned Item_Identifier is well-formed', () => {
  it('assigns Research_Items and Attachments canonical twelve-character Crockford identifiers through the real create path', async () => {
    const core = () => world.core();
    await fc.assert(fc.asyncProperty(fc.record({ kind: fc.constantFrom('finding', 'source', 'hypothesis', 'topic', 'journal_entry'), items: fc.integer({ min: 1, max: 3 }) }), async (plan) => {
      await resetRecords(core());
      const projectId = await addProject(core(), world.ids.admin, world.at);
      const assigned: string[] = [];
      for (let index = 0; index < plan.items; index++) {
        const created = await world.created('author', plan.kind, { projectId });
        assigned.push(created.identifier as string);
      }
      // Read the registry too, so well-formedness holds for the stored value and its lower-case registry key. The
      // `identifiers` registry is never cleared (R15.6), so it accumulates across runs; every row it holds — this
      // run's and the earlier runs' — must be a well-formed identifier whose registry key is its lower-case form.
      const rows = (await core().prepare('SELECT identifier, identifier_lc AS identifierLc FROM identifiers').all<{ identifier: string; identifierLc: string }>()).results;
      const registered = new Set(rows.map((row) => row.identifier));
      // Each Research_Item registers exactly one identifier; its reported identifier is the one stored.
      for (const value of assigned) expect(registered.has(value), `${value} was registered for the created Item`).toBe(true);
      for (const value of [...assigned, ...rows.map((row) => row.identifier)]) {
        expect(isItemIdentifier(value), `${value} is a valid Item_Identifier`).toBe(true);
        expect(value, `${value} matches the canonical XXXX-XXXX-XXXX format`).toMatch(CANONICAL);
        expect([...value].length, `${value} has the format length`).toBe(EXPECTED_LENGTH);
      }
      for (const row of rows) expect(row.identifierLc, 'registry key is the lower-case identifier').toBe(itemIdentifierKey(row.identifier));
    }), { numRuns: Math.min(FC_RUNS, 40) });
  }, 50 * FC_RUNS);
});

describe('Property 41 (R15.1): identifiers are globally unique even under colliding randomness', () => {
  it('never shares one identifier across two units, retrying through the registry when the random source repeats', async () => {
    const core = () => world.core();
    // A biased source that, with some probability, hands back a fixed "stuck" identifier a few times before drawing a
    // fresh one. It forces both the in-batch de-duplication and the registry-collision retry inside the real code.
    const biasedArb = fc.record({
      items: fc.integer({ min: 1, max: 4 }),
      attachmentCount: fc.integer({ min: 0, max: 3 }),
      stickiness: fc.integer({ min: 0, max: 3 }),
    });
    await fc.assert(fc.asyncProperty(fc.array(biasedArb, { minLength: 1, maxLength: 3 }), async (plans) => {
      await resetRecords(core());
      const projectId = await addProject(core(), world.ids.admin, world.at);
      const submissionId = await addSubmissionRow(core(), world.ids.author, world.at, false);
      const place = { projectId, ownerId: world.ids.author, submissionId, now: world.at } as const;
      for (const plan of plans) {
        // The stuck value is drawn from the REAL generator, so the test invents no identifier scheme.
        const stuck = newItemIdentifier();
        let remaining = plan.stickiness;
        const issue: IdentifierSource = () => (remaining-- > 0 ? stuck : newItemIdentifier());
        const issued = await createUnits(place, plan.items, plan.attachmentCount, issue);
        expect(issued.size).toBe(plan.items + plan.attachmentCount);
      }
      // Across every unit committed this run (the `identifiers` registry keeps earlier runs' rows, whose units
      // resetRecords removed, so the check joins back to the live units): the registry keys, the stored identifiers,
      // and the per-table identifiers are all distinct and one-to-one — the global-uniqueness invariant of R15.1.
      const registry = (await core().prepare('SELECT i.identifier, i.identifier_lc AS identifierLc, i.unit_id AS unitId FROM identifiers i JOIN units u ON u.id = i.unit_id').all<{ identifier: string; identifierLc: string; unitId: ULID }>()).results;
      const total = (await core().prepare("SELECT count(*) AS n FROM units WHERE unit_type IN ('research_item', 'attachment')").first<number>('n'))!;
      expect(registry.length, 'one registry row per identifier-bearing unit').toBe(total);
      expect(new Set(registry.map((row) => row.identifierLc)).size, 'registry keys are unique').toBe(registry.length);
      expect(new Set(registry.map((row) => row.identifier)).size, 'identifiers are unique').toBe(registry.length);
      expect(new Set(registry.map((row) => row.unitId)).size, 'one identifier per unit').toBe(registry.length);
      for (const row of registry) expect(row.identifierLc, 'registry key is the lower-case identifier').toBe(itemIdentifierKey(row.identifier));
      // The whole registry's keys — this run's and every earlier run's — stay globally unique (R15.6 never reissues).
      const allKeys = (await core().prepare('SELECT identifier_lc AS identifierLc FROM identifiers').all<{ identifierLc: string }>()).results.map((row) => row.identifierLc);
      expect(new Set(allKeys).size, 'the whole registry has unique keys').toBe(allKeys.length);
      // The unit tables carry exactly the registered identifiers, with their own unique indexes intact.
      const table = async (sql: string) => (await core().prepare(sql).all<{ itemIdentifier: string }>()).results.map((row) => row.itemIdentifier);
      const tableIds = [...await table('SELECT item_identifier AS itemIdentifier FROM research_items'), ...await table('SELECT item_identifier AS itemIdentifier FROM attachments')];
      expect(new Set(tableIds).size, 'every unit-table identifier is distinct').toBe(tableIds.length);
      expect(new Set(tableIds)).toEqual(new Set(registry.map((row) => row.identifier)));
    }), { numRuns: Math.min(FC_RUNS, 40) });
  }, 50 * FC_RUNS);
});

describe('Property 41 (R15.6): a permanently deleted identifier is never reissued', () => {
  it('keeps the registry row after permanent deletion and refuses to hand the identifier to a new unit', async () => {
    const core = () => world.core();
    await fc.assert(fc.asyncProperty(fc.record({ before: fc.integer({ min: 1, max: 3 }), after: fc.integer({ min: 1, max: 4 }) }), async (plan) => {
      await resetRecords(core());
      const projectId = await addProject(core(), world.ids.admin, world.at);
      const submissionId = await addSubmissionRow(core(), world.ids.author, world.at, false);
      const place = { projectId, ownerId: world.ids.author, submissionId, now: world.at } as const;

      // Create a batch of Items, then permanently delete one the way the deletion job does (its registry row stays).
      const issued = await createUnits(place, plan.before, 0);
      const [doomedId, doomedIdentifier] = [...issued][0]!;
      const doomedKey = itemIdentifierKey(doomedIdentifier);
      await deleteUnit(core(), doomedId, world.ids.admin, world.at);

      // The registry row survives deletion (R15.6), though the unit and its research_items row are gone.
      expect(await core().prepare('SELECT count(*) AS n FROM identifiers WHERE identifier_lc = ?1').bind(doomedKey).first<number>('n'), 'deleted identifier stays registered').toBe(1);
      expect(await core().prepare('SELECT count(*) AS n FROM units WHERE id = ?1').bind(doomedId).first<number>('n'), 'deleted unit is gone').toBe(0);

      // A new Submission whose random source first keeps returning the deleted identifier must still never reuse it:
      // the registry primary key blocks the key, so the real code's retry draws fresh identifiers instead. After the
      // biased draws, the source yields genuinely fresh identifiers so each batch can make progress.
      const stuck = { identifier: doomedIdentifier, registryKey: doomedKey };
      let handOutDeleted = plan.after; // keep offering the deleted identifier for the first few draws
      const issue: IdentifierSource = () => (handOutDeleted-- > 0 ? stuck : newItemIdentifier());
      const reissued = await createUnits(place, plan.after, 0, issue);

      // None of the newly assigned identifiers is the deleted one, and the deleted identifier still belongs only to the
      // original (now-deleted) unit in the registry.
      for (const value of reissued.values()) expect(value, 'a new unit never takes the deleted identifier').not.toBe(doomedIdentifier);
      const registryForDeleted = (await core().prepare('SELECT unit_id AS unitId FROM identifiers WHERE identifier_lc = ?1').bind(doomedKey).all<{ unitId: ULID }>()).results;
      expect(registryForDeleted, 'the deleted identifier maps only to its original unit').toEqual([{ unitId: doomedId }]);
      // Global uniqueness still holds across the whole registry.
      const keys = (await core().prepare('SELECT identifier_lc AS identifierLc FROM identifiers').all<{ identifierLc: string }>()).results.map((row) => row.identifierLc);
      expect(new Set(keys).size, 'registry keys remain unique after a deletion and re-create').toBe(keys.length);
    }), { numRuns: Math.min(FC_RUNS, 40) });
  }, 50 * FC_RUNS);
});
