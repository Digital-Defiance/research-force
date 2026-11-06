// Feature: research-collab-cms, Property 72: Export JSON round trip
import { describe, expect, it } from 'vitest';
import { stableJson } from '@researchforce/domain/history';
import type { RichText } from '@researchforce/domain/richtext';
import type { DocumentDate, PartialDate } from '@researchforce/domain/types';
import type {
  AttachmentView, CreditView, DissentNoteView, EntrySectionView, FullContentView, LinkTarget, LinkView, ProjectRef,
  ProjectView, PublicView, ReplyView, ResearchItemView, UnitKey, ValueRef, WithheldView,
} from '@researchforce/kernel/views';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { archiveJson } from '@researchforce/public-render/export/data';

/**
 * Validates R35.4.
 *
 * Property 72: for any public snapshot, parsing the export's JSON yields, for every exported unit, each value its
 * Public_View shows — character for character, with dates in ISO 8601 at their recorded precision — together with the
 * Cross_Links the view presents, each Research_Item's Project, and each child's Parent and position.
 *
 *  - R35.4 — `data/archive.json` holds, for every exported unit, each value its view shows with the same characters,
 *            dates already in ISO 8601 at their recorded precision, the presented Cross_Links, each Research_Item's
 *            Project, and each child's Parent and its position in the Parent's arrays.
 *
 * Chosen layer. The single production path that writes `data/archive.json` is `archiveJson`
 * (packages/public-render/src/export/data.ts), the encoder `renderExport` calls for the export's JSON twin; the export
 * job (apps/app/src/jobs/export.ts) writes its output verbatim and the package is read back with `JSON.parse`. So this
 * property drives the REAL `archiveJson` to encode a generated snapshot of Public_Views and `JSON.parse` to decode it —
 * it never reimplements the serialization. The round trip is encode → parse → compare each unit against its source
 * view. `stableJson` (packages/domain/src/history.ts), the production canonicaliser `archiveJson` itself uses, is the
 * semantic-equality oracle: two values are equal when they serialise identically whatever their key order, so a decoded
 * unit matches its source iff no value, character, digit string, date, link, Project, or array position was lost or
 * mangled.
 *
 * Adversarial content. The generators push exactly what a JSON round trip could mangle: strings with diacritics, mixed
 * case, leading and trailing spaces, inner line breaks, quotes and backslashes, control characters, and astral
 * code points; digit strings and numeric-looking strings (`"007"`, `"9007199254740993"`, `"1e400"`) that must survive
 * as strings, never coerced to numbers; `PartialDate` values at year, year-month, and day precision that must stay at
 * their recorded precision; Cross_Links (outgoing and incoming, to present and Withheld targets); each Attachment's
 * Parent and each Research_Item's Project; and the ordered child arrays (attachments, replies, dissent) whose positions
 * carry a child's place under its Parent. Object keys are also emitted in a randomised order so the round trip cannot
 * lean on insertion order.
 *
 * No shared state. This property exercises two pure functions over generated values — no D1, R2, or Durable Object — so
 * the p88 per-run reset and the p78 run cap used by the stateful export/record properties do not apply here; it runs
 * the full `FC_RUNS` with no setup between runs.
 */

// --- Adversarial leaf generators -------------------------------------------

/** Strings with the characters a JSON round trip must preserve exactly: quotes, backslashes, control chars, line breaks, and astral code points. */
const trickyString = fc.oneof(
  fc.string({ maxLength: 24 }),
  fc.constantFrom(
    'plain', 'Émile Example', 'MiXeD CaSe', '  leading and trailing  ', 'line one\nline two',
    'tab\tbetween', 'carriage\r\nreturn', 'quote "inside" and \\backslash\\', 'a/relative\\path',
    '</script>', 'null\0byte', 'astral \u{1F9EA} and \u{1D11E}', 'ẞ ligature', '日本語', 'عربي', 'zero‑width\u200b',
    '', ' ', '\n', '   ',
  ),
);
/** Digit strings and numeric-looking strings that must survive the round trip AS STRINGS, never coerced to a JS number. */
const digitString = fc.oneof(
  fc.string({ unit: fc.constantFrom(...'0123456789'.split('')), minLength: 1, maxLength: 20 }),
  fc.constantFrom('0', '007', '000', '9007199254740993', '12345678901234567890', '1e400', '0.1000', '-0', '+1', '3.14'),
);
const anyString = fc.oneof({ weight: 3, arbitrary: trickyString }, { weight: 2, arbitrary: digitString });
// Optional view fields are modelled by leaving the key out of `requiredKeys`, so a generated value either carries a
// concrete value or omits the key entirely — never a present `undefined`. That mirrors how the Public_Views carry
// their optional fields and keeps the round trip comparing like for like (JSON has no `undefined`).

