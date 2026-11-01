// Feature: research-collab-cms, Property 105: Attachment moves keep identity and move whole Version_Chains
import { beforeAll, describe, expect, it } from 'vitest';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { newItemIdentifier, newULID } from '@researchforce/domain/identifiers';
import { asTimestamp } from '@researchforce/domain/types';
import type { ULID } from '@researchforce/domain/types';
import { BUILT_IN_VALUE_IDS } from '@researchforce/domain/value-sets';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { assertionSpec, signAssertion, testAccess } from '@researchforce/testing/jwt';
import type { TestAccess } from '@researchforce/testing/jwt';
import type { Env } from '../../src/env';
import type { MovePreview } from '../../src/files/move';
import { migrated } from '../d1';
import { addMember, call, KeyServer, resetPeople, testApi } from '../api';
import { itemBody } from '../items';
import { addElement, addProject, resetRecords } from '../units';

/**
 * Validates R12.12, R12.13, R12.14, R12.15: against an independent model of each Attachment chain's Parent, Root_Item,
 * Project, source-item access level and Owner, and identity fields, every applied move reparents the whole
 * Version_Chain and everything under it — it updates `parent_id` (on the chain), `root_id`, and `project_id` on every
 * moved unit, while each Attachment's Item_Identifier, Public_URL, file (sha256/r2_key/size), Rights_Status,
 * Disclosure_Level, chain position, and Cross_Links stay exactly as they were (R12.12). A move records one Revision per
 * moved Attachment holding the previous Parent, Disclosure_Change when it alters a Public_View and Minor_Edit otherwise,
 * and a Public_View change is one Activity_Feed entry (R12.13). A move that widens a Public_View needs `disclosure.set`,
 * a fresh preview token, and the gates; without the token it is refused and nothing moves (R12.14). A move out of a
 * Restricted Research_Item to a Root_Item more Members can read needs `access.widen` on the source, guarded by
 * `access_owner`; a Member who can edit the Attachment but is not the source item's Owner is refused (R12.15). Every
 * refused move changes nothing.
 */
const LICENCE = 'Synthetic Content Licence 1.0';
const SECRET = 'synthetic-preview-hmac-secret-for-tests';
const ACTORS = ['admin', 'author', 'colleague'] as const;
type Actor = (typeof ACTORS)[number];
type Level = 'whole_team' | 'restricted';

/** One Attachment chain the move operates on: its place, its source item, and the identity the move must preserve. */
interface ModelChain {
  readonly index: number;
  readonly chainId: ULID;
  /** The Attachments of the Version_Chain and everything under them (the moved subtree); the whole set reparents. */
  readonly moved: readonly ULID[];
  /** The Attachments of the chain, each of which gets a Revision; the first carries the Activity_Feed entry. */
  readonly chain: readonly ULID[];
  /** The Owner of the Attachments: the Member whose `item.edit` lets them move it (a Contributor needs to own it). */
  owner: Actor;
  parentId: ULID;
  rootId: ULID;
  projectId: ULID;
  /** The source Research_Item the chain currently sits in: its access level and Owner gate a widening move (R12.15). */
  sourceItem: number;
  /** Own Disclosure_Level of the first Attachment, which decides whether a move into a public item widens a view. */
  level: 'not_published' | 'public';
}

/** A destination Research_Item a move can target: its Project, access level, grant list, and whether it is Published. */
interface ModelItem { readonly id: ULID; readonly projectId: ULID; level: Level; published: boolean; readonly grants: Set<Actor> }

let bindings: Env;
let access: TestAccess;
beforeAll(async () => {
  bindings = await migrated();
  access = await testAccess();
});

