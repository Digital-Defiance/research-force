// Feature: research-collab-cms, Property 65: Workspace lists filter by conjunction and page losslessly
import { beforeAll, describe, expect, it } from 'vitest';
import { GuardedBatch } from '@researchforce/db/batch';
import { identifiers, researchItems, units } from '@researchforce/db/schema/core';
import { todayInZone } from '@researchforce/domain/dates';
import { newItemIdentifier, newULID } from '@researchforce/domain/identifiers';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { asTimestamp, asULID } from '@researchforce/domain/types';
import type { CreditEntry, ItemKind, Timestamp, ULID } from '@researchforce/domain/types';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { assertionSpec, signAssertion, testAccess } from '@researchforce/testing/jwt';
import type { TestAccess } from '@researchforce/testing/jwt';
import type { Env } from '../../src/env';
import type { LogPage } from '../../src/projects/log';
import { migrated } from '../d1';
import { addMember, call, KeyServer, resetPeople, SPECIALTY, testApi } from '../api';
import type { TestApi } from '../api';
import { addFinding, addCorrespondence } from '../lists';
import { addProject, addSubmissionRow, resetRecords } from '../units';

/**
 * Validates R3.4, R5.7, R7.6, R8.5, R9.7, R10.4, R18.8, R18.9, R23.8, R26.8, R39.14, R39.16, R43.1, R43.2, R43.4,
 * R43.5: against an independent in-memory model of each Workspace list — the Project_Log and the record-kind ledgers —
 * the real list APIs filter by CONJUNCTION and page LOSSLESSLY. Over randomised item sets and randomised filter
 * combinations, the id set the API returns equals the set the model keeps: every entry that matches EVERY chosen filter
 * AND the viewer's Can_Read gate AND the completed-Submission rule, and no other. Paging the whole list with the cursor
 * (page size 50) yields every matching entry exactly once in the modelled order — the concatenation of all pages equals
 * the full ordered matching set, with no duplicates and no gaps — asserted for the Project_Log newest- and oldest-first
 * (including the viewer-zone same-day reorder across a page boundary), the Findings ledger, and the Correspondences
 * ledger. The Projects list's Research_Item count (R39.16/R47.11) never includes a Restricted Item the viewer cannot
 * read. The model is authored here from the requirements, never by calling the production query.
 */

const KINDS: readonly ItemKind[] = ['finding', 'run', 'hypothesis', 'journal_entry', 'correspondence'];
const CRYPTANALYSIS = asULID('0000000000000000000000S003');
const DAY_MS = 86_400_000;
type Who = 'author' | 'colleague' | 'admin';
const WHO: readonly Who[] = ['author', 'colleague', 'admin'];

let bindings: Env;
let access: TestAccess;
let api: TestApi;
const now = new Date('2026-10-27T18:00:00.000Z');
const at = asTimestamp(now.toISOString());
const core = (): D1Database => bindings.RF_CORE;

beforeAll(async () => {
  bindings = await migrated();
  access = await testAccess();
  api = testApi(access, new KeyServer(access), now);
});

/** Fresh people and records, three Members (author, colleague, Administrator) and one Project, returning their ids and tokens. */
async function freshWorld(): Promise<{ ids: Record<Who, ULID>; tokens: Record<Who, string>; projectId: ULID }> {
  await resetPeople(core());
  await resetRecords(core());
  const ids: Record<Who, ULID> = {
    author: await addMember(core(), 'author@example.test', 'active', at),
    colleague: await addMember(core(), 'colleague@example.test', 'active', at),
    admin: await addMember(core(), 'admin@example.test', 'active', at, ROLE_IDS.administrator),
  };
  const tokens = Object.fromEntries(await Promise.all(WHO.map(async (who) =>
    [who, (await signAssertion(access, assertionSpec(`${who}@example.test`), now))!]))) as Record<Who, string>;
  const projectId = await addProject(core(), ids.admin, at);
  return { ids, tokens, projectId };
}

/** The viewer-readable rule shared by every list: Whole_Team, or the viewer is the Owner, an Administrator, or on the Access_List. */
function canRead(viewer: Who, item: { ownerId: ULID; restrictedTo: readonly ULID[] | null }, ids: Record<Who, ULID>): boolean {
  if (item.restrictedTo === null) return true;
  if (viewer === 'admin') return true;
  if (ids[viewer] === item.ownerId) return true;
  return item.restrictedTo.includes(ids[viewer]);
}

