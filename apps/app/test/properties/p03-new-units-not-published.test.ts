// Feature: research-collab-cms, Property 3: New Disclosure_Units start Not_Published
import { describe, expect, it } from 'vitest';
import { BUILT_IN_VALUE_IDS } from '@researchforce/domain/value-sets';
import { newULID } from '@researchforce/domain/identifiers';
import type { ItemKind, ULID } from '@researchforce/domain/types';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { JOB_HANDLERS } from '../../src/do/jobs';
import type { JsonValue } from '../../src/do/jobs';
import '../../src/api/routes/imports';
import { itemWorld } from '../items';
import type { ItemView, Who } from '../items';
import { addProject, resetRecords } from '../units';
import { completedUpload, configureFiles, fileInput } from '../files';

/**
 * Property 3: New Disclosure_Units start Not_Published.
 *
 * **Validates: Requirements 13.5, 23.2, 23.15, 26.4, 32.4, 33.2, 37.5, 39.4, 42.1**
 *
 * EVERY newly-created Disclosure_Unit — whatever the creation path — starts with Disclosure_Level Not_Published (and
 * Classification_State Unclassified where the path creates it Unclassified), never Public or Withheld, and leaves no
 * public trace until an explicit, separately-gated disclosure change. The nine criteria cover the distinct creation
 * flows, each read character-for-character against requirements.md:
 *
 *  - R23.2  — a Disclosure_Unit created by any means other than restoring an Internal_Backup gets Disclosure_Level
 *             Not_Published, including when an Administrator creates it, and keeps it Not_Published until an
 *             Administrator changes it. (The umbrella rule for the whole property.)
 *  - R13.5  — a new version added to a Version_Chain gets Not_Published whatever the superseded Attachment's level,
 *             and stays Not_Published until an Administrator sets another.
 *  - R23.15 — a Restoration gives each Entry_Section it adds back Not_Published; the ordinary Entry_Section creation
 *             path (a Journal_Entry's sections) likewise starts each section Not_Published.
 *  - R26.4  — a journal or attachment import creates each Journal_Entry, Entry_Section, or Attachment Not_Published
 *             and Unclassified.
 *  - R32.4  — accepting an Outside_Submission creates every Disclosure_Unit (Research_Items, Replies, Attachments)
 *             Not_Published and Unclassified.
 *  - R33.2  — a Source or Attachment created without a supplied Rights_Status (including a new version, acceptance of
 *             an Outside_Submission, or import) gets Rights_Status Unknown with empty holder and terms.
 *  - R37.5  — a Bulk_Import sets every Disclosure_Unit Not_Published and Unclassified, regardless of the manifest.
 *  - R39.4  — an Administrator creating a Project gets Disclosure_Level Not_Published.
 *  - R42.1  — attaching a Dissent_Note creates it Not_Published.
 *
 * Chosen layer. New units are created on the app's D1 creation handlers, so the most faithful proof drives the REAL
 * handlers through the Worker API against rf-core D1 and reads the stored `units.disclosure_level` /
 * `classification_state` (and `attachments.rights_status_id` for R33.2) immediately after each create, plus the
 * Effective_Disclosure the item projection reports. This file drives these real creation paths as the randomized
 * property:
 *
 *  - Research_Item of every kind                 — POST /items/{kind}            (R23.2, R39.4 project context)
 *  - Journal_Entry with Entry_Sections           — POST /items/journal-entry     (R23.2, R23.15 Entry_Section start)
 *  - Reply (discussion) and Group_Note           — POST /replies, groupNote field (R23.2)
 *  - Dissent_Note                                — POST /dissent                 (R42.1)
 *  - Attachment on an Item / Reply               — POST /attachments             (R23.2, R33.2 Rights Unknown)
 *  - Attachment new version in a Version_Chain   — POST /attachments supersedesId (R13.5, R33.2)
 *  - Project                                     — POST /projects                (R39.4)
 *  - Outside_Submission acceptance               — POST /moderation/{id}/decide  (R32.4, R33.2)
 *  - Bulk_Import of Research_Items + Attachments — POST /imports/bulk + job slice (R37.5, R33.2)
 *
 * Journal import (R26.4) is driven end-to-end by the example suite journal-import.test.ts ("commits one Journal_Entry
 * per entry, Not_Published, Unclassified, owned by the Administrator"), and the Restoration re-add half of R23.15 by
 * p34-restoration.test.ts; both are left to those suites rather than duplicated here, while this property covers the
 * ordinary creation side of every criterion it drives.
 *
 * p88 PATTERN: every fast-check run FIRST resets the seeded records (the named D1 is shared across runs in the Workers
 * pool, so a run that did not reset would inherit the prior run's units). p78 CAP: numRuns is Math.min(FC_RUNS, 40).
 */

