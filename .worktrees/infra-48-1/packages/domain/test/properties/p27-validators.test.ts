// Feature: research-collab-cms, Property 27: Validators accept exactly the valid inputs
import { expect, it } from 'vitest';
import { z } from 'zod';
import { fc } from '@researchforce/testing/fc';
import { ITEM_KINDS } from '../../src/types';
import { BUILT_IN_VALUE_IDS as builtIn } from '../../src/value-sets';
import { validate, logSummarySchema } from '../../src/schemas/common';
import { researchItemSchema } from '../../src/schemas/items';
import { emailSchema, externalPartySchema, genericLabelSchema, invitationSchema, memberSchema, policySectionSchema, profileSchema, projectSchema, publicDescriptionSchema, settingSchema } from '../../src/schemas/people';
import { attachmentMetadataSchema, disclosureLineSchema, dissentNoteSchema, editMarkSchema, groupNoteSchema, outsideSubmissionSchema, removalRequestStatementSchema, replySchema, reviewRequestSchema, submissionReadinessSchema } from '../../src/schemas/other';
import { itemFixture, outsideFixture, SCHEMA_CONTEXT as context, SCHEMA_IDS as ids, schemaId, schemaText as rt } from '../schema-fixtures';
import { ROLE_IDS } from '../../src/permissions';
import { SETTINGS } from '../../src/settings';

interface TextCase {
  name: string; schema: z.ZodType; limit?: number; required: boolean; path: string; emptyPath?: string;
  build(value: unknown): unknown;
}
const profile = { displayName: 'Synthetic profile', specialtyIds: [ids.specialty], timeZone: 'UTC' };
const project = { name: 'Synthetic project', description: 'Research', slug: 'synthetic-project' };
const review = { targetId: schemaId(500), memberIds: [ids.member], specialtyIds: [], roleIds: [] };
const attachment = { title: 'Synthetic file', origin: 'Synthetic origin' };
const line = { kindOfMaterial: 'correspondence', date: { value: '1943', approx: true }, partyIds: [] };
const schemas = Object.fromEntries(ITEM_KINDS.map((kind) => [kind, researchItemSchema(kind, context)]));
const texts: TextCase[] = [];
function field(name: string, schema: z.ZodType, base: Record<string, unknown>, key: string, limit: number | undefined, required: boolean, rich = false, emptyPath?: string): void {
  texts.push({ name, schema, ...(limit === undefined ? {} : { limit }), required, path: rich ? `${key}.text` : key, ...(emptyPath === undefined ? {} : { emptyPath }), build: (value) => ({ ...base, [key]: rich ? { text: value, spans: [] } : value }) });
}
function standalone(name: string, schema: z.ZodType, limit: number, required: boolean, rich = false): void {
  texts.push({ name, schema, limit, required, path: rich ? 'text' : '$', build: (value) => rich ? { text: value, spans: [] } : value });
}
field('Profile display name', profileSchema(context, ids.member), profile, 'displayName', 80, true);
field('Profile biography', profileSchema(context, ids.member), profile, 'biography', 1000, false);
texts.push({ name: 'Profile affiliation', schema: profileSchema(context, ids.member), limit: 200, required: false, path: 'affiliations.0', build: (value) => ({ ...profile, affiliations: [value] }) });
field('Project name', projectSchema(context), project, 'name', 100, true);
field('Project description', projectSchema(context), project, 'description', 500, true);
for (const kind of ITEM_KINDS) field(`${kind} title`, schemas[kind]!, itemFixture(kind), 'title', 200, true);
field('Finding claim', schemas.finding!, itemFixture('finding'), 'claim', 2000, true, true);
field('Finding caveat', schemas.finding!, itemFixture('finding'), 'scopeCaveat', 2000, true, true);
for (const [key, limit, rich] of [['scope', 10_000, true], ['parameters', 10_000, true], ['toolName', 200, false], ['toolVersion', 200, false], ['computeResource', 200, false], ['resumePoint', 1000, false], ['notes', 10_000, true]] as const) {
  field(`Run ${key}`, schemas.run!, itemFixture('run'), key, limit, !['resumePoint', 'notes'].includes(key), rich);
}
field('Hypothesis statement', schemas.hypothesis!, itemFixture('hypothesis'), 'statement', 10_000, true, true);
field('Hypothesis optional scope', schemas.hypothesis!, itemFixture('hypothesis'), 'eliminationScope', 1000, false, true);
field('Topic body', schemas.topic!, itemFixture('topic'), 'body', 50_000, true, true);
field('Required Log Summary', schemas.finding!, itemFixture('finding'), 'logSummary', 2000, true, true, 'logSummary');
field('Optional Log Summary', schemas.topic!, itemFixture('topic'), 'logSummary', 2000, false, true);
field('Group Note on submission', schemas.finding!, itemFixture('finding'), 'groupNote', 50_000, false, true);
field('Archival request text', schemas.archival_request!, itemFixture('archival_request'), 'requestText', undefined, true, true);
field('Review note', reviewRequestSchema(context), review, 'note', 2000, false);
for (const [key, limit, required] of [['title', 255, true], ['caption', 2000, false], ['origin', 5000, true], ['rightsHolder', 200, false], ['rightsTerms', 2000, false]] as const) field(`Attachment ${key}`, attachmentMetadataSchema(context), attachment, key, limit, required);
field('Disclosure kind', disclosureLineSchema(context), line, 'kindOfMaterial', 100, true);
field('Disclosure note', disclosureLineSchema(context), line, 'note', 200, false);
field('Correction reason', editMarkSchema, { mark: 'correction' }, 'reason', 1000, true);
const outside = outsideSubmissionSchema(context, { contentLicence: 'synthetic-licence-v1' });
for (const [key, limit, required] of [['message', 10_000, true], ['name', 200, true], ['affiliation', 200, false], ['pageReference', 2000, false]] as const) field(`Outside ${key}`, outside, outsideFixture(), key, limit, required);
for (const [name, schema, limit, required, rich] of [
  ['Reply', replySchema, 50_000, true, true], ['Group Note', groupNoteSchema, 50_000, false, true], ['Dissent', dissentNoteSchema, 2000, true, true],
  ['Log Summary', logSummarySchema, 2000, true, true], ['Required policy', policySectionSchema(true), 20_000, true, true], ['Optional policy', policySectionSchema(false), 20_000, false, true],
  ['Public Description', publicDescriptionSchema, 500, true, false], ['Generic Label', genericLabelSchema, 100, true, false], ['Removal statement', removalRequestStatementSchema, 5000, true, false],
] as const) standalone(name, schema, limit, required, rich);

