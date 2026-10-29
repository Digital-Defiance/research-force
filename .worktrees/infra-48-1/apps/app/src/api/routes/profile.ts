import { Hono } from 'hono';
import type { Context } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { canRead } from '@researchforce/db/access';
import { CHANGE_SEQ, GuardedBatch } from '@researchforce/db/batch';
import { EMAIL_MODES, notificationPrefs, profileAffiliations, profiles, profileSpecialties } from '@researchforce/db/schema/core';
import { distinctIds, knownId } from '@researchforce/domain/schemas/common';
import { profileSchema } from '@researchforce/domain/schemas/people';
import { asULID, EVENT_TYPES, isULID } from '@researchforce/domain/types';
import type { EventType, MemberStatus, ULID } from '@researchforce/domain/types';
import { projectProfile } from '@researchforce/kernel/substitute';
import { canonicalJson } from '@researchforce/kernel/views';
import { authorizeRead } from '../../auth/authorize';
import { profileGaps } from '../../auth/profile-gate';
import type { ApiEnv } from '../app';
import { ApiError, isUniqueViolation } from '../errors';
import { parse, readJson } from '../input';

type EmailMode = typeof EMAIL_MODES[number];
interface ProfileRow {
  displayName: string; biography: string; timeZone: string; dailyDigestHour: number; publicProfile: number; licenceName: string | null; rev: number;
}
interface SpecialtyRow { id: ULID; name: string; retired: number }
interface Agreement { licenceName: string; givenOn: string }
interface StoredProfile { readonly row: ProfileRow; readonly specialties: readonly SpecialtyRow[]; readonly affiliations: readonly string[]; readonly agreements: readonly Agreement[] }

const ITEM_TYPES = "'research_item', 'attachment', 'reply'";
const RECENT_SUBMISSIONS = 20;

function profileStatements(db: D1Database, memberId: ULID): D1PreparedStatement[] {
  return [
    db.prepare(`SELECT display_name AS displayName, bio AS biography, time_zone AS timeZone, digest_hour AS dailyDigestHour, public_profile AS publicProfile,
      licence_name AS licenceName, rev FROM profiles WHERE member_id = ?1`).bind(memberId),
    db.prepare('SELECT v.id, v.name, v.retired FROM profile_specialties s JOIN config_values v ON v.id = s.value_id WHERE s.member_id = ?1 ORDER BY v.position, v.id').bind(memberId),
    db.prepare('SELECT text FROM profile_affiliations WHERE member_id = ?1 ORDER BY position').bind(memberId),
    db.prepare('SELECT licence_name AS licenceName, given_on AS givenOn FROM licence_agreements WHERE member_id = ?1 ORDER BY given_on, licence_name').bind(memberId),
  ];
}

function storedProfile(results: readonly D1Result[]): StoredProfile | undefined {
  const [row, specialties, affiliations, agreements] = results as [D1Result<ProfileRow>, D1Result<SpecialtyRow>, D1Result<{ text: string }>, D1Result<Agreement>];
  const found = row.results[0];
  return found && { row: found, specialties: specialties.results, affiliations: affiliations.results.map((entry) => entry.text), agreements: agreements.results };
}

async function loadProfile(c: Context<ApiEnv>, memberId: ULID): Promise<StoredProfile | undefined> {
  return storedProfile(await c.get('accountant').track(c.env.RF_CORE.batch(profileStatements(c.env.RF_CORE, memberId))));
}

/** A Profile as any Member sees it, with whether its Member has agreed to the current Content_Licence (R3.4, R46.16). */
function present(profile: StoredProfile, contentLicence: string) {
  return {
    displayName: profile.row.displayName,
    specialties: profile.specialties.map((value) => ({ id: value.id, name: value.name, retired: value.retired === 1 })),
    affiliations: profile.affiliations, biography: profile.row.biography, timeZone: profile.row.timeZone, publicProfile: profile.row.publicProfile === 1,
    licence: { current: contentLicence !== '' && profile.agreements.some((agreement) => agreement.licenceName === contentLicence), agreements: profile.agreements },
  };
}

function gapsOf(profile: StoredProfile | undefined) {
  return profileGaps(profile && { displayName: profile.row.displayName, timeZone: profile.row.timeZone, specialties: profile.specialties.length });
}

/** Each Event_Type's preference; a missing row is the initial in-app On and email Immediate (R19.9). */
function preferences(rows: readonly { eventType: EventType; inApp: number; email: EmailMode }[], profile: StoredProfile | undefined) {
  const stored = new Map(rows.map((row) => [row.eventType, { inApp: row.inApp === 1, email: row.email }]));
  return {
    events: Object.fromEntries(EVENT_TYPES.map((type) => [type, stored.get(type) ?? { inApp: true, email: 'immediate' as const }])),
    dailyDigestHour: profile?.row.dailyDigestHour ?? 8,
  };
}