const world = itemWorld();

/** The signed-in Members the world seeds: `admin` holds the Administrator Role, the others Contributor. */
const PEOPLE = ['author', 'colleague', 'admin'] as const;
/** The Research_Item kinds a plain create can submit through POST /items/{kind}. */
const ITEM_KINDS: readonly ItemKind[] = ['journal_entry', 'finding', 'source', 'run', 'hypothesis', 'topic', 'research_question', 'work_item', 'decision_record'];
const RIGHTS_UNKNOWN = BUILT_IN_VALUE_IDS.rightsUnknown;

/** A creation action the property drives through a real handler, each proving the Not_Published start on its path. */
type Action =
  | { readonly t: 'item'; readonly who: Who; readonly kind: ItemKind; readonly groupNote: boolean }
  | { readonly t: 'reply'; readonly who: Who }
  | { readonly t: 'dissent'; readonly who: Who }
  | { readonly t: 'attachment'; readonly who: Who }
  | { readonly t: 'version'; readonly who: Who }
  | { readonly t: 'project'; readonly who: Who };

const who = fc.constantFrom<Who>(...PEOPLE);
const actionArb: fc.Arbitrary<Action> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ t: fc.constant('item' as const), who, kind: fc.constantFrom(...ITEM_KINDS), groupNote: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('reply' as const), who }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('dissent' as const), who }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('attachment' as const), who }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('version' as const), who }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('project' as const), who }) },
);

/** The stored disclosure of a unit, for the Not_Published/Unclassified assertions over the units table. */
interface Stored { readonly level: string; readonly classification: string | null; readonly type: string }
const storedOf = (core: D1Database, id: string) => core.prepare(
  'SELECT disclosure_level AS level, classification_state AS classification, unit_type AS type FROM units WHERE id = ?1',
).bind(id).first<Stored>();
const rightsOf = (core: D1Database, id: string) => core.prepare(
  'SELECT rights_status_id AS rightsStatusId, rights_holder AS rightsHolder, rights_terms AS rightsTerms FROM attachments WHERE unit_id = ?1',
).bind(id).first<{ rightsStatusId: string; rightsHolder: string | null; rightsTerms: string | null }>();

