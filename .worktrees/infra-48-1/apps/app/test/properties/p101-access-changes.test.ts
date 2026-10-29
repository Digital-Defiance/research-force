// Feature: research-collab-cms, Property 101: Only the Owner widens access, and restricting unpublishes
import { beforeAll, describe, expect, it } from 'vitest';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { asTimestamp } from '@researchforce/domain/types';
import type { ULID } from '@researchforce/domain/types';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { assertionSpec, signAssertion, testAccess } from '@researchforce/testing/jwt';
import type { TestAccess } from '@researchforce/testing/jwt';
import type { Env } from '../../src/env';
import type { AccessPreview } from '../../src/records/access';
import { migrated } from '../d1';
import { addMember, call, KeyServer, resetPeople, testApi } from '../api';
import { itemBody } from '../items';
import { addElement, addProject, addSubmissionRow, resetRecords } from '../units';

/**
 * Validates R47.6, R47.7, R47.8, R47.12, R47.14: against a model of each item's Access_Level, Access_List, and unit
 * levels, a change applies to every chosen item or none; it widens (a Member gains read access, or Restricted becomes
 * Whole_Team) only from the Owner and narrows only from the Owner or an Administrator; widening or restricting needs the
 * preview's confirmation; restricting resets every Public or Withheld unit to Not_Published with a Disclosure_Change and
 * Item_Update events for every active Administrator; every change records one Access_Change; edits never change access;
 * and reads follow the new access at once.
 */
const ACTORS = ['author', 'colleague', 'admin'] as const;
const MEMBERS = ['author', 'colleague', 'admin', 'admin2', 'revoked'] as const;
type Actor = (typeof ACTORS)[number];
type Who = (typeof MEMBERS)[number];
type Level = 'whole_team' | 'restricted';

interface ModelItem { readonly id: ULID; readonly owner: Actor; level: Level; list: Set<Who>; readonly units: { readonly id: ULID; level: string }[] }

const changeArb = fc.record({
  kind: fc.constant('change' as const),
  actor: fc.constantFrom(...ACTORS),
  items: fc.uniqueArray(fc.nat({ max: 2 }), { minLength: 1, maxLength: 3 }),
  level: fc.constantFrom<Level | undefined>(undefined, 'whole_team', 'restricted'),
  add: fc.subarray(['author', 'colleague', 'admin', 'admin2', 'revoked'] as Who[], { maxLength: 2 }),
  remove: fc.subarray(['author', 'colleague', 'admin', 'admin2'] as Who[], { maxLength: 2 }),
  confirm: fc.boolean(),
});
const stepArb = fc.oneof(
  { weight: 6, arbitrary: changeArb },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('publish' as const), item: fc.nat({ max: 2 }), unit: fc.nat({ max: 1 }), level: fc.constantFrom('public', 'withheld') }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('edit' as const), item: fc.nat({ max: 2 }) }) },
);

let bindings: Env;
let access: TestAccess;
beforeAll(async () => {
  bindings = await migrated();
  access = await testAccess();
});

