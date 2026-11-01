import { describe, expect, it } from 'vitest';
import { EVIDENCE_LIMITS } from '@researchforce/domain/evidence';
import type { ULID } from '@researchforce/domain/types';
import { evidenceSnapshotHash } from '../src/records/evidence';
import type { EvidenceGrant, UnitIdentity } from '../src/records/evidence';
import type { CurationQueue } from '../src/disclosure/records';
import { itemWorld } from './items';
import { addElement, addSubmissionRow } from './units';
import type { Who } from './items';

const world = itemWorld();

async function post(who: Who, path: string, body: unknown): Promise<Response> {
  return world.request(who, 'POST', path, body);
}
async function get<T>(who: Who, path: string): Promise<T> {
  const response = await world.request(who, 'GET', path);
  if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return response.json<T>();
}

/** A verified grant body over the current text of one Research_Item, permitting publication. */
function grantBody(unitId: ULID, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    unitId,
    grantorName: 'Jane Writer',
    claimedAuthority: 'The writer of the letter',
    source: 'letter',
    evidenceReference: 'box 4, folder 2, letter 9',
    uses: ['publication'],
    naming: 'unnamed',
    covered: [{ unitId, contentRev: 1 }],
    ...overrides,
  };
}

describe('POST /evidence records a manual Permission_Evidence grant (R51.15)', () => {
  it('needs the disclosure curation permission', async () => {
    const item = await world.created('author', 'source');
    const response = await post('author', '/evidence', grantBody(item.id as ULID));
    expect(response.status).toBe(403);
  });

  it('records an immutable, verified grant sealed against the unit as it stands now', async () => {
    const item = await world.created('admin', 'source');
    const response = await post('admin', '/evidence', grantBody(item.id as ULID));
    expect(response.status).toBe(201);
    const grant = await response.json<EvidenceGrant>();
    expect(grant.verified).toBe(true);
    expect(grant.uses).toEqual(['publication']);
    expect(grant.naming).toBe('unnamed');
    expect(grant.withdrawnAt).toBeNull();
    // The snapshot is the shared digest of the covered identity, uses, and naming, so a later change is judged the one way.
    expect(grant.snapshotHash).toBe(evidenceSnapshotHash(grantBody(item.id as ULID) as never));
    expect(grant.covered).toEqual([{ unitId: item.id, contentRev: 1 }]);
  });

  it('refuses a content revision that is not the unit as it is now', async () => {
    const item = await world.created('admin', 'source');
    const response = await post('admin', '/evidence', grantBody(item.id as ULID, { covered: [{ unitId: item.id, contentRev: 2 }] }));
    expect(response.status).toBe(422);
  });

  it('seals a file-sharing grant against the exact Attachment bytes and size, and refuses a mismatch', async () => {
    const root = await world.created('admin', 'finding');
    const place = { projectId: world.projectId, ownerId: world.ids.admin, submissionId: await addSubmissionRow(world.core(), world.ids.admin, world.at), now: world.at };
    const attachment = await addElement(world.core(), place, 'attachment', root.id as ULID);
    const fileHash = '0'.repeat(64);
    const ok = await post('admin', '/evidence', {
      unitId: attachment.id, grantorName: 'Rights Holder', claimedAuthority: 'Copyright holder', source: 'email', evidenceReference: 'message:42',
      uses: ['publication', 'file_share'], naming: 'unnamed', covered: [{ unitId: attachment.id, contentRev: 1, fileHash, fileSize: 10 }],
    });
    expect(ok.status).toBe(201);
    const grant = await ok.json<EvidenceGrant>();
    // Recording a file_share grant does not share the file; it only records the permission (R51.16).
    expect(grant.uses).toContain('file_share');
    expect(grant.covered[0]).toEqual({ unitId: attachment.id, contentRev: 1, fileHash, fileSize: 10 });
    const bad = await post('admin', '/evidence', {
      unitId: attachment.id, grantorName: 'Rights Holder', claimedAuthority: 'Copyright holder', source: 'email', evidenceReference: 'message:43',
      uses: ['file_share'], naming: 'unnamed', covered: [{ unitId: attachment.id, contentRev: 1, fileHash: 'a'.repeat(64), fileSize: 10 }],
    });
    expect(bad.status).toBe(422);
  });

  it('records a grant covering the full bound of distinct documents in one bounded write (R51.16)', async () => {
    // The declared bound is EVIDENCE_LIMITS.coveredItems (50) distinct covered identities; the write must store them all,
    // so the covered-items insert chunks through json_each rather than a single over-wide multi-row statement.
    const root = await world.created('admin', 'finding');
    const place = { projectId: world.projectId, ownerId: world.ids.admin, submissionId: await addSubmissionRow(world.core(), world.ids.admin, world.at), now: world.at };
    const covered: { unitId: string; contentRev: number }[] = [{ unitId: root.id as string, contentRev: 1 }];
    for (let i = 0; i < EVIDENCE_LIMITS.coveredItems - 1; i += 1) {
      const attachment = await addElement(world.core(), place, 'attachment', root.id as ULID);
      covered.push({ unitId: attachment.id, contentRev: 1 });
    }
    expect(covered.length).toBe(EVIDENCE_LIMITS.coveredItems);
    const response = await post('admin', '/evidence', grantBody(root.id as ULID, { covered }));
    expect(response.status, await response.clone().text()).toBe(201);
    const grant = await response.json<EvidenceGrant>();
    expect(grant.covered.length).toBe(EVIDENCE_LIMITS.coveredItems);
  });

  it('allows a Generic Label only on a grant that permits naming', async () => {
    const item = await world.created('admin', 'source');
    const named = await post('admin', '/evidence', grantBody(item.id as ULID, { naming: 'named', label: 'a correspondent' }));
    expect(named.status).toBe(201);
    const bad = await post('admin', '/evidence', grantBody(item.id as ULID, { naming: 'unnamed', label: 'a correspondent' }));
    expect(bad.status).toBe(422);
  });

  it('records a withdrawal as one appended row, after which the grant covers nothing', async () => {
    const item = await world.created('admin', 'source');
    const grant = await (await post('admin', '/evidence', grantBody(item.id as ULID))).json<EvidenceGrant>();
    const withdrawn = await post('admin', `/evidence/${grant.id}/withdrawal`, { reason: 'The writer changed their mind.' });
    expect(withdrawn.status).toBe(200);
    expect((await withdrawn.json<EvidenceGrant>()).withdrawnAt).not.toBeNull();
    // A second withdrawal is refused: a grant has at most one withdrawal.
    const again = await post('admin', `/evidence/${grant.id}/withdrawal`, {});
    expect(again.status).toBe(409);
  });

  it('marks the earlier grant superseded when a new grant supersedes it', async () => {
    const item = await world.created('admin', 'source');
    const first = await (await post('admin', '/evidence', grantBody(item.id as ULID))).json<EvidenceGrant>();
    const second = await post('admin', '/evidence', grantBody(item.id as ULID, { supersedesId: first.id, evidenceReference: 'box 4, folder 2, letter 10' }));
    expect(second.status).toBe(201);
    const list = await get<{ unit: UnitIdentity; grants: EvidenceGrant[] }>('admin', `/units/${item.id}/evidence`);
    const earlier = list.grants.find((grant) => grant.id === first.id)!;
    expect(earlier.supersededById).toBe((await second.clone().json<EvidenceGrant>()).id);
  });
});