describe('Property 3 (R13.5, R23.2, R23.15, R26.4, R32.4, R33.2, R37.5, R39.4, R42.1): new Disclosure_Units start Not_Published', () => {
  it('starts every unit created through each real app handler Not_Published, never Public or Withheld, with no public trace', async () => {
    const core = () => world.bindings.RF_CORE;
    const ids = () => world.ids;
    configureFiles(world);

    await fc.assert(
      fc.asyncProperty(fc.array(actionArb, { minLength: 1, maxLength: 10 }), async (actions) => {
        // p88: reset the shared records at the START so no prior run's units leak in. The reset also clears the
        // beforeEach Project and uploads, so create a fresh Project and track every new unit of this run.
        await resetRecords(core());
        await core().batch(['uploads', 'upload_parts'].map((table) => core().prepare(`DELETE FROM ${table}`)));
        const projectId = await addProject(core(), ids().admin, world.at);
        // A single parent Item every Reply, Dissent_Note, and Attachment hangs on; it is itself created Not_Published.
        const root: ItemView = await world.created('author', 'finding', { projectId, logSummary: { text: 'A summary to dissent from.', spans: [] } });
        const rootDisclosure = (root.disclosure as { level: string; effective: string });
        expect(rootDisclosure.level, 'root item stored level').toBe('not_published');
        expect(rootDisclosure.effective, 'root item effective').toBe('not_published');

        /** Every unit id created this run and, where it applies, the Classification_State the creating path must set. */
        const created: { readonly id: ULID; readonly unclassified: boolean; readonly attachment: boolean }[] = [];
        const dissenters = new Set<Who>();
        // The current chain tip and the Member who owns it; only the Owner (or an Administrator) may add a version
        // (R13.8), so the property drives each version add as the tip's Owner.
        let lastVersionTip: ULID | null = null;
        let lastVersionOwner: Who = 'author';

        for (const action of actions) {
          if (action.t === 'item') {
            // R23.2/R39.4 (project context): a Member (including the Administrator) submits a Research_Item; it and its
            // Entry_Sections (R23.15 creation side) and any Group_Note all start Not_Published.
            const overrides: Record<string, unknown> = { projectId };
            if (action.groupNote) overrides['groupNote'] = { text: 'A synthetic group note.', spans: [] };
            const item = await world.created(action.who, action.kind, overrides);
            const disclosure = item.disclosure as { level: string; effective: string };
            expect(disclosure.level, `${action.kind} level`).toBe('not_published');
            expect(disclosure.effective, `${action.kind} effective`).toBe('not_published');
            created.push({ id: item.id as ULID, unclassified: false, attachment: false });
            // R23.15 creation side: each Entry_Section a Journal_Entry create produces starts Not_Published.
            const sections = (item['sections'] as readonly { id: ULID; disclosure: { level: string; effective: string } }[] | undefined) ?? [];
            for (const section of sections) {
              expect(section.disclosure.level, 'entry section level').toBe('not_published');
              expect(section.disclosure.effective, 'entry section effective').toBe('not_published');
              created.push({ id: section.id, unclassified: false, attachment: false });
            }
            // A Group_Note is a Reply unit; it starts Not_Published too (R23.2).
            const note = item['groupNote'] as { id: ULID; disclosure: { level: string; effective: string } } | null;
            if (note) {
              expect(note.disclosure.level, 'group note level').toBe('not_published');
              expect(note.disclosure.effective, 'group note effective').toBe('not_published');
              created.push({ id: note.id, unclassified: false, attachment: false });
            }
          } else if (action.t === 'reply') {
            // R23.2: a Reply posted to the root Item starts Not_Published.
            const response = await world.request(action.who, 'POST', '/replies', { parentId: root.id, text: { text: 'A synthetic reply.', spans: [] } });
            expect(response.status, await response.clone().text()).toBe(201);
            const id = (await response.json<{ reply: { id: ULID } }>()).reply.id;
            created.push({ id, unclassified: false, attachment: false });
          } else if (action.t === 'dissent') {
            // R42.1: a Member other than the Owner attaches a Dissent_Note, created Not_Published. Each Member may hold
            // at most one non-withdrawn note on a Log_Summary (R42.2) and the Owner cannot dissent, so skip those.
            if (action.who === 'author' || dissenters.has(action.who)) continue;
            const response = await world.request(action.who, 'POST', '/dissent', { itemId: root.id, text: { text: `Dissent by ${action.who}.`, spans: [] } });
            expect(response.status, await response.clone().text()).toBe(201);
            const id = (await response.json<{ dissent: { id: ULID } }>()).dissent.id;
            dissenters.add(action.who);
            created.push({ id, unclassified: false, attachment: false });
          } else if (action.t === 'attachment') {
            // R23.2 + R33.2: an Attachment created with no supplied Rights_Status starts Not_Published and Rights Unknown.
            const response = await world.request(action.who, 'POST', '/attachments', { parentId: root.id, files: [fileInput(await completedUpload(world, action.who))] });
            expect(response.status, await response.clone().text()).toBe(201);
            const id = (await response.json<{ ids: ULID[] }>()).ids[0]!;
            created.push({ id, unclassified: false, attachment: true });
            lastVersionTip = id;
            lastVersionOwner = action.who;
          } else if (action.t === 'version') {
            // R13.5 + R33.2: a new version added to the chain tip starts Not_Published and Rights Unknown whatever the
            // superseded Attachment's level. Needs an existing tip, so seed one when the run has not attached yet.
            if (lastVersionTip === null) {
              const seed = await world.request(action.who, 'POST', '/attachments', { parentId: root.id, files: [fileInput(await completedUpload(world, action.who))] });
              expect(seed.status, await seed.clone().text()).toBe(201);
              lastVersionTip = (await seed.json<{ ids: ULID[] }>()).ids[0]!;
              lastVersionOwner = action.who;
              created.push({ id: lastVersionTip, unclassified: false, attachment: true });
            }
            // The version is added by the tip's Owner, the only Contributor R13.8 permits (an Administrator also may).
            const response = await world.request(lastVersionOwner, 'POST', '/attachments', { supersedesId: lastVersionTip, files: [fileInput(await completedUpload(world, lastVersionOwner))] });
            expect(response.status, await response.clone().text()).toBe(201);
            const id = (await response.json<{ ids: ULID[] }>()).ids[0]!;
            created.push({ id, unclassified: false, attachment: true });
            lastVersionTip = id;
          } else {
            // R39.4: an Administrator creating a Project gets Disclosure_Level Not_Published. Only the Administrator may.
            const response = await world.request('admin', 'POST', '/projects', { name: `Synthetic p3 ${newULID(world.at)}`, description: 'Synthetic project.', slug: `p3-${newULID(world.at).toLowerCase()}` });
            expect(response.status, await response.clone().text()).toBe(201);
            const project = (await response.json<{ project: { disclosureLevel: string } }>()).project;
            // A Project is not a `units` row, so assert its own Disclosure_Level directly (R39.4).
            expect(project.disclosureLevel, 'project level').toBe('not_published');
          }
        }

        // Every unit created on an app handler this run is stored Not_Published, never Public or Withheld (R23.2).
        for (const unit of created) {
          const stored = (await storedOf(core(), unit.id))!;
          expect(stored, unit.id).not.toBeNull();
          expect(stored.level, `${stored.type} stored level`).toBe('not_published');
          expect(stored.level).not.toBe('public');
          expect(stored.level).not.toBe('withheld');
          // R33.2: an Attachment created without a supplied Rights_Status holds Unknown with empty holder and terms.
          if (unit.attachment) {
            const rights = (await rightsOf(core(), unit.id))!;
            expect(rights.rightsStatusId, 'attachment rights').toBe(RIGHTS_UNKNOWN);
            expect(rights.rightsHolder).toBeNull();
            expect(rights.rightsTerms).toBeNull();
          }
        }
        // No creation path left any unit at a non-default level: the only levels in the table are Not_Published.
        const levels = (await core().prepare('SELECT DISTINCT disclosure_level AS level FROM units').all<{ level: string }>()).results.map((row) => row.level);
        expect(levels.every((level) => level === 'not_published'), `levels: ${levels.join(', ')}`).toBe(true);
      }),
      { numRuns: Math.min(FC_RUNS, 40) },
    );
  }, 600_000);
});

