import { z } from 'zod';
import { dateSortKey, todayInZone } from '../dates';
import { cpLength, isBlank } from '../text';
import type { ItemKind } from '../types';
import type { RichText } from '../richtext';
import { BUILT_IN_VALUE_IDS } from '../value-sets';
import { distinctIds, documentDateSchema, enteredTimeSchema, fullDateSchema, idSchema, knownId, partialDateSchema, richTextSchema, selectedValue, textField, validDate, withChecks } from './common';
import type { ReportIssue, ValidationContext } from './common';

export const JOURNAL_LIMITS = Object.freeze({ sections: 5000, codePoints: 2_000_000, parserSourceBytes: 2_000_000 });
export type ItemValidationOptions =
  | { readonly mode: 'submit' | 'import' | 'restore' }
  | { readonly mode: 'parser'; readonly sourceBytes: number }
  | { readonly mode: 'edit'; readonly previous: { readonly logSummary?: RichText; readonly sectionCount?: number; readonly sectionCharacters?: number } };

function missingRich(value: unknown): boolean {
  return value === undefined || (typeof value === 'object' && value !== null && 'text' in value && typeof value.text === 'string' && isBlank(value.text));
}
function summaryCheck(kind: ItemKind, options: ItemValidationOptions, raw: Record<string, unknown>, report: ReportIssue): void {
  const requiredOnSubmit = options.mode === 'submit' && kind !== 'journal_entry' && kind !== 'topic';
  const hadSummary = options.mode === 'edit' && options.previous.logSummary !== undefined && !isBlank(options.previous.logSummary.text);
  if ((requiredOnSubmit || hadSummary) && missingRich(raw['logSummary'])) report(['logSummary'], hadSummary ? 'An existing Log Summary can be changed but not removed.' : 'This kind requires a Log Summary of 1 to 2000 Unicode code points.');
}
const safeMetric = (value: number | undefined): value is number => value !== undefined && Number.isSafeInteger(value) && value >= 0;

export function partySchema(context: ValidationContext) {
  return z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('member'), id: knownId(context.members.map((member) => member.id), 'Member') }),
    z.strictObject({ kind: z.literal('external'), id: knownId(context.externalPartyIds, 'External Party') }),
  ]);
}
export function rightsFields(context: ValidationContext, existing = false) {
  const selectionContext = existing ? context : { ...context, previousSelections: { ...context.previousSelections, rightsStatusId: [] } };
  const status = selectedValue(selectionContext, 'rights_status', 'rightsStatusId');
  return { rightsStatusId: existing ? status : status.prefault(BUILT_IN_VALUE_IDS.rightsUnknown), rightsHolder: textField(200).optional(), rightsTerms: textField(2000).optional() };
}

/** Compare fractions without converting long fractional values to floating point. */
function endBeforeStart(start: string, end: string): boolean {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (startMs !== endMs) return endMs < startMs;
  const startFraction = /\.(\d+)/.exec(start)?.[1] ?? '';
  const endFraction = /\.(\d+)/.exec(end)?.[1] ?? '';
  const width = Math.max(startFraction.length, endFraction.length);
  return endFraction.padEnd(width, '0') < startFraction.padEnd(width, '0');
}

