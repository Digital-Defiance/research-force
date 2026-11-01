import { describe, expect, it } from 'vitest';
import { coverChange, grantCovers, isLiveGrant, NEUTRAL_NAME_FALLBACK, withheldName } from '../src/evidence';
import type { CoverageRequest, EvidenceRow } from '../src/evidence';

const hash = 'a'.repeat(64);
const other = 'b'.repeat(64);
const fileHash = 'c'.repeat(64);
const at = '2026-10-31T00:00:00.000Z';

const grant = (overrides: Partial<EvidenceRow> = {}): EvidenceRow => ({
  id: 'G1', unitId: 'U', snapshotHash: hash, covered: [{ unitId: 'U', contentRev: 1 }], uses: ['publication'], naming: 'unnamed', verified: true, ...overrides,
});
const request = (overrides: Partial<CoverageRequest> = {}): CoverageRequest => ({ unitId: 'U', snapshotHash: hash, contentRev: 1, use: 'publication', at, ...overrides });

describe('a live grant (R51.9, R51.15, R51.18)', () => {
  it('is a verified grant that is unexpired and neither withdrawn nor superseded', () => {
    expect(isLiveGrant(grant(), at)).toBe(true);
    // A hand-set, unverified legacy status is never live, so it covers nothing.
    expect(isLiveGrant(grant({ verified: false }), at)).toBe(false);
    expect(isLiveGrant(grant({ withdrawnAt: at }), at)).toBe(false);
    expect(isLiveGrant(grant({ supersededById: 'G2' }), at)).toBe(false);
    expect(isLiveGrant(grant({ expiresAt: '2026-10-30T00:00:00.000Z' }), at)).toBe(false);
    expect(isLiveGrant(grant({ expiresAt: '2026-11-01T00:00:00.000Z' }), at)).toBe(true);
  });
});

describe('exact-snapshot coverage (R51.9, R51.16, R51.18)', () => {
  it('covers a change only against the exact snapshot, content revision, and use it was signed for', () => {
    expect(grantCovers(grant(), request())).toBe(true);
    // A different resulting snapshot, a changed body, a different unit, or an unlisted use is uncovered.
    expect(grantCovers(grant(), request({ snapshotHash: other }))).toBe(false);
    expect(grantCovers(grant(), request({ contentRev: 2 }))).toBe(false);
    expect(grantCovers(grant(), request({ unitId: 'V' }))).toBe(false);
    expect(grantCovers(grant(), request({ use: 'file_share' }))).toBe(false);
  });

  it('covers a rights change presenting a file only when the exact bytes and size match (R51.16)', () => {
    const rights = grant({ uses: ['publication', 'file_share'], covered: [{ unitId: 'U', contentRev: 1, fileHash, fileSize: 2048 }] });
    expect(grantCovers(rights, request({ use: 'file_share', fileHash, fileSize: 2048 }))).toBe(true);
    expect(grantCovers(rights, request({ use: 'file_share', fileHash: other, fileSize: 2048 }))).toBe(false);
    expect(grantCovers(rights, request({ use: 'file_share', fileHash, fileSize: 4096 }))).toBe(false);
  });

  it('refuses an uncovered change and names the grants considered, so the caller can offer a new request (R51.9)', () => {
    const rows = [grant({ id: 'legacy', verified: false }), grant({ id: 'stale', snapshotHash: other })];
    const result = coverChange(rows, request());
    expect(result.covered).toBe(false);
    if (!result.covered) expect(result.reason).toEqual({ unitId: 'U', use: 'publication', consideredIds: ['legacy', 'stale'] });
    // A single live grant for the exact snapshot covers the change; a hand-set status alone never does.
    expect(coverChange([...rows, grant({ id: 'real' })], request())).toEqual({ covered: true, grantId: 'real' });
    expect(coverChange(rows, request())).not.toEqual({ covered: true });
  });
});

describe('the Withheld neutral-name fallback and Do_Not_Name precedence (R51.17)', () => {
  const party = { name: 'Jane Writer', doNotName: false } as const;
  it('names the Party only with a current naming grant and Do_Not_Name off', () => {
    const named = [grant({ naming: 'named' })];
    expect(withheldName(party, named, 'U', at)).toBe('Jane Writer');
    // Do_Not_Name always wins, even over a grant that permitted naming.
    expect(withheldName({ ...party, doNotName: true }, named, 'U', at)).toBe(NEUTRAL_NAME_FALLBACK);
    // Without a naming grant the withheld name never appears.
    expect(withheldName(party, [grant({ naming: 'unnamed' })], 'U', at)).toBe(NEUTRAL_NAME_FALLBACK);
  });

  it('falls back to the grant label, then the Party label, then a neutral role label, never the withheld name', () => {
    expect(withheldName({ ...party, doNotName: true, genericLabel: 'a reader' }, [], 'U', at)).toBe('a reader');
    expect(withheldName({ ...party, doNotName: true }, [grant({ naming: 'named', label: 'the correspondent' })], 'U', at)).toBe(NEUTRAL_NAME_FALLBACK);
    // An expired naming grant does not name the Party.
    expect(withheldName(party, [grant({ naming: 'named', expiresAt: '2026-10-30T00:00:00.000Z' })], 'U', at)).toBe(NEUTRAL_NAME_FALLBACK);
  });
});