describe('Property 3 (R32.4, R33.2): accepting an Outside_Submission creates every unit Not_Published and Unclassified', () => {
  it('creates the accepted Research_Items, Replies, and Attachments Not_Published, Unclassified, with Rights Unknown', async () => {
    const core = () => world.bindings.RF_CORE;
    const ids = () => world.ids;
    configureFiles(world);

    await fc.assert(
      fc.asyncProperty(
        // How many Research_Items the Administrator accepts, whether a Reply is added, and whether an Attachment is.
        // An acceptance commits as ONE atomic save bounded by the statement budget (R32.5, R32.15), so a single
        // acceptance can create only so many Disclosure_Units; a larger selection is refused with a clean 422 (see
        // moderation-decide.test.ts "refuses an acceptance too large for one atomic save"). This property exercises the
        // Not_Published/Unclassified start across every unit kind the accept path creates, so the generator stays
        // within acceptances the save commits (total created units <= 4): Research_Items, a Reply, and an Attachment
        // together and separately. The oversized-acceptance refusal is its own regression test, not this invariant.
        fc.record({ findings: fc.integer({ min: 1, max: 3 }), reply: fc.boolean(), attachment: fc.boolean() })
          .filter((shape) => shape.findings + (shape.reply ? 1 : 0) + (shape.attachment ? 1 : 0) <= 4),
        async (shape) => {
          // p88: reset shared records and the moderation tables so this run's acceptance is the only creation.
          await resetRecords(core());
          await core().batch(['uploads', 'upload_parts', 'outgoing_emails', 'response_links', 'moderation_decisions', 'outside_files', 'outside_submissions']
            .map((table) => core().prepare(`DELETE FROM ${table}`)));
          const projectId = await addProject(core(), ids().admin, world.at);

          // One queued Outside_Submission the way the rf-submit Worker stores it (R32.1).
          const subId = newULID(world.at);
          await core().prepare(
            `INSERT INTO outside_submissions (id, reference, type, project_id, message, name, email, affiliation, page_ref, licence_agreed, received_at, state, rev, updated_seq)
             VALUES (?1, ?2, 'material', ?3, ?4, 'Grace Hopper', 'grace@example.test', 'Navy', NULL, 'Synthetic Licence 1.0', ?5, 'queued', 1, 0)`,
          ).bind(subId, 'RS-P3-0001', projectId, 'A synthetic outside submission.', world.at).run();

          // The Administrator accepts, creating the Research_Items plus an optional Reply and Attachment on the first
          // created Research_Item, all in one acceptance Submission (R32.4, R32.5).
          const items: Record<string, unknown>[] = Array.from({ length: shape.findings }, (_unused, index) => ({
            unit: 'research_item', kind: 'finding', ref: `finding-${index}`,
            fields: { title: `An accepted finding ${index}`, claim: { text: 'A synthetic claim.', spans: [] }, scopeCaveat: { text: 'Synthetic caveat.', spans: [] }, logSummary: { text: 'Summary of the finding.', spans: [] } },
          }));
          if (shape.reply) items.push({ unit: 'reply', parent: { created: 'finding-0' }, text: { text: 'A reply from the Submitter.', spans: [] } });
          if (shape.attachment) items.push({ unit: 'attachment', parent: { created: 'finding-0' }, uploadId: await completedUpload(world, 'admin', 'outside-evidence.txt'), metadata: { origin: 'Submitter upload.' } });

          const response = await world.request('admin', 'POST', `/moderation/${subId}/decide`, { decision: 'accepted', confirm: true, text: 'Accepted with thanks.', items });
          expect(response.status, await response.clone().text()).toBe(200);
          const createdIds = (await response.json<{ applied?: { createdUnitIds: ULID[] } }>()).applied!.createdUnitIds;
          expect(createdIds.length).toBe(shape.findings + (shape.reply ? 1 : 0) + (shape.attachment ? 1 : 0));

          // R32.4: every Disclosure_Unit created by the acceptance is Not_Published and Unclassified.
          for (const id of createdIds) {
            const stored = (await storedOf(core(), id))!;
            expect(stored.level, `${stored.type} level`).toBe('not_published');
            expect(stored.classification, `${stored.type} classification`).toBe('unclassified');
            // R33.2: the accepted Attachment holds Rights_Status Unknown with empty holder and terms.
            if (stored.type === 'attachment') {
              const rights = (await rightsOf(core(), id))!;
              expect(rights.rightsStatusId).toBe(RIGHTS_UNKNOWN);
              expect(rights.rightsHolder).toBeNull();
              expect(rights.rightsTerms).toBeNull();
            }
          }
          // No accepted unit is Public or Withheld.
          const levels = (await core().prepare('SELECT DISTINCT disclosure_level AS level FROM units').all<{ level: string }>()).results.map((row) => row.level);
          expect(levels.every((level) => level === 'not_published'), `levels: ${levels.join(', ')}`).toBe(true);
        },
      ),
      { numRuns: Math.min(FC_RUNS, 40) },
    );
  }, 600_000);
});

