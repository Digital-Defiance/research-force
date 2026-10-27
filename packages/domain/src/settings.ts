import { accepted, refused } from './rules';
import type { RuleIssue, RuleResult } from './rules';
import { isULID } from './types';
import type { MemberStatus, ULID } from './types';

export interface SettingMember { readonly id: ULID; readonly status: MemberStatus; }
export interface SettingContext { readonly members?: readonly SettingMember[]; }
export interface SettingDefinition<T> {
  readonly default: T;
  readonly allowed: string;
  validate(value: unknown, context?: SettingContext): RuleResult<T>;
}

function integer(defaultValue: number, min: number, max: number, unit: string): SettingDefinition<number> {
  const allowed = `A whole number from ${min} to ${max} ${unit}`;
  return Object.freeze({ default: defaultValue, allowed, validate: (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
    ? accepted(value) : refused('setting_range', 'value', `${allowed}.`) });
}
const positiveBytes = (initial: number): SettingDefinition<number> => integer(initial, 1, Number.MAX_SAFE_INTEGER, 'bytes');
export interface OutsideSubmissionLimits {
  readonly filesPerSubmission: number;
  readonly bytesPerSubmission: number;
  readonly submissionsPerAddressPerHour: number;
  readonly submissionsPerEmailPerDay: number;
  readonly submissionsPerDay: number;
  readonly uploadedBytesPerDay: number;
}
const outsideDefaults: OutsideSubmissionLimits = Object.freeze({ filesPerSubmission: 10, bytesPerSubmission: 500_000_000, submissionsPerAddressPerHour: 5, submissionsPerEmailPerDay: 3, submissionsPerDay: 20, uploadedBytesPerDay: 1_000_000_000 });
const outsideLimits: SettingDefinition<OutsideSubmissionLimits> = Object.freeze({
  default: outsideDefaults,
  allowed: 'Every limit is a non-negative safe integer; byte limits are in bytes',
  validate(value: unknown): RuleResult<OutsideSubmissionLimits> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return refused('outside_limits', 'value', 'Provide every Outside Submission limit.');
    const fields = value as Record<string, unknown>;
    const issues: RuleIssue[] = [];
    for (const key of Object.keys(outsideDefaults)) {
      if (!Object.hasOwn(fields, key) || typeof fields[key] !== 'number' || !Number.isSafeInteger(fields[key]) || (fields[key] as number) < 0) issues.push({ code: 'outside_limit', field: key, message: 'Use a non-negative safe integer.' });
    }
    for (const key of Object.keys(fields)) if (!Object.hasOwn(outsideDefaults, key)) issues.push({ code: 'unknown_limit', field: key, message: 'This is not a supported Outside Submission limit.' });
    return issues.length ? { ok: false, issues } : accepted({ ...fields } as unknown as OutsideSubmissionLimits);
  },
});

export const SETTINGS = Object.freeze({
  followUpInterval: integer(30, 1, 365, 'days'),
  emailBatchWindow: integer(5, 1, 60, 'minutes'),
  // All uploads go directly to R2 in this design; zero represents that policy.
  directUploadThreshold: integer(0, 0, 100_000_000, 'bytes'),
  attachmentSizeLimit: positiveBytes(1_000_000_000),
  publicUploadSizeLimit: positiveBytes(100_000_000),
  outsideSubmissionLimits: outsideLimits,
  publicTrafficBudget: integer(25, 0, 50, 'percent'),
  emailProvider: Object.freeze({ default: 'microsoft_graph' as const, allowed: 'The registered Microsoft Graph provider', validate: (value: unknown): RuleResult<'microsoft_graph'> => value === 'microsoft_graph' ? accepted(value) : refused('email_provider', 'value', 'Select the registered Microsoft Graph provider; credentials are separate secrets.') }),
  recipientCap: integer(2000, 1, 10_000, 'recipients per rolling 24 hours'),
  aiDrafting: Object.freeze({ default: true as boolean, allowed: 'On or Off', validate: (value: unknown): RuleResult<boolean> => typeof value === 'boolean' ? accepted(value) : refused('ai_drafting', 'value', 'Choose On or Off.') }),
  aiInputLimit: integer(10_000, 1000, 50_000, 'Unicode code points'),
  responsiblePerson: Object.freeze({
    // The bootstrap seed replaces this placeholder with the campaign owner's real id.
    default: null as ULID | null,
    allowed: 'The id of one active Member',
    validate(value: unknown, context?: SettingContext): RuleResult<ULID | null> {
      if (typeof value !== 'string' || !isULID(value)) return refused('responsible_person', 'value', 'Select an active Member as the Responsible Person.');
      if (!context?.members?.some((member) => member.id === value && member.status === 'active')) return refused('responsible_person_active', 'value', 'The Responsible Person must be an active Member.');
      return accepted(value);
    },
  }),
});
export type SettingKey = keyof typeof SETTINGS;
export type WorkspaceSettings = { readonly [K in SettingKey]: typeof SETTINGS[K]['default'] };

export function validateSetting<K extends SettingKey>(key: K, value: unknown, context?: SettingContext): RuleResult<WorkspaceSettings[K]> {
  if (!Object.hasOwn(SETTINGS, key)) return refused('unknown_setting', String(key), 'Choose a supported workspace setting.');
  const result = SETTINGS[key].validate(value, context);
  if (!result.ok) return { ok: false, issues: result.issues.map((issue) => ({ ...issue, field: issue.field === 'value' ? key : `${key}.${issue.field}` })) };
  return result as RuleResult<WorkspaceSettings[K]>;
}

/** Provisioning cannot leave the Privacy page without a designated person. */
export function defaultSettings(owner: SettingMember): WorkspaceSettings {
  const result = validateSetting('responsiblePerson', owner.id, { members: [owner] });
  if (!result.ok) throw new RangeError(result.issues.map((issue) => issue.message).join(' '));
  return Object.freeze({ ...Object.fromEntries(Object.entries(SETTINGS).map(([key, definition]) => [key, definition.default])), responsiblePerson: owner.id }) as WorkspaceSettings;
}

/** Design budgets, not a replacement for the deployment-time free-plan checks in Task 48. */
export const OPERATIONS = Object.freeze({
  maxD1Statements: 40, maxExternalSubrequests: 40, stagedSaveThresholdBytes: 512_000,
  jobSliceRows: 500, renderPagesPerSlice: 20, projectionSliceBytes: 500_000,
  bulkImportRowsPerUTCDay: 30_000, exportObjectsPerVolume: 900,
  singlePutMaxBytes: 64 * 1024 * 1024, multipartPartBytes: 16 * 1024 * 1024,
  publicBudgetMarginFraction: 0.02, aiNeuronMargin: 300, aiNeuronsPerUTCDay: 10_000,
  workerRequestsPerUTCDay: 100_000, d1RowsReadPerUTCDay: 5_000_000, d1RowsWrittenPerUTCDay: 100_000,
});