// --- The Project_Log inserter: full control of the Log_Date key, creation flag, kind, credit, access, completion. ---

async function addLogItem(place: { projectId: ULID; ownerId: ULID }, options: {
  readonly createdAt: Timestamp; readonly kind?: ItemKind; readonly logDateKey: string; readonly logDateIsCreation?: boolean;
  readonly credit?: readonly CreditEntry[]; readonly restrictedTo?: readonly ULID[]; readonly completed?: boolean;
}): Promise<ULID> {
  const id = newULID(options.createdAt);
  const { identifier, registryKey } = newItemIdentifier();
  const kind = options.kind ?? 'finding';
  const submissionId = await addSubmissionRow(core(), place.ownerId, options.createdAt, options.completed ?? true);
  await new GuardedBatch(core(), { id: place.ownerId, now: options.createdAt })
    .insert(units, {
      id, unitType: 'research_item', projectId: place.projectId, rootId: id, ownerId: place.ownerId,
      credit: options.credit ?? [{ member: place.ownerId }], submissionId, createdAt: options.createdAt,
    })
    .insert(researchItems, {
      unitId: id, kind, itemIdentifier: identifier, projectId: place.projectId, title: `Item ${id}`,
      itemDateKey: options.logDateKey, logDateKey: options.logDateKey, logDateIsCreation: options.logDateIsCreation ?? false,
      logSummary: `Summary of ${id}`, logSummarySpans: [],
      ...(options.restrictedTo === undefined ? {} : { accessLevel: 'restricted' as const }),
    })
    .insert(identifiers, { identifierLc: registryKey, identifier, unitId: id, issuedAt: options.createdAt })
    .commit();
  for (const member of options.restrictedTo ?? []) {
    await core().prepare('INSERT INTO access_grants (root_id, member_id, granted_by, granted_at) VALUES (?1, ?2, ?3, ?4)')
      .bind(id, member, place.ownerId, options.createdAt).run();
  }
  return id;
}

/** Read one page of the Project_Log, failing the test on any refusal. */
async function logPage(token: string, projectId: ULID, query = ''): Promise<LogPage> {
  const response = await call(api, bindings, token, 'GET', `/projects/${projectId}/log${query}`);
  if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return response.json<LogPage>();
}

/** Every Project_Log page concatenated in order, following the cursor to the end (R43.1). */
async function allLogIds(token: string, projectId: ULID, query = ''): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | null = null;
  do {
    const page: LogPage = await logPage(token, projectId, `${query}${query.includes('?') ? '&' : '?'}${cursor === null ? '' : `cursor=${encodeURIComponent(cursor)}`}`);
    out.push(...page.entries.map((entry) => entry.id));
    cursor = page.next;
  } while (cursor !== null);
  return out;
}

interface Page { entries: { id: string; [k: string]: unknown }[]; next: string | null }
/** Every list page concatenated in order, following the cursor to the end (R43.1, R18.8). */
async function allListIds(token: string, path: string): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | null = null;
  do {
    const url = `${path}${path.includes('?') ? '&' : '?'}${cursor === null ? '' : `cursor=${encodeURIComponent(cursor)}`}`;
    const response = await call(api, bindings, token, 'GET', url);
    if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
    const page = await response.json<Page>();
    out.push(...page.entries.map((entry) => entry.id));
    cursor = page.next;
  } while (cursor !== null);
  return out;
}

