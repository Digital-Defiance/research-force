import { sql } from 'drizzle-orm';
import type { GuardedBatch } from '@researchforce/db/batch';
import { sourceBibliography, sourceCreators, sourceIdentifiers } from '@researchforce/db/schema/core';
import { bibliographyIsEmpty } from '@researchforce/domain/bibliography';
import type { Bibliography } from '@researchforce/domain/bibliography';
import { rowsOf, storedDate } from './kind';

/** Statements that read the bibliography of Source `?1`, in the order `readBibliography` expects. */
export const bibliographyStatements = (db: D1Database, id: string): D1PreparedStatement[] => [
  db.prepare(`SELECT publication_date AS publicationDate, publication_date_approx AS publicationDateApprox, edition, language, external_url AS url, access_date AS accessDate
    FROM source_bibliography WHERE unit_id = ?1`).bind(id),
  db.prepare('SELECT name, role FROM source_creators WHERE unit_id = ?1 ORDER BY position').bind(id),
  db.prepare('SELECT scheme, value FROM source_identifiers WHERE unit_id = ?1 ORDER BY position').bind(id),
];
export const BIBLIOGRAPHY_STATEMENTS = 3;

/** The bibliography as the schema accepts it, or undefined when the Source has none. */
export function readBibliography([bibliography, creators, identifiers]: readonly (D1Result | undefined)[]): Bibliography | undefined {
  const stored = rowsOf<{ publicationDate: string | null; publicationDateApprox: number; edition: string | null; language: string | null; url: string | null; accessDate: string | null }>(bibliography)[0];
  const people = rowsOf<{ name: string; role: Bibliography['creators'][number]['role'] }>(creators);
  const ids = rowsOf<{ scheme: Bibliography['identifiers'][number]['scheme']; value: string }>(identifiers);
  if (!stored && people.length === 0 && ids.length === 0) return undefined;
  const date = storedDate(stored?.publicationDate ?? null, stored?.publicationDateApprox ?? null);
  return {
    creators: people, identifiers: ids,
    ...(date === undefined ? {} : { publicationDate: date }),
    ...(stored?.edition == null ? {} : { edition: stored.edition }),
    ...(stored?.language == null ? {} : { language: stored.language }),
    ...(stored?.url == null ? {} : { url: stored.url }),
    ...(stored?.accessDate == null ? {} : { accessDate: stored.accessDate }),
  };
}

/** Replace the bibliography of Source `id` in the caller's batch; an empty one leaves no rows (R54.1). */
export function writeBibliography(batch: GuardedBatch, id: string, value: Bibliography | undefined, replacing: boolean): void {
  if (replacing) {
    batch.run(sql`DELETE FROM source_creators WHERE unit_id = ${id}`).run(sql`DELETE FROM source_identifiers WHERE unit_id = ${id}`).run(sql`DELETE FROM source_bibliography WHERE unit_id = ${id}`);
  }
  if (value === undefined || bibliographyIsEmpty(value)) return;
  batch.insert(sourceBibliography, {
    unitId: id, publicationDate: value.publicationDate?.value ?? null, publicationDateApprox: value.publicationDate?.approx ?? false,
    edition: value.edition ?? null, language: value.language ?? null, externalUrl: value.url ?? null, accessDate: value.accessDate ?? null,
  });
  if (value.creators.length > 0) batch.insert(sourceCreators, value.creators.map((creator, position) => ({ unitId: id, position, name: creator.name, role: creator.role })));
  if (value.identifiers.length > 0) batch.insert(sourceIdentifiers, value.identifiers.map((identifier, position) => ({ unitId: id, position, scheme: identifier.scheme, value: identifier.value })));
}
