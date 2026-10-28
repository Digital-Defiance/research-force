import { GuardedBatch } from '@researchforce/db/batch';
import { attachments, deletions, dissentNotes, entrySections, identifiers, projects, replies, researchItems, submissions, units } from '@researchforce/db/schema/core';
import { newItemIdentifier, newULID } from '@researchforce/domain/identifiers';
import { BUILT_IN_VALUE_IDS } from '@researchforce/domain/value-sets';
import type { ItemKind, Timestamp, ULID } from '@researchforce/domain/types';

/** Remove every synthetic unit, link, Submission, Project, and External_Party; issued identifiers stay registered. */
export async function resetRecords(core: D1Database): Promise<void> {
  await core.batch([
    'units', 'research_items', 'attachments', 'entry_sections', 'replies', 'dissent_notes', 'submissions', 'cross_links', 'deletions', 'external_parties', 'projects',
    'journal_entries', 'je_members', 'findings', 'sources', 'runs', 'run_counts', 'hypotheses', 'correspondences', 'correspondence_parties', 'archival_requests', 'topics', 'revisions',
    'staging_rows', 'review_requests', 'review_addressees', 'access_grants', 'notification_events',
  ].map((table) => core.prepare(`DELETE FROM ${table}`)));
}

/**
 * Restores seeded tables that a test file changes: the first call records their rows, every later call puts them back.
 * Call it from `beforeEach`.
 */
