// Feature: research-collab-cms, Property 28: Saves are all-or-nothing
import { beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { newItemIdentifier, newULID } from '@researchforce/domain/identifiers';
import { asTimestamp } from '@researchforce/domain/types';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import { GuardedBatch, GuardViolation } from '@researchforce/db/batch';
import { accessGrants, externalParties, identifiers, researchItems, units } from '@researchforce/db/schema/core';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import type { Env } from '../../src/env';
import { migrated } from '../d1';

/**
 * Validates R4.1, R4.5, R26.13, R28.13, R32.15, R37.13: a save is atomic. A save collects every statement — the frozen
 * guard, the change-counter increment, the writes, any guard inserts, the Revisions — into one `db.batch`, which D1
 * runs as a single transaction, so a save either commits in full or leaves the database exactly as it was. The property
 * drives a randomized sequence of save attempts against a seeded world through the real `GuardedBatch` primitive: an
 * attempt that commits leaves its intended rows present, and an attempt forced to abort — by a guard that refuses, by a
 * unique-constraint conflict after earlier writes in the same batch, or by a statement error injected mid-batch —
 * leaves the whole database byte-identical to the snapshot taken just before it, the change counter included.
 */

// The tables a generated save can touch, so the before/after snapshot of an abort is bounded yet complete.
const SNAPSHOT_TABLES = ['units', 'research_items', 'identifiers', 'external_parties', 'access_grants', 'revisions', 'outbox', 'counters'] as const;

let bindings: Env;
let core: D1Database;
const now: Timestamp = asTimestamp('2026-10-27T18:00:00.000Z');
const id = (): ULID => newULID(now);

/** The whole relevant DB state, ordered within each table, serialized so equality is byte-for-byte. */
async function snapshot(db: D1Database): Promise<string> {
  const rows = await db.batch(SNAPSHOT_TABLES.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`)));
  return JSON.stringify(SNAPSHOT_TABLES.map((table, index) => [table, rows[index]!.results]));
}

const changeSeq = async (): Promise<number> => (await core.prepare("SELECT v FROM counters WHERE k = 'change'").first<number>('v'))!;

/** One Research_Item with its registered Item_Identifier, in `projectId`, owned by `owner`. */
function writeItem(batch: GuardedBatch, owner: ULID, projectId: ULID): { readonly unitId: ULID; readonly identifier: string } {
  const unitId = id();
  const { identifier, registryKey } = newItemIdentifier();
  batch
    .insert(units, { id: unitId, unitType: 'research_item', projectId, rootId: unitId, ownerId: owner, credit: [{ member: owner }], submissionId: id(), createdAt: now })
    .insert(researchItems, { unitId, kind: 'finding', itemIdentifier: identifier, projectId, title: `Item ${unitId}`, itemDateKey: '2026-10-27', logDateKey: '2026-10-27' })
    .insert(identifiers, { identifierLc: registryKey, identifier, unitId, issuedAt: now });
  return { unitId, identifier };
}

// A save attempt: it either commits or is forced to abort in one of three realistic ways.
type Attempt =
  | { readonly kind: 'commit'; readonly items: number }
  | { readonly kind: 'guard'; readonly items: number } // a false `rev` guard refuses the whole batch (R4.1)
  | { readonly kind: 'conflict'; readonly items: number } // a duplicate identifier after earlier writes in the same batch (R37.13)
  | { readonly kind: 'inject'; readonly items: number }; // a statement error partway through the batch (R28.13)

const attemptArb: fc.Arbitrary<Attempt> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('commit' as const), items: fc.integer({ min: 1, max: 3 }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('guard' as const), items: fc.integer({ min: 1, max: 3 }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('conflict' as const), items: fc.integer({ min: 1, max: 3 }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('inject' as const), items: fc.integer({ min: 1, max: 3 }) }) },
);

beforeAll(async () => {
  bindings = await migrated();
  core = bindings.RF_CORE;
});

describe('Property 28: Saves are all-or-nothing', () => {
  it('leaves the database byte-identical after every aborted save and present after every committed one', async () => {
    await fc.assert(fc.asyncProperty(fc.array(attemptArb, { minLength: 1, maxLength: 8 }), async (attempts) => {
      // A fresh seeded world: the two Projects and the Owner every generated save writes into. Issued Item_Identifiers
      // are permanent (R15.6) and so stay registered; `newItemIdentifier` draws fresh ones, so no save reuses one.
      await core.batch([
        core.prepare('DELETE FROM units'), core.prepare('DELETE FROM research_items'),
        core.prepare('DELETE FROM external_parties'), core.prepare('DELETE FROM access_grants'), core.prepare('DELETE FROM revisions'), core.prepare('DELETE FROM outbox'),
      ]);
      const owner = id();
      const projects = [id(), id()] as const;
      const seedBatch = new GuardedBatch(core, { id: owner, now });
      const seed = writeItem(seedBatch, owner, projects[0]);
      await seedBatch.commit();

      for (const attempt of attempts) {
        const before = await snapshot(core);
        const beforeSeq = await changeSeq();

        if (attempt.kind === 'commit') {
          const batch = new GuardedBatch(core, { id: owner, now });
          const written = Array.from({ length: attempt.items }, (_item, index) => writeItem(batch, owner, projects[index % projects.length]));
          await batch.commit();
          // The save applied: every intended row is present and the change counter advanced by one.
          for (const { unitId } of written) {
            expect(await core.prepare('SELECT count(*) AS n FROM units WHERE id = ?1').bind(unitId).first<number>('n')).toBe(1);
            expect(await core.prepare('SELECT count(*) AS n FROM research_items WHERE unit_id = ?1').bind(unitId).first<number>('n')).toBe(1);
          }
          expect(await changeSeq()).toBe(beforeSeq + 1);
          continue;
        }

        // An attempt forced to abort. Every one writes real rows first, so the snapshot proves the earlier writes in the
        // same batch were rolled back too — the core all-or-nothing claim.
        let error: unknown;
        try {
          const batch = new GuardedBatch(core, { id: owner, now });
          const written = Array.from({ length: attempt.items }, (_item, index) => writeItem(batch, owner, projects[index % projects.length]));
          if (attempt.kind === 'guard') {
            // R4.1: a stale `rev` guard (its condition is false) aborts the whole batch after the writes before it.
            batch.guard('rev', sql`EXISTS (SELECT 1 FROM units WHERE id = ${seed.unitId} AND rev = ${99})`);
          } else if (attempt.kind === 'conflict') {
            // R37.13: a later statement re-registers an identifier already in `identifiers`, violating its unique key.
            batch.insert(identifiers, { identifierLc: seed.identifier.toLowerCase(), identifier: seed.identifier, unitId: written[0]!.unitId, issuedAt: now });
          } else {
            // R28.13: a statement that errors partway through the batch (a check-constraint violation) aborts it.
            batch.run(sql`INSERT INTO run_counts (unit_id, position, name, value) VALUES (${written[0]!.unitId}, 0, 'bad', 'not-a-digit')`);
          }
          await batch.commit();
        } catch (caught) {
          error = caught;
        }

        expect(error).toBeDefined();
        if (attempt.kind === 'guard') expect(error).toBeInstanceOf(GuardViolation);

        // All-or-nothing: the whole database is byte-identical to the pre-attempt snapshot — no orphan units, no
        // half-written research_items, no stray identifiers, revisions, or outbox rows.
        expect(await snapshot(core)).toBe(before);
        // Because the whole `db.batch` rolls back, even the INCREMENT_CHANGE statement is undone.
        expect(await changeSeq()).toBe(beforeSeq);
      }
    }), { numRuns: FC_RUNS });
  }, 600 * FC_RUNS);

  it('grounds the invariant in a requirement-named write: an aborted access/party save changes nothing (R32.15, R4.5)', async () => {
    await core.batch([
      core.prepare('DELETE FROM units'), core.prepare('DELETE FROM research_items'),
      core.prepare('DELETE FROM external_parties'), core.prepare('DELETE FROM access_grants'), core.prepare('DELETE FROM revisions'), core.prepare('DELETE FROM outbox'),
    ]);
    const owner = id();
    const projectId = id();
    const { unitId } = await (async () => {
      const batch = new GuardedBatch(core, { id: owner, now });
      const written = writeItem(batch, owner, projectId);
      await batch.commit();
      return written;
    })();
    const partyId = id();
    await new GuardedBatch(core, { id: owner, now }).insert(externalParties, { id: partyId, name: 'Synthetic party', nameFold: 'synthetic party', createdAt: now }).commit();

    const before = await snapshot(core);
    const beforeSeq = await changeSeq();

    // A real moderation-style save that widens access and records a grant, aborted by a false guard: a decision that
    // writes several rows but cannot commit leaves no partial record (R32.15, R4.5).
    const batch = new GuardedBatch(core, { id: owner, now })
      .update(researchItems, { accessLevel: 'restricted' }, eq(researchItems.unitId, unitId))
      .insert(accessGrants, { rootId: unitId, memberId: owner, grantedBy: owner, grantedAt: now })
      .insert(externalParties, { id: id(), name: 'Another party', nameFold: 'another party', createdAt: now })
      .outbox('publish', `root:${unitId}`)
      .guard('decision_open', sql`0`);
    await expect(batch.commit()).rejects.toBeInstanceOf(GuardViolation);

    expect(await snapshot(core)).toBe(before);
    expect(await changeSeq()).toBe(beforeSeq);
  });
});
