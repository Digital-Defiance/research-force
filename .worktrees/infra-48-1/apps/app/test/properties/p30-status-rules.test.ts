// Feature: research-collab-cms, Property 30: Status rules hold under all operation sequences
import { describe, expect, it } from 'vitest';
import type { ULID } from '@researchforce/domain/types';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { itemWorld, RELATED, rich, V } from '../items';

const world = itemWorld();
const FINDING_STATUSES = [V.findingOpen, V.findingConfirmed, V.findingSuperseded] as const;
const EVIDENCE = ['none', 'source', 'run', 'finding', 'hypothesis'] as const;
type Evidence = typeof EVIDENCE[number];

const opArb = fc.oneof(
  { arbitrary: fc.record({ type: fc.constant('finding' as const), finding: fc.nat(), status: fc.constantFrom(...FINDING_STATUSES), evidence: fc.constantFrom(...EVIDENCE), link: fc.boolean(), supersede: fc.boolean() }), weight: 3 },
  { arbitrary: fc.record({ type: fc.constant('submit' as const), status: fc.constantFrom(...FINDING_STATUSES), evidence: fc.constantFrom(...EVIDENCE), link: fc.boolean(), supersede: fc.boolean() }), weight: 1 },
  {
    arbitrary: fc.record({
      type: fc.constant('hypothesis' as const), status: fc.constantFrom('same', V.hypothesisOpen, V.hypothesisEliminated, V.hypothesisEliminated), scope: fc.constantFrom('none', 'new', 'new', 'blank'),
      evidence: fc.constantFrom<Evidence>('run', 'finding', 'run', 'none', 'source', 'hypothesis'), mark: fc.constantFrom('none', 'minor_edit', 'correction'), reason: fc.boolean(),
    }),
    weight: 4,
  },
  { arbitrary: fc.record({ type: fc.constant('unlink' as const), link: fc.nat() }), weight: 2 },
  { arbitrary: fc.record({ type: fc.constant('withdraw' as const), finding: fc.nat() }), weight: 1 },
);