/** A `PartialDate` at year, year-month, or day precision — the precision the round trip must keep (R45.12). */
const partialDateArb: fc.Arbitrary<PartialDate> = fc.record({
  value: fc.constantFrom('1949', '1950-03', '1951-04-02', '1952', '1953-12-31', '2026-01-05', '0001', '9999-12-31'),
  approx: fc.boolean(),
});
/** A `DocumentDate`: a single `PartialDate` or a start–end range. */
const documentDateArb: fc.Arbitrary<DocumentDate> = fc.oneof(
  partialDateArb,
  fc.record({ start: partialDateArb, end: partialDateArb }),
);

/** A RichText value with a few plausible spans; its text carries the adversarial characters. */
const richTextArb: fc.Arbitrary<RichText> = fc.record({
  text: anyString,
  spans: fc.constant([] as RichText['spans']),
});

const ulidArb = fc.string({ unit: fc.constantFrom(...'0123456789ABCDEFGHJKMNPQRSTVWXYZ'.split('')), minLength: 26, maxLength: 26 });
const valueRefArb: fc.Arbitrary<ValueRef> = fc.record({ id: ulidArb, name: anyString });
const creditArb: fc.Arbitrary<CreditView> = fc.record(
  { name: anyString, affiliation: anyString, profiled: fc.constant(true as const) },
  { requiredKeys: ['name'] },
);

// --- Keys and links --------------------------------------------------------

/** The unit keys the snapshot assigns; links and Parent/Project references point at these. */
const UNIT_KEYS = ['u:a', 'u:b', 'u:c', 'u:d', 'u:e'] as const;
const PROJECT_KEYS = ['p:1', 'p:2'] as const;
const keyArb = fc.constantFrom<UnitKey>(...UNIT_KEYS);

const projectRefArb: fc.Arbitrary<ProjectRef> = fc.record(
  { key: fc.constantFrom<UnitKey>(...PROJECT_KEYS), name: anyString, slug: anyString, path: anyString, accent: anyString },
  { requiredKeys: ['key', 'name', 'slug', 'path'] },
);
const lineArb = fc.record(
  { kindOfMaterial: anyString, date: partialDateArb, parties: fc.array(anyString, { maxLength: 3 }), note: anyString },
  { requiredKeys: ['kindOfMaterial', 'date', 'parties'] },
);
/** The other end of a Cross_Link: a present unit or a Withheld one (R24.8). */
const linkTargetArb: fc.Arbitrary<LinkTarget> = fc.oneof(
  fc.record(
    { tag: fc.constant('link' as const), key: keyArb, path: anyString, type: fc.constantFrom('research_item', 'attachment', 'project'), title: anyString, kind: fc.constantFrom('finding', 'source', 'hypothesis') },
    { requiredKeys: ['tag', 'key', 'path', 'type', 'title'] },
  ),
  fc.record(
    { tag: fc.constant('withheld' as const), key: keyArb, path: anyString, line: lineArb },
    { requiredKeys: ['tag', 'key', 'line'] },
  ),
);
const linkArb: fc.Arbitrary<LinkView> = fc.record(
  { direction: fc.constantFrom('outgoing', 'incoming'), relation: valueRefArb, target: linkTargetArb },
  { requiredKeys: ['direction', 'target'] },
);
const linksArb = fc.array(linkArb, { maxLength: 3 });
/** Ordered child references; their position in the array is a child's place under its Parent (R35.4). */
const childRefsArb = fc.array(fc.record({ key: keyArb }), { maxLength: 4 });

// --- View generators -------------------------------------------------------

