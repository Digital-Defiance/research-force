import { z } from 'zod';

export const RESOURCE_PROFILE_VERSION = 'resource-v1' as const;
export const OPERATING_PROFILES = ['Free_Qualified', 'Paid_Standard'] as const;
export type OperatingProfile = typeof OPERATING_PROFILES[number];
export const operatingProfileSchema = z.enum(OPERATING_PROFILES);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const cpu = z.strictObject({ interactiveMs: positive, durableObjectSliceMs: positive });

export const resourceProfileSchema = z.strictObject({
  version: z.literal(RESOURCE_PROFILE_VERSION), operatingProfile: operatingProfileSchema,
  provider: z.strictObject({
    checkedOn: z.iso.date(), sources: z.array(z.url()).min(3),
    cpu: z.strictObject({ httpCeilingMs: positive, durableObjectDefaultMs: positive }),
    isolateBytes: positive,
    d1: z.strictObject({ callsPerHttpInvocation: positive, rowBytes: positive, parametersPerStatement: positive, sqlBytesPerStatement: positive, databaseBytes: positive }),
    externalSubrequests: positive,
    // null means no provider daily cap asserted here; paid operator quotas are still mandatory.
    daily: z.strictObject({ requests: positive.nullable(), rowsRead: positive.nullable(), rowsWritten: positive.nullable() }),
  }),
  chosen: z.strictObject({
    cpu, requiredHttpCeilingMs: positive, requiredDurableObjectCeilingMs: positive, isolateBytes: positive,
    d1CallsPerInvocation: positive, statementsPerSave: positive, parametersPerStatement: positive, externalSubrequests: positive,
    bytes: z.strictObject({ request: positive, fragment: positive, physicalRow: positive, revision: positive }),
    logical: z.strictObject({ journalCodePoints: positive, journalSections: positive, spansPerField: positive, sourceCodePoints: positive, spanOffsets: z.literal('UTF-16') }),
    preview: z.strictObject({ textBytes: positive, csvScanBytes: positive, csvRecordBytes: positive, csvBufferBytes: positive, csvRows: positive, pdfCacheBytes: positive, rasterDecodedBytes: positive, totalWorkingBytes: positive }),
    freeze: z.strictObject({ leaseSeconds: positive, heartbeatSeconds: positive, maximumSeconds: positive }),
    reserve: z.strictObject({ memberPercent: positive.max(100), publicPercent: z.number().int().min(0).max(50), urgentPercent: positive.max(100) }),
  }),
  referenceArchiveVersion: z.literal('reference-archive-v1'), growthVersion: z.literal('growth-v1'), abuseVersion: z.literal('abuse-v1'),
}).superRefine((p, ctx) => {
  const check = (condition: boolean, path: string, message: string): void => { if (!condition) ctx.addIssue({ code: 'custom', path: path.split('.'), message }); };
  const c = p.chosen;
  check(c.cpu.interactiveMs < c.requiredHttpCeilingMs && c.requiredHttpCeilingMs <= p.provider.cpu.httpCeilingMs, 'chosen.cpu', 'Interactive target must be below the configured provider ceiling.');
  check(c.cpu.durableObjectSliceMs < c.requiredDurableObjectCeilingMs && c.requiredDurableObjectCeilingMs <= p.provider.cpu.durableObjectDefaultMs, 'chosen.cpu', 'DO slices must fit their own CPU budget.');
  check(c.isolateBytes < p.provider.isolateBytes, 'chosen.isolateBytes', 'Keep an isolate memory margin, including concurrent requests.');
  check(c.d1CallsPerInvocation < p.provider.d1.callsPerHttpInvocation, 'chosen.d1CallsPerInvocation', 'Keep a D1 invocation-call margin.');
  check(c.parametersPerStatement <= p.provider.d1.parametersPerStatement, 'chosen.parametersPerStatement', 'Bound each statement separately, including batches.');
  check(c.externalSubrequests < p.provider.externalSubrequests, 'chosen.externalSubrequests', 'Keep a subrequest margin.');
  check(c.bytes.fragment < c.bytes.request && c.bytes.fragment < c.bytes.physicalRow && c.bytes.physicalRow < p.provider.d1.rowBytes && c.bytes.revision <= c.bytes.physicalRow, 'chosen.bytes', 'Fragments, envelopes and revisions must fit below the physical provider row ceiling.');
  const v = c.preview;
  check(v.csvRecordBytes <= v.csvBufferBytes && v.csvBufferBytes < v.csvScanBytes && v.pdfCacheBytes + v.rasterDecodedBytes <= v.totalWorkingBytes && v.totalWorkingBytes < c.isolateBytes, 'chosen.preview', 'Preview allocations must fit their scan, parser and working-memory budgets.');
  check(c.freeze.heartbeatSeconds < c.freeze.leaseSeconds && c.freeze.leaseSeconds <= c.freeze.maximumSeconds, 'chosen.freeze', 'Heartbeat, lease and maximum freeze must be ordered.');
  check(c.reserve.memberPercent + c.reserve.publicPercent + c.reserve.urgentPercent <= 100, 'chosen.reserve', 'Capacity reservations cannot exceed 100%.');
  check(p.operatingProfile !== 'Free_Qualified' || c.requiredHttpCeilingMs <= 10, 'chosen.requiredHttpCeilingMs', 'Free HTTP CPU cannot use a paid ceiling.');
  check(p.operatingProfile !== 'Paid_Standard' || c.requiredHttpCeilingMs >= 100, 'chosen.requiredHttpCeilingMs', 'Paid interactive CPU needs at least a configured 100 ms ceiling.');
});
export type ResourceProfile = z.infer<typeof resourceProfileSchema>;

