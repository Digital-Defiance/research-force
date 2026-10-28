import type { Context } from 'hono';
import type { MentionSpan, RichText } from '@researchforce/domain/richtext';
import type { ValidationContext } from '@researchforce/domain/schemas/common';
import type { ULID } from '@researchforce/domain/types';
import { readerSql } from '@researchforce/db/access';
import type { AccessScope } from '@researchforce/db/access';
import { sql } from 'drizzle-orm';
import { SQLiteAsyncDialect } from 'drizzle-orm/sqlite-core';
import type { ApiEnv } from '../api/app';
import type { FieldIssue } from '../api/errors';

/** A rich text of a save with the field path that names it in a refusal. */
export interface PlacedText { readonly path: string; readonly text: RichText }
export interface MentionTargets { readonly members: readonly string[]; readonly specialties: readonly string[] }
/** One Member a save newly mentions: by name, or else through the first newly mentioned Specialty the Member holds. */
export interface MentionRecipient { readonly memberId: ULID; readonly specialtyId: ULID | null }

const isRich = (value: unknown): value is RichText => typeof value === 'object' && value !== null && !Array.isArray(value)
  && typeof (value as RichText).text === 'string' && Array.isArray((value as RichText).spans);
const isMention = (span: RichText['spans'][number]): span is MentionSpan => span.k === 'mention';

/** Every rich text in a saved value: Research_Item fields, Entry_Section contents, a Group_Note, or a Reply's text. */
export function textsOf(value: unknown, path = ''): PlacedText[] {
  if (isRich(value)) return [{ path, text: value }];
  const at = (key: string | number) => (path === '' ? String(key) : `${path}.${key}`);
  if (Array.isArray(value)) return value.flatMap((entry, index) => textsOf(entry, at(index)));
  if (typeof value === 'object' && value !== null) return Object.entries(value).flatMap(([key, entry]) => textsOf(entry, at(key)));
  return [];
}

function targetsOf(texts: readonly PlacedText[]): { members: Set<string>; specialties: Set<string> } {
  const members = new Set<string>();
  const specialties = new Set<string>();
  for (const span of texts.flatMap(({ text }) => text.spans.filter(isMention))) {
    if (span.member !== undefined) members.add(span.member);
    else specialties.add(span.specialty);
  }
  return { members, specialties };
}

/** Members and Specialties the saved text mentions that the previously saved text did not (R16.6, R16.7). */
export function addedMentions(before: unknown, after: unknown): MentionTargets {
  const old = targetsOf(textsOf(before));
  const next = targetsOf(textsOf(after));
  return { members: [...next.members].filter((id) => !old.members.has(id)).sort(), specialties: [...next.specialties].filter((id) => !old.specialties.has(id)).sort() };
}

/**
 * A new Mention names an active Member or a Specialty that is not retired, as the picker offers them; Mentions the
 * previously saved text already had stay valid after their Member leaves or their Specialty is retired (R3.8, R16.8).
 */
export function mentionIssues(context: Pick<ValidationContext, 'members' | 'valueSets'>, before: unknown, after: unknown): FieldIssue[] {
  const old = targetsOf(textsOf(before));
  const members = new Set(context.members.filter((member) => member.status === 'active').map((member) => member.id as string));
  const specialties = new Set((context.valueSets.specialty ?? []).filter((value) => !value.retired).map((value) => value.id as string));
  return textsOf(after).flatMap(({ path, text }) => text.spans.flatMap((span, index) => {
    if (!isMention(span)) return [];
    const known = span.member === undefined ? old.specialties.has(span.specialty) || specialties.has(span.specialty) : old.members.has(span.member) || members.has(span.member);
    const field = `${path === '' ? '' : `${path}.`}spans.${index}`;
    return known ? [] : [{ field, rule: 'A Mention names an active Member or a Specialty that is not retired.' }];
  }));
}

/**
 * The other active Members a save newly mentions who can read its Research_Item, once each: each Member named, then
 * each active holder of a newly mentioned Specialty who is not named, never the author (R16.6, R16.7, R47.5).
 */
export async function mentionRecipients(c: Context<ApiEnv>, added: MentionTargets, authorId: ULID, scope: AccessScope): Promise<MentionRecipient[]> {
  if (added.members.length + added.specialties.length === 0) return [];
  const members = JSON.stringify(added.members);
  const reader = readerSql(sql.raw('m.id'), scope);
  const query = new SQLiteAsyncDialect().sqlToQuery(sql`
    SELECT m.id AS memberId, NULL AS specialtyId FROM members m
      WHERE m.status = 'active' AND m.id <> ${authorId} AND m.id IN (SELECT value FROM json_each(${members})) AND ${reader}
    UNION ALL
    SELECT m.id AS memberId, min(ps.value_id) AS specialtyId FROM members m JOIN profile_specialties ps ON ps.member_id = m.id
      WHERE m.status = 'active' AND m.id <> ${authorId} AND ps.value_id IN (SELECT value FROM json_each(${JSON.stringify(added.specialties)}))
        AND m.id NOT IN (SELECT value FROM json_each(${members})) AND ${reader}
      GROUP BY m.id
    ORDER BY memberId`);
  const rows = await c.get('accountant').track(c.env.RF_CORE.prepare(query.sql).bind(...query.params).all<MentionRecipient>());
  return rows.results;
}