const projectViewArb = (key: UnitKey): fc.Arbitrary<ProjectView> => fc.record(
  { tag: fc.constant('project' as const), key: fc.constant(key), path: anyString, name: anyString, description: anyString, slug: anyString, accent: anyString },
  { requiredKeys: ['tag', 'key', 'path', 'name', 'description', 'slug'] },
);
const withheldViewArb = (key: UnitKey): fc.Arbitrary<WithheldView> => fc.record(
  { tag: fc.constant('withheld' as const), key: fc.constant(key), path: anyString, line: lineArb, project: projectRefArb },
  { requiredKeys: ['tag', 'key', 'line'] },
);
const researchItemViewArb = (key: UnitKey): fc.Arbitrary<ResearchItemView> => fc.record(
  {
    tag: fc.constant('research_item' as const), key: fc.constant(key), path: anyString,
    kind: fc.constantFrom('finding', 'source', 'hypothesis', 'journal_entry', 'topic', 'research_question'),
    title: anyString, publicSummary: richTextArb, itemDate: documentDateArb, logDate: partialDateArb,
    credit: fc.array(creditArb, { maxLength: 3 }), identifier: anyString, withdrawal: fc.record({ date: anyString, reason: anyString }),
    project: projectRefArb, firstPublicOn: anyString, attachments: childRefsArb, links: linksArb,
    question: anyString,
    full: fc.record({
      fields: fc.constant([] as FullContentView['fields']),
      logSummary: richTextArb, sections: childRefsArb, replies: childRefsArb, dissent: childRefsArb,
    }, { requiredKeys: ['fields', 'sections', 'replies', 'dissent'] }),
  },
  { requiredKeys: ['tag', 'key', 'path', 'kind', 'title', 'itemDate', 'logDate', 'credit', 'identifier', 'project', 'firstPublicOn', 'attachments', 'links'] },
);
const attachmentViewArb = (key: UnitKey): fc.Arbitrary<AttachmentView> => fc.record(
  {
    tag: fc.constant('attachment' as const), key: fc.constant(key), path: anyString, title: anyString,
    fileKind: fc.constantFrom('pdf', 'image', 'archive', 'spreadsheet', 'csv', 'structured_data', 'text_log', 'video', 'other'), size: fc.nat({ max: 5_000_000_000 }),
    caption: anyString, credit: fc.array(creditArb, { maxLength: 2 }), origin: anyString, identifier: anyString,
    rights: fc.record({ status: valueRefArb, holder: anyString, terms: anyString, licenceCovers: fc.boolean() }, { requiredKeys: ['status', 'licenceCovers'] }),
    download: anyString,
    supersededBy: fc.record({ key: keyArb, path: anyString, uploadedOn: anyString }),
    parent: fc.record({ key: keyArb, path: anyString }), project: projectRefArb,
    links: linksArb, replies: childRefsArb,
  },
  { requiredKeys: ['tag', 'key', 'path', 'title', 'fileKind', 'size', 'credit', 'origin', 'identifier', 'rights', 'download', 'parent', 'project', 'links', 'replies'] },
);
const entrySectionViewArb = (key: UnitKey): fc.Arbitrary<EntrySectionView> => fc.record(
  { tag: fc.constant('entry_section' as const), key: fc.constant(key), text: richTextArb, links: linksArb },
);
const replyViewArb = (key: UnitKey): fc.Arbitrary<ReplyView> => fc.record(
  {
    tag: fc.constant('reply' as const), key: fc.constant(key), text: richTextArb, author: anyString, postedOn: anyString,
    withdrawal: fc.record({ date: anyString, reason: anyString }), attachments: childRefsArb, replies: childRefsArb, links: linksArb,
  },
  { requiredKeys: ['tag', 'key', 'text', 'author', 'postedOn', 'attachments', 'replies', 'links'] },
);
const dissentViewArb = (key: UnitKey): fc.Arbitrary<DissentNoteView> => fc.record(
  { tag: fc.constant('dissent_note' as const), key: fc.constant(key), text: richTextArb, author: anyString, savedOn: anyString, earlierWording: fc.boolean(), authorProfiled: fc.constant(true as const) },
  { requiredKeys: ['tag', 'key', 'text', 'author', 'savedOn', 'earlierWording'] },
);

/** Any Public_View for a given key, across every tag the archive exports. */
const viewForKey = (key: UnitKey): fc.Arbitrary<PublicView> => fc.oneof(
  researchItemViewArb(key), attachmentViewArb(key), withheldViewArb(key),
  entrySectionViewArb(key), replyViewArb(key), dissentViewArb(key),
);

