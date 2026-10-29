import { z } from 'zod';
import { isTimeZone } from '../dates';
import { isBlank } from '../text';
import { MEMBER_STATUSES } from '../types';
import type { ULID } from '../types';
import { SETTINGS, validateSetting } from '../settings';
import type { SettingContext, SettingKey, WorkspaceSettings } from '../settings';
import { distinctIds, idSchema, knownId, richTextSchema, selectedValue, textField, timestampSchema, withChecks } from './common';
import type { ValidationContext } from './common';

export const RESERVED_PROJECT_SLUGS = Object.freeze(['projects', 'search', 'submit', 'respond', 'about', 'people', 'methods', 'licence', 'privacy', 'corrections', 'p', 'r', 'a', 'f', 'idx', 'assets', 'page', 'log', 'withheld', '404'] as const);
export const emailSchema = textField(254, true).refine((email) => {
  // Deliberately implements the specification's address rule instead of imposing RFC mailbox restrictions.
  const at = email.indexOf('@');
  return !/[\p{White_Space}\uFEFF]/u.test(email) && at > 0 && at === email.lastIndexOf('@') && email.slice(at + 1).includes('.') && email.slice(at + 1).split('.').every((part) => part.length > 0);
}, 'Enter one email address with one @, no whitespace, and a dotted domain.');

export function invitationSchema(context: ValidationContext) {
  return z.strictObject({ roleId: knownId(context.roleIds, 'Role'), email: emailSchema.refine((email) => !context.members.some((member) => member.status === 'active' && member.email?.toLowerCase() === email.toLowerCase()), 'An active Member already holds this address.') });
}
export const memberSchema = z.strictObject({ id: idSchema, roleId: idSchema, status: z.enum(MEMBER_STATUSES), email: emailSchema, createdAt: timestampSchema, inviteEmailState: z.enum(['pending', 'sent', 'failed']).optional() });

export function profileSchema(context: ValidationContext, memberId: ULID) {
  return z.strictObject({
    displayName: textField(80, true).refine((name) => !context.members.some((member) => member.id !== memberId && member.displayName?.toLowerCase() === name.toLowerCase()), 'Display names must be unique ignoring letter case.'),
    specialtyIds: distinctIds(selectedValue(context, 'specialty', 'specialtyIds'), 1),
    affiliations: z.array(textField(200)).max(5).prefault([]), biography: textField(1000).prefault(''),
    timeZone: z.string().refine(isTimeZone, 'Choose a valid IANA time zone.'),
    dailyDigestHour: z.number().int().min(0).max(23).prefault(8), publicProfile: z.boolean().prefault(false),
  });
}
export function projectSchema(context: ValidationContext, previous?: { readonly id: ULID; readonly slug: string; readonly slugFixed: boolean }) {
  return z.strictObject({
    name: textField(100, true).refine((name) => !context.projects.some((project) => project.id !== previous?.id && project.name.toLowerCase() === name.toLowerCase()), 'Project names must be unique ignoring letter case.'),
    description: textField(500, true),
    slug: z.string().min(1).max(40).regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lower-case letters, digits and hyphens, starting with a letter or digit.')
      .refine((slug) => !(RESERVED_PROJECT_SLUGS as readonly string[]).includes(slug), `Reserved names: ${RESERVED_PROJECT_SLUGS.join(', ')}.`)
      .refine((slug) => !context.projects.some((project) => project.id !== previous?.id && project.slug === slug), 'This Project Slug is already in use.')
      .refine((slug) => !previous?.slugFixed || slug === previous.slug, 'The Project Slug is fixed after its first Public or Withheld appearance.'),
  });
}
export const publicDescriptionSchema = textField(500, true);
export const genericLabelSchema = textField(100, true);
export function policySectionSchema(required: boolean) { return richTextSchema(20_000, required); }
export function externalPartySchema() {
  return withChecks(z.strictObject({ name: textField(undefined, true), doNotName: z.boolean(), genericLabel: textField(100).optional() }), (raw, report) => {
    if (raw['doNotName'] === true && (raw['genericLabel'] === undefined || (typeof raw['genericLabel'] === 'string' && isBlank(raw['genericLabel'])))) report(['genericLabel'], 'A Party marked Do Not Name needs a non-blank Generic Label.');
  });
}

export function settingSchema<K extends SettingKey>(key: K, context?: SettingContext): z.ZodType<WorkspaceSettings[K]> {
  return z.unknown().transform((value, ctx) => {
    const result = validateSetting(key, value, context);
    if (result.ok) return result.value;
    for (const issue of result.issues) ctx.addIssue({ code: 'custom', path: issue.field === key ? [] : issue.field.slice(key.length + 1).split('.'), message: issue.message });
    return z.NEVER;
  });
}
export function workspaceSettingsSchema(context?: SettingContext): z.ZodType<WorkspaceSettings> {
  const shape = Object.fromEntries((Object.keys(SETTINGS) as SettingKey[]).map((key) => [key, settingSchema(key, context)])) as { [K in SettingKey]: z.ZodType<WorkspaceSettings[K]> };
  return z.strictObject(shape);
}
export const settingKeySchema = z.enum(Object.keys(SETTINGS) as [SettingKey, ...SettingKey[]]);
export function settingChangeSchema(context?: SettingContext) {
  return withChecks(z.strictObject({ key: settingKeySchema, value: z.unknown() }), (raw, report) => {
    if (!Object.hasOwn(raw, 'value')) { report(['value'], 'Provide a setting value.'); return; }
    const key = settingKeySchema.safeParse(raw['key']);
    if (!key.success) return;
    const result = validateSetting(key.data, raw['value'], context);
    if (!result.ok) for (const issue of result.issues) report(['value', ...(issue.field === key.data ? [] : issue.field.slice(key.data.length + 1).split('.'))], issue.message);
  });
}

// Exported input types keep callers tied to the runtime validators.
export type ProfileInput = z.output<ReturnType<typeof profileSchema>>;
export type ProjectInput = z.output<ReturnType<typeof projectSchema>>;
export type InvitationInput = z.output<ReturnType<typeof invitationSchema>>;
