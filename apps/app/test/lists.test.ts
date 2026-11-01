import { describe, expect, it } from 'vitest';
import { asTimestamp, asULID } from '@researchforce/domain/types';
import type { Timestamp } from '@researchforce/domain/types';
import { errorOf, itemWorld } from './items';
import type { Who } from './items';
import { addProject } from './units';
import { addArchival, addCorrespondence, addFinding, addHypothesis, addRun } from './lists';
import type { Place } from './lists';

const world = itemWorld();
const at = (iso: string): Timestamp => asTimestamp(iso);
const place = (): Place => ({ core: world.core(), projectId: world.projectId, ownerId: world.ids.author, now: world.at });

const FINDING_OPEN = asULID('00000000000000000000000020');
const FINDING_CONFIRMED = asULID('00000000000000000000000021');
const FINDING_SUPERSEDED = asULID('00000000000000000000000023');
const RUN_COMPLETE = asULID('0000000000000000000000R002');
const RUN_PARTIAL = asULID('0000000000000000000000R004');
const HYP_OPEN = asULID('00000000000000000000000001');
const HYP_ELIMINATED = asULID('00000000000000000000000002');
const ARCH_SENT = asULID('00000000000000000000000003');
const ARCH_REPLIED = asULID('00000000000000000000000004');
const CRYPTANALYSIS = asULID('0000000000000000000000S003');

interface Page { entries: { id: string; [k: string]: unknown }[]; next: string | null }
async function get(who: Who, path: string): Promise<Page> {
  const response = await world.request(who, 'GET', path);
  if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return response.json<Page>();
}
const ids = (page: Page): string[] => page.entries.map((entry) => entry.id);

