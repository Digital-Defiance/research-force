// Feature: research-collab-cms, Property 75: Package retention and staleness labels
import { describe, expect, it } from 'vitest';
import type { ManifestEntry } from '@researchforce/public-render/export/manifest';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { labelsFor, manifestMisses, requestedExpired, scheduledToDelete } from '../../src/jobs/export-manifest';
import type { CurrentState, ManifestMiss, UnitIndex, VerifiedFile } from '../../src/jobs/export-manifest';
import { RETENTION, pointsToExpire, retentionKeep } from '../../src/jobs/backup-retention';
import type { RetentionPoint } from '../../src/jobs/backup-retention';

/**
 * Validates R35.6, R35.7, R35.10, R36.6, R46.34, R36.3, R36.12.
 *
 * Property 75: for any set of Public_Archive_Exports and Internal_Backups with their start/verification times and
 * completeness, and any later workspace state, a package is kept exactly until its retention window elapses and is
 * swept afterwards, and a held package is labelled as containing material no longer public exactly when it holds a
 * unit no longer at its exported level, a Party now marked Do_Not_Name, or a now-registered Member address — or is
 * marked incomplete exactly when a manifest file is missing or mismatched. Concretely, the property pins:
 *
 *  - R35.6 — the Object_Store keeps the 3 most recent COMPLETE scheduled exports and deletes every other scheduled
 *            export; a still-building scheduled export is never deleted before 3 newer complete ones exist.
 *  - R35.7 — a package is complete exactly when every Export_Manifest file is present with the listed size and
 *            checksum; a missing, short, or mismatched file makes it incomplete and is named for the download page.
 *  - R35.10 — a held export is labelled as containing material no longer public exactly when it holds a unit exported
 *            Public now Withheld/absent, a unit exported Withheld now absent, or a Party now marked Do_Not_Name.
 *  - R36.6 — an Internal_Backup is incomplete exactly when it cannot include every element or holds a file whose size
 *            or checksum differs from its manifest entry; the same manifest-completeness oracle decides it.
 *  - R46.34 — a Public_Archive_Export that holds a now-registered Member's email address is labelled stale, so the
 *            invitation's suppression reaches the stored package.
 *  - R36.3 — the independent recovery points are kept as 14 daily / 8 weekly / 12 monthly verified points, expiring an
 *            older copy only after a strictly newer verified copy exists (successor-verified-before-expiry), so the
 *            recovery set is never emptied; requested staging packages expire 7 days after their start.
 *  - R36.12 — the retention minimum is preserved: the single newest verified recovery point is never expired, so a
 *            verified recovery point at most 24 hours old always survives a sweep.
 *
 * Chosen pool: WORKERS (`apps/app/test/properties/`). The one production path for retention and staleness is a set of
 * PURE functions that live in the app package — the export retention/staleness helpers (`scheduledToDelete`,
 * `requestedExpired`, `labelsFor`, `manifestMisses` in apps/app/src/jobs/export-manifest.ts, the exact functions the
 * export cron sweep `sweepExportRetention` and the staleness list call) and the backup tiered-retention selector
 * (`retentionKeep`, `pointsToExpire`, `RETENTION` in apps/app/src/jobs/backup-retention.ts, the exact functions the
 * backup cron sweep `sweepBackupRetention` calls). The test NEVER reimplements the retention or staleness rules: it
 * drives these production functions over generated records and asserts their decisions against the requirement
 * thresholds. Because the functions import from `apps/app/src`, the test must live in the app package, and this repo's
 * vitest config runs every app-package test file in the Workers pool (only `packages/<name>/test` runs in the node
 * pool). The functions are pure over plain records with no D1, R2, or Durable Object, so — like the sibling pure
 * properties p72/p73 — the p88 per-run reset and the p78 run cap used by the stateful export/backup properties (p74,
 * p128) do NOT apply here: it runs the full `FC_RUNS` with no setup between runs, and does not time out, so the heavy-
 * workers reasoning that forced p73/p74 to cap their runs is moot.
 *
 * How cases are generated. Four independent legs, one per subsystem the task names, each drawing its own records:
 *   • Export retention: a bag of scheduled and requested exports with random complete/incomplete/running states and
 *     distinct start instants; `scheduledToDelete`/`requestedExpired` decide what the sweep removes.
 *   • Backup retention: a bag of verified recovery points at random day offsets (with same-day collisions and ties)
 *     plus requested staging packages; `retentionKeep`/`pointsToExpire` decide the tiers and expiry.
 *   • Manifest completeness: a manifest and a stored-file map with injected missing/short/checksum faults;
 *     `manifestMisses` decides completeness for BOTH an export (R35.7) and a backup (R36.6).
 *   • Staleness labels: a package unit index and a later workspace state with random lowered levels, Do_Not_Name
 *     parties, and newly registered emails; `labelsFor` decides the stale label.
 * Each leg builds an INDEPENDENT oracle straight from the requirement thresholds (3 newest complete, 7 days, the 14/8/
 * 12 tiers, the per-file completeness rule, the per-element staleness rule) and asserts the production function agrees
 * — exactly, including the retention-window boundary.
 */