/** Encode a header and rows as an RFC 4180 CSV the Manifest_Parser reads back exactly (every field quoted). */
function csv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const quote = (field: string): string => `"${field.replace(/"/gu, '""')}"`;
  const line = (cells: readonly string[]): string => cells.map(quote).join(',');
  return [line(header), ...rows.map(line)].join('\r\n');
}
const encodeManifest = (text: string): string => Buffer.from(new TextEncoder().encode(text)).toString('base64');
async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function manifestFile(fileName: string, content: string): Promise<Record<string, unknown>> {
  const bytes = new TextEncoder().encode(content);
  return { fileName, sizeBytes: bytes.byteLength, sha256: await sha256Hex(bytes.buffer as ArrayBuffer), content: Buffer.from(bytes).toString('base64') };
}
/** The manifest columns the Bulk_Import property's three kinds fill, plus files and rights. */
const BULK_HEADER = [
  'row_key', 'kind', 'title', 'date', 'source_kind', 'reliability', 'rights_status', 'rights_holder', 'rights_terms',
  'origin', 'files', 'versions', 'claim', 'scope_caveat', 'statement', 'scope',
] as const;
const EMPTY: Readonly<Record<string, string>> = Object.fromEntries(BULK_HEADER.map((column) => [column, '']));
const bulkRow = (values: Partial<Record<(typeof BULK_HEADER)[number], string>>): string[] => BULK_HEADER.map((column) => values[column] ?? EMPTY[column]!);

