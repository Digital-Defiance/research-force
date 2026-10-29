export interface RetentionConfiguration {
  readonly sessions: { readonly validHours: number; readonly purgeDaysAfterEnd: number };
  readonly downloadLinks: { readonly validMinutes: number };
  readonly abandonedOutsideUploads: { readonly minHours: number; readonly maxHours: number };
  readonly networkAddresses: { readonly maxHours: number };
  readonly pendingOutsideSubmissions: { readonly until: string };
  readonly finalDecisionFilesAndEmail: { readonly filesWithinHours: number; readonly emailMinDays: number; readonly emailMaxDays: number };
  readonly finalDecisionText: { readonly reason: string };
  readonly acceptedOtherSubmissions: { readonly until: string };
  readonly responseLinks: { readonly validDays: number; readonly tokenPurgeDaysAfterExpiry: number };
  readonly publicExports: { readonly requestedDays: number; readonly scheduledCompleteCount: number };
  readonly internalBackups: { readonly days: number; readonly deleteWithinHours: number };
  readonly timeTravel: { readonly days: number };
  readonly deletedItemFiles: { readonly withinHours: number };
  readonly memberAccountsAndProfiles: { readonly reason: string };
  readonly externalParties: { readonly reason: string };
}
/** Sweepers and the generated Privacy table consume these same entries. Changes require a release. */
export const RETENTION: RetentionConfiguration = Object.freeze({
  sessions: Object.freeze({ validHours: 24, purgeDaysAfterEnd: 7 }),
  downloadLinks: Object.freeze({ validMinutes: 15 }),
  abandonedOutsideUploads: Object.freeze({ minHours: 24, maxHours: 48 }),
  networkAddresses: Object.freeze({ maxHours: 24 }),
  pendingOutsideSubmissions: Object.freeze({ until: 'a final moderation decision' }),
  finalDecisionFilesAndEmail: Object.freeze({ filesWithinHours: 24, emailMinDays: 90, emailMaxDays: 91 }),
  finalDecisionText: Object.freeze({ reason: 'kept as the record of the decision' }),
  acceptedOtherSubmissions: Object.freeze({ until: 'neither the Outside Submission nor a credited Item exists' }),
  responseLinks: Object.freeze({ validDays: 30, tokenPurgeDaysAfterExpiry: 30 }),
  publicExports: Object.freeze({ requestedDays: 7, scheduledCompleteCount: 3 }),
  internalBackups: Object.freeze({ days: 7, deleteWithinHours: 1 }), timeTravel: Object.freeze({ days: 7 }),
  deletedItemFiles: Object.freeze({ withinHours: 24 }),
  memberAccountsAndProfiles: Object.freeze({ reason: 'Revoked Members remain for attribution' }),
  externalParties: Object.freeze({ reason: 'while records name them' }),
});
export type RetentionKind = keyof RetentionConfiguration;
export type RetentionRule =
  | { readonly kind: 'period'; readonly amount: number; readonly unit: 'minutes' | 'hours' | 'days'; readonly action: string; readonly after: string }
  | { readonly kind: 'window'; readonly minimum: number; readonly maximum: number; readonly unit: 'hours' | 'days'; readonly action: string; readonly after: string }
  | { readonly kind: 'until'; readonly event: string }
  | { readonly kind: 'unlimited'; readonly reason: string }
  | { readonly kind: 'count'; readonly count: number }
  | { readonly kind: 'combined'; readonly rules: readonly RetentionRule[] };
export interface RetentionRow { readonly kind: RetentionKind; readonly data: string; readonly rule: RetentionRule; readonly statement: string; }

export function describeRetention(rule: RetentionRule): string {
  const unit = (amount: number, plural: string): string => amount === 1 ? plural.slice(0, -1) : plural;
  switch (rule.kind) {
    case 'period': return `${rule.action} ${rule.amount} ${unit(rule.amount, rule.unit)} after ${rule.after}.`;
    case 'window': return `${rule.action} ${rule.minimum} to ${rule.maximum} ${unit(rule.maximum, rule.unit)} after ${rule.after}.`;
    case 'until': return `Keep until ${rule.event}.`;
    case 'unlimited': return `No time limit; ${rule.reason}.`;
    case 'count': return `Keep the ${rule.count} most recent complete scheduled ${rule.count === 1 ? 'export' : 'exports'}.`;
    case 'combined': return rule.rules.map(describeRetention).join(' ');
  }
}

