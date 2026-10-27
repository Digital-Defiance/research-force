import { z } from 'zod';
import { SETTINGS } from '../settings';
import { isBlank } from '../text';
import { OUTSIDE_SUBMISSION_TYPES } from '../types';
import { distinctIds, idSchema, knownId, partialDateSchema, richTextSchema, textField, validate, withChecks } from './common';
import type { ValidationContext } from './common';
import type { RuleResult } from '../rules';
import { emailSchema } from './people';
import { rightsFields } from './items';

export const replySchema = richTextSchema(50_000, true);
export const groupNoteSchema = richTextSchema(50_000).optional();
export const dissentNoteSchema = richTextSchema(2000, true);
export const reasonSchema = textField(1000, true);
export const removalRequestStatementSchema = textField(5000, true);
export const editMarkSchema = withChecks(z.strictObject({ mark: z.enum(['minor_edit', 'correction']), reason: textField(1000).optional() }), (raw, report) => {
  if (raw['mark'] === 'correction' && (raw['reason'] === undefined || (typeof raw['reason'] === 'string' && isBlank(raw['reason'])))) report(['reason'], 'A Correction needs a non-blank reason of 1 to 1000 Unicode code points.');
});

export function reviewRequestSchema(context: ValidationContext) {
  return withChecks(z.strictObject({
    targetId: idSchema,
    memberIds: distinctIds(knownId(context.members.filter((member) => member.status === 'active').map((member) => member.id), 'active Member')),
    specialtyIds: distinctIds(knownId((context.valueSets.specialty ?? []).filter((value) => !value.retired).map((value) => value.id), 'active Specialty')),
    roleIds: distinctIds(knownId(context.roleIds, 'Role')), note: textField(2000).optional(),
  }), (raw, report) => {
    const lists = [raw['memberIds'], raw['specialtyIds'], raw['roleIds']];
    if (lists.every((list) => Array.isArray(list) && list.length === 0)) report(['memberIds'], 'Choose at least one Member, Specialty or Role as an addressee.');
  });
}
export function disclosureLineSchema(context: ValidationContext) {
  return z.strictObject({ kindOfMaterial: textField(100, true), date: partialDateSchema, partyIds: z.array(knownId([...context.members.map((member) => member.id), ...context.externalPartyIds], 'Party')).max(20), note: textField(200).optional() });
}

export function attachmentMetadataSchema(context: ValidationContext, existing = false) {
  return z.strictObject({ title: textField(255, true), caption: textField(2000).optional(), origin: textField(5000, true), ...rightsFields(context, existing) });
}
export function submissionReadinessSchema(context: ValidationContext, options: { readonly maximumBytes?: number; readonly bulkImport?: boolean } = {}) {
  const sizeLimit = options.maximumBytes ?? SETTINGS.attachmentSizeLimit.default;
  if (!Number.isSafeInteger(sizeLimit) || sizeLimit < 0) throw new RangeError('The file size limit must be a non-negative safe integer.');
  let files = z.array(withChecks(z.strictObject({
    fileName: z.string(), sizeBytes: z.number().int().min(0).max(sizeLimit), state: z.enum(['uploading', 'failed', 'complete']), metadata: attachmentMetadataSchema(context),
  }), (raw, report) => {
    if (raw['state'] === 'uploading') report(['state'], 'This file is still uploading.');
    if (raw['state'] === 'failed') report(['state'], 'This file failed to upload.');
  }));
  if (!options.bulkImport) files = files.max(100, 'A Submission can contain at most 100 files.');
  return files;
}
export function submissionReadiness(files: unknown, context: ValidationContext, options: { readonly maximumBytes?: number; readonly bulkImport?: boolean } = {}): RuleResult<z.output<ReturnType<typeof submissionReadinessSchema>>> {
  const result = validate(submissionReadinessSchema(context, options), files);
  if (result.ok) return result;
  const list = Array.isArray(files) ? files : [];
  return { ok: false, issues: result.issues.map((issue) => {
    const index = Number(issue.field.split('.')[0]);
    const file = list[index];
    const name = typeof file === 'object' && file !== null && 'fileName' in file && typeof file.fileName === 'string' ? file.fileName : undefined;
    return { ...issue, message: name === undefined ? issue.message : `${name}: ${issue.message}` };
  }) };
}

export function outsideSubmissionSchema(context: ValidationContext, options: { readonly contentLicence: string; readonly maximumFileBytes?: number; readonly filesPerSubmission?: number; readonly bytesPerSubmission?: number }) {
  if (isBlank(options.contentLicence)) throw new RangeError('The current Content Licence must be configured.');
  const perFile = options.maximumFileBytes ?? SETTINGS.publicUploadSizeLimit.default;
  const count = options.filesPerSubmission ?? SETTINGS.outsideSubmissionLimits.default.filesPerSubmission;
  const totalLimit = options.bytesPerSubmission ?? SETTINGS.outsideSubmissionLimits.default.bytesPerSubmission;
  for (const limit of [perFile, count, totalLimit]) if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('Outside upload limits must be non-negative safe integers.');
  const destination = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('general') }), z.strictObject({ kind: z.literal('project'), projectId: knownId(context.projects.map((project) => project.id), 'Project') })]);
  return withChecks(z.strictObject({
    type: z.enum(OUTSIDE_SUBMISSION_TYPES), destination, message: textField(10_000, true), name: textField(200, true), email: emailSchema,
    affiliation: textField(200).optional(), pageReference: textField(2000).optional(), licenceAgreement: z.strictObject({ agreed: z.boolean(), contentLicence: z.string() }).optional(),
    files: z.array(z.strictObject({ fileId: idSchema, sizeBytes: z.number().int().min(0).max(perFile) })).max(count).prefault([]),
  }), (raw, report) => {
    if (raw['type'] !== 'removal_request' && (OUTSIDE_SUBMISSION_TYPES as readonly unknown[]).includes(raw['type'])) {
      const agreement = raw['licenceAgreement'];
      if (agreement === undefined) report(['licenceAgreement'], 'Agree to the current Content Licence before submitting material, a correction or a comment.');
      else if (typeof agreement === 'object' && agreement !== null) {
        if ('agreed' in agreement && agreement.agreed === false) report(['licenceAgreement', 'agreed'], 'Agreement must be explicitly given.');
        if ('contentLicence' in agreement && typeof agreement.contentLicence === 'string' && agreement.contentLicence !== options.contentLicence) report(['licenceAgreement', 'contentLicence'], 'Agree to the current Content Licence.');
      }
    }
    if (Array.isArray(raw['files'])) {
      let total = 0;
      const seen = new Set<string>();
      for (const [index, file] of raw['files'].entries()) if (typeof file === 'object' && file !== null) {
        if ('sizeBytes' in file && typeof file.sizeBytes === 'number' && Number.isSafeInteger(file.sizeBytes) && file.sizeBytes >= 0) {
          if (file.sizeBytes > totalLimit - total) report(['files', index, 'sizeBytes'], 'These files exceed the per-Submission total size limit.');
          total += file.sizeBytes;
        }
        if ('fileId' in file && typeof file.fileId === 'string') {
          if (seen.has(file.fileId)) report(['files', index, 'fileId'], 'Choose each uploaded file at most once.');
          seen.add(file.fileId);
        }
      }
    }
  });
}
export type OutsideSubmissionInput = z.output<ReturnType<typeof outsideSubmissionSchema>>;
