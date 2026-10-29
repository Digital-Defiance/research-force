import { beforeAll, beforeEach } from 'vitest';
import { newULID } from '@researchforce/domain/identifiers';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import type { RichText } from '@researchforce/domain/richtext';
import { asTimestamp, asULID } from '@researchforce/domain/types';
import type { ItemKind, Timestamp, ULID } from '@researchforce/domain/types';
import { BUILT_IN_VALUE_IDS } from '@researchforce/domain/value-sets';
import { assertionSpec, signAssertion, testAccess } from '@researchforce/testing/jwt';
import type { TestAccess } from '@researchforce/testing/jwt';
import type { Env } from '../src/env';
import type { itemResponse } from '../src/records/items';
import { migrated } from './d1';
import { addMember, call, KeyServer, resetPeople, testApi } from './api';
import type { TestApi } from './api';
import { addProject, resetRecords } from './units';

export type Who = 'author' | 'colleague' | 'admin';
export type ItemView = ReturnType<typeof itemResponse> & Record<string, unknown>;
export const V = BUILT_IN_VALUE_IDS;
export const RELIABILITY_HIGH = asULID('0000000000000000000000Q001');
export const OUTCOME_PARTIAL = asULID('0000000000000000000000R004');
export const CAMPAIGN_OPEN = asULID('0000000000000000000000C005');
export const RIGHTS_PUBLIC_DOMAIN = asULID('0000000000000000000000P002');
export const RELATED = asULID('0000000000000000000000X004');

export const rich = (text: string, spans: RichText['spans'] = []): RichText => ({ text, spans });

/** Synthetic bodies for each kind; tests override single fields. */
export function itemBody(kind: ItemKind, projectId: ULID, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const common = { projectId, title: `A synthetic ${kind}`, logSummary: rich(`Synthetic summary of a ${kind}.`) };
  const fields: Record<ItemKind, Record<string, unknown>> = {
    journal_entry: { sections: [{ content: rich('First synthetic section.') }, { content: rich('Second synthetic section.') }] },
    finding: { claim: rich('A synthetic claim.'), scopeCaveat: rich('Synthetic caveat.') },
    source: { sourceKind: 'primary', reliabilityId: RELIABILITY_HIGH },
    run: { scope: rich('Synthetic scope.'), parameters: rich('Synthetic parameters.'), toolName: 'synthtool', toolVersion: '1.0', computeResource: 'test rig', startTime: '2026-10-01T09:30:15+02:00', outcomeId: OUTCOME_PARTIAL },
    hypothesis: { statement: rich('A synthetic statement.') },
    correspondence: { date: { value: '2026-10-01', approx: false }, direction: 'sent', parties: [] },
    archival_request: { archiveOrDesk: { kind: 'member', id: '' }, requestText: rich('A synthetic request.'), statusValueId: asULID('0000000000000000000000A001') },
    topic: { body: rich('A synthetic topic body.') },
  };
  return { ...common, ...fields[kind], ...overrides };
}

export interface ItemWorld {
  readonly bindings: Env;
  readonly ids: Record<Who, ULID>;
  readonly projectId: ULID;
  readonly at: Timestamp;
  core(): D1Database;
  request(who: Who, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  create(who: Who, kind: ItemKind, body: Record<string, unknown>): Promise<Response>;
  /** Create and return the item, failing the test on any refusal. */
  created(who: Who, kind: ItemKind, overrides?: Record<string, unknown>): Promise<ItemView>;
  view(who: Who, id: string): Promise<ItemView>;
  edit(who: Who, id: string, body: Record<string, unknown>): Promise<Response>;
  /** A new External_Party with a synthetic name. */
  party(name?: string): Promise<ULID>;
}

const KIND_PATH = (kind: ItemKind) => kind.replaceAll('_', '-');

/** Three Members (author, colleague, Administrator) and one Project, fresh for each test. */
export function itemWorld(t0 = new Date('2026-10-27T18:00:00.000Z')): ItemWorld {
  const at = asTimestamp(t0.toISOString());
  let access: TestAccess;
  let api: TestApi;
  let tokens: Record<Who, string>;
  const world = {
    at,
    core: () => world.bindings.RF_CORE,
    request: (who: Who, method: string, path: string, body?: unknown, headers?: Record<string, string>) => call(api, world.bindings, tokens[who], method, path, body, headers),
    create: (who: Who, kind: ItemKind, body: Record<string, unknown>) => world.request(who, 'POST', `/items/${KIND_PATH(kind)}`, body),
    async created(who: Who, kind: ItemKind, overrides: Record<string, unknown> = {}) {
      const response = await world.create(who, kind, itemBody(kind, world.projectId, overrides));
      if (response.status !== 201) throw new Error(`${response.status} ${await response.text()}`);
      return (await response.json<{ item: ItemView }>()).item;
    },
    async view(who: Who, id: string) {
      const response = await world.request(who, 'GET', `/items/${id}`);
      if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
      return (await response.json<{ item: ItemView }>()).item;
    },
    edit: (who: Who, id: string, body: Record<string, unknown>) => world.request(who, 'PATCH', `/items/${id}`, body),
    async party(name = `Synthetic party ${newULID(at)}`) {
      const id = newULID(at);
      await world.core().prepare('INSERT INTO external_parties (id, name, name_fold, created_at, updated_seq) VALUES (?1, ?2, ?3, ?4, 0)').bind(id, name, name.toLowerCase(), at).run();
      return id;
    },
  } as ItemWorld & { bindings: Env; ids: Record<Who, ULID>; projectId: ULID };
  beforeAll(async () => {
    world.bindings = await migrated();
    access = await testAccess();
  });
  beforeEach(async () => {
    await resetPeople(world.core());
    await resetRecords(world.core());
    world.ids = {
      author: await addMember(world.core(), 'author@example.test', 'active', at),
      colleague: await addMember(world.core(), 'colleague@example.test', 'active', at),
      admin: await addMember(world.core(), 'admin@example.test', 'active', at, ROLE_IDS.administrator),
    };
    api = testApi(access, new KeyServer(access), t0);
    tokens = Object.fromEntries(await Promise.all((['author', 'colleague', 'admin'] as const)
      .map(async (who) => [who, (await signAssertion(access, assertionSpec(`${who}@example.test`), t0))!]))) as Record<Who, string>;
    world.projectId = await addProject(world.core(), world.ids.admin, at);
  });
  return world;
}

export async function errorOf(response: Response): Promise<{ status: number; error: string; fields?: { field: string; rule: string }[]; details?: { rule?: string; message?: string } }> {
  return { status: response.status, ...(await response.json<{ error: string }>()) };
}
