import { describe, expect, it } from 'vitest';
import { validate } from '../src/schemas/common';
import { attachmentMetadataSchema, disclosureLineSchema, dissentNoteSchema, editMarkSchema, groupNoteSchema, outsideSubmissionSchema, removalRequestStatementSchema, replySchema, reviewRequestSchema, submissionReadiness } from '../src/schemas/other';
import { outsideFixture, SCHEMA_CONTEXT as context, SCHEMA_IDS as ids, schemaId, schemaText as rt } from './schema-fixtures';
import { ROLE_IDS } from '../src/permissions';

describe('discussion, reviews and edits', () => {
  it('distinguishes an absent Group Note from required Reply and Dissent text', () => {
    expect(groupNoteSchema.safeParse(rt(' \u0085 ')).success).toBe(true);
    expect(groupNoteSchema.safeParse(undefined).success).toBe(true);
    expect(replySchema.safeParse(rt(' ')).success).toBe(false);
    expect(replySchema.safeParse(rt('😀'.repeat(50_000))).success).toBe(true);
    expect(dissentNoteSchema.safeParse(rt('😀'.repeat(2000))).success).toBe(true);
    expect(dissentNoteSchema.safeParse(rt('😀'.repeat(2001))).success).toBe(false);
  });

  it('requires distinct current addressees and at least one recipient of any allowed kind', () => {
    const schema = reviewRequestSchema(context);
    const base = { targetId: schemaId(500), memberIds: [], specialtyIds: [], roleIds: [] };
    expect(schema.safeParse(base).success).toBe(false);
    for (const selection of [{ memberIds: [ids.member] }, { specialtyIds: [ids.specialty] }, { roleIds: [ROLE_IDS.administrator] }]) expect(schema.safeParse({ ...base, ...selection }).success).toBe(true);
    expect(schema.safeParse({ ...base, memberIds: [ids.revoked], specialtyIds: [ids.retiredSpecialty] }).success).toBe(false);
    expect(schema.safeParse({ ...base, memberIds: [ids.member, ids.member] }).success).toBe(false);
    expect(schema.safeParse({ ...base, roleIds: [ROLE_IDS.administrator], note: 'x'.repeat(2001) }).success).toBe(false);
  });

  it('requires edit marks and Correction reasons and validates Removal Request outcomes', () => {
    expect(editMarkSchema.safeParse({ mark: 'minor_edit' }).success).toBe(true);
    expect(editMarkSchema.safeParse({ mark: 'correction', reason: 'Evidence updated' }).success).toBe(true);
    const invalid = validate(editMarkSchema, { mark: 'correction', reason: ' ' });
    expect(invalid.ok).toBe(false);
    expect(editMarkSchema.safeParse({ reason: 'Missing mark' }).success).toBe(false);
    for (const reason of ['', ' ', 'x'.repeat(5001)]) expect(removalRequestStatementSchema.safeParse(reason).success).toBe(false);
    expect(removalRequestStatementSchema.safeParse('😀'.repeat(5000)).success).toBe(true);
  });
});

it('validates Withheld Disclosure Lines at the entered date precision', () => {
  const schema = disclosureLineSchema(context);
  const line = { kindOfMaterial: 'correspondence', date: { value: '1943-05', approx: true }, partyIds: [ids.external] };
  expect(schema.parse(line)).toEqual(line);
  expect(schema.safeParse({ ...line, partyIds: Array.from({ length: 21 }, () => ids.external) }).success).toBe(false);
  expect(schema.safeParse({ ...line, kindOfMaterial: '', note: 'x'.repeat(201) }).success).toBe(false);
  expect(schema.safeParse({ ...line, partyIds: [schemaId(999)] }).success).toBe(false);
});

