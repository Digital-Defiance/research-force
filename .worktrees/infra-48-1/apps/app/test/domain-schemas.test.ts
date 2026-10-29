import { expect, it } from 'vitest';
import { asTimestamp, asULID } from '@researchforce/domain/types';
import { BUILT_IN_VALUE_IDS } from '@researchforce/domain/value-sets';
import { researchItemSchema } from '@researchforce/domain/schemas/items';
import { validate } from '@researchforce/domain/schemas/common';

it('validates Zod schemas in workerd without accepting client-controlled ownership', () => {
  const id = asULID('00000000000000000000000100');
  const schema = researchItemSchema('finding', {
    now: asTimestamp('2026-01-01T00:00:00.000Z'), members: [], roleIds: [], externalPartyIds: [],
    projects: [{ id, name: 'Synthetic', slug: 'synthetic' }], valueSets: { finding_status: [{ id: BUILT_IN_VALUE_IDS.findingOpen, name: 'Open', retired: false }] },
  });
  const rich = { text: 'Synthetic é e\u0301 😀', spans: [] };
  const input = { kind: 'finding', projectId: id, title: 'Synthetic', claim: rich, scopeCaveat: rich, logSummary: rich };
  expect(schema.safeParse(input).success).toBe(true);
  const invalid = validate(schema, { ...input, ownerId: id, title: false, logSummary: { text: ' ', spans: [] } });
  if (invalid.ok) throw new Error('Expected a rejected save.');
  expect(invalid.issues.map((issue) => issue.field)).toEqual(expect.arrayContaining(['ownerId', 'title', 'logSummary']));
});