interface MutationCase { name: string; schema: z.ZodType; build(variant: number): { input: unknown; fields: string[] }; }
const mutations: MutationCase[] = [
  { name: 'Member record', schema: memberSchema, build: (n) => {
    const base = { id: ids.member, roleId: ROLE_IDS.contributor, status: 'active', email: 'synthetic@example.test', createdAt: context.now };
    if (n % 4 === 1) return { input: { ...base, status: 'unknown' }, fields: ['status'] };
    if (n % 4 === 2) return { input: { ...base, roleId: undefined }, fields: ['roleId'] };
    if (n % 4 === 3) return { input: { ...base, createdAt: '2026-01-01T00:00:00Z' }, fields: ['createdAt'] };
    return { input: base, fields: [] };
  } },
  ...ITEM_KINDS.map((kind): MutationCase => ({ name: `${kind} server-owned field`, schema: schemas[kind]!, build: () => ({ input: { ...itemFixture(kind), ownerId: ids.member }, fields: ['ownerId'] }) })),
  { name: 'Profile specialties', schema: profileSchema(context, ids.member), build: (n) => {
    const values = [[ids.specialty], [], [ids.specialty, ids.specialty], [ids.retiredSpecialty], [schemaId(999)]];
    return { input: { ...profile, specialtyIds: values[n % 5] }, fields: [[], ['specialtyIds'], ['specialtyIds.1'], ['specialtyIds.0'], ['specialtyIds.0']][n % 5]! };
  } },
  { name: 'Profile affiliation count', schema: profileSchema(context, ids.member), build: (n) => ({ input: { ...profile, affiliations: Array.from({ length: n % 2 ? 6 : 5 }, () => 'An institution') }, fields: n % 2 ? ['affiliations'] : [] }) },
  { name: 'External Party naming', schema: externalPartySchema(), build: (n) => ({ input: { name: 'An archive', doNotName: true, genericLabel: n % 2 ? ' ' : 'an archive' }, fields: n % 2 ? ['genericLabel'] : [] }) },
  { name: 'Run counts', schema: schemas.run!, build: (n) => {
    const counts: unknown[] = [[{ name: 'Keys', value: '123456789012345678901234567890' }], [{ name: 'Keys', value: 123 }], [{ name: 'Keys', value: '0' }, { name: 'Keys', value: '1' }], Array.from({ length: 21 }, (_, i) => ({ name: String(i), value: '0' })), [{ name: 'Keys', value: '1'.repeat(31) }]];
    return { input: { ...itemFixture('run'), counts: counts[n % 5] }, fields: [[], ['counts.0.value'], ['counts.1.name'], ['counts'], ['counts.0.value']][n % 5]! };
  } },
  { name: 'Run end time', schema: schemas.run!, build: (n) => ({ input: { ...itemFixture('run'), startTime: '2026-03-07T12:00:00.0009Z', endTime: n % 2 ? '2026-03-07T12:00:00.0001Z' : '2026-03-07T12:00:00.001Z' }, fields: n % 2 ? ['endTime'] : [] }) },
  { name: 'Finding withdrawal', schema: schemas.finding!, build: (n) => ({ input: { ...itemFixture('finding'), statusValueId: builtIn.findingWithdrawn, withdrawalReason: n % 2 ? ' ' : 'Evidence corrected' }, fields: n % 2 ? ['withdrawalReason'] : [] }) },
  { name: 'Hypothesis elimination', schema: schemas.hypothesis!, build: (n) => ({ input: { ...itemFixture('hypothesis'), statusValueId: builtIn.hypothesisEliminated, eliminationScope: rt(n % 2 ? ' ' : 'A bounded region') }, fields: n % 2 ? ['eliminationScope'] : [] }) },
  { name: 'Correspondence parties and local date', schema: schemas.correspondence!, build: (n) => {
    const input = itemFixture('correspondence');
    if (n % 4 === 1) return { input: { ...input, date: { value: '2026-03-08', approx: false } }, fields: ['date'] };
    if (n % 4 === 2) return { input: { ...input, parties: [] }, fields: ['parties'] };
    if (n % 4 === 3) return { input: { ...input, parties: [{ kind: 'member', id: ids.member }, { kind: 'member', id: ids.member }] }, fields: ['parties.1'] };
    return { input, fields: [] };
  } },
  { name: 'Archival status dates', schema: schemas.archival_request!, build: (n) => {
    if (n % 3 === 1) return { input: { ...itemFixture('archival_request'), statusValueId: builtIn.archivalSent }, fields: ['dateSent'] };
    if (n % 3 === 2) return { input: { ...itemFixture('archival_request'), title: false, statusValueId: builtIn.archivalReplied }, fields: ['title', 'dateSent', 'replyDate', 'replyContent'] };
    return { input: itemFixture('archival_request'), fields: [] };
  } },
  { name: 'Source date range', schema: schemas.source!, build: (n) => ({ input: { ...itemFixture('source'), documentDate: { start: { value: '1943-05', approx: true }, end: { value: n % 2 ? '1942' : '1943', approx: false } } }, fields: n % 2 ? ['documentDate.end'] : [] }) },
  { name: 'Review addressees', schema: reviewRequestSchema(context), build: (n) => {
    const input = { ...review, memberIds: n % 3 === 0 ? [ids.member] : n % 3 === 1 ? [ids.revoked] : [] };
    return { input, fields: n % 3 === 0 ? [] : [n % 3 === 1 ? 'memberIds.0' : 'memberIds'] };
  } },
  { name: 'Outside agreement', schema: outside, build: (n) => {
    if (n % 4 === 1) return { input: { ...outsideFixture(), licenceAgreement: undefined }, fields: ['licenceAgreement'] };
    if (n % 4 === 2) return { input: { ...outsideFixture(), name: false, licenceAgreement: { agreed: false, contentLicence: 'synthetic-licence-v1' } }, fields: ['name', 'licenceAgreement.agreed'] };
    if (n % 4 === 3) return { input: { ...outsideFixture('removal_request'), licenceAgreement: undefined }, fields: [] };
    return { input: outsideFixture(), fields: [] };
  } },
  { name: 'Submission readiness', schema: submissionReadinessSchema(context), build: (n) => {
    const file = { fileName: 'synthetic.txt', state: 'complete', sizeBytes: 0, metadata: attachment };
    if (n % 5 === 1) return { input: [{ ...file, state: 'uploading' }], fields: ['0.state'] };
    if (n % 5 === 2) return { input: [{ ...file, state: 'failed' }], fields: ['0.state'] };
    if (n % 5 === 3) return { input: [{ ...file, sizeBytes: 1_000_000_001 }], fields: ['0.sizeBytes'] };
    if (n % 5 === 4) return { input: Array.from({ length: 101 }, () => file), fields: ['$'] };
    return { input: [file], fields: [] };
  } },
  { name: 'Invitation', schema: invitationSchema(context), build: (n) => ({ input: { roleId: ROLE_IDS.contributor, email: n % 2 ? 'OWNER@example.test' : 'new@example.test' }, fields: n % 2 ? ['email'] : [] }) },
];
const numericCases = [
  ['followUpInterval', 1, 365], ['emailBatchWindow', 1, 60], ['directUploadThreshold', 0, 100_000_000], ['attachmentSizeLimit', 1, Number.MAX_SAFE_INTEGER], ['publicUploadSizeLimit', 1, Number.MAX_SAFE_INTEGER],
  ['publicTrafficBudget', 0, 50], ['recipientCap', 1, 10_000], ['aiInputLimit', 1000, 50_000],
] as const;