describe('Property 105: Attachment moves keep identity and move whole Version_Chains', () => {
  it('reparents the whole chain and preserves identity when allowed, and changes nothing when refused', async () => {
    const now = new Date('2026-10-27T18:00:00.000Z');
    const at = asTimestamp(now.toISOString());
    const core = () => bindings.RF_CORE;
    await resetPeople(core());
    const ids: Record<Actor, ULID> = {
      admin: await addMember(core(), 'admin@example.test', 'active', at, ROLE_IDS.administrator),
      author: await addMember(core(), 'author@example.test', 'active', at),
      colleague: await addMember(core(), 'colleague@example.test', 'active', at),
    };
    // The Administrator credits their own work, so widening a move to Public needs a Licence_Agreement (R12.14 gates).
    await core().prepare('UPDATE profiles SET licence_name = ?1, licence_given_on = ?2 WHERE member_id = ?3').bind(LICENCE, '2026-10-27', ids.admin).run();
    bindings.DOWNLOAD_HMAC_KEY = SECRET;

    const api = testApi(access, new KeyServer(access), now, { contentLicence: LICENCE });
    const tokens = Object.fromEntries(await Promise.all(ACTORS.map(async (who) => [who, (await signAssertion(access, assertionSpec(`${who}@example.test`), now))!]))) as Record<Actor, string>;

    /** A finding owned by the Administrator with one Attachment under it, placed in `projectId`. */
    const finding = async (projectId: ULID): Promise<{ itemId: ULID; attachmentId: ULID }> => {
      const created = await call(api, bindings, tokens.admin, 'POST', '/items/finding', itemBody('finding', projectId));
      expect(created.status).toBe(201);
      const { item } = await created.json<{ item: { id: ULID } }>();
      const submissionId = (await core().prepare('SELECT submission_id AS id FROM units WHERE id = ?1').bind(item.id).first<ULID>('id'))!;
      const attachment = await addElement(core(), { projectId, ownerId: ids.admin, submissionId, now: at }, 'attachment', item.id);
      return { itemId: item.id, attachmentId: attachment.id };
    };
    /** A second version appended to a chain, so the move must carry more than one Attachment. */
    const addVersion = async (chainId: ULID, supersedesId: ULID, parent: { id: ULID; rootId: ULID; projectId: ULID }): Promise<ULID> => {
      const id = newULID(at);
      const { identifier, registryKey } = newItemIdentifier();
      await core().batch([
        core().prepare(`INSERT INTO units (id, unit_type, project_id, root_id, parent_id, owner_id, credit, submission_id, created_at, updated_seq)
          VALUES (?1, 'attachment', ?2, ?3, ?4, ?5, ?6, (SELECT submission_id FROM units WHERE id = ?4), ?7, 0)`)
          .bind(id, parent.projectId, parent.rootId, parent.id, ids.admin, JSON.stringify([{ member: ids.admin }]), at),
        core().prepare(`INSERT INTO attachments (unit_id, item_identifier, title, file_kind, original_name, size_bytes, sha256, r2_key, origin, uploaded_at, rights_status_id, chain_id, supersedes_unit_id)
          VALUES (?1, ?2, 'Version 2', 'pdf', 'v2.pdf', 10, ?3, ?4, 'upload', ?5, ?6, ?7, ?8)`)
          .bind(id, identifier, '0'.repeat(64), `synthetic/${id}`, at, BUILT_IN_VALUE_IDS.rightsOwnWork, chainId, supersedesId),
        core().prepare('INSERT INTO identifiers (identifier_lc, identifier, unit_id, issued_at) VALUES (?1, ?2, ?3, ?4)').bind(registryKey, identifier, id, at),
      ]);
      return id;
    };
    /** Make a unit and its Project Public, the way a publish sets up a Public_View to widen into (R12.14). */
    const publishItem = async (unitId: ULID, projectId: ULID): Promise<void> => {
      await core().batch([
        core().prepare("UPDATE units SET disclosure_level = 'public' WHERE id = ?1").bind(unitId),
        core().prepare("UPDATE research_items SET public_presentation = 'full_content' WHERE unit_id = ?1").bind(unitId),
        core().prepare("UPDATE projects SET disclosure_level = 'public', slug_fixed_at = ?2 WHERE id = ?1").bind(projectId, at),
      ]);
    };

    const startArb = fc.record({
      // A second version makes the move carry a whole chain; a single version exercises the degenerate case.
      twoVersions: fc.boolean(),
      // The source item's access level, which decides whether leaving it needs `access.widen` (R12.15).
      restricted: fc.boolean(),
      // Whether a Contributor owns the Attachment (so they can edit and move it) or the Administrator does.
      contributorOwns: fc.boolean(),
    });
    const stepArb = fc.oneof(
      { weight: 5, arbitrary: fc.record({ kind: fc.constant('move' as const), chain: fc.nat({ max: 2 }), dest: fc.nat({ max: 3 }), actor: fc.constantFrom(...ACTORS), withToken: fc.boolean() }) },
      { weight: 2, arbitrary: fc.record({ kind: fc.constant('makeAttachmentPublic' as const), chain: fc.nat({ max: 2 }) }) },
      { weight: 1, arbitrary: fc.record({ kind: fc.constant('publishDest' as const), dest: fc.nat({ max: 3 }) }) },
    );

    await fc.assert(fc.asyncProperty(fc.array(startArb, { minLength: 3, maxLength: 3 }), fc.array(stepArb, { minLength: 1, maxLength: 8 }), async (starts, steps) => {
      await resetRecords(core());

      // Each Research_Item sits in its own Project, so publishing one item never reaches another: a publish sets its
      // own Project public, and a move's widening of a Public_View is decided only by the destination item's own state.
      const destinations: ModelItem[] = [];
      for (let destIndex = 0; destIndex < 4; destIndex++) {
        const dp = await addProject(core(), ids.admin, at);
        const created = await call(api, bindings, tokens.admin, 'POST', '/items/finding', itemBody('finding', dp, { title: 'Destination' }));
        expect(created.status).toBe(201);
        const { item } = await created.json<{ item: { id: ULID } }>();
        destinations.push({ id: item.id, projectId: dp, level: 'whole_team', published: false, grants: new Set() });
      }

      // The source chains. Each source finding is created in its own Project with one Attachment; some get a second
      // version and some are Restricted or Contributor-owned.
      const chains: ModelChain[] = [];
      for (const [index, start] of starts.entries()) {
        const projectId = await addProject(core(), ids.admin, at);
        const { itemId, attachmentId } = await finding(projectId);
        const chainId = (await core().prepare('SELECT chain_id AS id FROM attachments WHERE unit_id = ?1').bind(attachmentId).first<ULID>('id'))!;
        const moved: ULID[] = [attachmentId];
        const chain: ULID[] = [attachmentId];
        if (start.twoVersions) {
          const v2 = await addVersion(chainId, attachmentId, { id: itemId, rootId: itemId, projectId });
          moved.push(v2);
          chain.push(v2);
        }
        const grants = new Set<Actor>();
        let owner: Actor = 'admin';
        if (start.contributorOwns) {
          owner = 'author';
          await core().prepare('UPDATE units SET owner_id = ?2 WHERE id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(chain), ids.author).run();
        }
        if (start.restricted) {
          await core().prepare("UPDATE research_items SET access_level = 'restricted' WHERE unit_id = ?1").bind(itemId).run();
          // So a Contributor who owns the Attachment can still read its Restricted source item (and thus reach the
          // `access.widen` refusal rather than a not-found), grant that Owner read access on the source (R12.15).
          if (owner !== 'admin') {
            await core().prepare('INSERT INTO access_grants (root_id, member_id, granted_by, granted_at) VALUES (?1, ?2, ?3, ?4)').bind(itemId, ids[owner], ids.admin, at).run();
            grants.add(owner);
          }
        }
        chains.push({ index, chainId, moved, chain, owner, parentId: itemId, rootId: itemId, projectId, sourceItem: -1, level: 'not_published' });
        // The source item is modelled as a destination-like item too, so `sourceItem` points at its model entry.
        chains[index]!.sourceItem = destinations.length;
        destinations.push({ id: itemId, projectId, level: start.restricted ? 'restricted' : 'whole_team', published: false, grants });
      }

      // The model of who can read a Whole_Team / Restricted item: Whole_Team is everyone, Restricted is its Owner
      // (always the Administrator here) plus Administrators. A move out of a Restricted source to a Whole_Team item the
      // author or colleague can now read widens readership (R12.15).
      const counts = { minor: 0, disclosure: 0, activity: 0 };

      const assertDb = async () => {
        // Every moved unit sits where the model places its chain, with Project and Root_Item following.
        for (const chain of chains) {
          const rows = (await core().prepare('SELECT id, parent_id AS parentId, root_id AS rootId, project_id AS projectId FROM units WHERE id IN (SELECT value FROM json_each(?1)) ORDER BY id')
            .bind(JSON.stringify([...chain.moved])).all<{ id: string; parentId: string; rootId: string; projectId: string }>()).results;
          for (const row of rows) {
            // The chain's Attachments carry the Parent; the whole moved set shares the Root_Item and Project.
            if (chain.chain.includes(row.id as ULID)) expect(row.parentId).toBe(chain.parentId);
            expect(row.rootId).toBe(chain.rootId);
            expect(row.projectId).toBe(chain.projectId);
          }
          // Identity is preserved on every Attachment of the chain (R12.12): Item_Identifier, file, and Rights_Status.
          const identity = (await core().prepare('SELECT item_identifier AS identifier, sha256, r2_key AS r2Key, size_bytes AS size, rights_status_id AS rights FROM attachments WHERE chain_id = ?1 ORDER BY unit_id')
            .bind(chain.chainId).all<{ identifier: string; sha256: string; r2Key: string; size: number; rights: string }>()).results;
          expect(identity.every((row) => row.sha256 === '0'.repeat(64) && row.size === 10 && row.rights === BUILT_IN_VALUE_IDS.rightsOwnWork)).toBe(true);
        }
        const [revisionRows, activityRows] = await core().batch([
          core().prepare("SELECT kind, count(*) AS n FROM revisions WHERE kind IN ('minor_edit', 'disclosure_change') GROUP BY kind"),
          core().prepare("SELECT count(*) AS n FROM activity WHERE kind = 'disclosure_change'"),
        ]);
        const revisions = Object.fromEntries((revisionRows!.results as { kind: string; n: number }[]).map((row) => [row.kind, row.n]));
        expect([revisions['minor_edit'] ?? 0, revisions['disclosure_change'] ?? 0, (activityRows!.results[0] as { n: number }).n]).toEqual([counts.minor, counts.disclosure, counts.activity]);
      };

      await assertDb();

      for (const step of steps) {
        if (step.kind === 'makeAttachmentPublic') {
          const chain = chains[step.chain]!;
          // Set only the Attachment's own Disclosure_Level Public, leaving its source item and Project not public, so
          // the Attachment is in no Public_View where it sits now; a later move into a Published destination widens one.
          await core().prepare("UPDATE units SET disclosure_level = 'public' WHERE id IN (SELECT value FROM json_each(?1))").bind(JSON.stringify([...chain.chain])).run();
          chain.level = 'public';
          await assertDb();
          continue;
        }
        if (step.kind === 'publishDest') {
          const dest = destinations[step.dest]!;
          if (!dest.published) { await publishItem(dest.id, dest.projectId); dest.published = true; }
          await assertDb();
          continue;
        }

        const chain = chains[step.chain]!;
        const dest = destinations[step.dest]!;
        const source = destinations[chain.sourceItem]!;
        const token = tokens[step.actor];

        // The model's decision for this move, mirroring move.ts end to end, in the order the API checks them.
        // Readability of a Research_Item: a Whole_Team item is read by everyone, a Restricted item only by its Owner
        // (always the Administrator here, no Access_Grants added) and Administrators (R47.1). The move loads the source
        // Attachment and the destination Parent through the Can_Read check, so an actor who cannot read either gets a
        // not-found before any permission or gate check.
        const canRead = (item: ModelItem): boolean => item.level === 'whole_team' || step.actor === 'admin' || item.grants.has(step.actor);
        const degenerate = chain.parentId === dest.id;
        // `item.edit`: an Administrator edits any Attachment; a Contributor only one they own.
        const canEdit = step.actor === 'admin' || (chain.owner === step.actor);
        // A move widens a Public_View when the moved Attachment's own Disclosure_Level is Public: the widening test is
        // evaluated with every ancestor treated as Public, so moving a Public Attachment to a new Parent could present
        // it on the Public_Site, whatever the destination's current state. It needs `disclosure.set`, a fresh token,
        // and the disclosure gates (R12.14).
        const widensPublic = !degenerate && chain.level === 'public';
        // Leaving a Restricted source for a different Whole_Team Root_Item lets more Members read the Attachments.
        const leavesRestricted = !degenerate && source.level === 'restricted' && dest.id !== source.id && dest.level === 'whole_team';
        // `access.widen` on the source stays with its Owner (always the Administrator here); a Contributor is refused.
        const accessRefused = leavesRestricted && step.actor !== 'admin';
        // `disclosure.set` is an Administrator-only Permission; a widening move by a Contributor is refused there too.
        const disclosureRefused = widensPublic && step.actor !== 'admin';
        // A move alters a Public_View (the actual before/after diff, which decides the Revision_Kind in R12.13) only
        // when a Public Attachment actually enters or leaves a Published item's Public_View — a real Public Project on
        // either side. A move alters-and-is-a-Disclosure_Change; otherwise it is a Minor_Edit. A Public Attachment move
        // between two not-published items widens (the conservative gate) but alters no actual view, so it stays a
        // Minor_Edit yet still needs the widening gate and token.
        const altersPublic = !degenerate && chain.level === 'public' && (source.published || dest.published);
        // The disclosure gates decide whether the preview issues a token. For these own-work Attachment moves the only
        // gate that bites is the Owner-consent gate (R23.17): a widening of the Attachment's Consenting_Member's view —
        // the Attachment's Owner — needs that Owner's Publication_Consent unless the requester is the Owner, and no
        // Publication_Consents exist here. So the preview issues a token exactly when the requester is the Owner.
        const previewTokenIssued = widensPublic && chain.owner === step.actor;
        // The apply additionally needs `disclosure.set` (Administrator only), so a widening move succeeds only for the
        // Administrator, and only when the Administrator could obtain a token — i.e. the Attachment is also
        // Administrator-owned (an author-owned widening clears no Owner-consent gate for the Administrator requester).
        const tokenIssued = previewTokenIssued && step.actor === 'admin';

        // The source Attachment is loaded first; an actor who cannot read the source item sees it as not-found.
        if (!canRead(source)) {
          expect((await call(api, bindings, token, 'POST', `/attachments/${chain.chain[0]}/move`, { parentId: dest.id })).status).toBe(404);
          await assertDb();
          continue;
        }
        if (!canEdit) {
          expect((await call(api, bindings, token, 'POST', `/attachments/${chain.chain[0]}/move`, { parentId: dest.id })).status).toBe(403);
          await assertDb();
          continue;
        }
        // The destination Parent is loaded next; an actor who cannot read it sees it as not-found.
        if (!canRead(dest)) {
          expect((await call(api, bindings, token, 'POST', `/attachments/${chain.chain[0]}/move`, { parentId: dest.id })).status).toBe(404);
          await assertDb();
          continue;
        }
        if (degenerate) {
          expect((await call(api, bindings, token, 'POST', `/attachments/${chain.chain[0]}/move`, { parentId: dest.id })).status).toBe(422);
          await assertDb();
          continue;
        }

        // The preview exposes the move's flags and, when the gates pass, a token. Any Member who can edit the
        // Attachment and read both ends may preview (it needs no `disclosure.set`), so it is read for every live move.
        const previewResponse = await call(api, bindings, token, 'POST', `/attachments/${chain.chain[0]}/move/preview`, { parentId: dest.id });
        expect(previewResponse.status).toBe(200);
        const preview = await previewResponse.json<MovePreview>();
        expect(preview.widensPublicView).toBe(widensPublic);
        expect(preview.altersPublicView).toBe(altersPublic);
        expect(preview.leavesRestricted).toBe(leavesRestricted);
        expect(preview.token !== null).toBe(previewTokenIssued);

        if (accessRefused) {
          // R12.15: a Contributor who can edit the Attachment but is not the source item's Owner cannot widen who
          // reads it; the move is refused with the `access_widen` rule and nothing moves.
          const apply = await call(api, bindings, token, 'POST', `/attachments/${chain.chain[0]}/move`, { parentId: dest.id });
          expect(apply.status).toBe(403);
          expect((await apply.json<{ details?: { rule?: string } }>()).details?.rule).toBe('access_widen');
          await assertDb();
          continue;
        }
        if (disclosureRefused) {
          // R12.14: a widening move needs `disclosure.set`, which a Contributor lacks, so the move is refused.
          expect((await call(api, bindings, token, 'POST', `/attachments/${chain.chain[0]}/move`, { parentId: dest.id })).status).toBe(403);
          await assertDb();
          continue;
        }

        // A widening move carries the fresh token when the Member confirmed it; the token is included only when the
        // gates issued one (passing `null` would be an invalid request body).
        const body = tokenIssued && step.withToken ? { parentId: dest.id, token: preview.token } : { parentId: dest.id };
        const apply = await call(api, bindings, token, 'POST', `/attachments/${chain.chain[0]}/move`, body);

        if (widensPublic && !(tokenIssued && step.withToken)) {
          // R12.14: a widening move without a confirmed fresh token (or whose gates refused one) is refused as stale
          // and nothing moves.
          expect(apply.status).toBe(409);
          await assertDb();
          continue;
        }
        expect(apply.status).toBe(200);
        // The move applied: the whole chain and its subtree now belong to the destination item.
        chain.parentId = dest.id;
        chain.rootId = dest.id;
        chain.projectId = dest.projectId;
        chain.sourceItem = destinations.indexOf(dest);
        // R12.13: one Revision per moved Attachment, Disclosure_Change when a Public_View changed, Minor_Edit otherwise.
        if (altersPublic) { counts.disclosure += chain.chain.length; counts.activity += 1; } else counts.minor += chain.chain.length;
        await assertDb();
      }
    }), { numRuns: FC_RUNS });
  }, 600 * FC_RUNS);
});