async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function objectBody(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ApiError('validation', { fields: [{ field: '$', rule: 'Send a JSON object.' }] });
  return body as Record<string, unknown>;
}

const preferencesSchema = z.strictObject({
  events: z.partialRecord(z.enum(EVENT_TYPES), z.strictObject({ inApp: z.boolean(), email: z.enum(EMAIL_MODES) })),
  dailyDigestHour: z.number().int().min(0).max(23),
});
const agreementSchema = z.strictObject({
  agreed: z.literal(true, 'Tick the agreement to give it.'),
  licenceName: z.string(),
});

export const meRoutes = new Hono<ApiEnv>();

meRoutes.get('/', async (c) => {
  const db = c.env.RF_CORE;
  const { member } = c.get('session');
  const results = await c.get('accountant').track(db.batch([
    ...profileStatements(db, member.id),
    db.prepare('SELECT event_type AS eventType, in_app AS inApp, email FROM notification_prefs WHERE member_id = ?1').bind(member.id),
    db.prepare('SELECT project_id AS projectId FROM muted_projects WHERE member_id = ?1 ORDER BY project_id').bind(member.id),
    db.prepare("SELECT id, name FROM config_values WHERE set_key = 'specialty' AND retired = 0 ORDER BY position, id"),
  ]));
  const profile = storedProfile(results.slice(0, 4));
  const contentLicence = c.get('contentLicence');
  return c.json({
    member,
    profile: profile ? present(profile, contentLicence) : null,
    missing: gapsOf(profile),
    preferences: preferences((results[4] as D1Result<{ eventType: EventType; inApp: number; email: EmailMode }>).results, profile),
    mutedProjectIds: (results[5] as D1Result<{ projectId: ULID }>).results.map((row) => row.projectId),
    specialtyOptions: (results[6] as D1Result<{ id: ULID; name: string }>).results,
    contentLicence: contentLicence === '' ? null : contentLicence,
  });
});

/**
 * Save the Member's own Profile; omitted fields keep their saved values. Turning Public_Profile On
 * first returns the People-page preview, and saves only when the request repeats its confirmation (R46.4).
 */
meRoutes.patch('/profile', async (c) => {
  const db = c.env.RF_CORE;
  const memberId = c.get('session').member.id;
  const { confirmation, ...changes } = objectBody(await readJson(c));
  if (confirmation !== undefined && typeof confirmation !== 'string') throw new ApiError('validation', { fields: [{ field: 'confirmation', rule: 'Repeat the confirmation from the preview.' }] });
  const results = await c.get('accountant').track(db.batch([
    ...profileStatements(db, memberId),
    db.prepare('SELECT p.member_id AS id, m.status, p.display_name AS displayName FROM profiles p JOIN members m ON m.id = p.member_id WHERE p.member_id <> ?1').bind(memberId),
    db.prepare("SELECT id, name, retired FROM config_values WHERE set_key = 'specialty'"),
    db.prepare('SELECT email FROM members'),
  ]));
  const stored = storedProfile(results.slice(0, 4));
  const others = (results[4] as D1Result<{ id: ULID; status: MemberStatus; displayName: string }>).results;
  const specialtySet = (results[5] as D1Result<SpecialtyRow>).results.map((value) => ({ id: value.id, name: value.name, retired: value.retired === 1 }));
  const emails = (results[6] as D1Result<{ email: string }>).results.map((row) => row.email);
  const saved = stored && {
    displayName: stored.row.displayName, specialtyIds: stored.specialties.map((value) => value.id), affiliations: stored.affiliations,
    biography: stored.row.biography, timeZone: stored.row.timeZone, dailyDigestHour: stored.row.dailyDigestHour, publicProfile: stored.row.publicProfile === 1,
  };
  const input = parse(profileSchema({
    now: c.get('now'), valueSets: { specialty: specialtySet }, members: others, roleIds: [], projects: [], externalPartyIds: [],
    previousSelections: { specialtyIds: saved?.specialtyIds ?? [] },
  }, memberId), { ...saved, ...changes });

  if (input.publicProfile && !saved?.publicProfile) {
    const names = new Map(specialtySet.map((value) => [value.id, value.name]));
    const preview = projectProfile({
      displayName: input.displayName, specialties: input.specialtyIds.map((id) => names.get(id)!), affiliations: input.affiliations, biography: input.biography,
      publicProfile: true, status: 'active',
    }, emails)!;
    const expected = await sha256(canonicalJson(preview.view));
    if (confirmation === undefined) return c.json({ saved: false, preview, confirmation: expected });
    if (confirmation !== expected) throw new ApiError('preview_stale', { details: { preview, confirmation: expected } });
  }

  const now = c.get('now');
  const values = {
    displayName: input.displayName, displayNameKey: input.displayName.toLowerCase(), bio: input.biography, timeZone: input.timeZone,
    digestHour: input.dailyDigestHour, publicProfile: input.publicProfile,
  };
  const batch = new GuardedBatch(db, { id: memberId, now });
  if (stored) {
    batch.guard('rev', sql`(SELECT rev FROM profiles WHERE member_id = ${memberId}) = ${stored.row.rev}`).update(profiles, values, eq(profiles.memberId, memberId));
  } else {
    batch.insert(profiles, { memberId, ...values });
  }
  batch.run(sql`DELETE FROM profile_specialties WHERE member_id = ${memberId}`)
    .bulkInsert(profileSpecialties, input.specialtyIds.map((valueId) => ({ memberId, valueId })))
    .run(sql`DELETE FROM profile_affiliations WHERE member_id = ${memberId}`)
    .bulkInsert(profileAffiliations, input.affiliations.map((text, position) => ({ memberId, position, text })))
    .outbox('publish', `member:${memberId}`);
  try {
    await batch.commit(c.get('accountant'));
  } catch (error) {
    if (isUniqueViolation(error, 'profiles.display_name_key')) throw new ApiError('validation', { fields: [{ field: 'displayName', rule: 'Display names must be unique ignoring letter case.' }] }, { cause: error });
    if (isUniqueViolation(error, 'profiles.member_id')) throw new ApiError('conflict', {}, { cause: error });
    throw error;
  }
  return c.json({ saved: true, profile: present((await loadProfile(c, memberId))!, c.get('contentLicence')) });
});