/** A whole snapshot: two Projects plus a handful of units of varied tags, keyed as the `public_views` table would key them. */
const snapshotArb: fc.Arbitrary<{ views: Map<UnitKey, PublicView>; startedAt: string; scope: string }> = fc.record({
  projects: fc.tuple(projectViewArb(PROJECT_KEYS[0]), projectViewArb(PROJECT_KEYS[1])),
  units: fc.tuple(viewForKey(UNIT_KEYS[0]), viewForKey(UNIT_KEYS[1]), viewForKey(UNIT_KEYS[2]), viewForKey(UNIT_KEYS[3]), viewForKey(UNIT_KEYS[4])),
  startedAt: fc.constantFrom('2026-05-06T00:07:00.000Z', '1999-12-31T23:59:59.000Z'),
  scope: anyString,
}).map(({ projects, units, startedAt, scope }) => {
  const views = new Map<UnitKey, PublicView>();
  for (const project of projects) views.set(project.key, project);
  for (const unit of units) views.set(unit.key, unit);
  return { views, startedAt, scope };
});

/** The decoded shape of `data/archive.json`: the two top-level fields and the units keyed by their Unit_Key. */
interface DecodedArchive { readonly exportedAt: string; readonly scope: string; readonly units: Record<string, unknown> }

describe('Property 72: Export JSON round trip', () => {
  it('encodes every unit of a snapshot and parses it back with each value, date, Cross_Link, Project, and child position intact', () => {
    fc.assert(fc.property(snapshotArb, (snapshot) => {
      // Encode with the REAL export encoder, then decode with the reader's JSON.parse — the full round trip.
      const json = archiveJson(snapshot.views, snapshot.startedAt, snapshot.scope);
      const decoded = JSON.parse(json) as DecodedArchive;

      // The envelope keeps the start time and scope verbatim (R35.1, R35.4).
      expect(decoded.exportedAt).toBe(snapshot.startedAt);
      expect(decoded.scope).toBe(snapshot.scope);

      // Every exported unit is present under its own Unit_Key, and no extra unit appears.
      expect(new Set(Object.keys(decoded.units))).toEqual(new Set(snapshot.views.keys()));

      for (const [key, view] of snapshot.views) {
        const parsed = decoded.units[key];
        // Semantic equality: the decoded unit serialises identically to the source view. `stableJson` is order- and
        // key-insensitive, so this holds iff nothing was lost or mangled — no coerced digit string, no dropped field,
        // no altered character, date, link, Project reference, or array position (R35.4).
        expect(stableJson(parsed), `unit ${key} round-trips with no loss`).toBe(stableJson(view));

        // Targeted, type-aware checks that the oracle above would also catch, pinned so a regression names the field.
        const asObject = parsed as Record<string, unknown>;
        expect(asObject['tag'], `unit ${key} keeps its tag`).toBe(view.tag);

        if (view.tag === 'research_item') {
          const ri = asObject as unknown as ResearchItemView;
          // The title's characters survive exactly (no escaping artefact, no whitespace trim).
          expect(ri.title).toBe(view.title);
          // The identifier — often a digit-bearing string — stays a string, character for character.
          expect(ri.identifier).toBe(view.identifier);
          expect(typeof ri.identifier).toBe('string');
          // Dates keep their recorded ISO precision (year / year-month / day), unchanged.
          expect(ri.itemDate).toEqual(view.itemDate);
          expect(ri.logDate).toEqual(view.logDate);
          // Each Research_Item's Project reference is preserved (R35.4).
          expect(ri.project).toEqual(view.project);
          // Child positions: each ordered array matches the source element for element (a child's place under its Parent).
          expect(ri.attachments).toEqual(view.attachments);
          if (view.full) expect(ri.full?.replies).toEqual(view.full.replies);
          if (view.full) expect(ri.full?.dissent).toEqual(view.full.dissent);
          // The presented Cross_Links are preserved in order (R35.4).
          expect(ri.links).toEqual(view.links);
        } else if (view.tag === 'attachment') {
          const att = asObject as unknown as AttachmentView;
          expect(att.title).toBe(view.title);
          expect(att.identifier).toBe(view.identifier);
          // A child's Parent reference is preserved (R35.4).
          expect(att.parent).toEqual(view.parent);
          expect(att.project).toEqual(view.project);
          expect(att.links).toEqual(view.links);
          // The byte size is a number the round trip keeps exactly.
          expect(att.size).toBe(view.size);
        }
      }
    }), { numRuns: FC_RUNS });
  }, 50 * FC_RUNS);
});
