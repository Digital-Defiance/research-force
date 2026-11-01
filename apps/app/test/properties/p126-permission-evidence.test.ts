// Feature: research-collab-cms, Property 126: Permission evidence covers only the exact authorized use
import { describe, expect, it } from 'vitest';
import {
  coverChange,
  EVIDENCE_LIMITS,
  EVIDENCE_USES,
  grantCovers,
  isLiveGrant,
  NEUTRAL_NAME_FALLBACK,
  withheldName,
} from '@researchforce/domain/evidence';
import type { CoverageRequest, EvidenceRow, EvidenceUse } from '@researchforce/domain/evidence';
import type { ULID } from '@researchforce/domain/types';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import type { EvidenceGrant } from '../../src/records/evidence';
import { itemWorld } from '../items';
import { addElement, addSubmissionRow } from '../units';
import type { Who } from '../items';

/**
 * Validates R51.9, R51.15, R51.16, R51.17, R51.18, R23.23, R23.24, R49.8 against an independent model of the shared
 * coverage helpers in `@researchforce/domain/evidence`, which decide manual and emailed grants identically. A random
 * sequence of operations drives a tiny world of one Disclosure_Unit, one grant, and the change a release asks it to
 * cover, beside a model built from the acceptance criteria alone. The grant's source (an emailed Consent_Answer or a
 * hand-recorded letter) is varied but never changes a single coverage answer (R51.15). Fault injection moves each thing
 * coverage binds to: the grant is hand-set unverified, withdrawn, superseded, or expired so it stops being live (R51.9,
 * R51.15, R51.18); the resulting snapshot, content revision, file bytes, or file size is replaced so the change no
 * longer presents the exact identity the grant was signed against (R51.16, R51.18, which is the R23.23/R23.24
 * dependency-digest discipline and the R49.8 "changed effect lapses" principle); and the use the change makes is flipped
 * between publication and file_share so a use the grant does not name is uncovered (R51.16).
 *
 * After every step the model asserts the pure functions decide coverage exactly: `grantCovers`/`coverChange` return
 * covered only when the grant is live for the same unit, permits the exact use, and matches the exact snapshot and
 * content/file identity, and `coverChange` otherwise refuses and names every grant it considered so a new Consent_Request
 * or manual grant can be offered (R51.9); a hand-set unverified status never stands in for a grant. The Withheld naming
 * fallback is checked beside it: `withheldName` shows the Party name only with a live `named` grant and Do_Not_Name off,
 * and otherwise falls to the Generic_Label or a neutral role label, never the withheld name, with Do_Not_Name always
 * winning (R51.17). A companion case exercises the recordEvidence/withdraw/supersede flow end-to-end through the
 * /evidence API so coverage is verified against actually-stored grants, and the design's current-access (a live grant
 * covering its exact change) and maximum-encoded-input (a covered set one past the bound refused with nothing stored)
 * cases are pinned.
 */

type Source = 'emailed' | 'letter';

/** A fault that takes a grant off its live footing, each the independent `isLiveGrant` rule in one place (R51.9, R51.15, R51.18). */
type Liveness = 'live' | 'unverified' | 'withdrawn' | 'superseded' | 'expired';

const AT = '2026-10-31T00:00:00.000Z';
const BEFORE = '2026-10-30T00:00:00.000Z';
const SNAP_A = 'a'.repeat(64);
const SNAP_B = 'b'.repeat(64);
const FILE_A = 'c'.repeat(64);
const FILE_B = 'd'.repeat(64);

/** An operation driving the model and the pure helpers in lockstep: liveness faults, identity/use mismatches, naming. */
type Op =
  | { t: 'liveness'; value: Liveness } // fault injection: how the grant sits relative to the live rule.
  | { t: 'snapshot'; value: string } // the resulting snapshot the change presents; off the signed hash is uncovered.
  | { t: 'contentRev'; value: number } // the resulting content revision; a changed body is uncovered (R51.18).
  | { t: 'file'; file: { hash: string; size: number } | undefined } // the file identity the change presents, bytes and size together (R51.16).
  | { t: 'use'; value: EvidenceUse } // the use the change makes; a use the grant does not name is uncovered (R51.16).
  | { t: 'naming'; doNotName: boolean; named: boolean }; // the Withheld naming inputs (R51.17).