/** Notification_Preferences per Event_Type, effective for events created afterwards, and the Daily_Digest hour (R19.8, R20.13). */
meRoutes.put('/preferences', async (c) => {
  const memberId = c.get('session').member.id;
  const input = parse(preferencesSchema, await readJson(c));
  const rows = EVENT_TYPES.flatMap((eventType) => {
    const preference = input.events[eventType];
    return preference && !(preference.inApp && preference.email === 'immediate') ? [{ memberId, eventType, inApp: preference.inApp, email: preference.email }] : [];
  });
  await new GuardedBatch(c.env.RF_CORE, { id: memberId, now: c.get('now') })
    .run(sql`DELETE FROM notification_prefs WHERE member_id = ${memberId}`)
    .bulkInsert(notificationPrefs, rows)
    .update(profiles, { digestHour: input.dailyDigestHour }, eq(profiles.memberId, memberId))
    .commit(c.get('accountant'));
  const stored = await loadProfile(c, memberId);
  const saved = await c.get('accountant').track(c.env.RF_CORE.prepare('SELECT event_type AS eventType, in_app AS inApp, email FROM notification_prefs WHERE member_id = ?1')
    .bind(memberId).all<{ eventType: EventType; inApp: number; email: EmailMode }>());
  return c.json({ preferences: preferences(saved.results, stored) });
});

/** The Member's Muted_Projects, replaced as a whole; a Project stays muted from the time it was first added (R39.10). */
meRoutes.put('/mutes', async (c) => {
  const db = c.env.RF_CORE;
  const memberId = c.get('session').member.id;
  const projects = await c.get('accountant').track(db.prepare('SELECT id FROM projects').all<{ id: ULID }>());
  const input = parse(z.strictObject({ projectIds: distinctIds(knownId(projects.results.map((row) => row.id), 'Project')) }), await readJson(c));
  const now = c.get('now');
  const selected = JSON.stringify(input.projectIds);
  await new GuardedBatch(db, { id: memberId, now })
    .run(sql`DELETE FROM muted_projects WHERE member_id = ${memberId} AND project_id NOT IN (SELECT value FROM json_each(${selected}))`)
    .run(sql`INSERT INTO muted_projects (member_id, project_id, muted_at) SELECT ${memberId}, value, ${now} FROM json_each(${selected}) WHERE true ON CONFLICT DO NOTHING`)
    .commit(c.get('accountant'));
  const muted = await c.get('accountant').track(db.prepare('SELECT project_id AS projectId FROM muted_projects WHERE member_id = ?1 ORDER BY project_id').bind(memberId).all<{ projectId: ULID }>());
  return c.json({ mutedProjectIds: muted.results.map((row) => row.projectId) });
});