/**
 * Property 3 — Bulk_Import side (R37.5, R33.2). A Bulk_Import sets EVERY Disclosure_Unit it creates Not_Published and
 * Unclassified regardless of any value in the Import_Manifest, and an Attachment created with no supplied Rights_Status
 * holds Unknown. This drives the REAL POST /imports/bulk route and the bulk_import job to completion, then reads the
 * stored levels — so the assertion is against the same handlers production runs. The manifest randomly supplies, or
 * omits, a Source Rights_Status to show the level/classification start is independent of the manifest (R37.5) while an
 * omitted attachment rights value falls to Unknown (R33.2).
 */
describe('Property 3 (R37.5, R33.2): a Bulk_Import creates every unit Not_Published and Unclassified regardless of the manifest', () => {
  it('imports Research_Items and Attachments all Not_Published, Unclassified, with Attachment Rights Unknown when none is supplied', async () => {
    const world3 = world;
    const core = () => world3.bindings.RF_CORE;
    const ids = () => world3.ids;
    configureFiles(world3);

    /** Drive a bulk_import job from a null cursor to completion, returning its final progress. */
    const run = async (jobId: ULID): Promise<Record<string, number>> => {
      let cursor: JsonValue = null;
      let progress: JsonValue = null;
      for (let guard = 0; guard < 2000; guard++) {
        const stored = (await core().prepare('SELECT params, requested_by AS requestedBy FROM jobs WHERE id = ?1').bind(jobId).first<{ params: string; requestedBy: ULID }>())!;
        const job = { id: jobId, type: 'bulk_import' as const, params: JSON.parse(stored.params) as JsonValue, requestedBy: stored.requestedBy };
        const result = await JOB_HANDLERS.bulk_import!.slice({ env: world3.bindings, job, now: world3.at }, cursor);
        progress = result.progress;
        if (result.done) break;
        cursor = result.cursor;
      }
      return progress as Record<string, number>;
    };

    await fc.assert(
      fc.asyncProperty(
        // Whether the Source row supplies a (publication-permitting) Rights_Status, whether a Finding and a Hypothesis
        // row are present, and whether the Source carries a two-file version chain. Each exercises R37.5 the same way.
        fc.record({ supplyRights: fc.boolean(), finding: fc.boolean(), hypothesis: fc.boolean(), versioned: fc.boolean() }),
        async (shape) => {
          // p88: reset shared records and the import tables so this run's import is the only creation.
          await resetRecords(core());
          await core().batch(['uploads', 'upload_parts', 'jobs'].map((table) => core().prepare(`DELETE FROM ${table}`)));
          const projectId = await addProject(core(), ids().admin, world3.at);

          // A Source row with one or two version-chained files; its Rights_Status is supplied or omitted per the shape.
          const fileNames = shape.versioned ? 'a.pdf; a-v2.pdf' : 'a.pdf';
          const versions = shape.versioned ? 'a.pdf > a-v2.pdf' : '';
          const rows: string[][] = [bulkRow({
            row_key: 'r-source', kind: 'source', title: 'A recovered letter', date: '1850-06', source_kind: 'primary', reliability: 'High',
            origin: 'Recovered from the Kew bundle.', files: fileNames, versions,
            ...(shape.supplyRights ? { rights_status: 'Public domain', rights_holder: 'Estate of A', rights_terms: 'CC-BY' } : {}),
          })];
          if (shape.finding) rows.push(bulkRow({ row_key: 'r-finding', kind: 'finding', title: 'A finding', claim: 'The claim holds.', scope_caveat: 'Within the sampled range.' }));
          if (shape.hypothesis) rows.push(bulkRow({ row_key: 'r-hyp', kind: 'hypothesis', title: 'A hypothesis', statement: 'The signal persists.', scope: 'All known samples.' }));
          const files = [await manifestFile('a.pdf', 'version one'), ...(shape.versioned ? [await manifestFile('a-v2.pdf', 'version two')] : [])];

          const response = await world3.request('admin', 'POST', '/imports/bulk', {
            projectId, accessLevel: 'whole_team', manifestFormat: 'csv', manifest: encodeManifest(csv(BULK_HEADER, rows)), files,
          });
          expect(response.status, await response.clone().text()).toBe(202);
          const { jobId, errors } = await response.json<{ jobId: ULID; errors: unknown[] }>();
          expect(errors).toEqual([]);
          const progress = await run(jobId);
          expect(progress['failed']).toBe(0);

          // R37.5: every unit the import created is Not_Published and Unclassified, regardless of the manifest.
          const units = (await core().prepare('SELECT disclosure_level AS level, classification_state AS classification FROM units WHERE project_id = ?1').bind(projectId).all<{ level: string; classification: string | null }>()).results;
          expect(units.length).toBeGreaterThan(0);
          for (const unit of units) {
            expect(unit.level).toBe('not_published');
            expect(unit.classification).toBe('unclassified');
          }
          // R33.2: an imported Attachment created with NO supplied Rights_Status holds Unknown. (When the manifest row
          // supplies a value the Attachment carries the Source's value instead, and a new version in the chain is itself
          // created Unknown per R13.5/R33.2 — both are covered by other criteria, so the Unknown assertion here is made
          // only for the no-supplied-rights case, which is exactly what R33.2 names.)
          const attachments = (await core().prepare(
            'SELECT a.rights_status_id AS rightsStatusId FROM attachments a JOIN units u ON u.id = a.unit_id WHERE u.project_id = ?1',
          ).bind(projectId).all<{ rightsStatusId: string }>()).results;
          expect(attachments.length).toBeGreaterThan(0);
          if (!shape.supplyRights) for (const attachment of attachments) expect(attachment.rightsStatusId).toBe(RIGHTS_UNKNOWN);
        },
      ),
      { numRuns: Math.min(FC_RUNS, 40) },
    );
  }, 600_000);
});