describe('GET /lists/findings', () => {
  it('lists Findings newest first with the claim, Scope_Caveat, status, supersession, Project, and Restricted mark', async () => {
    const a = await addFinding(place(), { createdAt: at('2026-10-27T10:00:00.000Z'), status: FINDING_OPEN });
    const later = await addFinding(place(), { createdAt: at('2026-10-27T11:00:00.000Z'), status: FINDING_CONFIRMED });
    const page = await get('colleague', '/lists/findings');
    expect(ids(page)).toEqual([later.id, a.id]);
    expect(page.next).toBeNull();
    expect(page.entries[0]).toMatchObject({
      id: later.id, claim: { text: `Claim of ${later.id}`, spans: [] }, scopeCaveat: { text: `Caveat of ${later.id}`, spans: [] },
      status: { id: FINDING_CONFIRMED, name: 'Confirmed' }, project: { id: world.projectId, name: expect.stringContaining('Synthetic') }, restricted: false,
    });
    expect(page.entries[0]!['owner']).toMatchObject({ id: world.ids.author, displayName: `Member ${world.ids.author}` });
  });

  it('shows the superseding Finding on a Superseded Finding', async () => {
    const newer = await addFinding(place(), { createdAt: at('2026-10-27T09:00:00.000Z') });
    const old = await addFinding(place(), { createdAt: at('2026-10-27T10:00:00.000Z'), status: FINDING_SUPERSEDED, supersededById: newer.id });
    const entry = (await get('colleague', '/lists/findings')).entries.find((e) => e.id === old.id)!;
    expect(entry['supersededBy']).toBe(newer.id);
  });

  it('filters by Finding_Status, Credit person, and Specialty as a conjunction', async () => {
    await world.core().prepare('UPDATE profile_specialties SET value_id = ?2 WHERE member_id = ?1').bind(world.ids.colleague, CRYPTANALYSIS).run();
    const open = await addFinding(place(), { createdAt: at('2026-10-27T10:00:00.000Z'), status: FINDING_OPEN });
    const credited = await addFinding(place(), { createdAt: at('2026-10-27T11:00:00.000Z'), status: FINDING_CONFIRMED, ownerId: world.ids.admin, credit: [{ member: world.ids.admin }, { member: world.ids.colleague }] });
    const matched = async (query: string) => ids(await get('admin', `/lists/findings${query}`)).sort();
    expect(await matched(`?status=${FINDING_OPEN}`)).toEqual([open.id]);
    expect(await matched(`?person=${world.ids.colleague}`)).toEqual([credited.id]);
    expect(await matched(`?specialty=${CRYPTANALYSIS}`)).toEqual([credited.id]);
    expect(await matched(`?status=${FINDING_CONFIRMED}&person=${world.ids.colleague}`)).toEqual([credited.id]);
    expect(await matched(`?status=${FINDING_OPEN}&person=${world.ids.colleague}`)).toEqual([]);
  });

  it('confines to one or more Projects, naming each entry Project', async () => {
    const second = await addProject(world.core(), world.ids.admin, world.at);
    const here = await addFinding(place(), { createdAt: at('2026-10-27T10:00:00.000Z') });
    const there = await addFinding(place(), { createdAt: at('2026-10-27T11:00:00.000Z'), projectId: second });
    expect(ids(await get('colleague', `/lists/findings?project=${world.projectId}`))).toEqual([here.id]);
    expect(ids(await get('colleague', `/lists/findings?project=${second}`))).toEqual([there.id]);
    expect(ids(await get('colleague', `/lists/findings?project=${world.projectId}&project=${second}`)).sort()).toEqual([here.id, there.id].sort());
    const both = await get('colleague', '/lists/findings');
    expect(both.entries.find((e) => e.id === there.id)!['project']).toMatchObject({ id: second });
  });

  it('hides a Restricted Finding from a non-reader and keeps the Restricted mark for readers', async () => {
    const open = await addFinding(place(), { createdAt: at('2026-10-27T10:00:00.000Z') });
    const restricted = await addFinding(place(), { createdAt: at('2026-10-27T11:00:00.000Z'), restrictedTo: [] });
    expect(ids(await get('colleague', '/lists/findings'))).toEqual([open.id]);
    for (const who of ['author', 'admin'] as const) {
      const page = await get(who, '/lists/findings');
      expect(ids(page).sort()).toEqual([open.id, restricted.id].sort());
      expect(page.entries.find((e) => e.id === restricted.id)!['restricted']).toBe(true);
    }
  });

  it('excludes the Findings of an incomplete Submission', async () => {
    const shown = await addFinding(place(), { createdAt: at('2026-10-27T10:00:00.000Z') });
    await addFinding(place(), { createdAt: at('2026-10-27T11:00:00.000Z'), completed: false });
    expect(ids(await get('colleague', '/lists/findings'))).toEqual([shown.id]);
  });

  it('pages 50 at a time with a working next cursor', async () => {
    const all: string[] = [];
    for (let index = 0; index < 55; index++) all.push((await addFinding(place(), { createdAt: at(`2026-10-27T10:${String(index).padStart(2, '0')}:00.000Z`) })).id);
    const newest = [...all].reverse();
    const first = await get('colleague', '/lists/findings');
    expect(ids(first)).toEqual(newest.slice(0, 50));
    expect(first.next).not.toBeNull();
    const second = await get('colleague', `/lists/findings?cursor=${encodeURIComponent(first.next!)}`);
    expect(ids(second)).toEqual(newest.slice(50));
    expect(second.next).toBeNull();
  });

  it('shows the empty-result page as no entries', async () => {
    expect(await get('colleague', '/lists/findings')).toEqual({ entries: [], next: null });
  });
});

