import { describe, expect, it } from 'vitest';
import { SCHEMA_CONTEXT as context, SCHEMA_IDS as ids, schemaText as rt } from './schema-fixtures';
import { validate, documentDateSchema, idSchema, richTextSchema } from '../src/schemas/common';
import { emailSchema, externalPartySchema, genericLabelSchema, invitationSchema, memberSchema, policySectionSchema, profileSchema, projectSchema, publicDescriptionSchema, RESERVED_PROJECT_SLUGS, settingChangeSchema, settingSchema, workspaceSettingsSchema } from '../src/schemas/people';
import { defaultSettings, SETTINGS } from '../src/settings';
import type { SettingKey } from '../src/settings';
import { ROLE_IDS } from '../src/permissions';

describe('people and profile validation', () => {
  it('implements the documented address rule without adding mailbox-provider restrictions', () => {
    for (const email of ['é+tag@example.test', 'new@x.y']) expect(emailSchema.safeParse(email).success).toBe(true);
    expect(emailSchema.safeParse(`${'a'.repeat(250)}@x.y`).success).toBe(true);
    for (const email of ['', 'a b@example.test', 'a@@x.y', '@x.y', 'x@y', 'x@y..z', `${'a'.repeat(251)}@x.y`]) expect(emailSchema.safeParse(email).success).toBe(false);
    expect(validate(invitationSchema(context), { email: 'OWNER@example.test' }).ok).toBe(false);
    expect(invitationSchema(context).safeParse({ roleId: ROLE_IDS.contributor, email: 'REVOKED@example.test' }).success).toBe(true);
    expect(invitationSchema(context).safeParse({ roleId: ROLE_IDS.contributor, email: 'new@x.y', password: 'synthetic' }).success).toBe(false);
    expect(memberSchema.safeParse({ id: ids.member, roleId: ROLE_IDS.contributor, status: 'active', email: 'é@x.y', createdAt: context.now }).success).toBe(true);
  });

  it('initializes optional Profile fields, preserves Unicode and refuses duplicates and retired selections', () => {
    const input = { displayName: 'e\u0301 “ß”', specialtyIds: [ids.specialty], timeZone: 'Asia/Kathmandu' };
    const snapshot = structuredClone(input);
    expect(profileSchema(context, ids.member).parse(input)).toEqual({ ...input, affiliations: [], biography: '', dailyDigestHour: 8, publicProfile: false });
    expect(input).toEqual(snapshot);
    const invalid = validate(profileSchema(context, ids.member), { ...input, displayName: 'OTHER PERSON', specialtyIds: [ids.retiredSpecialty, ids.retiredSpecialty], affiliations: ['😀'.repeat(201)], timeZone: 'not/a-zone', dailyDigestHour: 24 });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.issues.map((issue) => issue.field)).toEqual(expect.arrayContaining(['displayName', 'specialtyIds.0', 'specialtyIds.1', 'affiliations.0', 'timeZone', 'dailyDigestHour']));
    const prior = { ...context, previousSelections: { specialtyIds: [ids.retiredSpecialty] } };
    expect(profileSchema(prior, ids.member).safeParse({ ...input, specialtyIds: [ids.retiredSpecialty] }).success).toBe(true);
  });
});

