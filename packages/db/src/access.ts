import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { SQLiteAsyncDialect } from 'drizzle-orm/sqlite-core';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import type { AccessLevel } from '@researchforce/domain/types';

const dialect = new SQLiteAsyncDialect();

/** Whether `member` is an active Administrator, who reads every Research_Item (R47.1). */
export function isAdministratorSql(member: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM members acc_m WHERE acc_m.id = ${member} AND acc_m.status = 'active' AND acc_m.role_id = ${sql.raw(`'${ROLE_IDS.administrator}'`)})`;
}

/**
 * Whether `member` Can_Read the Research_Item `root`: it is Whole_Team, or the Member is an Administrator, its Owner,
 * or on its Access_List (R47.1, R47.3). Every element reaches its Research_Item through `units.root_id`.
 */
export function canReadSql(member: SQL, isAdmin: SQL, root: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM research_items acc_ri WHERE acc_ri.unit_id = ${root} AND (
    acc_ri.access_level = 'whole_team' OR ${isAdmin}
    OR EXISTS (SELECT 1 FROM units acc_u WHERE acc_u.id = acc_ri.unit_id AND acc_u.owner_id = ${member})
    OR EXISTS (SELECT 1 FROM access_grants acc_g WHERE acc_g.root_id = acc_ri.unit_id AND acc_g.member_id = ${member})))`;
}

/** `canReadSql` for a member whose Administrator Role is looked up in the same statement. */
export function memberCanReadSql(member: SQL, root: SQL): SQL {
  return canReadSql(member, isAdministratorSql(member), root);
}

/** The access a Research_Item has, or will have once the Submission that creates it commits. */
export type AccessScope =
  | { readonly rootId: string }
  | { readonly pending: { readonly level: AccessLevel; readonly members: readonly string[]; readonly ownerId: string } };

/** Whether `member` can read the Research_Item of `scope`, so recipients and addressees are chosen alike before and after it exists (R47.5). */
export function readerSql(member: SQL, scope: AccessScope): SQL {
  if ('rootId' in scope) return memberCanReadSql(member, sql`${scope.rootId}`);
  const { level, members, ownerId } = scope.pending;
  if (level === 'whole_team') return sql`1`;
  return sql`(${member} = ${ownerId} OR ${member} IN (SELECT value FROM json_each(${JSON.stringify(members)})) OR ${isAdministratorSql(member)})`;
}

/** `memberCanReadSql` as SQL text, for a member and root given as a column such as `m.id` or a parameter such as `?2`. */
export function canRead(member: string, root: string): string {
  return dialect.sqlToQuery(memberCanReadSql(sql.raw(member), sql.raw(root))).sql;
}