const MiB = 1024 * 1024;
function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function makeProfile(operatingProfile: OperatingProfile): ResourceProfile {
  const paid = operatingProfile === 'Paid_Standard';
  return freeze(resourceProfileSchema.parse({
    version: RESOURCE_PROFILE_VERSION, operatingProfile,
    provider: {
      checkedOn: '2026-10-28', sources: [
        'https://developers.cloudflare.com/workers/platform/limits/',
        'https://developers.cloudflare.com/d1/platform/limits/',
        'https://developers.cloudflare.com/durable-objects/platform/limits/',
      ],
      cpu: { httpCeilingMs: paid ? 300_000 : 10, durableObjectDefaultMs: 30_000 }, isolateBytes: 128 * MiB,
      d1: { callsPerHttpInvocation: paid ? 1000 : 50, rowBytes: 2_000_000, parametersPerStatement: 100, sqlBytesPerStatement: 100_000, databaseBytes: paid ? 10_000_000_000 : 500_000_000 },
      externalSubrequests: paid ? 10_000 : 50,
      daily: paid ? { requests: null, rowsRead: null, rowsWritten: null } : { requests: 100_000, rowsRead: 5_000_000, rowsWritten: 100_000 },
    },
    chosen: {
      cpu: { interactiveMs: paid ? 50 : 8, durableObjectSliceMs: 2000 }, requiredHttpCeilingMs: paid ? 100 : 10, requiredDurableObjectCeilingMs: 30_000,
      isolateBytes: 96 * MiB, d1CallsPerInvocation: 40, statementsPerSave: 40, parametersPerStatement: 100, externalSubrequests: 40,
      bytes: { request: 512_000, fragment: 128_000, physicalRow: 512_000, revision: 512_000 },
      logical: { journalCodePoints: 2_000_000, journalSections: 5000, spansPerField: 50_000, sourceCodePoints: 300, spanOffsets: 'UTF-16' },
      preview: { textBytes: 1_000_000, csvScanBytes: 32 * MiB, csvRecordBytes: 256 * 1024, csvBufferBytes: 2 * MiB, csvRows: 1000, pdfCacheBytes: 16 * MiB, rasterDecodedBytes: 32 * MiB, totalWorkingBytes: 48 * MiB },
      freeze: { leaseSeconds: 30, heartbeatSeconds: 10, maximumSeconds: 120 },
      reserve: { memberPercent: 50, publicPercent: 25, urgentPercent: 25 },
    },
    referenceArchiveVersion: 'reference-archive-v1', growthVersion: 'growth-v1', abuseVersion: 'abuse-v1',
  }));
}
export const RESOURCE_PROFILES = freeze({ Free_Qualified: makeProfile('Free_Qualified'), Paid_Standard: makeProfile('Paid_Standard') });
export const DEFAULT_RESOURCE_PROFILE = RESOURCE_PROFILES.Free_Qualified;
/** The fallback supports existing development installs; production setup must select explicitly. No plan is activated. */
export function resourceProfile(name: unknown = 'Free_Qualified'): ResourceProfile { return RESOURCE_PROFILES[operatingProfileSchema.parse(name)]; }

export const ABUSE_PROFILE = freeze({ version: 'abuse-v1', durationSeconds: 1800, requestsPerSecond: 100, sourceIdentities: 1000, concurrentMembers: 10, minimumAuthorizedSuccess: 0.999,
  traffic: ['invalid /t tokens', 'invalid /x tokens', 'rejected submit requests', 'rejected consent requests'], concurrent: ['member saves', 'authorized downloads', 'urgent removal'], countRejectedInvocations: true });
export const REFERENCE_ARCHIVE = freeze({ version: 'reference-archive-v1', members: 10, newItemsPerDay: 100, memberPageViewsPerDay: 5000, emailsPerDay: 100, aiDraftsPerDay: 50,
  publicPageViewsPerDay: 100_000, publicSearchesPerDay: 10_000, publicDownloadsPerDay: 2000, outsideSubmissionsPerDay: 20,
  boundaryCases: ['single-600k-ascii', 'single-600k-emoji', 'two-million-code-points', 'escaped-text', '50000-spans', 'cross-fragment-spans', '100-file-submission'],
  rpoHours: 24, rtoHours: 8, curatorCorpusMeasured: false });