export function retentionRows(config: RetentionConfiguration = RETENTION): RetentionRow[] {
  for (const entry of Object.values(config)) for (const value of Object.values(entry)) {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 1)) throw new RangeError('Retention periods and counts must be positive safe integers.');
    if (typeof value === 'string' && value.trim() === '') throw new RangeError('Retention events and reasons cannot be blank.');
  }
  if (config.abandonedOutsideUploads.minHours > config.abandonedOutsideUploads.maxHours || config.finalDecisionFilesAndEmail.emailMinDays > config.finalDecisionFilesAndEmail.emailMaxDays) throw new RangeError('A retention window cannot end before it starts.');
  const period = (amount: number, unit: 'minutes' | 'hours' | 'days', action: string, after: string): RetentionRule => ({ kind: 'period', amount, unit, action, after });
  const combined = (...rules: RetentionRule[]): RetentionRule => ({ kind: 'combined', rules });
  const row = (kind: RetentionKind, data: string, rule: RetentionRule): RetentionRow => ({ kind, data, rule, statement: describeRetention(rule) });
  return [
    row('sessions', 'Sessions', combined(period(config.sessions.validHours, 'hours', 'Expires', 'establishment, or earlier on logout'), period(config.sessions.purgeDaysAfterEnd, 'days', 'Delete the record', 'the session ends'))),
    row('downloadLinks', 'Download Links', period(config.downloadLinks.validMinutes, 'minutes', 'Not stored; valid for', 'issue')),
    row('abandonedOutsideUploads', 'Files uploaded outside a complete Outside Submission', { kind: 'window', minimum: config.abandonedOutsideUploads.minHours, maximum: config.abandonedOutsideUploads.maxHours, unit: 'hours', action: 'Delete', after: 'the upload starts' }),
    row('networkAddresses', 'Network addresses used for Outside Submission limits', period(config.networkAddresses.maxHours, 'hours', 'Delete within', 'recording')),
    row('pendingOutsideSubmissions', 'Outside Submissions without a final decision: text, files, name, email and affiliation', { kind: 'until', event: config.pendingOutsideSubmissions.until }),
    row('finalDecisionFilesAndEmail', 'Rejected Outside Submissions and accepted Removal Requests: files and email', combined(period(config.finalDecisionFilesAndEmail.filesWithinHours, 'hours', 'Delete files within', 'the decision'), { kind: 'window', minimum: config.finalDecisionFilesAndEmail.emailMinDays, maximum: config.finalDecisionFilesAndEmail.emailMaxDays, unit: 'days', action: 'Erase the email address', after: 'the decision' })),
    row('finalDecisionText', 'Rejected Outside Submissions and accepted Removal Requests: text, name and affiliation', { kind: 'unlimited', reason: config.finalDecisionText.reason }),
    row('acceptedOtherSubmissions', 'Other accepted Outside Submissions: text, name, email and affiliation', { kind: 'until', event: config.acceptedOtherSubmissions.until }),
    row('responseLinks', 'Response Links', combined(period(config.responseLinks.validDays, 'days', 'Valid for', 'sending'), period(config.responseLinks.tokenPurgeDaysAfterExpiry, 'days', 'Delete token hashes', 'expiry'))),
    row('publicExports', 'Public Archive Exports', combined(period(config.publicExports.requestedDays, 'days', 'Keep requested exports for', 'the requested export starts'), { kind: 'count', count: config.publicExports.scheduledCompleteCount })),
    row('internalBackups', 'Internal Backups', combined(period(config.internalBackups.days, 'days', 'Keep for', 'the backup is produced or marked incomplete'), period(config.internalBackups.deleteWithinHours, 'hours', 'Delete within', 'that retention period ends'))),
    row('timeTravel', 'D1 Time Travel', period(config.timeTravel.days, 'days', 'Keep recovery history for', 'each change')),
    row('deletedItemFiles', 'Files of permanently deleted Items', period(config.deletedItemFiles.withinHours, 'hours', 'Delete within', 'permanent deletion')),
    row('memberAccountsAndProfiles', 'Member accounts and Profiles', { kind: 'unlimited', reason: config.memberAccountsAndProfiles.reason }),
    row('externalParties', 'External Parties named in records', { kind: 'unlimited', reason: config.externalParties.reason }),
  ];
}
