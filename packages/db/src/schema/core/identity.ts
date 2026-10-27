import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { EVENT_TYPES, LEVELS, MEMBER_STATUSES } from '@researchforce/domain/types';
import type { DisclosureLine } from '@researchforce/domain/types';
import { PERMISSIONS } from '@researchforce/domain/permissions';
import { VALUE_SET_KINDS } from '@researchforce/domain/value-sets';
import { flag, oneOf, sequenced, versioned } from '../columns';

export const EMAIL_MODES = ['immediate', 'daily_digest', 'off'] as const;
export const INVITE_EMAIL_STATES = ['pending', 'sent', 'failed'] as const;
export const PERMISSION_SCOPES = ['any', 'own', 'other', 'eligible'] as const;
export const METHODS_TERM_GROUPS = ['source_kind', 'disclosure_level', 'label_kind', 'term'] as const;

// Access handles sign-in, so no column here holds a password, password hash, or one-time PIN (R1.2).
export const members = sqliteTable('members', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  emailLc: text('email_lc').notNull(),
  roleId: text('role_id').notNull(),
  status: text('status', { enum: MEMBER_STATUSES }).notNull(),
  createdAt: text('created_at').notNull(), // the invitation time for invited Members (R18.6)
  invitedBy: text('invited_by'),
  activatedAt: text('activated_at'),
  revokedAt: text('revoked_at'),
  inviteEmailState: text('invite_email_state', { enum: INVITE_EMAIL_STATES }),
  ...versioned(),
}, (t) => [
  uniqueIndex('members_email_lc').on(t.emailLc),
  index('members_status').on(t.status, t.roleId),
  oneOf('members_status_values', t.status, MEMBER_STATUSES),
  oneOf('members_invite_email_values', t.inviteEmailState, INVITE_EMAIL_STATES, true),
]);

export const sessions = sqliteTable('sessions', {
  tokenHash: text('token_hash').primaryKey(),
  memberId: text('member_id').notNull(),
  establishedAt: text('established_at').notNull(),
  endedAt: text('ended_at'),
}, (t) => [index('sessions_member').on(t.memberId), index('sessions_established').on(t.establishedAt)]);

export const roles = sqliteTable('roles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  nameKey: text('name_key').notNull(),
  builtin: flag('builtin'),
  ...versioned(),
}, (t) => [uniqueIndex('roles_name_key').on(t.nameKey)]);

export const rolePermissions = sqliteTable('role_permissions', {
  roleId: text('role_id').notNull(),
  permission: text('permission', { enum: PERMISSIONS }).notNull(),
  scope: text('scope', { enum: PERMISSION_SCOPES }).notNull(),
}, (t) => [
  primaryKey({ columns: [t.roleId, t.permission] }),
  oneOf('role_permissions_permission_values', t.permission, PERMISSIONS),
  oneOf('role_permissions_scope_values', t.scope, PERMISSION_SCOPES),
]);

export const profiles = sqliteTable('profiles', {
  memberId: text('member_id').primaryKey(),
  displayName: text('display_name').notNull(),
  displayNameKey: text('display_name_key').notNull(), // case-folded for uniqueness
  bio: text('bio').notNull().default(''),
  timeZone: text('time_zone').notNull(),
  digestHour: integer('digest_hour').notNull().default(8),
  publicProfile: flag('public_profile'),
  licenceName: text('licence_name'),
  licenceGivenOn: text('licence_given_on'), // UTC date; a Licence_Agreement is never withdrawn (R46.16)
  ...versioned(),
}, (t) => [
  uniqueIndex('profiles_display_name_key').on(t.displayNameKey),
  check('profiles_digest_hour_range', sql`${t.digestHour} BETWEEN 0 AND 23`),
  check('profiles_licence_pair', sql`(${t.licenceName} IS NULL) = (${t.licenceGivenOn} IS NULL)`),
]);

export const profileSpecialties = sqliteTable('profile_specialties', {
  memberId: text('member_id').notNull(),
  valueId: text('value_id').notNull(),
}, (t) => [primaryKey({ columns: [t.memberId, t.valueId] }), index('profile_specialties_value').on(t.valueId)]);

export const profileAffiliations = sqliteTable('profile_affiliations', {
  memberId: text('member_id').notNull(),
  position: integer('position').notNull(),
  text: text('text').notNull(),
}, (t) => [primaryKey({ columns: [t.memberId, t.position] }), check('profile_affiliations_position_range', sql`${t.position} BETWEEN 0 AND 4`)]);