describe('Property 101: Only the Owner widens access, and restricting unpublishes', () => {
  it('applies each access change to every item or none, as the model decides', async () => {
    const now = new Date('2026-10-27T18:00:00.000Z');
    const at = asTimestamp(now.toISOString());
    const core = () => bindings.RF_CORE;
    await resetPeople(core());
    const ids: Record<Who, ULID> = {
      author: await addMember(core(), 'author@example.test', 'active', at),
      colleague: await addMember(core(), 'colleague@example.test', 'active', at),
      admin: await addMember(core(), 'admin@example.test', 'active', at, ROLE_IDS.administrator),
      admin2: await addMember(core(), 'admin2@example.test', 'active', at, ROLE_IDS.administrator),
      revoked: await addMember(core(), 'revoked@example.test', 'revoked', at),
    };
    const byId = new Map(MEMBERS.map((who) => [ids[who], who]));
    const api = testApi(access, new KeyServer(access), now);
    const tokens = Object.fromEntries(await Promise.all(ACTORS.map(async (who) => [who, (await signAssertion(access, assertionSpec(`${who}@example.test`), now))!]))) as Record<Actor, string>;
    const isAdmin = (who: Who) => who === 'admin' || who === 'admin2';

    const startArb = fc.record({
      owner: fc.constantFrom(...ACTORS),
      level: fc.constantFrom<Level>('whole_team', 'restricted'),
      list: fc.subarray(['author', 'colleague', 'admin2'] as Who[]),
      units: fc.tuple(fc.constantFrom('not_published', 'public', 'withheld'), fc.constantFrom('not_published', 'public', 'withheld')),
    });
    await fc.assert(fc.asyncProperty(fc.array(startArb, { minLength: 3, maxLength: 3 }), fc.array(stepArb, { minLength: 1, maxLength: 8 }), async (starts, steps) => {
      await resetRecords(core());
      const projectId = await addProject(core(), ids.admin, at);
      const items: ModelItem[] = [];
      for (const { owner } of starts) {
        const place = { projectId, ownerId: ids[owner], submissionId: await addSubmissionRow(core(), ids[owner], at), now: at };
        const created = await call(api, bindings, tokens[owner], 'POST', '/items/finding', itemBody('finding', projectId));
        expect(created.status).toBe(201);
        const { item } = await created.json<{ item: { id: ULID } }>();
        const attachment = await addElement(core(), place, 'attachment', item.id);
        items.push({ id: item.id, owner, level: 'whole_team', list: new Set(), units: [{ id: item.id, level: 'not_published' }, { id: attachment.id, level: 'not_published' }] });
      }
      const publish = async (unit: { id: ULID; level: string }, level: string) => {
        await core().prepare("UPDATE units SET disclosure_level = ?2, disclosure_line = CASE WHEN ?2 = 'withheld' THEN ?3 ELSE disclosure_line END WHERE id = ?1")
          .bind(unit.id, level, JSON.stringify({ kindOfMaterial: 'Synthetic letters', date: { value: '2026', approx: false }, partyIds: [] })).run();
        unit.level = level;
      };
      for (const [index, start] of starts.entries()) {
        const item = items[index]!;
        if (start.level === 'whole_team') {
          for (const [at, level] of start.units.entries()) await publish(item.units[at]!, level);
          continue;
        }
        item.level = 'restricted';
        item.list = new Set(start.list.filter((who) => who !== item.owner));
        await core().batch([
          core().prepare("UPDATE research_items SET access_level = 'restricted' WHERE unit_id = ?1").bind(item.id),
          ...[...item.list].map((who) => core().prepare('INSERT INTO access_grants (root_id, member_id, granted_by, granted_at) VALUES (?1, ?2, ?3, ?4)').bind(item.id, ids[who], ids[item.owner], at)),
        ]);
      }
      const counts = { access: 0, disclosure: 0, events: 0 };
      const readers = (item: ModelItem, level: Level, list: ReadonlySet<Who>) => new Set<Who>(level === 'whole_team' ? MEMBERS : [item.owner, ...list, 'admin', 'admin2']);
      const canRead = (who: Who, item: ModelItem) => readers(item, item.level, item.list).has(who);

      for (const step of steps) {
        if (step.kind === 'publish') {
          const item = items[step.item]!;
          if (item.level === 'restricted') continue;
          await publish(item.units[step.unit]!, step.level);
        } else if (step.kind === 'edit') {
          const item = items[step.item]!;
          const { item: view } = await (await call(api, bindings, tokens[item.owner], 'GET', `/items/${item.id}`)).json<{ item: { rev: number } }>();
          const edited = await call(api, bindings, tokens[item.owner], 'PATCH', `/items/${item.id}`, { rev: view.rev, title: `Edited ${view.rev}`, mark: { mark: 'minor_edit' } });
          expect(edited.status).toBe(200);
        } else {
          const chosen = step.items.map((index) => items[index]!);
          const body = { ...(step.level === undefined ? {} : { level: step.level }), ...(step.add.length > 0 ? { add: step.add.map((who) => ids[who]) } : {}), ...(step.remove.length > 0 ? { remove: step.remove.map((who) => ids[who]) } : {}) };
          const single = chosen.length === 1;
          const paths = single ? { preview: `/items/${chosen[0]!.id}/access/preview`, apply: `/items/${chosen[0]!.id}/access` } : { preview: '/access/bulk/preview', apply: '/access/bulk' };
          const payload = single ? body : { ...body, itemIds: chosen.map((item) => item.id) };

          const unreadable = chosen.some((item) => !canRead(step.actor, item));
          const invalid = step.add.includes('revoked') || step.add.some((who) => step.remove.includes(who)) || (step.level === 'whole_team' && step.add.length > 0);
          const plans = chosen.map((item) => {
            const level = step.level ?? item.level;
            const list = new Set<Who>(level === 'whole_team' ? [] : [...item.list, ...step.add]);
            for (const who of [...step.remove, item.owner]) list.delete(who);
            const before = readers(item, item.level, item.list);
            const gaining = [...readers(item, level, list)].filter((who) => !before.has(who));
            const changed = level !== item.level || list.size !== item.list.size || [...list].some((who) => !item.list.has(who));
            const widens = gaining.length > 0 || (item.level === 'restricted' && level === 'whole_team');
            const refused = (changed && widens && step.actor !== item.owner) || (changed && !widens && step.actor !== item.owner && !isAdmin(step.actor)) || (level === 'whole_team' && step.add.length > 0);
            const resets = changed && level === 'restricted' ? item.units.filter((unit) => unit.level !== 'not_published') : [];
            return { item, level, list, changed, widens, refused, resets, restricting: item.level === 'whole_team' && level === 'restricted' };
          });
          const needsConfirmation = plans.some((plan) => plan.changed && (plan.widens || plan.restricting || plan.resets.length > 0));

          const preview = await call(api, bindings, tokens[step.actor], 'POST', paths.preview, payload);
          if (unreadable && single && !invalid) {
            expect(preview.status).toBe(404);
            expect((await call(api, bindings, tokens[step.actor], 'POST', paths.apply, payload)).status).toBe(404);
            continue;
          }
          if (unreadable || invalid) {
            expect(preview.status).toBe(422);
            expect((await call(api, bindings, tokens[step.actor], 'POST', paths.apply, payload)).status).toBe(422);
            continue;
          }
          expect(preview.status).toBe(200);
          const shown = await preview.json<AccessPreview>();
          expect(shown.confirmation !== null).toBe(needsConfirmation);
          expect(shown.items.filter((entry) => entry.refusal !== undefined).map((entry) => entry.id).sort()).toEqual(plans.filter((plan) => plan.refused).map((plan) => plan.item.id).sort());
          const gaining = new Set(plans.filter((plan) => plan.changed).flatMap((plan) => [...readers(plan.item, plan.level, plan.list)].filter((who) => !readers(plan.item, plan.item.level, plan.item.list).has(who))));
          expect(shown.gaining.map((member) => byId.get(member.id)).sort()).toEqual([...gaining].filter((who) => who !== 'revoked').sort());
          expect(shown.resets.map((unit) => unit.unitId).sort()).toEqual(plans.flatMap((plan) => plan.resets.map((unit) => unit.id)).sort());

          const applied = await call(api, bindings, tokens[step.actor], 'POST', paths.apply, { ...payload, ...(step.confirm && shown.confirmation !== null ? { confirmation: shown.confirmation } : {}) });
          if (plans.some((plan) => plan.refused)) {
            expect(applied.status).toBe(403);
            continue;
          }
          if (needsConfirmation && !step.confirm) {
            expect(applied.status).toBe(409);
            continue;
          }
          expect(applied.status).toBe(200);
          for (const plan of plans.filter((entry) => entry.changed)) {
            counts.access += 1;
            counts.disclosure += plan.resets.length;
            if (plan.restricting) counts.events += isAdmin(step.actor) ? 1 : 2; // the acting Administrator is not told of their own action (R19.4)
            for (const unit of plan.resets) unit.level = 'not_published';
            plan.item.level = plan.level;
            plan.item.list = plan.list;
          }
        }

        const [levelRows, grantRows, unitRows, revisionRows, eventRows] = await core().batch([
          core().prepare('SELECT unit_id AS id, access_level AS level FROM research_items'),
          core().prepare('SELECT root_id AS rootId, member_id AS memberId FROM access_grants'),
          core().prepare("SELECT id, disclosure_level AS level FROM units WHERE unit_type IN ('research_item', 'attachment')"),
          core().prepare("SELECT kind, count(*) AS n FROM revisions WHERE kind IN ('access_change', 'disclosure_change') GROUP BY kind"),
          core().prepare("SELECT count(*) AS n FROM notification_events WHERE event_type = 'item_update'"),
        ]);
        const sorted = <T>(rows: T[]) => rows.map((row) => JSON.stringify(row)).sort();
        expect(sorted(levelRows!.results)).toEqual(sorted(items.map((item) => ({ id: item.id, level: item.level }))));
        expect(sorted(grantRows!.results)).toEqual(sorted(items.flatMap((item) => [...item.list].map((who) => ({ rootId: item.id, memberId: ids[who] })))));
        expect(sorted(unitRows!.results)).toEqual(sorted(items.flatMap((item) => item.units.map((unit) => ({ id: unit.id, level: unit.level })))));
        const revisions = Object.fromEntries((revisionRows!.results as { kind: string; n: number }[]).map((row) => [row.kind, row.n]));
        expect([revisions['access_change'] ?? 0, revisions['disclosure_change'] ?? 0, (eventRows!.results[0] as { n: number }).n]).toEqual([counts.access, counts.disclosure, counts.events]);
        for (const item of items) {
          if (item.level === 'restricted') expect(item.units.every((unit) => unit.level === 'not_published')).toBe(true);
        }
        const statuses = await Promise.all(items.map(async (item) => (await call(api, bindings, tokens.colleague, 'GET', `/items/${item.id}`)).status));
        expect(statuses).toEqual(items.map((item) => (canRead('colleague', item) ? 200 : 404)));
      }
    }), { numRuns: FC_RUNS });
  }, 600 * FC_RUNS);
});
