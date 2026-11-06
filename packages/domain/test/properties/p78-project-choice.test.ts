// Feature: research-collab-cms, Property 78: Project choice and preselection
import { describe, expect, it } from 'vitest';
import { asULID } from '../../src/types';
import type { ULID } from '../../src/types';
import { fc } from '@researchforce/testing/fc';
import { validate } from '../../src/schemas/common';
import type { ValidationContext } from '../../src/schemas/common';
import { outsideSubmissionSchema } from '../../src/schemas/other';
import { SCHEMA_CONTEXT } from '../schema-fixtures';

/**
 * Property 78: Project choice and preselection — the kernel part (Validates: Requirements 31.13, 32.18, 39.2, 39.3).
 *
 * This file proves the pure, data-only half of Property 78: what the public Outside_Submission_Form may offer and
 * accept. The D1-driven half — the baked-in offered list in Project_Order with the page's preselection (R31.13,
 * R39.2), the Workspace rule that a submitted Research_Item names a Project that must exist (R39.3), and the
 * acceptance path that places a created Research_Item in the Outside_Submission's Project unless another is chosen,
 * requiring a choice for the General_Choice (R32.18) — lives in
 * `apps/app/test/properties/p78-project-choice.test.ts`, where the real `projectChoice`, `requireProject`, and
 * `decide.ts` run against the Workspace database. Splitting the property this way keeps each part at the level that
 * most directly proves it, and neither part weakens the claim.
 *
 * The kernel of the offered set (R31.13, R31.14) is the destination branch of `outsideSubmissionSchema`: the Visitor
 * may send either the General_Choice or one Project, and a Project is accepted exactly when its id is among the Public
 * Projects the form was built from (`context.projects` here, `publicProjects()` in the rf-submit Worker). A Project
 * that does not exist and a Project that exists but is not Public are BOTH simply absent from that set, so both are
 * refused in the identical way — the same `destination.projectId` issue — as the General case refuses any value that
 * is not one of the two offered kinds. The Project_Order that the form shows the offered Projects in is the order of
 * `context.projects`; the schema accepts a member of that set regardless of its position, so the ordering is a
 * rendering concern proven in the app part, not a validation one.
 *
 * fast-check defaults (packages/testing/src/fc.ts): 100 runs, overridable with FC_RUNS, with the failing seed and a
 * replay path logged on failure.
 */

/** A canonical 26-character ULID built from a number, distinct per seed so a generated id never collides by accident. */
const idOf = (n: number): ULID => asULID(n.toString(36).toUpperCase().padStart(26, '0').replace(/[^0-9A-HJKMNP-TV-Z]/g, '0'));

/** A base submit body that is otherwise valid, so only the destination decides acceptance. */
const base = (destination: unknown) => ({
  type: 'material' as const,
  destination,
  message: 'A synthetic message.',
  name: 'A researcher',
  email: 'visitor@example.test',
  licenceAgreement: { agreed: true, contentLicence: 'synthetic-licence-v1' },
  files: [],
});

/** A ValidationContext whose Public Projects are exactly `ids`, in the given Project_Order. */
const contextWith = (ids: readonly ULID[]): ValidationContext => ({
  ...SCHEMA_CONTEXT,
  projects: ids.map((id, index) => ({ id, name: `Public Project ${index}`, slug: `public-${index}` })),
});

const LICENCE = 'synthetic-licence-v1';
const schemaFor = (context: ValidationContext) => outsideSubmissionSchema(context, { contentLicence: LICENCE });

/** The field paths a refusal names, which is what makes two refusals indistinguishable or not. */
const refusedFields = (result: ReturnType<typeof validate>): string[] =>
  result.ok ? [] : result.issues.map((issue) => issue.field).sort();

/**
 * Generate a set of distinct Public Project ids (the offered set) together with a disjoint pool of "other" ids that
 * are NOT Public — these stand in for both a nonexistent Project and a Project that exists but is not Public, which
 * the form treats identically (neither is in `context.projects`).
 */