/** A missing row means the initial preference: in-app On and email Immediate (R19.9). */
export const notificationPrefs = sqliteTable('notification_prefs', {
  memberId: text('member_id').notNull(),
  eventType: text('event_type', { enum: EVENT_TYPES }).notNull(),
  inApp: integer('in_app', { mode: 'boolean' }).notNull().default(true),
  email: text('email', { enum: EMAIL_MODES }).notNull().default('immediate'),
}, (t) => [
  primaryKey({ columns: [t.memberId, t.eventType] }),
  oneOf('notification_prefs_event_values', t.eventType, EVENT_TYPES),
  oneOf('notification_prefs_email_values', t.email, EMAIL_MODES),
]);

export const mutedProjects = sqliteTable('muted_projects', {
  memberId: text('member_id').notNull(),
  projectId: text('project_id').notNull(),
  mutedAt: text('muted_at').notNull(),
}, (t) => [primaryKey({ columns: [t.memberId, t.projectId] }), index('muted_projects_project').on(t.projectId)]);

/** Every configurable value set shares this table and one rule set (R3.3, R33.6, R46.12). */
export const configValues = sqliteTable('config_values', {
  id: text('id').primaryKey(),
  setKey: text('set_key', { enum: VALUE_SET_KINDS }).notNull(),
  name: text('name').notNull(),
  nameKey: text('name_key').notNull(),
  retired: flag('retired'),
  locked: flag('locked'),
  permitsPublication: integer('permits_publication', { mode: 'boolean' }), // Rights_Status values only
  position: integer('position').notNull(),
  publicDescription: text('public_description'),
  ...versioned(),
}, (t) => [
  uniqueIndex('config_values_name_key').on(t.setKey, t.nameKey),
  index('config_values_set').on(t.setKey, t.position),
  oneOf('config_values_set_values', t.setKey, VALUE_SET_KINDS),
  check('config_values_publication_rights_only', sql`(${t.permitsPublication} IS NOT NULL) = (${t.setKey} = 'rights_status')`),
  check('config_values_methods_description', sql`${t.setKey} = 'specialty' OR ${t.publicDescription} IS NOT NULL`),
]);

/** Fixed Methods_Terms outside the configurable sets; only their Public_Descriptions change (R46.11, R46.12). */
export const methodsTerms = sqliteTable('methods_terms', {
  key: text('key').primaryKey(),
  groupKey: text('group_key', { enum: METHODS_TERM_GROUPS }).notNull(),
  name: text('name').notNull(),
  position: integer('position').notNull(),
  publicDescription: text('public_description').notNull(),
  ...versioned(),
}, (t) => [oneOf('methods_terms_group_values', t.groupKey, METHODS_TERM_GROUPS)]);

/** Workspace-wide settings from the domain registry, including the Responsible_Person (R46.37). */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedBy: text('updated_by'),
  updatedAt: text('updated_at').notNull(),
  ...sequenced(),
});

/** `change` is the change sequence; `frozen` is 1 while an Internal_Backup reads rf-core. */
export const counters = sqliteTable('counters', {
  k: text('k').primaryKey(),
  v: integer('v').notNull(),
});

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  nameKey: text('name_key').notNull(),
  shortDescription: text('short_description').notNull(),
  slug: text('slug').notNull(),
  slugFixedAt: text('slug_fixed_at'),
  featured: flag('featured'),
  // Reordering must move positions out of the way first, because SQLite checks uniqueness row by row.
  position: integer('position').notNull(),
  accent: text('accent'),
  disclosureLevel: text('disclosure_level', { enum: LEVELS }).notNull().default('private'),
  disclosureLine: text('disclosure_line', { mode: 'json' }).$type<DisclosureLine>(),
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at').notNull(),
  ...versioned(),
}, (t) => [
  uniqueIndex('projects_name_key').on(t.nameKey),
  uniqueIndex('projects_slug').on(t.slug),
  uniqueIndex('projects_position').on(t.position),
  index('projects_seq').on(t.updatedSeq),
  oneOf('projects_level_values', t.disclosureLevel, LEVELS),
  check('projects_withheld_line', sql`${t.disclosureLevel} <> 'withheld' OR ${t.disclosureLine} IS NOT NULL`),
]);
