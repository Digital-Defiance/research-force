import { BUILT_IN_ROLES } from '@researchforce/domain/permissions';
import { SETTINGS } from '@researchforce/domain/settings';
import { POLICY_PAGE_KEYS } from '@researchforce/db/schema/core';
import { FIXED_METHODS_TERMS } from '@researchforce/db/seed/methods-descriptions';
import { SEED_POLICY_SECTIONS } from '@researchforce/db/seed/policy-sections';
import { SEED_VALUES } from '@researchforce/db/seed/value-sets';

/**
 * SEED-OWNED TABLES and the "untouched installation default" test (R36.4, R36.8, R36.15).
 *
 * Every fresh installation already holds the default rows that `packages/db/migrations/core/0002_seed.sql` (and the
 * later migrations that grant new permissions) insert. A restore into a genuinely fresh installation therefore finds a
 * destination row at the key of each backed-up default row, and for tables that carry the migration-apply time
 * (`settings.updated_at`, `policy_pages.sections_changed_at`, `policy_sections.changed_at`) that row differs from the
 * backed-up copy even though nothing was ever modified. Treating that as an `unexpected-duplicate` would make every
 * disaster recovery into a fresh installation fail.
 *
 * So a backed-up row may REPLACE a destination row ONLY when (a) its table is in {@link SEED_OWNED_TABLES} and (b)
 * {@link isUntouchedSeedRow} proves the destination row is still exactly the installation default. A destination row
 * that was modified in the destination (a changed value, a bumped revision/sequence, an actor, a different scope or
 * text) is NOT untouched and stays an `unexpected-duplicate` conflict. The comparison is against the seed's own
 * definitions, so it ignores ONLY the seed timestamp columns; a row at a non-seed key is never untouched.
 *
 * The list is explicit, not inferred at runtime. It is exactly the intersection of the tables the migrations seed
 * (`counters` is also seeded, but is excluded from the backup — see BACKUP_EXCLUDED — so it is never restored) and
 * `BACKUP_TABLES`. Adding a seeded table to a migration requires adding it here and a predicate below.
 */
export const SEED_OWNED_TABLES: readonly string[] = Object.freeze([
  'settings', 'roles', 'role_permissions', 'config_values', 'methods_terms', 'policy_pages', 'policy_sections',
]);

type Row = Readonly<Record<string, unknown>>;

/** Whether a table is seed-owned (its untouched default rows may be replaced by the backed-up copy). */
export const isSeedOwnedTable = (table: string): boolean => SEED_OWNED_TABLES.includes(table);

/** The sequencing columns every authoritative seeded row starts with: revision 1 (when present), sequence 0, no actor. */
function pristineSequence(row: Row, withRev: boolean): boolean {
  return row['updated_seq'] === 0 && (row['actor_id'] ?? null) === null && (!withRev || row['rev'] === 1);
}

const settingKeys: ReadonlySet<string> = new Set(Object.keys(SETTINGS).filter((key) => key !== 'responsiblePerson'));
const seedValues = new Map(SEED_VALUES.map((value) => [value.id as string, value]));
const methodsTerms = new Map(FIXED_METHODS_TERMS.map((term, position) => [term.key as string, { term, position }]));
const policySections = new Map(POLICY_PAGE_KEYS.flatMap((pageKey) => SEED_POLICY_SECTIONS
  .filter((section) => section.pageKey === pageKey)
  .map((section, position): [string, { section: typeof section; position: number }] => [`${pageKey}\u0000${section.sectionKey}`, { section, position }])));
const rolesById = new Map(Object.values(BUILT_IN_ROLES).map((role) => [role.id as string, role]));

/**
 * Whether the destination row (the full row image as stored) is still the untouched installation default for its
 * table. Pure: it reads only the row and the seed definitions. Unknown / non-seed tables are never untouched.
 */
export function isUntouchedSeedRow(table: string, row: Row): boolean {
  switch (table) {
    case 'settings': {
      const key = String(row['key']);
      if (!settingKeys.has(key)) return false;
      const expected = JSON.stringify(SETTINGS[key as keyof typeof SETTINGS].default);
      return row['value'] === expected && (row['updated_by'] ?? null) === null && pristineSequence(row, false);
    }
    case 'roles': {
      const role = rolesById.get(String(row['id']));
      return role !== undefined && row['name'] === role.name && row['name_key'] === role.name.toLowerCase()
        && row['builtin'] === 1 && pristineSequence(row, true);
    }
    case 'role_permissions': {
      const role = rolesById.get(String(row['role_id']));
      const scope = (role?.permissions as Readonly<Record<string, string>> | undefined)?.[String(row['permission'])];
      return scope !== undefined && row['scope'] === scope;
    }
    case 'config_values': {
      const seed = seedValues.get(String(row['id']));
      return seed !== undefined && row['set_key'] === seed.setKey && row['name'] === seed.name
        && row['name_key'] === seed.name.toLowerCase() && row['retired'] === 0 && row['locked'] === (seed.locked ? 1 : 0)
        && (row['permits_publication'] ?? null) === (seed.permitsPublication === null ? null : seed.permitsPublication ? 1 : 0)
        && row['position'] === seed.position && (row['public_description'] ?? null) === seed.publicDescription
        && pristineSequence(row, true);
    }
    case 'methods_terms': {
      const seed = methodsTerms.get(String(row['key']));
      return seed !== undefined && row['group_key'] === seed.term.groupKey && row['name'] === seed.term.name
        && row['position'] === seed.position && row['public_description'] === seed.term.publicDescription
        && pristineSequence(row, true);
    }
    case 'policy_pages':
      // `sections_changed_at` is the seed timestamp and is deliberately ignored.
      return (POLICY_PAGE_KEYS as readonly string[]).includes(String(row['page_key'])) && pristineSequence(row, true);
    case 'policy_sections': {
      // `changed_at` is the seed timestamp and is deliberately ignored.
      const seed = policySections.get(`${String(row['page_key'])}\u0000${String(row['section_key'])}`);
      return seed !== undefined && row['title'] === seed.section.title && row['required'] === (seed.section.required ? 1 : 0)
        && row['text'] === seed.section.text && row['position'] === seed.position && row['text_spans'] === '[]';
    }
    default:
      return false;
  }
}
