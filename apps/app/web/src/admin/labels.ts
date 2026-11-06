import type { ValueSetKind } from '@researchforce/domain/value-sets';
import type { SettingKey } from '@researchforce/domain/settings';

/** The six Policy_Pages in footer order, with the page key and its display title (R46.2, R46.27). */
export const POLICY_PAGE_LABELS: readonly { readonly key: string; readonly title: string }[] = [
  { key: 'about', title: 'About' },
  { key: 'people', title: 'People' },
  { key: 'methods', title: 'Methods' },
  { key: 'licence', title: 'Licence' },
  { key: 'privacy', title: 'Privacy' },
  { key: 'corrections', title: 'Corrections' },
];

/** A readable name for each configurable value set (R46.11, R46.13). */
export const VALUE_SET_NAMES: Readonly<Record<ValueSetKind, string>> = {
  specialty: 'Specialties',
  campaign_status: 'Project statuses',
  finding_status: 'Finding statuses',
  run_outcome: 'Run outcomes',
  hypothesis_status: 'Hypothesis statuses',
  archival_request_status: 'Archival request statuses',
  reliability: 'Reliability ratings',
  rights_status: 'Rights statuses',
  relation: 'Relation labels',
};

/** A readable name for each Methods_Term group heading on the Methods page (R46.11). */
export const METHODS_GROUP_NAMES: Readonly<Record<string, string>> = {
  source_kind: 'Source kinds',
  disclosure_level: 'Disclosure levels',
  label_kind: 'Label kinds',
  term: 'Other terms',
};

/** A readable name for each workspace-wide setting (R46.37, R2.5). */
export const SETTING_NAMES: Readonly<Record<SettingKey, string>> = {
  followUpInterval: 'Follow-up interval',
  emailBatchWindow: 'Email batch window',
  directUploadThreshold: 'Direct upload threshold',
  attachmentSizeLimit: 'Attachment size limit',
  publicUploadSizeLimit: 'Public upload size limit',
  outsideSubmissionLimits: 'Outside submission limits',
  publicTrafficBudget: 'Public traffic budget',
  emailProvider: 'Email provider',
  recipientCap: 'Recipient cap',
  aiDrafting: 'AI drafting',
  aiInputLimit: 'AI input limit',
  responsiblePerson: 'Responsible person',
};