/**
 * Give a Licence_Agreement for the current Content_Licence, recording the UTC date and the licence name.
 * Agreements are kept; no route withdraws one (R46.16).
 */
meRoutes.post('/licence-agreement', async (c) => {
  const memberId = c.get('session').member.id;
  const contentLicence = c.get('contentLicence');
  if (contentLicence === '') throw new ApiError('rule', { details: { rule: 'licence_unconfigured', message: 'No Content Licence is configured yet, so no agreement can be given.' } });
  const input = parse(agreementSchema, await readJson(c));
  if (input.licenceName !== contentLicence) throw new ApiError('validation', { fields: [{ field: 'licenceName', rule: 'Agree to the current Content Licence.' }] });
  const stored = (await loadProfile(c, memberId))!;
  const given = stored.agreements.some((agreement) => agreement.licenceName === contentLicence);
  if (!given) {
    const now = c.get('now');
    await new GuardedBatch(c.env.RF_CORE, { id: memberId, now })
      .run(sql`INSERT INTO licence_agreements (member_id, licence_name, given_on) VALUES (${memberId}, ${contentLicence}, ${now.slice(0, 10)}) ON CONFLICT DO NOTHING`)
      .run(sql`UPDATE profiles SET licence_name = ${contentLicence},
        licence_given_on = (SELECT given_on FROM licence_agreements WHERE member_id = ${memberId} AND licence_name = ${contentLicence}),
        rev = rev + 1, updated_seq = ${CHANGE_SEQ}, actor_id = ${memberId} WHERE member_id = ${memberId}`)
      .commit(c.get('accountant'));
  }
  return c.json({ profile: present((await loadProfile(c, memberId))!, contentLicence) }, given ? 200 : 201);
});

export const memberProfileRoutes = new Hono<ApiEnv>();

/** Any Member's Profile with their up to 20 most recent Submissions, newest first, and the Items each added (R3.4). */
memberProfileRoutes.get('/:id/profile', async (c) => {
  await authorizeRead(c);
  const id = c.req.param('id');
  if (!isULID(id)) throw new ApiError('not_found');
  const db = c.env.RF_CORE;
  const memberId = asULID(id);
  const results = await c.get('accountant').track(db.batch([
    db.prepare('SELECT id, status FROM members WHERE id = ?1').bind(memberId),
    ...profileStatements(db, memberId),
    // A Submission whose every unit belongs to Research_Items the viewer cannot read is left out (R47.4).
    db.prepare(`SELECT s.id, s.kind, s.completed_at AS completedAt FROM submissions s WHERE s.member_id = ?1 AND s.completed_at IS NOT NULL
        AND (NOT EXISTS (SELECT 1 FROM units su WHERE su.submission_id = s.id) OR EXISTS (SELECT 1 FROM units su WHERE su.submission_id = s.id AND ${canRead('?2', 'su.root_id')}))
      ORDER BY s.completed_at DESC, s.id DESC LIMIT ${RECENT_SUBMISSIONS}`).bind(memberId, c.get('session').member.id),
  ]));
  const member = (results[0] as D1Result<{ id: ULID; status: MemberStatus }>).results[0];
  if (!member) throw new ApiError('not_found');
  const profile = storedProfile(results.slice(1, 5));
  const submissions = (results[5] as D1Result<{ id: ULID; kind: string; completedAt: string }>).results;
  const items = submissions.length === 0 ? [] : (await c.get('accountant').track(db.prepare(
    `SELECT id, unit_type AS unitType, root_id AS rootId, submission_id AS submissionId,
       (SELECT f.flag FROM flags f WHERE f.unit_id = units.id AND f.member_id = ?2) AS flag FROM units
       WHERE submission_id IN (SELECT value FROM json_each(?1)) AND unit_type IN (${ITEM_TYPES}) AND ${canRead('?2', 'units.root_id')} ORDER BY created_at, id`,
  ).bind(JSON.stringify(submissions.map((submission) => submission.id)), c.get('session').member.id).all<{ id: ULID; unitType: string; rootId: ULID; submissionId: ULID; flag: 'new' | 'updated' | null }>())).results;
  return c.json({
    member,
    profile: profile ? present(profile, c.get('contentLicence')) : null,
    submissions: submissions.map((submission) => ({
      ...submission,
      items: items.filter((item) => item.submissionId === submission.id).map(({ submissionId: _submission, flag, ...item }) => ({ ...item, ...(flag === null ? {} : { flag }) })),
    })),
  });
});
