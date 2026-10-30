import { describe, expect, it } from 'vitest';
import { ACKNOWLEDGEMENT_RESPONSES, DECISION_LIMITS, DECISION_TRANSITIONS, acknowledgementInputSchema, adoptInputSchema, revisitIsDue, supersedeInputSchema, withdrawInputSchema, acknowledgementStatus, adoptionIssues, decisionDigest } from '../src/decisions';
import type { DecisionWording } from '../src/decisions';
import { researchItemSchema } from '../src/schemas/items';
import { fc } from '@researchforce/testing/fc';
import { SCHEMA_CONTEXT as context, SCHEMA_IDS as ids, itemFixture, schemaId, schemaText as rt } from './schema-fixtures';

const wording: DecisionWording = {
  question: 'Which key range is searched next?', context: 'Synthetic context.', rationale: 'The first half is cheaper.',
  alternatives: [{ title: 'First half', description: 'Keys 0 to 49.' }, { title: 'Second half', description: 'Keys 50 to 99.' }], outcome: { kind: 'selected', alternative: 0 },
};
const schema = () => researchItemSchema('decision_record', context, { mode: 'submit' });
const parse = (overrides: Record<string, unknown>) => schema().safeParse({ ...itemFixture('decision_record'), ...overrides });
const paths = (overrides: Record<string, unknown>) => { const result = parse(overrides); return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.')); };

describe('the wording digest (R53.3)', () => {
  it('is stable and changes with the question, context, rationale, alternatives or outcome', () => {
    const digest = decisionDigest(wording);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(decisionDigest({ ...wording })).toBe(digest);
    for (const changed of [
      { question: 'Which key range is searched later?' }, { context: 'Other context.' }, { rationale: 'The second half is cheaper.' },
      { alternatives: [wording.alternatives[1]!, wording.alternatives[0]!] }, { alternatives: [{ title: 'First half', description: 'Keys 0 to 48.' }, wording.alternatives[1]!] },
      { outcome: { kind: 'selected' as const, alternative: 1 } }, { outcome: { kind: 'deferred' as const } }, { outcome: undefined },
    ]) expect(decisionDigest({ ...wording, ...changed })).not.toBe(digest);
  });

  it('does not mistake an absent context or rationale for an empty one, or a deferral reason for none', () => {
    expect(decisionDigest({ ...wording, context: undefined })).not.toBe(decisionDigest({ ...wording, context: '' }));
    expect(decisionDigest({ ...wording, outcome: { kind: 'deferred' } })).not.toBe(decisionDigest({ ...wording, outcome: { kind: 'deferred', reason: 'Later.' } }));
  });

  it('is unaffected by the order of keys in the alternatives it is given', () => {
    const reordered = { ...wording, alternatives: wording.alternatives.map((alternative) => ({ description: alternative.description, title: alternative.title })) };
    expect(decisionDigest(reordered)).toBe(decisionDigest(wording));
  });
});

describe('acknowledgement status (R53.2, R53.3)', () => {
  const current = decisionDigest(wording);
  it('reports no response when nothing was recorded, and never agreement', () => {
    expect(acknowledgementStatus(undefined, current)).toBe('no_response');
  });
  it('reports a response as it stands only while the wording is unchanged', () => {
    for (const response of ACKNOWLEDGEMENT_RESPONSES) {
      expect(acknowledgementStatus({ response, digest: current }, current)).toBe(response);
      expect(acknowledgementStatus({ response, digest: decisionDigest({ ...wording, rationale: 'Changed.' }) }, current)).toBe('earlier_wording');
    }
  });
  it('treats any response to older wording as earlier wording for every change of the wording', () => {
    fc.assert(fc.property(fc.string(), fc.string(), (question, rationale) => {
      const next = { ...wording, question, rationale };
      const changes = decisionDigest(next) !== current;
      expect(acknowledgementStatus({ response: 'acknowledged', digest: current }, decisionDigest(next))).toBe(changes ? 'earlier_wording' : 'acknowledged');
    }));
  });
});

describe('adoption (R53.2)', () => {
  it('needs a non-blank rationale and an outcome that names a listed alternative', () => {
    expect(adoptionIssues(wording)).toEqual([]);
    expect(adoptionIssues({ ...wording, rationale: undefined }).map((issue) => issue.field)).toEqual(['rationale']);
    expect(adoptionIssues({ ...wording, rationale: ' \n\t' }).map((issue) => issue.field)).toEqual(['rationale']);
    expect(adoptionIssues({ ...wording, outcome: undefined }).map((issue) => issue.field)).toEqual(['outcome']);
    expect(adoptionIssues({ ...wording, outcome: { kind: 'selected', alternative: 2 } }).map((issue) => issue.field)).toEqual(['outcome.alternative']);
    expect(adoptionIssues({ ...wording, outcome: { kind: 'deferred' } })).toEqual([]);
    expect(adoptionIssues({ alternatives: [] }).map((issue) => issue.field)).toEqual(['rationale', 'outcome']);
  });
  it('makes withdrawal and supersession final', () => {
    expect(DECISION_TRANSITIONS.superseded).toEqual([]);
    expect(DECISION_TRANSITIONS.withdrawn).toEqual([]);
    expect(DECISION_TRANSITIONS.proposed).not.toContain('superseded');
  });
});

describe('the Decision_Record item schema (R53.1)', () => {
  it('accepts the minimal record and defaults to an individual decision with no participants or evidence', () => {
    const result = parse({});
    expect(result.success).toBe(true);
    expect(result.success && result.data).toMatchObject({ kind: 'decision_record', scope: 'individual', participantIds: [], evidenceCitationIds: [] });
  });

  it('bounds the question, context, rationale and alternatives', () => {
    expect(paths({ question: ' ' })).toEqual(['question']);
    expect(parse({ question: 'q'.repeat(DECISION_LIMITS.questionCodePoints) }).success).toBe(true);
    expect(paths({ question: 'q'.repeat(DECISION_LIMITS.questionCodePoints + 1) })).toEqual(['question']);
    expect(parse({ question: '😀'.repeat(DECISION_LIMITS.questionCodePoints) }).success).toBe(true);
    expect(parse({ context: rt('c'.repeat(DECISION_LIMITS.contextCodePoints)), rationale: rt('r'.repeat(DECISION_LIMITS.rationaleCodePoints)) }).success).toBe(true);
    expect(paths({ context: rt('c'.repeat(DECISION_LIMITS.contextCodePoints + 1)) })).toEqual(['context.text']);
    expect(paths({ rationale: rt('r'.repeat(DECISION_LIMITS.rationaleCodePoints + 1)) })).toEqual(['rationale.text']);
    expect(paths({ alternatives: [] })).toEqual(['alternatives']);
    const many = (n: number) => Array.from({ length: n }, (_v, i) => ({ title: `Alternative ${i}`, description: 'Described.' }));
    expect(parse({ alternatives: many(DECISION_LIMITS.alternatives) }).success).toBe(true);
    expect(paths({ alternatives: many(DECISION_LIMITS.alternatives + 1) })).toEqual(['alternatives']);
    expect(paths({ alternatives: [{ title: 't'.repeat(201), description: 'd' }] })).toEqual(['alternatives.0.title']);
    expect(paths({ alternatives: [{ title: 't', description: 'd'.repeat(5001) }] })).toEqual(['alternatives.0.description']);
    expect(paths({ alternatives: [{ title: ' ', description: 'd' }] })).toEqual(['alternatives.0.title']);
  });

  it('accepts a selected or deferred outcome and refuses one that names no listed alternative', () => {
    expect(parse({ outcome: { kind: 'selected', alternative: 0 } }).success).toBe(true);
    expect(parse({ outcome: { kind: 'deferred', reason: 'Waiting for the archive.' } }).success).toBe(true);
    expect(paths({ outcome: { kind: 'selected', alternative: 1 } })).toEqual(['outcome.alternative']);
    expect(parse({ outcome: { kind: 'selected', alternative: -1 } }).success).toBe(false);
    expect(parse({ outcome: { kind: 'unknown' } }).success).toBe(false);
    expect(parse({ outcome: { kind: 'deferred', reason: 'r'.repeat(1001) } }).success).toBe(false);
  });

  it('bounds the participants, requires them for a Team decision, and refuses duplicates and unknown Members', () => {
    expect(paths({ scope: 'team' })).toEqual(['participantIds']);
    expect(parse({ scope: 'team', participantIds: [ids.member] }).success).toBe(true);
    expect(parse({ scope: 'individual', participantIds: [ids.member] }).success).toBe(true);
    expect(parse({ scope: 'team', participantIds: [ids.member, ids.member] }).success).toBe(false);
    expect(parse({ scope: 'team', participantIds: [schemaId(999)] }).success).toBe(false);
    expect(parse({ scope: 'private' }).success).toBe(false);
    const wide = researchItemSchema('decision_record', { ...context, members: Array.from({ length: 51 }, (_v, i) => ({ id: schemaId(5000 + i), status: 'active' as const, email: `m${i}@example.test`, displayName: `M${i}` })) }, { mode: 'submit' });
    const people = (n: number) => Array.from({ length: n }, (_v, i) => schemaId(5000 + i));
    expect(wide.safeParse({ ...itemFixture('decision_record'), scope: 'team', participantIds: people(50) }).success).toBe(true);
    expect(wide.safeParse({ ...itemFixture('decision_record'), scope: 'team', participantIds: people(51) }).success).toBe(false);
  });

  it('bounds the evidence, and takes an exact revisit date or a condition', () => {
    const citations = (n: number) => Array.from({ length: n }, (_v, i) => schemaId(7000 + i));
    expect(parse({ evidenceCitationIds: citations(DECISION_LIMITS.evidence) }).success).toBe(true);
    expect(parse({ evidenceCitationIds: citations(DECISION_LIMITS.evidence + 1) }).success).toBe(false);
    expect(parse({ evidenceCitationIds: [schemaId(7000), schemaId(7000)] }).success).toBe(false);
    expect(parse({ evidenceCitationIds: ['not-an-id'] }).success).toBe(false);
    expect(parse({ revisitDate: { value: '2027-03-01', approx: false }, revisitCondition: 'When the archive replies.' }).success).toBe(true);
    expect(parse({ revisitDate: { value: '2027-03', approx: false } }).success).toBe(false);
    expect(parse({ revisitDate: { value: '2027-03-01', approx: true } }).success).toBe(false);
    expect(parse({ revisitCondition: 'c'.repeat(1001) }).success).toBe(false);
  });

  it('keeps the state, adoption and supersession out of the input', () => {
    for (const field of ['state', 'adoptedAt', 'adoptedBy', 'supersedesId', 'supersededById', 'wordingDigest']) expect(parse({ [field]: 'x' }).success, field).toBe(false);
  });

  it('requires a Log Summary on submission, like the kinds that record a conclusion', () => {
    expect(paths({ logSummary: undefined })).toEqual(['logSummary']);
  });
});

describe('the personal response input (R53.3)', () => {
  const valid = { response: 'acknowledged', digest: decisionDigest(wording), wordingVersion: 1, expectedVersion: 0 };
  it('names the wording read and the response replaced, and bounds the comment', () => {
    expect(acknowledgementInputSchema.safeParse(valid).success).toBe(true);
    expect(acknowledgementInputSchema.safeParse({ ...valid, response: 'disagreed', comment: 'c'.repeat(2000) }).success).toBe(true);
    expect(acknowledgementInputSchema.safeParse({ ...valid, comment: 'c'.repeat(2001) }).success).toBe(false);
    expect(acknowledgementInputSchema.safeParse({ ...valid, comment: ' ' }).success).toBe(false);
    for (const bad of [{ response: 'agreed' }, { digest: 'abc' }, { digest: 'A'.repeat(64) }, { wordingVersion: 0 }, { expectedVersion: -1 }, { memberId: 'someone' }]) {
      expect(acknowledgementInputSchema.safeParse({ ...valid, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('state change inputs and review dates (R53.4)', () => {
  it('name the revision they act on and refuse anything else', () => {
    expect(adoptInputSchema.safeParse({ rev: 3 }).success).toBe(true);
    expect(adoptInputSchema.safeParse({ rev: 3, state: 'adopted' }).success).toBe(false);
    expect(withdrawInputSchema.safeParse({ rev: 1, reason: 'No longer needed.' }).success).toBe(true);
    expect(withdrawInputSchema.safeParse({ rev: 1, reason: ' ' }).success).toBe(false);
    const earlier = '01J0000000000000000000DC02';
    expect(supersedeInputSchema.safeParse({ rev: 1, supersededId: earlier, supersededRev: 2 }).success).toBe(true);
    for (const bad of [{ supersededId: 'x' }, { supersededRev: 0 }, { supersededId: earlier.replace('J', 'I') }]) expect(supersedeInputSchema.safeParse({ rev: 1, supersededId: earlier, supersededRev: 2, ...bad }).success).toBe(false);
  });

  it('come due only for an adopted decision whose date has come', () => {
    expect(revisitIsDue('adopted', '2026-11-05', '2026-11-05')).toBe(true);
    expect(revisitIsDue('adopted', '2026-11-06', '2026-11-05')).toBe(false);
    expect(revisitIsDue('adopted', undefined, '2026-11-05')).toBe(false);
    expect(revisitIsDue('adopted', null, '2026-11-05')).toBe(false);
    for (const state of ['proposed', 'superseded', 'withdrawn'] as const) expect(revisitIsDue(state, '2020-01-01', '2026-11-05')).toBe(false);
  });
});