describe('Property 30: Status rules hold under all operation sequences', () => {
  it('keeps every Finding_Status and Hypothesis_Status rule after every accepted or refused operation', async () => {
    const core = world.core();
    let counter = 0;
    await fc.assert(fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 10 }), async (ops) => {
      const [source, run, hypothesis, ...findings] = (await Promise.all((['source', 'run', 'hypothesis', 'finding', 'finding'] as const).map((kind) => world.created('author', kind)))).map((item) => item.id);
      const ids = () => [source!, run!, hypothesis!, ...findings];
      const evidenceOf = (choice: Evidence, self: string) => {
        const id = { none: undefined, source, run, finding: findings.find((finding) => finding !== self), hypothesis }[choice];
        return id === undefined || id === self ? {} : { evidence: [id] };
      };
      const rev = async (id: string) => core.prepare('SELECT rev FROM units WHERE id = ?1').bind(id).first<number>('rev');
      const accepted = (response: Response) => {
        expect(response.status).toBeLessThan(500);
        expect(response.status).not.toBe(409);
      };
      for (const op of ops) {
        if (op.type === 'finding' || op.type === 'submit') {
          const self = op.type === 'finding' ? findings[op.finding % findings.length]! : '';
          const other = findings.find((finding) => finding !== self)!;
          const body = {
            statusValueId: op.status, ...evidenceOf(op.evidence, self),
            ...(op.supersede ? { supersededById: other } : {}), ...(op.link ? { links: [{ targetId: other, relationValueId: RELATED }] } : {}),
          };
          if (op.type === 'finding') accepted(await world.edit('author', self, { rev: await rev(self), ...body }));
          else {
            const response = await world.create('author', 'finding', { projectId: world.projectId, title: `Finding ${++counter}`, logSummary: rich('Synthetic summary.'), claim: rich('A claim.'), scopeCaveat: rich('A caveat.'), ...body });
            accepted(response);
            if (response.status === 201) findings.push((await response.json<{ item: { id: ULID } }>()).item.id);
          }
        } else if (op.type === 'hypothesis') {
          const scope = op.status === V.hypothesisOpen ? {} : { none: {}, new: { eliminationScope: rich(`Scope ${++counter}`) }, blank: { eliminationScope: rich('  ') } }[op.scope];
          accepted(await world.edit('author', hypothesis!, {
            rev: await rev(hypothesis!), ...(op.status === 'same' ? {} : { statusValueId: op.status }), ...scope, ...evidenceOf(op.evidence, hypothesis!),
            ...(op.mark === 'none' ? {} : { mark: op.mark === 'correction' ? { mark: 'correction', reason: 'Synthetic correction.' } : { mark: 'minor_edit' } }),
            ...(op.reason ? { statusReason: 'Synthetic reason.' } : {}),
          }));
        } else if (op.type === 'unlink') {
          const links = (await core.prepare('SELECT id FROM cross_links WHERE removed_at IS NULL AND (origin_id IN (SELECT value FROM json_each(?1)) OR target_id IN (SELECT value FROM json_each(?1))) ORDER BY id')
            .bind(JSON.stringify(ids())).all<{ id: string }>()).results;
          if (links.length > 0) accepted(await world.request('admin', 'DELETE', `/links/${links[op.link % links.length]!.id}`));
        } else {
          const finding = findings[op.finding % findings.length]!;
          accepted(await world.request('author', 'POST', `/items/${finding}/withdraw`, { rev: await rev(finding), reason: 'Synthetic withdrawal.', confirm: { reasonPublic: false } }));
        }

        const linked = `EXISTS (SELECT 1 FROM cross_links l LEFT JOIN research_items o ON o.unit_id = CASE WHEN l.origin_id = i.unit_id THEN l.target_id ELSE l.origin_id END
          WHERE l.removed_at IS NULL AND l.relation_value_id = '${V.relationEvidenceFor}' AND (l.origin_id = i.unit_id OR l.target_id = i.unit_id) AND %KINDS%)`;
        const broken = await core.prepare(`SELECT i.unit_id AS id, i.status_value_id AS status FROM research_items i
            LEFT JOIN findings f ON f.unit_id = i.unit_id LEFT JOIN hypotheses h ON h.unit_id = i.unit_id
          WHERE i.unit_id IN (SELECT value FROM json_each(?1)) AND (
            (i.status_value_id = '${V.findingConfirmed}' AND NOT ${linked.replace('%KINDS%', "(o.kind IS NULL OR o.kind <> 'hypothesis')")})
            OR (i.status_value_id = '${V.findingSuperseded}' AND (f.superseded_by_id IS NULL OR NOT EXISTS (SELECT 1 FROM cross_links l WHERE l.removed_at IS NULL
              AND ((l.origin_id = i.unit_id AND l.target_id = f.superseded_by_id) OR (l.target_id = i.unit_id AND l.origin_id = f.superseded_by_id)))))
            OR (i.status_value_id = '${V.hypothesisEliminated}' AND (trim(coalesce(h.elimination_scope, '')) = '' OR NOT ${linked.replace('%KINDS%', "o.kind IN ('run', 'finding')")}))
          )`).bind(JSON.stringify(ids())).all();
        expect(broken.results).toEqual([]);

        const revisions = (await core.prepare('SELECT kind, reason, prev FROM revisions WHERE target_id = ?1').bind(hypothesis).all<{ kind: string; reason: string | null; prev: string }>()).results
          .map((row) => ({ ...row, prev: JSON.parse(row.prev) as Record<string, unknown> }));
        for (const revision of revisions) {
          const reopening = revision.kind === 'status_change' && revision.prev['statusValueId'] === V.hypothesisEliminated;
          if (reopening) {
            expect(revision.reason?.trim()).toBeTruthy();
            expect(revision.prev['eliminationScope']).toBeTruthy();
          }
          if (revision.prev['eliminationScope'] !== undefined && revision.prev['eliminationScope'] !== null) expect(reopening || revision.kind === 'correction').toBe(true);
        }
      }
    }));
  }, 600 * FC_RUNS);
});