export const GROWTH_PROFILE = freeze({ version: 'growth-v1', years: [1, 3, 5], dailyRetention: 14, weeklyRetention: 8, monthlyRetention: 12, transientDays: 7,
  categories: ['originals', 'derivatives', 'metadata', 'history', 'publicCopies', 'releases', 'exports', 'backups', 'transientCopies'] });

export type PayloadBudget = keyof ResourceProfile['chosen']['bytes'];
export class ResourceLimitError extends RangeError {
  constructor(readonly budget: PayloadBudget, readonly limitBytes: number) { super(`Encoded ${budget} exceeds ${limitBytes} bytes.`); }
}
/** Exact UTF-8 byte count, capped at limit+1; no encoding buffer is allocated. */
export function utf8Bytes(text: string, limit = Number.MAX_SAFE_INTEGER): number {
  let bytes = 0;
  for (let i = 0; i < text.length && bytes <= limit; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
  }
  return Math.min(bytes, limit + 1);
}
/** Counts plain JSON without building its encoded copy. Stops at limit+1; bounded depth and cycles are refused. */
export function encodedJsonBytes(value: unknown, limit = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit >= Number.MAX_SAFE_INTEGER) {
    if (limit !== Number.MAX_SAFE_INTEGER) throw new RangeError('Use a non-negative safe byte limit.');
  }
  let bytes = 0;
  const ancestors = new Set<object>();
  const add = (n: number): void => { bytes = Math.min(bytes + n, limit + 1); };
  const string = (s: string): void => {
    add(2);
    for (let i = 0; i < s.length && bytes <= limit; i++) {
      const c = s.charCodeAt(i);
      if (c === 34 || c === 92 || (c === 8 || c === 9 || c === 10 || c === 12 || c === 13)) add(2);
      else if (c < 32) add(6);
      else if (c >= 0xd800 && c <= 0xdbff && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff) { add(4); i++; }
      else if (c >= 0xd800 && c <= 0xdfff) add(6);
      else add(c < 0x80 ? 1 : c < 0x800 ? 2 : 3);
    }
  };
  const visit = (v: unknown, depth: number): void => {
    if (bytes > limit) return;
    if (depth > 64) throw new RangeError('JSON exceeds 64 levels.');
    if (v === null) { add(4); return; }
    if (typeof v === 'string') { string(v); return; }
    if (typeof v === 'boolean') { add(v ? 4 : 5); return; }
    if (typeof v === 'number' && Number.isFinite(v)) { add(String(v).length); return; }
    if (typeof v !== 'object' || v === null || (!Array.isArray(v) && ![Object.prototype, null].includes(Object.getPrototypeOf(v)))) throw new TypeError('Use plain JSON data.');
    if (ancestors.has(v)) throw new TypeError('Cyclic JSON is unsupported.');
    ancestors.add(v); add(2);
    if (Array.isArray(v)) { for (let i = 0; i < v.length && bytes <= limit; i++) { if (i) add(1); visit(v[i], depth + 1); } }
    else {
      let first = true;
      for (const key in v) {
        if (!Object.hasOwn(v, key)) continue;
        if (bytes > limit) break;
        if (!first) add(1); first = false; string(key); add(1); visit((v as Record<string, unknown>)[key], depth + 1);
      }
    }
    ancestors.delete(v);
  };
  visit(value, 0); return bytes;
}
export function assertPayloadBudget(value: unknown, budget: PayloadBudget, profile = DEFAULT_RESOURCE_PROFILE): void {
  const limit = profile.chosen.bytes[budget];
  if (encodedJsonBytes(value, limit) > limit) throw new ResourceLimitError(budget, limit);
}

export interface InvocationUsage { readonly d1Calls: number; readonly statements: number; readonly maxParameters: number; readonly externalSubrequests: number }
/** A batch increments calls once and statements by its length. Never infer calls from statements. */
export function assertInvocationBudget(usage: InvocationUsage, profile = DEFAULT_RESOURCE_PROFILE): void {
  const limits = { d1Calls: profile.chosen.d1CallsPerInvocation, statements: profile.chosen.statementsPerSave, maxParameters: profile.chosen.parametersPerStatement, externalSubrequests: profile.chosen.externalSubrequests };
  for (const key of Object.keys(limits) as (keyof InvocationUsage)[]) if (!Number.isSafeInteger(usage[key]) || usage[key] < 0 || usage[key] > limits[key]) throw new RangeError(`${key} exceeds its chosen invocation budget (${limits[key]}).`);
}