describe('Property 65: Workspace lists filter by conjunction and page losslessly', () => {
  // --- The Project_Log: conjunction of its filters, both orders, lossless paging, Can_Read, completed-Submission. ----
  it('returns the conjunction of the Project_Log filters and pages both orders losslessly', async () => {
    const owners: readonly Who[] = ['author', 'admin'];
    const KEYS = Array.from({ length: 10 }, (_v, index) => new Date(Date.UTC(1943, 4, 1) + index * DAY_MS).toISOString().slice(0, 10));
    const itemArb = fc.record({
      owner: fc.constantFrom(...owners),
      kind: fc.constantFrom(...KINDS),
      logDateKey: fc.constantFrom(...KEYS),
      minute: fc.nat({ max: 59 }),
      creditColleague: fc.boolean(),
      completed: fc.boolean(),
      restricted: fc.boolean(),
    });
    const filterArb = fc.record({
      itemKind: fc.option(fc.constantFrom(...KINDS), { nil: undefined }),
      member: fc.option(fc.constantFrom('author', 'colleague', 'admin') as fc.Arbitrary<Who>, { nil: undefined }),
      specialty: fc.option(fc.constantFrom(SPECIALTY, CRYPTANALYSIS), { nil: undefined }),
      range: fc.option(fc.tuple(fc.constantFrom(...KEYS), fc.constantFrom(...KEYS)).map(([a, b]) => (a <= b ? [a, b] : [b, a]) as const), { nil: undefined }),
      viewer: fc.constantFrom('author', 'colleague', 'admin') as fc.Arbitrary<Who>,
    });

    await fc.assert(fc.asyncProperty(fc.array(itemArb, { minLength: 10, maxLength: 60 }), fc.array(filterArb, { minLength: 2, maxLength: 5 }), async (specs, filters) => {
      const { ids, tokens, projectId } = await freshWorld();
      // The colleague carries a second Specialty so a Specialty filter can split the set (the other two keep the seeded one).
      await core().prepare('UPDATE profile_specialties SET value_id = ?2 WHERE member_id = ?1').bind(ids.colleague, CRYPTANALYSIS).run();
      const specialtyOf: Record<Who, ULID> = { author: SPECIALTY, admin: SPECIALTY, colleague: CRYPTANALYSIS };

      interface Model { id: ULID; owner: Who; kind: ItemKind; logDateKey: string; createdAt: Timestamp; credit: Who[]; completed: boolean; restrictedTo: ULID[] | null }
      const model: Model[] = [];
      for (const [index, spec] of specs.entries()) {
        const createdAt = asTimestamp(`2026-10-27T10:${String(spec.minute).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`);
        const credit: Who[] = [spec.owner, ...(spec.creditColleague ? ['colleague' as const] : [])];
        const restrictedTo = spec.restricted ? [] : null;
        const id = await addLogItem({ projectId, ownerId: ids[spec.owner] }, {
          createdAt, kind: spec.kind, logDateKey: spec.logDateKey, completed: spec.completed,
          credit: credit.map((who) => ({ member: ids[who] })), ...(restrictedTo === null ? {} : { restrictedTo }),
        });
        model.push({ id, owner: spec.owner, kind: spec.kind, logDateKey: spec.logDateKey, createdAt, credit, completed: spec.completed, restrictedTo });
      }

      for (const filter of filters) {
        // The independent conjunction + visibility model: an entry matches iff it satisfies EVERY set filter, the
        // viewer Can_Read it, and its Submission completed. Owners here use recorded Log_Dates, so the viewer-zone
        // key is the stored key and the range compares date strings directly (R43.4). All Members are UTC here.
        const matches = model.filter((entry) => {
          if (!entry.completed) return false;
          if (!canRead(filter.viewer, { ownerId: ids[entry.owner], restrictedTo: entry.restrictedTo }, ids)) return false;
          if (filter.itemKind !== undefined && entry.kind !== filter.itemKind) return false;
          const people = [entry.owner, ...entry.credit];
          if (filter.member !== undefined && !people.includes(filter.member)) return false;
          if (filter.specialty !== undefined && !people.some((who) => specialtyOf[who] === filter.specialty)) return false;
          if (filter.range !== undefined && (entry.logDateKey < filter.range[0] || entry.logDateKey > filter.range[1])) return false;
          return true;
        });
        // Newest first: Log_Date key then creation time then id, descending. Oldest first is the exact reverse.
        const ordered = [...matches].sort((a, b) =>
          (a.logDateKey < b.logDateKey ? -1 : a.logDateKey > b.logDateKey ? 1 : a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
        const newest = [...ordered].reverse().map((entry) => entry.id);
        const oldest = ordered.map((entry) => entry.id);

        const parts = [
          filter.itemKind === undefined ? '' : `itemKind=${filter.itemKind}`,
          filter.member === undefined ? '' : `member=${ids[filter.member]}`,
          filter.specialty === undefined ? '' : `specialty=${filter.specialty}`,
          filter.range === undefined ? '' : `from=${filter.range[0]}&to=${filter.range[1]}`,
        ].filter((part) => part !== '');
        const query = parts.length === 0 ? '' : `?${parts.join('&')}`;
        const token = tokens[filter.viewer];

        // Conjunction: the full returned set (across every page) equals the modelled set.
        expect([...await allLogIds(token, projectId, query)].sort()).toEqual([...newest].sort());
        // Lossless paging in each order: the concatenation of all pages equals the modelled ordered set.
        expect(await allLogIds(token, projectId, query)).toEqual(newest);
        expect(await allLogIds(token, projectId, `${query}${query === '' ? '?' : '&'}order=oldest`)).toEqual(oldest);
      }
    }), { numRuns: FC_RUNS });
  }, 1200 * FC_RUNS);

  // --- The viewer-zone same-day reorder across the 50-boundary (the subtle R43.2 case), driven by a generator. ------
  it('keeps the viewer-zone Log_Date order across a page boundary so the Project_Log pages concatenate losslessly', async () => {
    // Every item is 2026-10-28 in Auckland (UTC+13): creation-date items keyed 2026-10-27 whose 23:xx Z instant is the
    // next day in Auckland, interleaved with recorded-date items keyed 2026-10-28. The UTC-key order (28 then 27) thus
    // differs from the viewer-zone order (by instant), so the page boundary is only correct after the viewer-zone sort.
    const flagsArb = fc.array(fc.boolean(), { minLength: 55, maxLength: 70 });
    await fc.assert(fc.asyncProperty(flagsArb, async (creationFlags) => {
      const { ids, tokens, projectId } = await freshWorld();
      await core().prepare("UPDATE profiles SET time_zone = 'Pacific/Auckland' WHERE member_id = ?1").bind(ids.colleague).run();
      const place = { projectId, ownerId: ids.author };
      const expected: { id: string; instant: number }[] = [];
      for (const [index, creation] of creationFlags.entries()) {
        const createdAt = asTimestamp(`2026-10-27T23:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`);
        const id = await addLogItem(place, { logDateKey: creation ? '2026-10-27' : '2026-10-28', createdAt, logDateIsCreation: creation });
        // In Auckland every item's viewer-zone Log_Date is 2026-10-28, so the order is purely by instant then id.
        expect(todayInZone(createdAt, 'Pacific/Auckland').value).toBe('2026-10-28');
        expected.push({ id, instant: Date.parse(createdAt) });
      }
      // Newest first in Auckland: descending instant then descending id.
      expected.sort((a, b) => b.instant - a.instant || (a.id < b.id ? 1 : -1));
      const concatenated = await allLogIds(tokens.colleague, projectId);
      expect(concatenated).toEqual(expected.map((entry) => entry.id));
      expect(new Set(concatenated).size).toBe(expected.length);
    }), { numRuns: Math.min(FC_RUNS, 20) });
  }, 1800 * FC_RUNS);

  // --- The Findings ledger: conjunction of its filters + multi-Project, lossless paging, Can_Read, Restricted mark. --
  it('returns the conjunction of the Findings filters across Projects and pages losslessly', async () => {
    const FINDING_OPEN = asULID('00000000000000000000000020');
    const FINDING_CONFIRMED = asULID('00000000000000000000000021');
    const STATUSES = [FINDING_OPEN, FINDING_CONFIRMED] as const;
    const findingArb = fc.record({
      owner: fc.constantFrom('author', 'admin') as fc.Arbitrary<'author' | 'admin'>,
      project: fc.boolean(),
      minute: fc.nat({ max: 59 }),
      second: fc.nat({ max: 59 }),
      status: fc.constantFrom(...STATUSES),
      creditColleague: fc.boolean(),
      completed: fc.boolean(),
      restricted: fc.boolean(),
    });
    const filterArb = fc.record({
      status: fc.option(fc.constantFrom(...STATUSES), { nil: undefined }),
      person: fc.option(fc.constantFrom('author', 'colleague', 'admin') as fc.Arbitrary<Who>, { nil: undefined }),
      specialty: fc.option(fc.constantFrom(SPECIALTY, CRYPTANALYSIS), { nil: undefined }),
      projects: fc.option(fc.constantFrom('a', 'b', 'both') as fc.Arbitrary<'a' | 'b' | 'both'>, { nil: undefined }),
      viewer: fc.constantFrom('author', 'colleague', 'admin') as fc.Arbitrary<Who>,
    });

    await fc.assert(fc.asyncProperty(fc.array(findingArb, { minLength: 10, maxLength: 60 }), fc.array(filterArb, { minLength: 2, maxLength: 5 }), async (specs, filters) => {
      const { ids, tokens, projectId } = await freshWorld();
      const projectB = await addProject(core(), ids.admin, at);
      await core().prepare('UPDATE profile_specialties SET value_id = ?2 WHERE member_id = ?1').bind(ids.colleague, CRYPTANALYSIS).run();
      const specialtyOf: Record<Who, ULID> = { author: SPECIALTY, admin: SPECIALTY, colleague: CRYPTANALYSIS };

      interface Model { id: ULID; owner: Who; project: ULID; createdAt: Timestamp; status: ULID; credit: Who[]; completed: boolean; restrictedTo: ULID[] | null }
      const model: Model[] = [];
      for (const [index, spec] of specs.entries()) {
        const createdAt = asTimestamp(`2026-10-27T10:${String(spec.minute).padStart(2, '0')}:${String(spec.second).padStart(2, '0')}.${String(index).padStart(3, '0')}Z`);
        const credit: Who[] = [spec.owner, ...(spec.creditColleague ? ['colleague' as const] : [])];
        const restrictedTo = spec.restricted ? [] : null;
        const project = spec.project ? projectB : projectId;
        const { id } = await addFinding({ core: core(), projectId: project, ownerId: ids[spec.owner], now: at }, {
          createdAt, status: spec.status, completed: spec.completed, credit: credit.map((who) => ({ member: ids[who] })),
          ...(restrictedTo === null ? {} : { restrictedTo }),
        });
        model.push({ id, owner: spec.owner, project, createdAt, status: spec.status, credit, completed: spec.completed, restrictedTo });
      }

      for (const filter of filters) {
        const projectSet = filter.projects === undefined ? undefined : filter.projects === 'a' ? [projectId] : filter.projects === 'b' ? [projectB] : [projectId, projectB];
        const matches = model.filter((entry) => {
          if (!entry.completed) return false;
          if (!canRead(filter.viewer, { ownerId: ids[entry.owner], restrictedTo: entry.restrictedTo }, ids)) return false;
          if (filter.status !== undefined && entry.status !== filter.status) return false;
          const people = [entry.owner, ...entry.credit];
          if (filter.person !== undefined && !people.includes(filter.person)) return false;
          if (filter.specialty !== undefined && !people.some((who) => specialtyOf[who] === filter.specialty)) return false;
          if (projectSet !== undefined && !projectSet.includes(entry.project)) return false;
          return true;
        });
        // Newest first by creation time then id.
        const ordered = [...matches].sort((a, b) =>
          (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1)).map((entry) => entry.id);
        const parts = [
          filter.status === undefined ? '' : `status=${filter.status}`,
          filter.person === undefined ? '' : `person=${ids[filter.person]}`,
          filter.specialty === undefined ? '' : `specialty=${filter.specialty}`,
          ...(projectSet === undefined ? [] : projectSet.map((id) => `project=${id}`)),
        ].filter((part) => part !== '');
        const path = `/lists/findings${parts.length === 0 ? '' : `?${parts.join('&')}`}`;
        const got = await allListIds(tokens[filter.viewer], path);
        expect([...got].sort()).toEqual([...ordered].sort());
        expect(got).toEqual(ordered);
      }
    }), { numRuns: FC_RUNS });
  }, 1200 * FC_RUNS);

  // --- The Correspondences ledger (a date-ordered list): conjunction of filters + range, lossless paging, Can_Read. --
  it('returns the conjunction of the Correspondences filters and pages losslessly by date', async () => {
    const DATES = Array.from({ length: 10 }, (_v, index) => `2026-${String(1 + (index % 9)).padStart(2, '0')}-${String(1 + index).padStart(2, '0')}`);
    const DIRECTIONS = ['sent', 'received'] as const;
    await fc.assert(fc.asyncProperty(
      fc.array(fc.record({
        owner: fc.constantFrom('author', 'admin') as fc.Arbitrary<'author' | 'admin'>,
        date: fc.constantFrom(...DATES),
        minute: fc.nat({ max: 59 }),
        direction: fc.constantFrom(...DIRECTIONS),
        withParty: fc.boolean(),
        completed: fc.boolean(),
        restricted: fc.boolean(),
      }), { minLength: 10, maxLength: 60 }),
      fc.array(fc.record({
        direction: fc.option(fc.constantFrom(...DIRECTIONS), { nil: undefined }),
        party: fc.option(fc.constant(true), { nil: undefined }),
        range: fc.option(fc.tuple(fc.constantFrom(...DATES), fc.constantFrom(...DATES)).map(([a, b]) => (a <= b ? [a, b] : [b, a]) as const), { nil: undefined }),
        viewer: fc.constantFrom('author', 'colleague', 'admin') as fc.Arbitrary<Who>,
      }), { minLength: 2, maxLength: 5 }),
      async (specs, filters) => {
        const { ids, tokens, projectId } = await freshWorld();
        const party = await (async (): Promise<ULID> => {
          const id = newULID(at);
          await core().prepare('INSERT INTO external_parties (id, name, name_fold, created_at, updated_seq) VALUES (?1, ?2, ?3, ?4, 0)').bind(id, 'The Desk', 'the desk', at).run();
          return id;
        })();

        interface Model { id: ULID; owner: Who; date: string; direction: typeof DIRECTIONS[number]; withParty: boolean; createdAt: Timestamp; completed: boolean; restrictedTo: ULID[] | null }
        const model: Model[] = [];
        for (const [index, spec] of specs.entries()) {
          const createdAt = asTimestamp(`2026-10-27T10:${String(spec.minute).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.${String(index).padStart(3, '0')}Z`);
          const restrictedTo = spec.restricted ? [] : null;
          const { id } = await addCorrespondence({ core: core(), projectId, ownerId: ids[spec.owner], now: at }, {
            createdAt, date: spec.date, direction: spec.direction, completed: spec.completed,
            ...(spec.withParty ? { parties: [{ kind: 'external', id: party }] } : {}),
            ...(restrictedTo === null ? {} : { restrictedTo }),
          });
          model.push({ id, owner: spec.owner, date: spec.date, direction: spec.direction, withParty: spec.withParty, createdAt, completed: spec.completed, restrictedTo });
        }

        for (const filter of filters) {
          const matches = model.filter((entry) => {
            if (!entry.completed) return false;
            if (!canRead(filter.viewer, { ownerId: ids[entry.owner], restrictedTo: entry.restrictedTo }, ids)) return false;
            if (filter.direction !== undefined && entry.direction !== filter.direction) return false;
            if (filter.party !== undefined && !entry.withParty) return false;
            if (filter.range !== undefined && (entry.date < filter.range[0] || entry.date > filter.range[1])) return false;
            return true;
          });
          // Newest date first, then id, both descending.
          const ordered = [...matches].sort((a, b) =>
            (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? 1 : -1)).map((entry) => entry.id);
          const parts = [
            filter.direction === undefined ? '' : `direction=${filter.direction}`,
            filter.party === undefined ? '' : `party=${party}`,
            filter.range === undefined ? '' : `from=${filter.range[0]}&to=${filter.range[1]}`,
          ].filter((part) => part !== '');
          const path = `/lists/correspondences${parts.length === 0 ? '' : `?${parts.join('&')}`}`;
          const got = await allListIds(tokens[filter.viewer], path);
          expect([...got].sort()).toEqual([...ordered].sort());
          expect(got).toEqual(ordered);
        }
      }), { numRuns: FC_RUNS });
  }, 1200 * FC_RUNS);

  // --- The Projects list count (R39.16/R47.11): the Research_Item count is the completed, viewer-readable set. -------
  it('counts only the completed, viewer-readable Research_Items of a Project', async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.record({
      owner: fc.constantFrom('author', 'admin') as fc.Arbitrary<'author' | 'admin'>,
      completed: fc.boolean(),
      restricted: fc.boolean(),
    }), { minLength: 5, maxLength: 30 }), async (specs) => {
      const { ids, tokens, projectId } = await freshWorld();
      interface Model { owner: Who; completed: boolean; restrictedTo: ULID[] | null }
      const model: Model[] = [];
      for (const [index, spec] of specs.entries()) {
        const createdAt = asTimestamp(`2026-10-27T10:00:${String(index % 60).padStart(2, '0')}.${String(index).padStart(3, '0')}Z`);
        const restrictedTo = spec.restricted ? [] : null;
        await addFinding({ core: core(), projectId, ownerId: ids[spec.owner], now: at }, {
          createdAt, completed: spec.completed, ...(restrictedTo === null ? {} : { restrictedTo }),
        });
        model.push({ owner: spec.owner, completed: spec.completed, restrictedTo });
      }
      for (const viewer of WHO) {
        const expected = model.filter((entry) => entry.completed && canRead(viewer, { ownerId: ids[entry.owner], restrictedTo: entry.restrictedTo }, ids)).length;
        const response = await call(api, bindings, tokens[viewer], 'GET', '/projects');
        const body = await response.json<{ projects: { id: string; researchItems: number }[] }>();
        const project = body.projects.find((entry) => entry.id === projectId)!;
        expect(project.researchItems).toBe(expected);
      }
    }), { numRuns: Math.min(FC_RUNS, 40) });
  }, 1200 * FC_RUNS);
});
