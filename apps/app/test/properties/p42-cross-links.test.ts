// Feature: research-collab-cms, Property 42: Cross_Links are unique and Backlinks complete
import { beforeAll, describe, expect, it } from 'vitest';
import { newULID } from '@researchforce/domain/identifiers';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { asTimestamp, asULID } from '@researchforce/domain/types';
import type { ULID } from '@researchforce/domain/types';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { assertionSpec, signAssertion, testAccess } from '@researchforce/testing/jwt';
import type { TestAccess } from '@researchforce/testing/jwt';
import type { Env } from '../../src/env';
import type { LinkEnd, LinkEntry } from '../../src/records/links';
import { migrated } from '../d1';
import { addMember, call, KeyServer, resetPeople, testApi } from '../api';
import { addElement, addItem, addProject, addSubmissionRow, deleteUnit, resetRecords } from '../units';

const ACTORS = ['author', 'colleague', 'admin'] as const;
type Actor = (typeof ACTORS)[number];
const RETIRED = asULID('01J000000000000000000RETX1');
const LABELS: readonly ({ id: ULID; name: string; state: 'active' | 'retired' | 'unknown' } | null)[] = [
  null,
  { id: asULID('0000000000000000000000X004'), name: 'Related', state: 'active' },
  { id: asULID('0000000000000000000000X003'), name: 'Discusses', state: 'active' },
  { id: RETIRED, name: 'Retired relation', state: 'retired' },
  { id: asULID('01J000000000000000000NXPE1'), name: '', state: 'unknown' },
];
const RULES = {
  missing: 'This Item or Entry Section does not exist or has been permanently deleted.',
  unlinkable: 'Only Items and Entry Sections can be linked.',
  self: 'A link must join two different Items or Entry Sections.',
  unknown: 'Choose a relation label from the relation label set.',
  retired: 'This relation label has been retired.',
  duplicate: 'These two ends are already linked with this relation label.',
};

interface PoolUnit { readonly id: ULID; readonly visibleTo: (actor: Actor) => boolean; readonly linkable: boolean; readonly end?: LinkEnd }
interface ModelLink { readonly id: ULID; readonly origin: number; readonly target: number; readonly label: number; readonly addedBy: Actor; removedBy?: Actor }

const addArb = fc.record({ actor: fc.constantFrom(...ACTORS), origin: fc.nat({ max: 8 }), target: fc.nat({ max: 8 }), label: fc.nat({ max: LABELS.length - 1 }) });
const stepArb = fc.oneof(
  { weight: 5, arbitrary: fc.record({ kind: fc.constant('add' as const), add: addArb }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('race' as const), add: addArb }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('remove' as const), actor: fc.constantFrom(...ACTORS), link: fc.nat() }) },
);

let bindings: Env;
let access: TestAccess;
beforeAll(async () => {
  bindings = await migrated();
  access = await testAccess();
  await bindings.RF_CORE.prepare(`INSERT INTO config_values (id, set_key, name, name_key, retired, locked, position, public_description, updated_seq)
    VALUES (?1, 'relation', 'Retired relation', 'retired relation', 1, 0, 99, 'A synthetic retired relation.', 0) ON CONFLICT DO NOTHING`).bind(RETIRED).run();
});