describe('GET /lists/runs', () => {
  it('lists Runs by start time newest first with the columns and counts', async () => {
    const early = await addRun(place(), { startKey: '2026-01-01T00:00:00Z', outcome: RUN_COMPLETE, counts: [{ name: 'keys', value: '42' }] });
    const late = await addRun(place(), { startKey: '2026-09-01T00:00:00Z', outcome: RUN_PARTIAL, toolName: 'fitz', toolVersion: '2.3', computeResource: 'cluster', endTime: '2026-09-02T00:00:00Z', resumePoint: 'key 51' });
    const page = await get('colleague', '/lists/runs');
    expect(ids(page)).toEqual([late.id, early.id]);
    expect(page.entries[0]).toMatchObject({
      toolName: 'fitz', toolVersion: '2.3', computeResource: 'cluster', endTime: '2026-09-02T00:00:00Z',
      outcome: { id: RUN_PARTIAL, name: 'Partial' }, resumePoint: 'key 51', project: { id: world.projectId },
    });
    expect(page.entries[1]!['counts']).toEqual([{ name: 'keys', value: '42' }]);
  });

  it('filters by Run_Outcome, tool name, tool version, compute resource, and Credit', async () => {
    const complete = await addRun(place(), { startKey: '2026-01-01T00:00:00Z', outcome: RUN_COMPLETE, toolName: 'fitz', toolVersion: '1.0', computeResource: 'rig-a' });
    const partial = await addRun(place(), { startKey: '2026-02-01T00:00:00Z', outcome: RUN_PARTIAL, toolName: 'zarf', toolVersion: '2.0', computeResource: 'rig-b', ownerId: world.ids.admin });
    const matched = async (query: string) => ids(await get('admin', `/lists/runs${query}`)).sort();
    expect(await matched(`?outcome=${RUN_COMPLETE}`)).toEqual([complete.id]);
    expect(await matched('?toolName=zarf')).toEqual([partial.id]);
    expect(await matched('?toolVersion=1.0')).toEqual([complete.id]);
    expect(await matched('?computeResource=rig-b')).toEqual([partial.id]);
    expect(await matched(`?person=${world.ids.admin}`)).toEqual([partial.id]);
    expect(await matched(`?outcome=${RUN_PARTIAL}&toolName=fitz`)).toEqual([]);
  });

  it('hides a Restricted Run from a non-reader and excludes incomplete Submissions', async () => {
    const shown = await addRun(place(), { startKey: '2026-01-01T00:00:00Z' });
    await addRun(place(), { startKey: '2026-02-01T00:00:00Z', restrictedTo: [] });
    await addRun(place(), { startKey: '2026-03-01T00:00:00Z', completed: false });
    expect(ids(await get('colleague', '/lists/runs'))).toEqual([shown.id]);
  });

  it('pages losslessly by start time', async () => {
    const all: string[] = [];
    for (let index = 0; index < 55; index++) all.push((await addRun(place(), { startKey: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00Z` })).id);
    const newest = [...all].reverse();
    const first = await get('colleague', '/lists/runs');
    const second = await get('colleague', `/lists/runs?cursor=${encodeURIComponent(first.next!)}`);
    expect([...ids(first), ...ids(second)]).toEqual(newest);
    expect(second.next).toBeNull();
  });
});

describe('GET /lists/hypotheses', () => {
  it('lists Hypotheses with statement and status and the Elimination_Scope with an Eliminated status', async () => {
    const open = await addHypothesis(place(), { createdAt: at('2026-10-27T10:00:00.000Z'), status: HYP_OPEN });
    const gone = await addHypothesis(place(), { createdAt: at('2026-10-27T11:00:00.000Z'), status: HYP_ELIMINATED, eliminationScope: 'Keys 0 to 49.' });
    const page = await get('colleague', '/lists/hypotheses');
    expect(ids(page)).toEqual([gone.id, open.id]);
    expect(page.entries[0]).toMatchObject({ status: { id: HYP_ELIMINATED, name: 'Eliminated' }, statement: { text: `Statement of ${gone.id}`, spans: [] }, eliminationScope: { text: 'Keys 0 to 49.', spans: [] } });
    expect(page.entries[1]!['eliminationScope']).toBeNull();
  });

  it('filters by Hypothesis_Status', async () => {
    const open = await addHypothesis(place(), { createdAt: at('2026-10-27T10:00:00.000Z'), status: HYP_OPEN });
    const gone = await addHypothesis(place(), { createdAt: at('2026-10-27T11:00:00.000Z'), status: HYP_ELIMINATED, eliminationScope: 'Scope.' });
    expect(ids(await get('colleague', `/lists/hypotheses?status=${HYP_OPEN}`))).toEqual([open.id]);
    expect(ids(await get('colleague', `/lists/hypotheses?status=${HYP_ELIMINATED}`))).toEqual([gone.id]);
  });

  it('hides a Restricted Hypothesis from a non-reader', async () => {
    const shown = await addHypothesis(place(), { createdAt: at('2026-10-27T10:00:00.000Z') });
    await addHypothesis(place(), { createdAt: at('2026-10-27T11:00:00.000Z'), restrictedTo: [] });
    expect(ids(await get('colleague', '/lists/hypotheses'))).toEqual([shown.id]);
    expect(ids(await get('admin', '/lists/hypotheses'))).toHaveLength(2);
  });
});

describe('GET /lists/correspondences', () => {
  it('lists Correspondences newest date first with date, Parties, direction, and Project', async () => {
    const external = await world.party('The Archive');
    const earlier = await addCorrespondence(place(), { date: '2026-05-01', direction: 'sent', parties: [{ kind: 'member', id: world.ids.author }, { kind: 'external', id: external }] });
    const later = await addCorrespondence(place(), { date: '2026-06-01', direction: 'received' });
    const page = await get('colleague', '/lists/correspondences');
    expect(ids(page)).toEqual([later.id, earlier.id]);
    const entry = page.entries.find((e) => e.id === earlier.id)!;
    expect(entry).toMatchObject({ date: { value: '2026-05-01', approx: false }, direction: 'sent', project: { id: world.projectId } });
    expect(entry['parties']).toEqual([
      { kind: 'member', id: world.ids.author, displayName: `Member ${world.ids.author}` },
      { kind: 'external', id: external, name: 'The Archive' },
    ]);
  });

  it('filters by Party, direction, and an inclusive date range as a conjunction', async () => {
    const party = await world.party('Desk');
    const sentWith = await addCorrespondence(place(), { date: '2026-05-10', direction: 'sent', parties: [{ kind: 'external', id: party }] });
    const received = await addCorrespondence(place(), { date: '2026-06-10', direction: 'received', parties: [{ kind: 'external', id: party }] });
    await addCorrespondence(place(), { date: '2026-07-10', direction: 'sent' });
    const matched = async (query: string) => ids(await get('colleague', `/lists/correspondences${query}`)).sort();
    expect(await matched(`?party=${party}`)).toEqual([sentWith.id, received.id].sort());
    expect(await matched('?direction=received')).toEqual([received.id]);
    expect(await matched('?from=2026-05-01&to=2026-06-30')).toEqual([sentWith.id, received.id].sort());
    expect(await matched(`?party=${party}&direction=sent`)).toEqual([sentWith.id]);
  });

  it('refuses a date range whose end precedes its start with 422 naming the end field', async () => {
    await addCorrespondence(place(), { date: '2026-05-01' });
    const refused = await errorOf(await world.request('colleague', 'GET', '/lists/correspondences?from=2026-06-01&to=2026-05-01'));
    expect(refused).toMatchObject({ status: 422, fields: [{ field: 'to' }] });
  });

  it('hides a Restricted Correspondence from a non-reader', async () => {
    const shown = await addCorrespondence(place(), { date: '2026-05-01' });
    await addCorrespondence(place(), { date: '2026-06-01', restrictedTo: [] });
    expect(ids(await get('colleague', '/lists/correspondences'))).toEqual([shown.id]);
    expect(ids(await get('admin', '/lists/correspondences'))).toHaveLength(2);
  });

  it('shows the empty-result page as no entries', async () => {
    expect(await get('colleague', '/lists/correspondences')).toEqual({ entries: [], next: null });
  });
});

describe('GET /lists/archival-requests', () => {
  it('lists Archival_Requests with archive or desk, date sent, status, Owner, and a Follow_Up_Due mark', async () => {
    const external = await world.party('State Archive');
    // Sent long ago: Follow_Up_Due. The world clock is 2026-10-27.
    const due = await addArchival(place(), { createdAt: at('2026-10-27T10:00:00.000Z'), status: ARCH_SENT, dateSent: '2026-01-01', archive: { kind: 'external', id: external } });
    // Replied: never Follow_Up_Due.
    const replied = await addArchival(place(), { createdAt: at('2026-10-27T11:00:00.000Z'), status: ARCH_REPLIED, dateSent: '2026-01-01' });
    const page = await get('colleague', '/lists/archival-requests');
    expect(ids(page)).toEqual([replied.id, due.id]);
    const dueEntry = page.entries.find((e) => e.id === due.id)!;
    expect(dueEntry).toMatchObject({
      status: { id: ARCH_SENT, name: 'Sent' }, dateSent: { value: '2026-01-01', approx: false },
      archiveOrDesk: { kind: 'external', id: external, name: 'State Archive' }, followUpDue: true, project: { id: world.projectId },
    });
    expect(dueEntry['owner']).toMatchObject({ id: world.ids.author, displayName: `Member ${world.ids.author}` });
    expect(page.entries.find((e) => e.id === replied.id)!['followUpDue']).toBe(false);
  });

  it('does not mark a recently sent request Follow_Up_Due', async () => {
    const fresh = await addArchival(place(), { createdAt: at('2026-10-27T10:00:00.000Z'), status: ARCH_SENT, dateSent: '2026-10-20' });
    expect((await get('colleague', '/lists/archival-requests')).entries.find((e) => e.id === fresh.id)!['followUpDue']).toBe(false);
  });

  it('filters by status and by archive or desk as a conjunction', async () => {
    const archiveA = await world.party('Archive A');
    const archiveB = await world.party('Archive B');
    const sentA = await addArchival(place(), { createdAt: at('2026-10-27T10:00:00.000Z'), status: ARCH_SENT, dateSent: '2026-01-01', archive: { kind: 'external', id: archiveA } });
    const repliedB = await addArchival(place(), { createdAt: at('2026-10-27T11:00:00.000Z'), status: ARCH_REPLIED, dateSent: '2026-01-01', archive: { kind: 'external', id: archiveB } });
    const matched = async (query: string) => ids(await get('colleague', `/lists/archival-requests${query}`)).sort();
    expect(await matched(`?status=${ARCH_SENT}`)).toEqual([sentA.id]);
    expect(await matched(`?archive=${archiveB}`)).toEqual([repliedB.id]);
    expect(await matched(`?status=${ARCH_SENT}&archive=${archiveB}`)).toEqual([]);
  });

  it('hides a Restricted Archival_Request from a non-reader', async () => {
    const shown = await addArchival(place(), { createdAt: at('2026-10-27T10:00:00.000Z') });
    await addArchival(place(), { createdAt: at('2026-10-27T11:00:00.000Z'), restrictedTo: [] });
    expect(ids(await get('colleague', '/lists/archival-requests'))).toEqual([shown.id]);
    expect(ids(await get('admin', '/lists/archival-requests'))).toHaveLength(2);
  });
});

describe('GET /projects (R39.16 reconciliation)', () => {
  it('names every R39.16 field and never counts a Restricted Research_Item a viewer cannot read', async () => {
    const open = await addFinding(place(), { createdAt: at('2026-10-27T10:00:00.000Z') });
    await addFinding(place(), { createdAt: at('2026-10-27T11:00:00.000Z'), restrictedTo: [] });
    // An incomplete Submission's Item is never counted either.
    await addFinding(place(), { createdAt: at('2026-10-27T12:00:00.000Z'), completed: false });
    expect(open).toBeDefined();
    const projectOf = async (who: Who) => {
      const response = await world.request(who, 'GET', '/projects');
      const body = await response.json<{ projects: Record<string, unknown>[] }>();
      return body.projects.find((project) => project['id'] === world.projectId)!;
    };
    const asColleague = await projectOf('colleague');
    // The colleague cannot read the Restricted Finding, so the count is only the open one (R47.11).
    expect(asColleague['researchItems']).toBe(1);
    expect(asColleague).toMatchObject({
      name: expect.any(String), description: expect.any(String), slug: expect.any(String), slugFixed: false, featured: false,
      disclosureLevel: 'not_published', effectiveDisclosure: 'not_published', muted: false,
    });
    // The Owner and an Administrator read both, so their count includes the Restricted one.
    expect((await projectOf('author'))['researchItems']).toBe(2);
    expect((await projectOf('admin'))['researchItems']).toBe(2);
  });
});