it('reports every unready file by index and name, including size, state and metadata errors', () => {
  const metadata = { title: 'Synthetic file', origin: 'Synthetic origin' };
  const complete = { fileName: 'synthetic.txt', sizeBytes: 0, state: 'complete', metadata };
  expect(submissionReadiness([complete], context).ok).toBe(true);
  const result = submissionReadiness([{ ...complete, fileName: 'one.txt', state: 'uploading' }, { ...complete, fileName: 'two.txt', state: 'failed', metadata: { title: '', origin: ' ' } }, { ...complete, sizeBytes: 11 }], context, { maximumBytes: 10 });
  if (result.ok) throw new Error('Expected unready files.');
  expect(result.issues.map((issue) => issue.field)).toEqual(expect.arrayContaining(['0.state', '1.state', '1.metadata.title', '1.metadata.origin', '2.sizeBytes']));
  expect(result.issues.find((issue) => issue.field === '0.state')?.message).toContain('one.txt');
  expect(submissionReadiness(Array.from({ length: 101 }, () => complete), context).ok).toBe(false);
  expect(submissionReadiness(Array.from({ length: 101 }, () => complete), context, { bulkImport: true }).ok).toBe(true);
  expect(attachmentMetadataSchema(context).safeParse({ ...metadata, rightsHolder: 'x'.repeat(201) }).success).toBe(false);
  const prior = { ...context, previousSelections: { rightsStatusId: [ids.retiredRights] } };
  expect(attachmentMetadataSchema(prior).safeParse({ ...metadata, rightsStatusId: ids.retiredRights }).success).toBe(false);
  expect(attachmentMetadataSchema(prior, true).safeParse({ ...metadata, rightsStatusId: ids.retiredRights }).success).toBe(true);
});

describe('outside submissions and licence agreement', () => {
  const schema = outsideSubmissionSchema(context, { contentLicence: 'synthetic-licence-v1' });

  it('requires explicit agreement to the current licence except for Removal Requests', () => {
    for (const type of ['material', 'correction', 'comment']) {
      const input = outsideFixture(type);
      expect(schema.safeParse(input).success).toBe(true);
      expect(schema.safeParse({ ...input, licenceAgreement: undefined }).success).toBe(false);
      expect(schema.safeParse({ ...input, licenceAgreement: { agreed: false, contentLicence: 'synthetic-licence-v1' } }).success).toBe(false);
      expect(schema.safeParse({ ...input, licenceAgreement: { agreed: true, contentLicence: 'old-licence' } }).success).toBe(false);
    }
    expect(schema.safeParse({ ...outsideFixture('removal_request'), licenceAgreement: undefined, files: undefined }).success).toBe(true);
  });

  it('reports independent field, licence and upload errors and rejects forged identities', () => {
    const input = { ...outsideFixture(), name: 123, message: ' ', email: 'two@@example.test', licenceAgreement: undefined, files: [{ fileId: schemaId(500), sizeBytes: 100_000_001 }], ownerId: ids.member };
    const original = structuredClone(input);
    const result = validate(schema, input);
    if (result.ok) throw new Error('Expected a rejected submission.');
    expect(result.issues.map((issue) => issue.field)).toEqual(expect.arrayContaining(['name', 'message', 'email', 'licenceAgreement', 'files.0.sizeBytes', 'ownerId']));
    expect(input).toEqual(original);
    const small = outsideSubmissionSchema(context, { contentLicence: 'synthetic-licence-v1', maximumFileBytes: 10, filesPerSubmission: 2, bytesPerSubmission: 15 });
    expect(small.safeParse({ ...outsideFixture(), files: [{ fileId: schemaId(500), sizeBytes: 10 }, { fileId: schemaId(501), sizeBytes: 5 }] }).success).toBe(true);
    expect(small.safeParse({ ...outsideFixture(), files: [{ fileId: schemaId(500), sizeBytes: 10 }, { fileId: schemaId(501), sizeBytes: 6 }] }).success).toBe(false);
    expect(small.safeParse({ ...outsideFixture(), files: [{ fileId: schemaId(500), sizeBytes: 1 }, { fileId: schemaId(500), sizeBytes: 1 }] }).success).toBe(false);
  });
});