const op: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ t: fc.constant('liveness' as const), value: fc.constantFrom<Liveness>('live', 'unverified', 'withdrawn', 'superseded', 'expired') }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('snapshot' as const), value: fc.constantFrom(SNAP_A, SNAP_B) }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('contentRev' as const), value: fc.constantFrom(1, 2) }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('file' as const), file: fc.constantFrom<{ hash: string; size: number } | undefined>({ hash: FILE_A, size: 2048 }, { hash: FILE_B, size: 2048 }, { hash: FILE_A, size: 4096 }, undefined) }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('use' as const), value: fc.constantFrom<EvidenceUse>(...EVIDENCE_USES) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('naming' as const), doNotName: fc.boolean(), named: fc.boolean() }) },
);

/** The signed identity the grant was recorded against: content revision 1 of unit U, over file FILE_A at 2048 bytes. */
const SIGNED = { unitId: 'U', contentRev: 1, fileHash: FILE_A, fileSize: 2048 } as const;

describe('Property 126: Permission evidence covers only the exact authorized use', () => {
  it('covers a change through the pure helpers only for a live grant, the exact use, and the exact snapshot and content/file identity', () => {
    fc.assert(fc.property(
      fc.constantFrom<Source>('emailed', 'letter'),
      // The grant permits publication, and may also permit file_share, so a file change can be covered or not by the listed uses.
      fc.subarray([...EVIDENCE_USES], { minLength: 1 }).filter((uses) => uses.includes('publication')),
      fc.array(op, { minLength: 1, maxLength: 12 }),
      (source, uses, ops) => {
        // The independent model: how the one grant sits, and the exact change a release asks it to cover.
        const model = {
          source, // varied but never consulted: manual and emailed grants follow the same rules (R51.15).
          liveness: 'live' as Liveness,
          uses: uses as readonly EvidenceUse[],
          naming: { doNotName: false, named: false },
          change: {
            snapshotHash: SNAP_A as string, // the resulting snapshot; the grant was signed against SNAP_A.
            contentRev: SIGNED.contentRev as number,
            file: undefined as { hash: string; size: number } | undefined, // the file bytes and size the change presents, or none.
            use: 'publication' as EvidenceUse,
          },
        };

        // The grant as the pure helpers read it, rebuilt from the model after each step. The source never enters here,
        // so an emailed grant and a hand-recorded letter with the same identity, uses, and liveness cover identically.
        const row = (): EvidenceRow => ({
          id: 'G1',
          unitId: SIGNED.unitId,
          snapshotHash: SNAP_A,
          covered: [{ unitId: SIGNED.unitId, contentRev: SIGNED.contentRev, fileHash: SIGNED.fileHash, fileSize: SIGNED.fileSize }],
          uses: model.uses,
          naming: model.naming.named ? 'named' : 'unnamed',
          verified: model.liveness !== 'unverified',
          ...(model.liveness === 'withdrawn' ? { withdrawnAt: BEFORE } : {}),
          ...(model.liveness === 'superseded' ? { supersededById: 'G2' } : {}),
          ...(model.liveness === 'expired' ? { expiresAt: BEFORE } : {}),
        });
        const request = (): CoverageRequest => ({
          unitId: SIGNED.unitId,
          snapshotHash: model.change.snapshotHash,
          contentRev: model.change.contentRev,
          ...(model.change.file === undefined ? {} : { fileHash: model.change.file.hash, fileSize: model.change.file.size }),
          use: model.change.use,
          at: AT,
        });

        // The model's own verdict, built from the acceptance criteria alone: a live grant, for the exact use, exact
        // snapshot, exact content revision, and (when a file is presented) the exact bytes and size (R51.9, R51.16, R51.18).
        const live = () => model.liveness === 'live';
        const expectedCovered = (): boolean => {
          if (!live()) return false; // a hand-set, withdrawn, superseded, or expired grant covers nothing (R51.9, R51.15, R51.18).
          if (!model.uses.includes(model.change.use)) return false; // a use the grant does not name is uncovered (R51.16).
          if (model.change.snapshotHash !== SNAP_A) return false; // a changed resulting snapshot is uncovered (R51.18, R23.23).
          if (model.change.contentRev !== SIGNED.contentRev) return false; // a changed body is uncovered (R51.18, R23.24, R49.8).
          // A change presenting a file is covered only when the exact bytes and size match the signed identity (R51.16).
          if (model.change.file !== undefined && (SIGNED.fileHash !== model.change.file.hash || SIGNED.fileSize !== model.change.file.size)) return false;
          return true;
        };

        const verify = (label: string): void => {
          const expected = expectedCovered();
          expect(grantCovers(row(), request()), `${label}: grantCovers`).toBe(expected);
          // isLiveGrant is the single liveness rule the coverage helpers share; it matches the model's liveness exactly.
          expect(isLiveGrant(row(), AT), `${label}: isLiveGrant`).toBe(live());

          // coverChange over the one grant returns covered with its id, or refuses and names every grant it considered (R51.9).
          const result = coverChange([row()], request());
          expect(result.covered, `${label}: coverChange covered`).toBe(expected);
          if (result.covered) {
            expect(result.grantId, `${label}: covering grant id`).toBe('G1');
          } else {
            // The refusal always names the unit, the attempted use, and the grant considered, so a new request can be offered.
            expect(result.reason.unitId, `${label}: refusal unit`).toBe(SIGNED.unitId);
            expect(result.reason.use, `${label}: refusal use`).toBe(model.change.use);
            expect(result.reason.consideredIds, `${label}: refusal considered`).toEqual(['G1']);
          }

          // A hand-set unverified status can never stand in for a grant: adding one alongside changes no coverage answer (R51.9, R51.15).
          const handSet: EvidenceRow = { ...row(), id: 'legacy', verified: false };
          const withHandSet = coverChange([handSet, row()], request());
          expect(withHandSet.covered, `${label}: hand-set status grants nothing`).toBe(expected);
          if (!withHandSet.covered) expect(withHandSet.reason.consideredIds, `${label}: refusal names both`).toEqual(['legacy', 'G1']);

          // The Withheld naming fallback: the name appears only with a live `named` grant and Do_Not_Name off (R51.17).
          const party = { name: 'Jane Writer', doNotName: model.naming.doNotName, genericLabel: 'a reader' } as const;
          const namingRow: EvidenceRow = { ...row(), naming: model.naming.named ? 'named' : 'unnamed' };
          const shown = withheldName(party, [namingRow], SIGNED.unitId, AT);
          const namesParty = !model.naming.doNotName && model.naming.named && live();
          if (namesParty) {
            expect(shown, `${label}: names the Party`).toBe('Jane Writer');
          } else {
            // Never the withheld name: the Generic_Label when there is one, else the neutral role label; Do_Not_Name always wins.
            expect(shown, `${label}: withheld name never leaks`).not.toBe('Jane Writer');
            expect(shown === 'a reader' || shown === NEUTRAL_NAME_FALLBACK, `${label}: label or neutral fallback`).toBe(true);
          }
        };

        verify('start');
        for (const [step, current] of ops.entries()) {
          const label = `source=${source} step ${step} ${JSON.stringify(current)}`;
          if (current.t === 'liveness') model.liveness = current.value;
          else if (current.t === 'snapshot') model.change.snapshotHash = current.value;
          else if (current.t === 'contentRev') model.change.contentRev = current.value;
          else if (current.t === 'file') model.change.file = current.file;
          else if (current.t === 'use') model.change.use = current.value;
          else model.naming = { doNotName: current.doNotName, named: current.named };
          verify(label);
        }
      },
    ), { numRuns: Math.max(FC_RUNS, 100) });
  });

  // A live naming grant that expires or is withdrawn stops naming the Party at once, the R51.17 fallback following the
  // same liveness rule as coverage: Do_Not_Name always wins, then only a live `named` grant names the Party.
  it('reads the Withheld name only from a live naming grant with Do_Not_Name off, across every liveness and precedence', () => {
    fc.assert(fc.property(
      fc.record({ doNotName: fc.boolean(), liveness: fc.constantFrom<Liveness>('live', 'unverified', 'withdrawn', 'superseded', 'expired'), naming: fc.constantFrom<'named' | 'unnamed'>('named', 'unnamed'), hasLabel: fc.boolean() }),
      ({ doNotName, liveness, naming, hasLabel }) => {
        const grant: EvidenceRow = {
          id: 'G', unitId: 'U', snapshotHash: SNAP_A, covered: [{ unitId: 'U', contentRev: 1 }], uses: ['publication'], naming,
          verified: liveness !== 'unverified',
          ...(liveness === 'withdrawn' ? { withdrawnAt: BEFORE } : {}),
          ...(liveness === 'superseded' ? { supersededById: 'G2' } : {}),
          ...(liveness === 'expired' ? { expiresAt: BEFORE } : {}),
        };
        const party = { name: 'Jane Writer', doNotName, ...(hasLabel ? { genericLabel: 'a reader' } : {}) };
        const shown = withheldName(party, [grant], 'U', AT);
        const namesParty = !doNotName && naming === 'named' && isLiveGrant(grant, AT);
        if (namesParty) expect(shown).toBe('Jane Writer');
        else expect(shown).toBe(hasLabel ? 'a reader' : NEUTRAL_NAME_FALLBACK);
      },
    ), { numRuns: Math.max(FC_RUNS, 100) });
  });
});