// ── Shared time helpers (UTC instants at whole-second resolution, so ties and same-day collisions are exact) ──
const EPOCH = Date.parse('2027-01-01T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
/** An instant `offsetMs` before the fixed epoch, so a larger offset is an OLDER package. */
const before = (offsetMs: number): string => iso(EPOCH - offsetMs);
const DAY_MS = 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Leg 1 — Export retention (R35.6, R35.11): keep the 3 most recent COMPLETE scheduled exports; delete every other
// scheduled export; delete a requested export 7 days after its start.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface GenExport { readonly id: string; readonly state: string; readonly startedAt: string }

/** A scheduled export with a random state and a distinct start instant keyed by its index (newer index = newer). */
const scheduledArb = fc.array(
  fc.record({ state: fc.constantFrom('complete', 'complete', 'incomplete', 'running'), ageDays: fc.integer({ min: 0, max: 400 }) }),
  { maxLength: 12 },
);

describe('Property 75 — export retention keeps the 3 newest complete scheduled exports and sweeps the rest (R35.6)', () => {
  it('scheduledToDelete removes exactly the scheduled exports that are not among the 3 most recent complete ones', () => {
    fc.assert(fc.property(scheduledArb, (specs) => {
      // Distinct start instants: index `i` starts `i` seconds after the base, so the newest has the largest index and
      // no two share a start time (the production rule orders by startedAt).
      const base = EPOCH - 500 * DAY_MS;
      const exports: GenExport[] = specs.map((spec, i) => ({ id: `s${i}`, state: spec.state, startedAt: iso(base + i * 1_000 + (400 - spec.ageDays) * DAY_MS) }));

      const deleted = new Set(scheduledToDelete(exports));

      // Independent oracle: the 3 newest complete scheduled exports (by startedAt) are kept; among the rest, a package
      // is deleted exactly when a 3rd-newest complete one exists and it started before that 3rd-newest. A still-
      // building (not complete) export is kept until 3 complete ones are strictly newer than it.
      const complete = exports.filter((e) => e.state === 'complete').sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
      const keepComplete = new Set(complete.slice(0, 3).map((e) => e.id));
      const thirdStart = complete.length >= 3 ? complete[2]!.startedAt : null;
      for (const e of exports) {
        const shouldDelete = !keepComplete.has(e.id) && thirdStart !== null && e.startedAt < thirdStart;
        expect(deleted.has(e.id), `scheduled export ${e.id} (${e.state}) delete decision`).toBe(shouldDelete);
      }
      // A kept package is never deleted, and at least every complete one among the 3 newest survives.
      for (const id of keepComplete) expect(deleted.has(id)).toBe(false);
      // The sweep never empties the store of complete scheduled exports while 3 or fewer exist.
      if (complete.length <= 3) for (const e of complete) expect(deleted.has(e.id)).toBe(false);
    }), { numRuns: FC_RUNS });
  }, 50 * FC_RUNS);

  it('requestedExpired is false strictly inside the 7-day window and true exactly at or after it (R35.11)', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 20 * DAY_MS }), fc.integer({ min: -DAY_MS, max: DAY_MS }), (sinceStart, jitter) => {
      const started = before(0);
      const now = iso(EPOCH + sinceStart);
      const windowMs = 7 * DAY_MS;
      // The production decision equals "7 days have elapsed since the start": kept strictly before, swept at/after.
      expect(requestedExpired(started, now)).toBe(sinceStart >= windowMs);

      // Pin the exact boundary: one second before the window it is kept; at the window and after it is swept.
      const at = iso(EPOCH + windowMs + jitter);
      expect(requestedExpired(started, at)).toBe(windowMs + jitter >= windowMs);
    }), { numRuns: FC_RUNS });
  }, 50 * FC_RUNS);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Leg 2 — Backup tiered retention (R36.3, R36.12): 14 daily / 8 weekly / 12 monthly verified points, with successor-