export function seededTables(core: () => D1Database, tables: readonly string[]): () => Promise<void> {
  let saved: ReadonlyMap<string, readonly Record<string, unknown>[]> | undefined;
  return async () => {
    const db = core();
    if (!saved) {
      saved = new Map(await Promise.all(tables.map(async (table) => [table, (await db.prepare(`SELECT * FROM ${table}`).all<Record<string, unknown>>()).results] as const)));
      return;
    }
    const rows = saved;
    await db.batch(tables.flatMap((table) => {
      const list = rows.get(table)!;
      const columns = Object.keys(list[0] ?? {});
      return [
        db.prepare(`DELETE FROM ${table}`),
        ...(list.length === 0 ? [] : [db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) SELECT ${columns.map((column) => `value ->> '$.${column}'`).join(', ')} FROM json_each(?1)`).bind(JSON.stringify(list))]),
      ];
    }));
  };
}

let projectCount = 0;
export async function addProject(core: D1Database, by: ULID, now: Timestamp): Promise<ULID> {
  const id = newULID(now);
  const n = ++projectCount;
  const position = (await core.prepare('SELECT count(*) AS n FROM projects').first<number>('n'))!;
  await new GuardedBatch(core, { id: by, now }).insert(projects, {
    id, name: `Synthetic project ${n}`, nameKey: `synthetic project ${n}`, shortDescription: 'Synthetic.', slug: `synthetic-${n}`, position, createdBy: by, createdAt: now,
  }).commit();
  return id;
}

export async function addSubmissionRow(core: D1Database, memberId: ULID, now: Timestamp, completed = true): Promise<ULID> {
  const id = newULID(now);
  await new GuardedBatch(core, { id: memberId, now }).insert(submissions, { id, memberId, kind: 'member', startedAt: now, completedAt: completed ? now : null }).commit();
  return id;
}

/** The `research_items` row every Research_Item unit has, which the access check reads (R47.3). */
export function researchItemRow(id: ULID, projectId: ULID): typeof researchItems.$inferInsert {
  return { unitId: id, kind: 'finding', itemIdentifier: newItemIdentifier().identifier, projectId, title: `Item ${id}`, itemDateKey: '2026-10-27', logDateKey: '2026-10-27' };
}

export interface Place { readonly projectId: ULID; readonly ownerId: ULID; readonly submissionId: ULID; readonly now: Timestamp }
export interface AddedUnit { readonly id: ULID; readonly identifier: string | null }

export async function addItem(core: D1Database, place: Place, options: { readonly kind?: ItemKind; readonly title?: string; readonly withdrawn?: boolean } = {}): Promise<AddedUnit> {
  const id = newULID(place.now);
  const { identifier, registryKey } = newItemIdentifier();
  await new GuardedBatch(core, { id: place.ownerId, now: place.now })
    .insert(units, {
      id, unitType: 'research_item', projectId: place.projectId, rootId: id, ownerId: place.ownerId, credit: [{ member: place.ownerId }], submissionId: place.submissionId, createdAt: place.now,
      ...(options.withdrawn ? { withdrawnAt: place.now, withdrawnBy: place.ownerId, withdrawalReason: 'Synthetic withdrawal.' } : {}),
    })
    .insert(researchItems, {
      unitId: id, kind: options.kind ?? 'finding', itemIdentifier: identifier, projectId: place.projectId, title: options.title ?? `Item ${id}`, itemDateKey: '2026-10-27', logDateKey: '2026-10-27',
    })
    .insert(identifiers, { identifierLc: registryKey, identifier, unitId: id, issuedAt: place.now })
    .commit();
  return { id, identifier };
}

export type ElementType = 'entry_section' | 'reply' | 'attachment' | 'dissent_note';
export async function addElement(core: D1Database, place: Place, type: ElementType, rootId: ULID, options: { readonly withdrawn?: boolean; readonly title?: string } = {}): Promise<AddedUnit> {
  const id = newULID(place.now);
  const batch = new GuardedBatch(core, { id: place.ownerId, now: place.now }).insert(units, {
    id, unitType: type, projectId: place.projectId, rootId, parentId: rootId, ownerId: place.ownerId, credit: [{ member: place.ownerId }], submissionId: place.submissionId, createdAt: place.now,
    ...(options.withdrawn ? { withdrawnAt: place.now, withdrawnBy: place.ownerId, withdrawalReason: 'Synthetic withdrawal.' } : {}),
  });
  let identifier: string | null = null;
  if (type === 'entry_section') batch.insert(entrySections, { unitId: id, text: 'A synthetic section.' });
  else if (type === 'reply') batch.insert(replies, { unitId: id, text: 'A synthetic reply.' });
  else if (type === 'dissent_note') {
    batch.insert(dissentNotes, { unitId: id, authorId: place.ownerId, text: 'A synthetic note.', attachedAt: place.now, lastSavedAt: place.now, concernedSummary: 'A synthetic summary.' });
  } else {
    const issued = newItemIdentifier();
    identifier = issued.identifier;
    batch.insert(attachments, {
      unitId: id, itemIdentifier: identifier, title: options.title ?? `Attachment ${id}`, fileKind: 'pdf', originalName: 'synthetic.pdf', sizeBytes: 10, sha256: '0'.repeat(64),
      r2Key: `synthetic/${id}`, origin: 'upload', uploadedAt: place.now, rightsStatusId: BUILT_IN_VALUE_IDS.rightsOwnWork, chainId: id,
    }).insert(identifiers, { identifierLc: issued.registryKey, identifier, unitId: id, issuedAt: place.now });
  }
  await batch.commit();
  return { id, identifier };
}

/** Permanently delete a unit the way the deletion job leaves it: the row gone and a Deletion record kept. */
export async function deleteUnit(core: D1Database, id: ULID, by: ULID, now: Timestamp): Promise<void> {
  const row = await core.prepare(`SELECT u.unit_type AS unitType, u.root_id AS rootId, u.project_id AS projectId, ri.kind, coalesce(ri.item_identifier, a.item_identifier) AS identifier
    FROM units u LEFT JOIN research_items ri ON ri.unit_id = u.id LEFT JOIN attachments a ON a.unit_id = u.id WHERE u.id = ?1`).bind(id)
    .first<{ unitType: 'research_item'; rootId: string; projectId: string; kind: ItemKind | null; identifier: string | null }>();
  await new GuardedBatch(core, { id: by, now })
    .insert(deletions, { unitId: id, unitType: row!.unitType, kind: row!.kind, itemIdentifier: row!.identifier, rootId: row!.rootId, projectId: row!.projectId, deletedBy: by, deletedAt: now, reason: 'Synthetic deletion.' })
    .commit();
  await core.batch(['units WHERE id', 'research_items WHERE unit_id', 'attachments WHERE unit_id', 'entry_sections WHERE unit_id', 'replies WHERE unit_id']
    .map((clause) => core.prepare(`DELETE FROM ${clause} = ?1`).bind(id)));
}