function fields(result: ReturnType<typeof validate>): string[] { return result.ok ? [] : [...new Set(result.issues.map((issue) => issue.field))].sort(); }

it('accepts exactly documented valid inputs, names each failing field, and leaves inputs unchanged', () => {
  const contextSnapshot = structuredClone(context);
  fc.assert(fc.property(fc.integer({ min: 0, max: 9 }), fc.boolean(), fc.nat({ max: 300 }), (variant, emoji, arbitraryLength) => {
    for (const entry of texts) {
      const cap = entry.limit ?? 100;
      const sizes = [0, 1, cap - 1, cap, cap + 1, arbitraryLength];
      const count = sizes[variant % sizes.length]!;
      const blank = variant === 7 || variant === 8;
      const inputValue: unknown = variant === 9 ? 123 : (blank ? '\u2003' : emoji ? '😀' : 'x').repeat(count);
      const valid = typeof inputValue === 'string' && (!entry.required || (count > 0 && !blank)) && (entry.limit === undefined || count <= entry.limit);
      const empty = typeof inputValue === 'string' && (blank || count === 0);
      const expected = valid ? [] : [empty && entry.emptyPath && entry.required ? entry.emptyPath : entry.path];
      const input = entry.build(inputValue);
      const snapshot = structuredClone(input);
      const result = validate(entry.schema, input);
      expect(fields(result), entry.name).toEqual(expected);
      expect(result.ok, entry.name).toBe(valid);
      expect(input, entry.name).toEqual(snapshot);
    }
    for (const [key, minimum, maximum] of numericCases) {
      const input = [minimum - 1, minimum, maximum, maximum + 1, minimum + 0.5, NaN, Infinity, '7', true, null][variant];
      const expected = typeof input === 'number' && Number.isSafeInteger(input) && input >= minimum && input <= maximum;
      expect(settingSchema(key).safeParse(input).success, key).toBe(expected);
    }
    const limitValue = [-1, 0, 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, 0.5, NaN, '1', true, null][variant];
    for (const key of Object.keys(SETTINGS.outsideSubmissionLimits.default)) {
      const value = { ...SETTINGS.outsideSubmissionLimits.default, [key]: limitValue };
      const expected = typeof limitValue === 'number' && Number.isSafeInteger(limitValue) && limitValue >= 0;
      expect(settingSchema('outsideSubmissionLimits').safeParse(value).success, key).toBe(expected);
    }
    expect(settingSchema('aiDrafting').safeParse(variant % 2 === 0 ? false : 'Off').success).toBe(variant % 2 === 0);
    expect(settingSchema('emailProvider').safeParse(variant % 2 === 0 ? 'microsoft_graph' : 'other').success).toBe(variant % 2 === 0);
    const responsiblePerson = [ids.member, ids.revoked, schemaId(999), null][variant % 4];
    expect(settingSchema('responsiblePerson', { members: context.members }).safeParse(responsiblePerson).success).toBe(variant % 4 === 0);
    const hour = [-1, 0, 23, 24, 0.5, NaN, Infinity, '8', true, 8][variant];
    const hourValid = typeof hour === 'number' && Number.isInteger(hour) && hour >= 0 && hour <= 23;
    expect(profileSchema(context, ids.member).safeParse({ ...profile, dailyDigestHour: hour }).success).toBe(hourValid);
    const email = `${'é'.repeat(arbitraryLength)}@example.test`;
    expect(emailSchema.safeParse(email).success).toBe(arbitraryLength >= 1 && arbitraryLength + '@example.test'.length <= 254);
    for (const entry of mutations) {
      const { input, fields: expected } = entry.build(variant);
      const snapshot = structuredClone(input);
      const result = validate(entry.schema, input);
      expect(fields(result), entry.name).toEqual([...expected].sort());
      expect(result.ok, entry.name).toBe(expected.length === 0);
      expect(input, entry.name).toEqual(snapshot);
    }
    expect(context).toEqual(contextSnapshot);
  }));
});