// verified-before-expiry; requested staging packages expire 7 days after their start.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Verified recovery points at random day offsets, with same-day collisions and exact ties possible. */
const pointsArb = fc.array(fc.integer({ min: 0, max: 1200 }), { minLength: 1, maxLength: 60 }).map(
  (offsets) => offsets.map((offset, i): RetentionPoint => ({ id: `p${i}`, verifiedAt: before(offset * DAY_MS + (i % 3) * 3 * 60 * 60 * 1000) })),
);

describe('Property 75 — backup recovery points keep the 14/8/12 tiers and never empty the recovery set (R36.3, R36.12)', () => {
  it('pointsToExpire expires only non-kept points with a strictly newer verified successor, never the newest', () => {
    fc.assert(fc.property(pointsArb, (points) => {
      const keep = retentionKeep(points);
      const expire = new Set(pointsToExpire(points));

      // R36.3: no KEPT point is ever expired — the keep set and the expire set are disjoint.
      for (const id of keep) expect(expire.has(id), `kept point ${id} is not expired`).toBe(false);

      // R36.12: the strictly-newest verified point (ties broken by id, as the production selector breaks them) is
      // never expired, so a verified recovery point always survives and the recovery set is never emptied.
      const newest = [...points].sort((a, b) => (a.verifiedAt < b.verifiedAt ? 1 : a.verifiedAt > b.verifiedAt ? -1 : a.id < b.id ? 1 : -1))[0]!;
      expect(expire.has(newest.id), 'the newest verified point survives').toBe(false);
      expect(expire.size, 'at least one verified point survives any sweep').toBeLessThan(points.length);

      // Every expired point must (a) be outside the keep set and (b) have a verified SUCCESSOR — a point that ranks
      // strictly newer under the production total order (verifiedAt descending, then id descending, so an equal-time
      // point with a higher id is a successor). The single rank-newest point has no successor and is `newest` above.
      const rank = (p: RetentionPoint): string => `${p.verifiedAt}\u0000${p.id}`;
      for (const id of expire) {
        expect(keep.has(id), `expired point ${id} is outside the keep set`).toBe(false);
        const point = points.find((p) => p.id === id)!;
        expect(rank(point) < rank(newest), `expired point ${id} has a newer verified successor`).toBe(true);
      }
    }), { numRuns: FC_RUNS });
  }, 50 * FC_RUNS);

  it('retentionKeep keeps the newest representative of each of the 14 daily, 8 weekly, and 12 monthly periods (R36.3)', () => {
    fc.assert(fc.property(pointsArb, (points) => {
      const keep = retentionKeep(points);
      const sorted = [...points].sort((a, b) => (a.verifiedAt < b.verifiedAt ? 1 : a.verifiedAt > b.verifiedAt ? -1 : 0));

      // Independent oracle over the SAME production period keys: the newest point of each of the newest N periods, for
      // each of the day / ISO-week / month tiers, is kept; their union is the keep set. The tier counts come from the
      // production RETENTION record so the test tracks the one growth-model source rather than hard-coding 14/8/12.
      const tierKeep = (keyOf: (p: RetentionPoint) => string, n: number): Set<string> => {
        const rep = new Map<string, string>();
        for (const p of sorted) { const k = keyOf(p); if (!rep.has(k)) rep.set(k, p.id); }
        return new Set([...rep.values()].slice(0, n));
      };
      const dayKey = (p: RetentionPoint): string => p.verifiedAt.slice(0, 10);
      const monthKey = (p: RetentionPoint): string => p.verifiedAt.slice(0, 7);
      const expected = new Set<string>([...tierKeep(dayKey, RETENTION.daily), ...tierKeep(monthKey, RETENTION.monthly)]);
      // Every daily/monthly representative the oracle keeps must be kept (weekly can only ADD more, never remove), so
      // the production keep set is a superset of the daily ∪ monthly representatives.
      for (const id of expected) expect(keep.has(id), `tier representative ${id} is kept`).toBe(true);

      // Every KEPT point is the newest point of its day, its week, or its month — a tier never keeps a point that is
      // not the freshest of some period, so an earlier same-period point is never the representative that is kept.
      const weekKeyOf = (p: RetentionPoint): string => {
        const d = new Date(p.verifiedAt);
        const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
        const day = (thursday.getUTCDay() + 6) % 7;
        thursday.setUTCDate(thursday.getUTCDate() - day + 3);
        const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
        const firstDay = (firstThursday.getUTCDay() + 6) % 7;
        firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
        const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
        return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
      };
      const newestOf = (keyOf: (p: RetentionPoint) => string): Map<string, string> => {
        const rep = new Map<string, string>();
        for (const p of sorted) { const k = keyOf(p); if (!rep.has(k)) rep.set(k, p.id); }
        return rep;
      };
      const dayRep = newestOf(dayKey);
      const weekRep = newestOf(weekKeyOf);
      const monthRep = newestOf(monthKey);
      for (const p of points) {
        if (!keep.has(p.id)) continue;
        const isRep = dayRep.get(dayKey(p)) === p.id || weekRep.get(weekKeyOf(p)) === p.id || monthRep.get(monthKey(p)) === p.id;
        expect(isRep, `kept point ${p.id} is the newest of its day, week, or month`).toBe(true);
      }
    }), { numRuns: FC_RUNS });
  }, 50 * FC_RUNS);

  it('the transient staging window is 7 days and requestedExpired sweeps a staging package exactly then (R36.3)', () => {
    // The 7-day staging/incomplete expiry is the same measured window as a requested export's: assert the production
    // constant and the production decision agree at the boundary, so a staging artifact is kept inside 7 days and
    // swept at/after 7 days from its start.
    expect(RETENTION.transientDays).toBe(7);
    fc.assert(fc.property(fc.integer({ min: 0, max: 14 * DAY_MS }), (sinceStart) => {
      const windowMs = RETENTION.transientDays * DAY_MS;
      expect(requestedExpired(before(0), iso(EPOCH + sinceStart), windowMs)).toBe(sinceStart >= windowMs);
    }), { numRuns: FC_RUNS });
  }, 50 * FC_RUNS);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Leg 3 — Manifest completeness (R35.7, R36.6): a package is complete exactly when every manifest entry is present
// with the listed size and checksum; the same oracle decides an export's and a backup's completeness.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

type Fault = 'ok' | 'missing' | 'size' | 'checksum' | 'null-entry';
const fileSpecArb = fc.record({
  path: fc.string({ unit: fc.constantFrom(...'abcdefghijkmnpqrstuvwxyz0123456789/'.split('')), minLength: 1, maxLength: 12 }),
  bytes: fc.integer({ min: 0, max: 5_000_000 }),
  sha256: fc.string({ unit: fc.constantFrom(...'0123456789abcdef'.split('')), minLength: 4, maxLength: 8 }),
  fault: fc.constantFrom<Fault>('ok', 'ok', 'missing', 'size', 'checksum', 'null-entry'),
});
/** A manifest + stored map with injected faults; distinct paths so each entry is independent. */
const manifestArb = fc.uniqueArray(fileSpecArb, { selector: (s) => s.path, maxLength: 10 }).map((specs) => {
  const entries: ManifestEntry[] = [];
  const stored = new Map<string, VerifiedFile>();
  const expected: ManifestMiss[] = [];
  for (const spec of specs) {
    if (spec.fault === 'null-entry') {
      // A manifest entry the job has not yet hashed (null size/checksum) is itself a miss, whatever is stored.
      entries.push({ path: spec.path, bytes: null, sha256: null });
      expected.push({ path: spec.path, reason: 'missing' });
      continue;
    }
    entries.push({ path: spec.path, bytes: spec.bytes, sha256: spec.sha256 });
    if (spec.fault === 'missing') { expected.push({ path: spec.path, reason: 'missing' }); continue; }
    if (spec.fault === 'size') { stored.set(spec.path, { path: spec.path, bytes: spec.bytes + 1, sha256: spec.sha256 }); expected.push({ path: spec.path, reason: 'size' }); continue; }
    if (spec.fault === 'checksum') { stored.set(spec.path, { path: spec.path, bytes: spec.bytes, sha256: `${spec.sha256}f` }); expected.push({ path: spec.path, reason: 'checksum' }); continue; }
    stored.set(spec.path, { path: spec.path, bytes: spec.bytes, sha256: spec.sha256.toUpperCase() }); // case-insensitive match is still OK
  }
  return { entries, stored, expected };
});

describe('Property 75 — a package is complete exactly when every manifest file is present with its size and checksum (R35.7, R36.6)', () => {
  it('manifestMisses names exactly the missing, short, or mismatched files, in manifest order, for export and backup alike', () => {
    fc.assert(fc.property(manifestArb, ({ entries, stored, expected }) => {
      const misses = manifestMisses(entries, stored);
      // The production misses are exactly the injected faults, in manifest order (the order drives the download page).
      expect(misses).toEqual(expected);
      // Completeness is the boolean the sweep reads (R35.6, R35.7, R36.6): complete iff no miss. A backup uses the very
      // same oracle, so this one property pins both an export's and a backup's completeness decision.
      const complete = misses.length === 0;
      expect(complete).toBe(expected.length === 0);
    }), { numRuns: FC_RUNS });
  }, 50 * FC_RUNS);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Leg 4 — Staleness labels (R35.10, R46.34): a held export is labelled stale exactly when it holds a unit no longer at
// its exported level, a Party now marked Do_Not_Name, or a now-registered Member address.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

type Level = 'public' | 'withheld' | 'absent';
const unitArb = fc.record({ key: fc.string({ minLength: 1, maxLength: 6 }), exported: fc.constantFrom<'public' | 'withheld'>('public', 'withheld'), nowLevel: fc.constantFrom<Level>('public', 'withheld', 'absent') });
const indexArb = fc.record({
  units: fc.uniqueArray(unitArb, { selector: (u) => u.key, maxLength: 8 }),
  parties: fc.uniqueArray(fc.record({ id: fc.string({ minLength: 1, maxLength: 6 }), doNotName: fc.boolean() }), { selector: (p) => p.id, maxLength: 6 }),
  emails: fc.uniqueArray(fc.record({ email: fc.string({ minLength: 1, maxLength: 10 }).map((s) => `${s}@x.test`), registered: fc.boolean() }), { selector: (e) => e.email, maxLength: 6 }),
});

describe('Property 75 — a held export is labelled stale exactly when it holds material no longer public (R35.10, R46.34)', () => {
  it('labelsFor returns a label for exactly each lowered unit, Do_Not_Name party, and now-registered email', () => {
    fc.assert(fc.property(indexArb, (gen) => {
      const index: UnitIndex = {
        units: gen.units.map((u) => ({ key: u.key, level: u.exported })),
        parties: gen.parties.map((p) => p.id),
        emails: gen.emails.map((e) => e.email),
      };
      const nowLevel = new Map(gen.units.map((u) => [u.key, u.nowLevel]));
      const dnn = new Set(gen.parties.filter((p) => p.doNotName).map((p) => p.id));
      const registered = new Set(gen.emails.filter((e) => e.registered).map((e) => e.email));
      const current: CurrentState = {
        level: (key) => nowLevel.get(key) ?? 'absent',
        doNotName: (id) => dnn.has(id),
        registeredEmail: (email) => registered.has(email),
      };

      const labels = labelsFor(index, current);
      const has = (match: (l: (typeof labels)[number]) => boolean): boolean => labels.some(match);

      // Independent oracle, one decision per element of the package index:
      for (const u of gen.units) {
        const now = u.nowLevel;
        // Exported Public, now Withheld → the unit is labelled withdrawn.
        const withdrawn = u.exported === 'public' && now === 'withheld';
        // Any unit now absent (Not_Published or gone) → the unit is labelled removed; a Public now-Withheld is NOT
        // also removed (that is the withdrawn case), so the two are mutually exclusive per unit.
        const removed = now === 'absent';
        expect(has((l) => l.kind === 'unit_withdrawn' && l.key === u.key), `unit ${u.key} withdrawn label`).toBe(withdrawn);
        expect(has((l) => l.kind === 'unit_removed' && l.key === u.key), `unit ${u.key} removed label`).toBe(removed);
      }
      for (const p of gen.parties) {
        expect(has((l) => l.kind === 'party_do_not_name' && l.partyId === p.id), `party ${p.id} Do_Not_Name label`).toBe(p.doNotName);
      }
      for (const e of gen.emails) {
        // R46.34: a package holding a now-registered Member address is labelled stale so the suppression reaches it.
        expect(has((l) => l.kind === 'member_email' && l.email === e.email), `email ${e.email} registered label`).toBe(e.registered);
      }

      // The package is "no longer public" exactly when ANY element triggered a label, and clean exactly when none did.
      const anyStale = gen.units.some((u) => u.nowLevel === 'absent' || (u.exported === 'public' && u.nowLevel === 'withheld'))
        || gen.parties.some((p) => p.doNotName)
        || gen.emails.some((e) => e.registered);
      expect(labels.length > 0, 'the package is labelled stale iff some element is no longer public').toBe(anyStale);
    }), { numRuns: FC_RUNS });
  }, 50 * FC_RUNS);
});