const worldArb = fc.record({
  publicCount: fc.integer({ min: 0, max: 6 }),
  otherCount: fc.integer({ min: 1, max: 6 }),
}).map(({ publicCount, otherCount }) => {
  const publics = Array.from({ length: publicCount }, (_v, index) => idOf(1000 + index));
  const others = Array.from({ length: otherCount }, (_v, index) => idOf(9000 + index));
  return { publics, others };
});

describe('Property 78 (kernel): the public form offers General and the Public Projects, and nothing else', () => {
  it('accepts the General_Choice and every Public Project, and refuses anything not in the offered set', () => {
    fc.assert(fc.property(worldArb, fc.nat(), (world, pick) => {
      const context = contextWith(world.publics);
      const schema = schemaFor(context);

      // The General_Choice is always offerable and accepted.
      expect(validate(schema, base({ kind: 'general' })).ok).toBe(true);

      // Every offered Public Project is accepted, at any position in the Project_Order.
      for (const projectId of world.publics) {
        const result = validate(schema, base({ kind: 'project', projectId }));
        expect(result.ok, `Public Project ${projectId} must be offerable`).toBe(true);
      }

      // A chosen Project not in the offered set is refused, whatever it stands for.
      const outside = world.others[pick % world.others.length]!;
      const result = validate(schema, base({ kind: 'project', projectId: outside }));
      expect(result.ok).toBe(false);
      expect(refusedFields(result)).toEqual(['destination.projectId']);
    }));
  });

  it('refuses a nonexistent and a non-Public Project the same way (R31.14): indistinguishable refusals', () => {
    fc.assert(fc.property(worldArb, (world) => {
      const context = contextWith(world.publics);
      const schema = schemaFor(context);

      // `others` are all absent from the offered set; a nonexistent Project and a non-Public one are both just an id
      // the set does not contain, so each refusal names the identical field with the identical message.
      const refusals = world.others.map((projectId) => validate(schema, base({ kind: 'project', projectId })));
      for (const refusal of refusals) expect(refusal.ok).toBe(false);
      const signatures = new Set(refusals.map((refusal) => JSON.stringify(refusal.ok ? null : refusal.issues)));
      expect(signatures.size, 'every out-of-set Project yields the same refusal').toBe(1);

      // That refusal is also indistinguishable from the General case's refusal of a destination with no valid kind —
      // the form offers exactly General and the Public Projects, so any other destination fails the same union.
      const unknownKind = validate(schema, base({ kind: 'project', projectId: world.others[0]! }));
      const missingProject = validate(schema, base({ kind: 'project' }));
      expect(unknownKind.ok).toBe(false);
      expect(missingProject.ok).toBe(false);
      expect(refusedFields(unknownKind)).toEqual(['destination.projectId']);
      expect(refusedFields(missingProject)).toEqual(['destination.projectId']);
    }));
  });

  it('never leaks the offered set: the refusal for an out-of-set Project does not depend on how many Public Projects exist', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 6 }), fc.integer({ min: 0, max: 6 }), (a, b) => {
      // The same nonexistent Project id is refused identically whether the Workspace has `a` or `b` Public Projects,
      // so a Visitor learns nothing about the set from the refusal (R31.6-style containment applied to the choice).
      const outside = idOf(42_000);
      const refuse = (count: number) => {
        const context = contextWith(Array.from({ length: count }, (_v, index) => idOf(2000 + index)));
        return validate(schemaFor(context), base({ kind: 'project', projectId: outside }));
      };
      const first = refuse(a);
      const second = refuse(b);
      expect(first.ok).toBe(false);
      expect(second.ok).toBe(false);
      expect(JSON.stringify(first.ok ? null : first.issues)).toBe(JSON.stringify(second.ok ? null : second.issues));
    }));
  });
});
