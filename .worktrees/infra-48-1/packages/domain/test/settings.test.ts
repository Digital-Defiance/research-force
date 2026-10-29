import { describe, expect, it } from 'vitest';
import { defaultSettings, OPERATIONS, SETTINGS, validateSetting } from '../src/settings';
import type { SettingKey } from '../src/settings';
import { asULID } from '../src/types';

const owner = { id: asULID('00000000000000000000000010'), status: 'active' as const };
describe('settings registry', () => {
  it('keeps defaults valid and initializes the Responsible Person with a real active Member', () => {
    const defaults = defaultSettings(owner);
    for (const key of Object.keys(defaults) as SettingKey[]) expect(validateSetting(key, defaults[key], { members: [owner] }).ok).toBe(true);
    expect(defaults.aiDrafting).toBe(true);
    expect(defaults.responsiblePerson).toBe(owner.id);
    expect(defaults.recipientCap).toBe(2000);
    expect(defaults.publicTrafficBudget).toBe(25);
    expect(defaults.directUploadThreshold).toBe(0);
    expect(() => defaultSettings({ ...owner, status: 'revoked' })).toThrow(RangeError);
    expect(validateSetting('responsiblePerson', null).ok).toBe(false);
    expect(validateSetting('responsiblePerson', owner.id).ok).toBe(false);
  });

  it.each([
    ['followUpInterval', 1, 365], ['emailBatchWindow', 1, 60], ['publicTrafficBudget', 0, 50],
    ['recipientCap', 1, 10_000], ['aiInputLimit', 1000, 50_000], ['directUploadThreshold', 0, 100_000_000],
  ] as const)('validates inclusive numeric bounds for %s without coercing values', (key, minimum, maximum) => {
    expect(validateSetting(key, minimum).ok).toBe(true);
    expect(validateSetting(key, maximum).ok).toBe(true);
    for (const value of [minimum - 1, maximum + 1, minimum + 0.5, NaN, Infinity, String(minimum), true, null]) {
      const result = validateSetting(key, value);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues[0]?.field).toBe(key);
    }
  });

  it('validates every outside limit and reports each broken or unknown field', () => {
    const limits = SETTINGS.outsideSubmissionLimits.default;
    const result = validateSetting('outsideSubmissionLimits', { ...limits, filesPerSubmission: -1, bytesPerSubmission: 0.1, surprise: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((issue) => issue.field)).toEqual(['outsideSubmissionLimits.filesPerSubmission', 'outsideSubmissionLimits.bytesPerSubmission', 'outsideSubmissionLimits.surprise']);
    expect(validateSetting('outsideSubmissionLimits', Object.create(limits)).ok).toBe(false);
    expect(validateSetting('outsideSubmissionLimits', { ...limits, filesPerSubmission: 0 }).ok).toBe(true);
    expect(validateSetting('attachmentSizeLimit', Number.MAX_SAFE_INTEGER + 1).ok).toBe(false);
    expect(validateSetting('publicUploadSizeLimit', 0).ok).toBe(false);
    expect(validateSetting('aiDrafting', false)).toEqual({ ok: true, value: false });
    expect(validateSetting('aiDrafting', 'Off').ok).toBe(false);
    expect(validateSetting('emailProvider', { token: 'synthetic' }).ok).toBe(false);
    expect(validateSetting('__proto__' as SettingKey, 1).ok).toBe(false);
  });

  it('centralizes operational slice and safety budgets', () => {
    expect(OPERATIONS.bulkImportRowsPerUTCDay).toBe(30_000);
    expect(OPERATIONS.maxD1Statements).toBeLessThan(50);
    expect(OPERATIONS.publicBudgetMarginFraction).toBe(0.02);
    expect(OPERATIONS.aiNeuronMargin).toBe(300);
    expect(OPERATIONS.singlePutMaxBytes).toBe(64 * 1024 * 1024);
  });
});