function buildResearchItemSchema(kind: ItemKind, context: ValidationContext, options: ItemValidationOptions) {
  const existing = options.mode === 'edit' || options.mode === 'restore';
  if (!existing) context = { ...context, previousSelections: {} };
  const common = {
    projectId: knownId(context.projects.map((project) => project.id), 'Project'), title: textField(200, true),
    logSummary: richTextSchema(2000).optional(), groupNote: richTextSchema(50_000).optional(),
  };
  const finish = <S extends z.ZodType>(schema: S, check?: (raw: Record<string, unknown>, report: ReportIssue) => void) => withChecks(schema, (raw, report) => {
    summaryCheck(kind, options, raw, report);
    check?.(raw, report);
  });
  switch (kind) {
    case 'journal_entry': {
      let maximumSections: number = JOURNAL_LIMITS.sections;
      let maximumCharacters: number = JOURNAL_LIMITS.codePoints;
      let minimumSections = 1;
      if (options.mode === 'restore') {
        maximumSections = Number.MAX_SAFE_INTEGER;
        maximumCharacters = Number.MAX_SAFE_INTEGER;
        minimumSections = 0;
      }
      if (options.mode === 'parser') {
        if (!safeMetric(options.sourceBytes) || options.sourceBytes > JOURNAL_LIMITS.parserSourceBytes) throw new RangeError('Parser input must be at most 2000000 bytes.');
        maximumSections = Number.MAX_SAFE_INTEGER;
        maximumCharacters = options.sourceBytes;
        minimumSections = 0;
      }
      if (options.mode === 'edit') {
        if (!safeMetric(options.previous.sectionCount) || !safeMetric(options.previous.sectionCharacters)) throw new RangeError('Editing a Journal Entry needs its saved section count and character total.');
        maximumSections = Math.max(maximumSections, options.previous.sectionCount);
        maximumCharacters = Math.max(maximumCharacters, options.previous.sectionCharacters);
        minimumSections = options.previous.sectionCount === 0 ? 0 : 1;
      }
      return finish(z.strictObject({
        ...common, kind: z.literal('journal_entry'), phaseId: textField(200).optional(), statusValueId: selectedValue(context, 'campaign_status', 'statusValueId').optional(),
        startDate: partialDateSchema.optional(), endDate: partialDateSchema.optional(), relatedMemberIds: distinctIds(knownId(context.members.map((member) => member.id), 'Member')).optional(),
        sections: z.array(z.strictObject({ id: idSchema.optional(), content: richTextSchema(undefined, true) })).min(minimumSections).max(maximumSections),
      }), (raw, report) => {
        const start = validDate(raw['startDate']);
        const end = validDate(raw['endDate']);
        if (start && end && dateSortKey(end) < dateSortKey(start)) report(['endDate'], 'The end date precedes the start date.');
        if (Array.isArray(raw['sections'])) {
          let total = 0;
          const ids = new Set<string>();
          for (const [index, section] of raw['sections'].entries()) {
            if (typeof section !== 'object' || section === null) continue;
            const entry = section as Record<string, unknown>;
            const content = entry['content'];
            if (typeof content === 'object' && content !== null && 'text' in content && typeof content.text === 'string') total += cpLength(content.text);
            if (typeof entry['id'] === 'string') {
              if (ids.has(entry['id'])) report(['sections', index, 'id'], 'An Entry Section can appear only once.');
              ids.add(entry['id']);
            }
          }
          if (total > maximumCharacters) report(['sections'], `Entry Section text must total at most ${maximumCharacters} Unicode code points.`);
        }
      });
    }
    case 'finding': {
      const status = selectedValue(context, 'finding_status', 'statusValueId');
      return finish(z.strictObject({ ...common, kind: z.literal('finding'), statusValueId: existing ? status : status.prefault(BUILT_IN_VALUE_IDS.findingOpen), claim: richTextSchema(2000, true), scopeCaveat: richTextSchema(2000, true), withdrawalReason: textField(1000).optional() }), (raw, report) => {
        if (raw['statusValueId'] === BUILT_IN_VALUE_IDS.findingWithdrawn && (raw['withdrawalReason'] === undefined || (typeof raw['withdrawalReason'] === 'string' && isBlank(raw['withdrawalReason'])))) report(['withdrawalReason'], 'A Withdrawn Finding needs a non-blank reason.');
      });
    }
    case 'source':
      return finish(z.strictObject({ ...common, kind: z.literal('source'), sourceKind: z.enum(['primary', 'secondary']), reliabilityId: selectedValue(context, 'reliability', 'reliabilityId'), documentDate: documentDateSchema.optional(), archiveOrCollection: z.string().optional(), archivalReference: z.string().optional(), recoverer: partySchema(context).optional(), reliabilityNote: richTextSchema().optional(), ...rightsFields(context, existing) }));
    case 'run':
      return finish(z.strictObject({
        ...common, kind: z.literal('run'), scope: richTextSchema(10_000, true), parameters: richTextSchema(10_000, true), toolName: textField(200, true), toolVersion: textField(200, true), computeResource: textField(200, true),
        startTime: enteredTimeSchema, endTime: enteredTimeSchema.optional(), outcomeId: selectedValue(context, 'run_outcome', 'outcomeId'), resumePoint: textField(1000).optional(), notes: richTextSchema(10_000).optional(),
        counts: z.array(z.strictObject({ name: textField(200, true), value: z.string().regex(/^\d{1,30}$/, 'Use a non-negative whole-number digit string of at most 30 digits.') })).max(20).optional(),
      }), (raw, report) => {
        const start = enteredTimeSchema.safeParse(raw['startTime']);
        const end = enteredTimeSchema.safeParse(raw['endTime']);
        if (start.success && end.success && endBeforeStart(start.data, end.data)) report(['endTime'], 'The end time precedes the start time.');
        if (Array.isArray(raw['counts'])) {
          const seen = new Set<string>();
          for (const [index, entry] of raw['counts'].entries()) if (typeof entry === 'object' && entry !== null && 'name' in entry && typeof entry.name === 'string') {
            if (seen.has(entry.name)) report(['counts', index, 'name'], 'Each count name must be distinct.');
            seen.add(entry.name);
          }
        }
      });
    case 'hypothesis': {
      const status = selectedValue(context, 'hypothesis_status', 'statusValueId');
      return finish(z.strictObject({ ...common, kind: z.literal('hypothesis'), statusValueId: existing ? status : status.prefault(BUILT_IN_VALUE_IDS.hypothesisOpen), statement: richTextSchema(10_000, true), eliminationScope: richTextSchema(1000).optional() }), (raw, report) => {
        if (raw['statusValueId'] === BUILT_IN_VALUE_IDS.hypothesisEliminated && missingRich(raw['eliminationScope'])) report(['eliminationScope'], 'An Eliminated Hypothesis needs a non-blank Elimination Scope.');
      });
    }
    case 'correspondence':
      return finish(z.strictObject({ ...common, kind: z.literal('correspondence'), date: fullDateSchema, channel: z.string().prefault(''), direction: z.enum(['sent', 'received']), content: richTextSchema().prefault({ text: '', spans: [] }), parties: z.array(partySchema(context)).min(2) }), (raw, report) => {
        const date = fullDateSchema.safeParse(raw['date']);
        if (date.success && date.data.value > todayInZone(context.now, context.timeZone).value) report(['date'], 'The Correspondence date cannot be after today in the saving Member’s time zone.');
        if (Array.isArray(raw['parties'])) {
          const seen = new Set<string>();
          for (const [index, party] of raw['parties'].entries()) {
            const parsed = partySchema(context).safeParse(party);
            if (!parsed.success) continue;
            const key = `${parsed.data.kind}:${parsed.data.id}`;
            if (seen.has(key)) report(['parties', index], 'Choose each Party at most once.');
            seen.add(key);
          }
        }
      });
    case 'archival_request':
      return finish(z.strictObject({ ...common, kind: z.literal('archival_request'), archiveOrDesk: partySchema(context), contact: partySchema(context).optional(), channel: z.string().optional(), requestText: richTextSchema(undefined, true), statusValueId: selectedValue(context, 'archival_request_status', 'statusValueId'), dateSent: fullDateSchema.optional(), replyDate: fullDateSchema.optional(), replyContent: richTextSchema().optional() }), (raw, report) => {
        const today = todayInZone(context.now, context.timeZone).value;
        const sent = fullDateSchema.safeParse(raw['dateSent']);
        const replied = fullDateSchema.safeParse(raw['replyDate']);
        const needsSent = raw['statusValueId'] === BUILT_IN_VALUE_IDS.archivalSent || raw['statusValueId'] === BUILT_IN_VALUE_IDS.archivalReplied;
        if (needsSent && raw['dateSent'] === undefined) report(['dateSent'], 'Sent and Replied requests need a date sent.');
        if (sent.success && sent.data.value > today) report(['dateSent'], 'The date sent cannot be after today.');
        if (raw['statusValueId'] === BUILT_IN_VALUE_IDS.archivalReplied) {
          if (raw['replyDate'] === undefined) report(['replyDate'], 'A Replied request needs a reply date.');
          if (missingRich(raw['replyContent'])) report(['replyContent'], 'A Replied request needs non-blank reply content.');
        }
        if (replied.success && replied.data.value > today) report(['replyDate'], 'The reply date cannot be after today.');
        if (sent.success && replied.success && replied.data.value < sent.data.value) report(['replyDate'], 'The reply date precedes the date sent.');
      });
    case 'topic': return finish(z.strictObject({ ...common, kind: z.literal('topic'), body: richTextSchema(50_000, true) }));
  }
}

export type ResearchItemInput = z.output<ReturnType<typeof buildResearchItemSchema>>;

/** A literal kind retains its corresponding validated output type. */
export function researchItemSchema<K extends ItemKind>(kind: K, context: ValidationContext, options: ItemValidationOptions = { mode: 'submit' }): z.ZodType<Extract<ResearchItemInput, { kind: K }>> {
  return buildResearchItemSchema(kind, context, options) as z.ZodType<Extract<ResearchItemInput, { kind: K }>>;
}