const world = itemWorld();

async function post(who: Who, path: string, body: unknown): Promise<Response> {
  return world.request(who, 'POST', path, body);
}

/** An attachment root so a file_share grant seals the exact bytes the stored unit has now. */
async function attachment(): Promise<ULID> {
  const root = await world.created('admin', 'finding');
  const place = { projectId: world.projectId, ownerId: world.ids.admin, submissionId: await addSubmissionRow(world.core(), world.ids.admin, world.at), now: world.at };
  return (await addElement(world.core(), place, 'attachment', root.id as ULID)).id;
}

describe('Property 126: coverage verified against actually-stored grants (R51.15, R51.16, R51.18)', () => {
  // The end-to-end case: record a real grant through the /evidence API, then feed the stored row and a release's change
  // through the same pure `coverChange` the gates use, so coverage is checked against a grant that actually exists.
  it('covers a stored grant\u2019s exact change, lapses when the grant is withdrawn, and never covers a superseded grant', async () => {
    const unitId = await attachment();
    const fileHash = '0'.repeat(64);
    const recorded = await post('admin', '/evidence', {
      unitId, grantorName: 'Rights Holder', claimedAuthority: 'Copyright holder', source: 'email', evidenceReference: 'message:42',
      uses: ['publication', 'file_share'], naming: 'unnamed', covered: [{ unitId, contentRev: 1, fileHash, fileSize: 10 }],
    });
    expect(recorded.status).toBe(201);
    const grant = await recorded.json<EvidenceGrant>();

    // The stored grant as the coverage helpers read it.
    // The stored grant as the coverage helpers read it; `withdrawnAt` is set only after the API withdrawal.
    const stored = (withdrawnAt?: string): EvidenceRow => ({
      id: grant.id, unitId, snapshotHash: grant.snapshotHash, covered: grant.covered, uses: grant.uses, naming: grant.naming,
      verified: grant.verified, ...(withdrawnAt === undefined ? {} : { withdrawnAt }),
    });
    // A file_share change presenting the exact stored bytes and size.
    const fileChange: CoverageRequest = { unitId, snapshotHash: grant.snapshotHash, contentRev: 1, fileHash, fileSize: 10, use: 'file_share', at: world.at };
    // A text-only publication change over the same signed snapshot and content revision.
    const textChange: CoverageRequest = { unitId, snapshotHash: grant.snapshotHash, contentRev: 1, use: 'publication', at: world.at };

    // The exact change the grant was signed against is covered, for either permitted use.
    expect(coverChange([stored()], fileChange)).toEqual({ covered: true, grantId: grant.id });
    expect(coverChange([stored()], textChange)).toEqual({ covered: true, grantId: grant.id });
    // A changed body, changed file bytes, or a changed size is uncovered (R51.16, R51.18).
    expect(coverChange([stored()], { ...fileChange, contentRev: 2 }).covered).toBe(false);
    expect(coverChange([stored()], { ...fileChange, fileHash: 'f'.repeat(64) }).covered).toBe(false);
    expect(coverChange([stored()], { ...fileChange, fileSize: 20 }).covered).toBe(false);

    // Withdrawing the stored grant through the API lapses its coverage: the same change is now uncovered (R51.18, R49.8).
    const withdrawn = await post('admin', `/evidence/${grant.id}/withdrawal`, { reason: 'The rights holder changed their mind.' });
    expect(withdrawn.status).toBe(200);
    const after = await withdrawn.json<EvidenceGrant>();
    expect(after.withdrawnAt).not.toBeNull();
    expect(coverChange([stored(after.withdrawnAt ?? undefined)], fileChange).covered).toBe(false);

    // A later grant superseding an earlier one leaves the earlier covering nothing (R51.15).
    const first = await (await post('admin', '/evidence', {
      unitId, grantorName: 'Rights Holder', claimedAuthority: 'Copyright holder', source: 'letter', evidenceReference: 'box 1',
      uses: ['publication'], naming: 'unnamed', covered: [{ unitId, contentRev: 1 }],
    })).json<EvidenceGrant>();
    const second = await post('admin', '/evidence', {
      unitId, grantorName: 'Rights Holder', claimedAuthority: 'Copyright holder', source: 'letter', evidenceReference: 'box 2',
      uses: ['publication'], naming: 'unnamed', covered: [{ unitId, contentRev: 1 }], supersedesId: first.id,
    });
    expect(second.status).toBe(201);
    const list = await world.request('admin', 'GET', `/units/${unitId}/evidence`);
    const grants = (await list.json<{ grants: EvidenceGrant[] }>()).grants;
    const earlier = grants.find((g) => g.id === first.id)!;
    expect(earlier.supersededById).not.toBeNull();
    const supersededRow: EvidenceRow = {
      id: earlier.id, unitId, snapshotHash: earlier.snapshotHash, covered: earlier.covered, uses: earlier.uses,
      naming: earlier.naming, verified: earlier.verified, ...(earlier.supersededById === null ? {} : { supersededById: earlier.supersededById }),
    };
    expect(isLiveGrant(supersededRow, world.at)).toBe(false);
    expect(coverChange([supersededRow], textChange).covered).toBe(false);
  });

  // The maximum-encoded-input case: a grant covers at most EVIDENCE_LIMITS.coveredItems identities. The schema refuses
  // a covered set one past the bound as a pure validation, with nothing stored; and a multi-identity grant that the
  // bounded write accepts is sealed exactly and still covers the exact change for the unit it is about (the current-
  // access case). The over-bound set is rejected by the input schema before any write, so the refusal is exact whatever
  // the write path's own per-statement ceiling is.
  it('refuses a covered set past the bound with nothing stored, and seals and covers a multi-identity grant exactly', async () => {
    const about = await attachment();
    const body = (covered: { unitId: ULID; contentRev: number }[]) => ({
      unitId: about, grantorName: 'Rights Holder', claimedAuthority: 'Copyright holder', source: 'letter', evidenceReference: 'box 9',
      uses: ['publication'], naming: 'unnamed', covered,
    });
    const before = await world.core().prepare('SELECT count(*) AS n FROM permission_evidence').first<number>('n');

    // One identity past the bound is refused by the input schema, and nothing is stored (R51.15, R51.16).
    const tooMany = Array.from({ length: EVIDENCE_LIMITS.coveredItems + 1 }, () => ({ unitId: about, contentRev: 1 }));
    const refused = await post('admin', '/evidence', body(tooMany));
    expect(refused.status).toBe(422);
    expect(await world.core().prepare('SELECT count(*) AS n FROM permission_evidence').first<number>('n')).toBe(before ?? 0);

    // A grant carrying several distinct covered identities is sealed and read back exactly.
    const others = [about, await attachment(), await attachment()];
    const covered = others.map((unitId) => ({ unitId, contentRev: 1 }));
    const recorded = await post('admin', '/evidence', body(covered));
    expect(recorded.status, await recorded.clone().text()).toBe(201);
    const grant = await recorded.json<EvidenceGrant>();
    expect(grant.covered.length).toBe(covered.length);
    expect(await world.core().prepare('SELECT count(*) AS n FROM permission_evidence').first<number>('n')).toBe((before ?? 0) + 1);

    // The current-access case: the exact change the grant was signed against is covered for the unit it is about.
    const row: EvidenceRow = {
      id: grant.id, unitId: about, snapshotHash: grant.snapshotHash, covered: grant.covered, uses: grant.uses, naming: grant.naming, verified: grant.verified,
    };
    expect(coverChange([row], { unitId: about, snapshotHash: grant.snapshotHash, contentRev: 1, use: 'publication', at: world.at })).toEqual({ covered: true, grantId: grant.id });
  });
});