describe('Projects and policy fields', () => {
  it('lists reserved slugs and prevents duplicates and changes to fixed slugs', () => {
    const schema = projectSchema(context);
    for (const slug of RESERVED_PROJECT_SLUGS) expect(schema.safeParse({ name: 'Other', description: 'A project', slug }).success).toBe(false);
    expect(schema.safeParse({ name: 'p1030680', description: 'A project', slug: 'another' }).success).toBe(false);
    expect(schema.safeParse({ name: 'Another', description: 'A project', slug: 'p1030680' }).success).toBe(false);
    for (const slug of ['-start', 'Upper', 'has space', 'x'.repeat(41), '']) expect(schema.safeParse({ name: 'Another', description: 'A project', slug }).success).toBe(false);
    const edit = projectSchema(context, { id: ids.project, slug: 'p1030680', slugFixed: true });
    expect(edit.safeParse({ name: 'P1030680', description: 'Research', slug: 'p1030680' }).success).toBe(true);
    expect(edit.safeParse({ name: 'P1030680', description: 'Research', slug: 'changed' }).success).toBe(false);
  });

  it('uses code-point limits and does not permit an empty required policy section or Generic Label', () => {
    expect(publicDescriptionSchema.safeParse('😀'.repeat(500)).success).toBe(true);
    expect(publicDescriptionSchema.safeParse('😀'.repeat(501)).success).toBe(false);
    expect(genericLabelSchema.safeParse(' ').success).toBe(false);
    expect(genericLabelSchema.safeParse('😀'.repeat(100)).success).toBe(true);
    expect(policySectionSchema(true).safeParse(rt(' \u0085 ')).success).toBe(false);
    expect(policySectionSchema(false).safeParse(rt('')).success).toBe(true);
    expect(policySectionSchema(true).safeParse(rt('😀'.repeat(20_000))).success).toBe(true);
    expect(policySectionSchema(false).safeParse(rt('x'.repeat(20_001))).success).toBe(false);
    expect(externalPartySchema().safeParse({ name: 'Archive', doNotName: true }).success).toBe(false);
    expect(externalPartySchema().safeParse({ name: 'Archive', doNotName: true, genericLabel: 'an archive' }).success).toBe(true);
  });
});

it('reuses every setting validator and exposes every failing field', () => {
  const member = context.members[0]!;
  const settingContext = { members: context.members };
  const defaults = defaultSettings(member);
  expect(workspaceSettingsSchema(settingContext).parse(defaults)).toEqual(defaults);
  for (const key of Object.keys(SETTINGS) as SettingKey[]) expect(settingSchema(key, settingContext).safeParse(defaults[key]).success).toBe(true);
  expect(settingSchema('aiDrafting').parse(false)).toBe(false);
  expect(settingChangeSchema(settingContext).safeParse({ key: 'recipientCap', value: '2000' }).success).toBe(false);
  expect(validate(settingChangeSchema(settingContext), { key: 'recipientCap' }).ok).toBe(false);
  const result = validate(workspaceSettingsSchema(settingContext), { ...defaults, followUpInterval: 0, recipientCap: Infinity, aiInputLimit: 50_001 });
  if (result.ok) throw new Error('Expected multiple errors.');
  expect(result.issues.map((issue) => issue.field)).toEqual(['followUpInterval', 'recipientCap', 'aiInputLimit']);
});

it('reports the relevant date branch and malformed IDs without throwing or fabricating unrelated errors', () => {
  expect(() => idSchema.safeParse('invalid')).not.toThrow();
  const result = validate(documentDateSchema, { start: { value: '1944', approx: false }, end: { value: '1943', approx: false } });
  if (result.ok) throw new Error('Expected a reversed date range.');
  expect(result.issues.map((issue) => issue.field)).toEqual(['end']);
});

it('does not hide other faulty labels when one span has a malformed JSON field', () => {
  const result = validate(richTextSchema(), { text: 'abcd', spans: [
    { k: 'quote', s: 0, e: 1, source: false },
    { k: 'quote', s: 1, e: 2, source: ' ' },
    { k: 'lang', s: 2, e: 3, lang: 'zz' },
    { k: 'unknown', s: 3, e: 4 },
  ] });
  if (result.ok) throw new Error('Expected all independent label errors.');
  expect(result.issues.map((issue) => issue.field)).toEqual(expect.arrayContaining(['spans.0.source', 'spans.1', 'spans.2', 'spans.3.k']));
  expect(result.issues.find((issue) => issue.field === 'spans.1')?.message).toMatch(/^Span 2:/);
});