describe('Property 42: Cross_Links are unique and Backlinks complete', () => {
  it('records exactly the valid links, once each, and lists every active link as a Backlink and every link in the origin’s history', async () => {
    const now = new Date('2026-10-27T18:00:00.000Z');
    const at = asTimestamp(now.toISOString());
    const core = () => bindings.RF_CORE;
    await resetPeople(core());
    await resetRecords(core());
    const ids = {
      author: await addMember(core(), 'author@example.test', 'active', at),
      colleague: await addMember(core(), 'colleague@example.test', 'active', at),
      admin: await addMember(core(), 'admin@example.test', 'active', at, ROLE_IDS.administrator),
    };
    const api = testApi(access, new KeyServer(access), now);
    const tokens = Object.fromEntries(await Promise.all(ACTORS.map(async (who) => [who, (await signAssertion(access, assertionSpec(`${who}@example.test`), now))!]))) as Record<Actor, string>;
    const place = { projectId: await addProject(core(), ids.admin, at), ownerId: ids.author, submissionId: await addSubmissionRow(core(), ids.author, at), now: at };

    const finding = await addItem(core(), place, { kind: 'finding', title: 'Pool finding' });
    const source = await addItem(core(), place, { kind: 'source', title: 'Pool source', withdrawn: true });
    await core().prepare("UPDATE units SET disclosure_level = 'public' WHERE id = ?1").bind(source.id).run();
    const journal = await addItem(core(), place, { kind: 'journal_entry', title: 'Pool journal entry' });
    const section = await addElement(core(), place, 'entry_section', journal.id);
    const scan = await addElement(core(), { ...place, ownerId: ids.colleague }, 'attachment', finding.id, { title: 'Pool scan' });
    const reply = await addElement(core(), place, 'reply', finding.id);
    const draft = await addItem(core(), { ...place, ownerId: ids.colleague, submissionId: await addSubmissionRow(core(), ids.colleague, at, false) }, { title: 'Pool draft' });
    const deleted = await addItem(core(), place);
    await deleteUnit(core(), deleted.id, ids.admin, at);
    const note = await addElement(core(), place, 'dissent_note', finding.id);
    const everyone = () => true;
    const pool: PoolUnit[] = [
      { id: finding.id, visibleTo: everyone, linkable: true, end: { id: finding.id, kind: 'finding', title: 'Pool finding', identifier: finding.identifier, withdrawn: false } },
      { id: source.id, visibleTo: everyone, linkable: true, end: { id: source.id, kind: 'source', title: 'Pool source', identifier: source.identifier, withdrawn: true } },
      { id: section.id, visibleTo: everyone, linkable: true, end: { id: section.id, kind: 'entry_section', title: 'Pool journal entry', identifier: journal.identifier, withdrawn: false } },
      { id: scan.id, visibleTo: everyone, linkable: true, end: { id: scan.id, kind: 'attachment', title: 'Pool scan', identifier: scan.identifier, withdrawn: false } },
      { id: reply.id, visibleTo: everyone, linkable: true, end: { id: reply.id, kind: 'reply', title: 'Pool finding', identifier: finding.identifier, withdrawn: false } },
      { id: draft.id, visibleTo: (actor) => actor === 'colleague', linkable: true, end: { id: draft.id, kind: 'finding', title: 'Pool draft', identifier: draft.identifier, withdrawn: false } },
      { id: deleted.id, visibleTo: () => false, linkable: true },
      { id: note.id, visibleTo: everyone, linkable: false },
      { id: newULID(at), visibleTo: () => false, linkable: true },
    ];

    await fc.assert(fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 14 }), async (steps) => {
      await core().prepare('DELETE FROM cross_links').run();
      const links: ModelLink[] = [];
      const active = () => links.filter((link) => link.removedBy === undefined);
      const refusal = (add: { actor: Actor; origin: number; target: number; label: number }) => {
        const fields: { field: string; rule: string }[] = [];
        for (const [field, index] of [['originId', add.origin], ['targetId', add.target]] as const) {
          const unit = pool[index]!;
          if (!unit.visibleTo(add.actor)) fields.push({ field, rule: RULES.missing });
          else if (!unit.linkable) fields.push({ field, rule: RULES.unlinkable });
        }
        if (add.origin === add.target) fields.push({ field: 'targetId', rule: RULES.self });
        const label = LABELS[add.label];
        if (label?.state === 'unknown') fields.push({ field: 'relationValueId', rule: RULES.unknown });
        if (label?.state === 'retired') fields.push({ field: 'relationValueId', rule: RULES.retired });
        if (fields.length === 0 && active().some((link) => link.origin === add.origin && link.target === add.target && link.label === add.label)) fields.push({ field: 'targetId', rule: RULES.duplicate });
        return fields;
      };
      const post = (add: { actor: Actor; origin: number; target: number; label: number }) => call(api, bindings, tokens[add.actor], 'POST', '/links', {
        originId: pool[add.origin]!.id, targetId: pool[add.target]!.id, ...(LABELS[add.label] ? { relationValueId: LABELS[add.label]!.id } : {}),
      });
      const record = async (add: { actor: Actor; origin: number; target: number; label: number }, response: Response) => {
        const { link } = await response.json<{ link: LinkEntry }>();
        expect(link.end).toEqual(pool[add.target]!.end);
        links.push({ id: link.id, origin: add.origin, target: add.target, label: add.label, addedBy: add.actor });
      };

      for (const step of steps) {
        if (step.kind === 'add') {
          const fields = refusal(step.add);
          const response = await post(step.add);
          if (fields.length === 0) {
            expect(response.status).toBe(201);
            await record(step.add, response);
          } else {
            expect([response.status, await response.json()]).toEqual([422, { error: 'validation', fields }]);
          }
        } else if (step.kind === 'race') {
          const fields = refusal(step.add);
          const responses = await Promise.all([post(step.add), post(step.add)]);
          if (fields.length > 0) {
            for (const response of responses) expect([response.status, await response.json()]).toEqual([422, { error: 'validation', fields }]);
          } else {
            expect(responses.map((response) => response.status).sort()).toEqual([201, 422]);
            const loser = responses.find((response) => response.status === 422)!;
            expect(await loser.json()).toEqual({ error: 'validation', fields: [{ field: 'targetId', rule: RULES.duplicate }] });
            await record(step.add, responses.find((response) => response.status === 201)!);
          }
        } else if (links.length > 0) {
          const link = links[step.link % links.length]!;
          const response = await call(api, bindings, tokens[step.actor], 'DELETE', `/links/${link.id}`);
          if (link.removedBy !== undefined || !pool[link.origin]!.visibleTo(step.actor)) expect(response.status).toBe(404);
          else if (step.actor !== link.addedBy && step.actor !== 'admin') expect(response.status).toBe(403);
          else {
            expect(response.status).toBe(200);
            link.removedBy = step.actor;
          }
        }
      }

      const byId = <T extends { id: string }>(rows: readonly T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
      const listed = async (viewer: Actor, query: string) => {
        const response = await call(api, bindings, tokens[viewer], 'GET', `/links?${query}`);
        return response.status === 200 ? (await response.json<{ entries: LinkEntry[] }>()).entries : response.status;
      };
      const shape = (link: ModelLink, end: number) => ({
        id: link.id, relation: LABELS[link.label] ? { id: LABELS[link.label]!.id, name: LABELS[link.label]!.name } : null,
        addedBy: { id: ids[link.addedBy], displayName: `Member ${ids[link.addedBy]}` }, addedAt: at,
        ...(link.removedBy === undefined ? {} : { removedBy: { id: ids[link.removedBy], displayName: `Member ${ids[link.removedBy]}` }, removedAt: at }),
        end: pool[end]!.end,
      });
      const checks: [Actor, string, unknown][] = [];
      for (const viewer of ['author', 'colleague'] as const) {
        for (const [index, unit] of pool.entries()) {
          if (!unit.end) continue;
          if (!unit.visibleTo(viewer)) {
            checks.push([viewer, `target=${unit.id}`, 404]);
            continue;
          }
          const seen = (end: number) => pool[end]!.visibleTo(viewer);
          checks.push(
            [viewer, `target=${unit.id}`, byId(active().filter((link) => link.target === index && seen(link.origin)).map((link) => shape(link, link.origin)))],
            [viewer, `origin=${unit.id}`, byId(active().filter((link) => link.origin === index && seen(link.target)).map((link) => shape(link, link.target)))],
            [viewer, `origin=${unit.id}&removed=true`, byId(links.filter((link) => link.origin === index && seen(link.target)).map((link) => shape(link, link.target)))],
          );
        }
      }
      const actual = await Promise.all(checks.map(([viewer, query]) => listed(viewer, query)));
      expect(actual).toEqual(checks.map(([, , expected]) => expected));
    }));
  }, 200 * FC_RUNS);
});