describe('GET /units/{id}/evidence returns the current identity and every grant (R51.13)', () => {
  it('prefills the content revision the editor seals against', async () => {
    const item = await world.created('admin', 'source');
    const view = await get<{ unit: UnitIdentity; grants: EvidenceGrant[] }>('admin', `/units/${item.id}/evidence`);
    expect(view.unit.contentRev).toBe(1);
    expect(view.unit.fileHash).toBeNull();
    expect(view.grants).toEqual([]);
  });
});

describe('GET /disclosure/evidence-queue lists units needing a grant (R51.9, R51.15)', () => {
  it('lists a Source with no grant and drops it once a verified grant is recorded', async () => {
    const item = await world.created('admin', 'source');
    const before = await get<CurationQueue>('admin', '/disclosure/evidence-queue');
    const entry = before.items.find((unit) => unit.id === item.id);
    expect(entry?.reason).toBe('no_grant');
    await post('admin', '/evidence', grantBody(item.id as ULID));
    const after = await get<CurationQueue>('admin', '/disclosure/evidence-queue');
    expect(after.items.find((unit) => unit.id === item.id)).toBeUndefined();
  });

  it('keeps a unit in the queue when its only grant is withdrawn, naming it as only-legacy', async () => {
    const item = await world.created('admin', 'source');
    const grant = await (await post('admin', '/evidence', grantBody(item.id as ULID))).json<EvidenceGrant>();
    await post('admin', `/evidence/${grant.id}/withdrawal`, {});
    const queue = await get<CurationQueue>('admin', '/disclosure/evidence-queue');
    expect(queue.items.find((unit) => unit.id === item.id)?.reason).toBe('only_legacy');
  });

  it('does not list a Finding, which is neither a Correspondence, Source, nor Attachment', async () => {
    const item = await world.created('admin', 'finding');
    const queue = await get<CurationQueue>('admin', '/disclosure/evidence-queue');
    expect(queue.items.find((unit) => unit.id === item.id)).toBeUndefined();
  });
});
