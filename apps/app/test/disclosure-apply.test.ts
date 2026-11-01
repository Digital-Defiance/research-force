import { beforeEach, describe, expect, it } from 'vitest';
import { newULID } from '@researchforce/domain/identifiers';
import { unitKey, projectKey } from '@researchforce/kernel/views';
import type { PreviewResult } from '../src/disclosure/preview';
import { itemWorld } from './items';
import type { ItemView, Who } from './items';

const SECRET = 'synthetic-preview-hmac-secret-for-tests';
const LICENCE = 'Synthetic Content Licence 1.0';
const world = itemWorld(undefined, { contentLicence: LICENCE });

// The Administrator credits their own work, so making it Public needs their Licence_Agreement for the current licence.
beforeEach(async () => {
  await world.core().prepare('UPDATE profiles SET licence_name = ?1, licence_given_on = ?2 WHERE member_id = ?3').bind(LICENCE, '2026-10-27', world.ids.admin).run();
});

/**
 * An Unclassified Not_Published finding owned by the Administrator in a Public Project, ready to be classified, as an
 * import creates one. The outbox rows the creation wrote are cleared so a test can count the apply's own rows.
 */
async function finding(): Promise<ItemView> {
  const item = await world.created('admin', 'finding');
  await world.core().batch([
    world.core().prepare("UPDATE projects SET disclosure_level = 'public' WHERE id = ?1").bind(world.projectId),
    world.core().prepare("UPDATE research_items SET public_presentation = 'full_content' WHERE unit_id = ?1").bind(item.id),
    world.core().prepare("UPDATE units SET classification_state = 'unclassified' WHERE id = ?1").bind(item.id),
    world.core().prepare("DELETE FROM outbox"),
  ]);
  return item;
}

async function preview(who: Who, body: unknown): Promise<PreviewResult> {
  world.bindings.DOWNLOAD_HMAC_KEY = SECRET;
  const response = await world.request(who, 'POST', '/disclosure/preview', body);
  if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return response.json<PreviewResult>();
}

function apply(who: Who, token: string): Promise<Response> {
  world.bindings.DOWNLOAD_HMAC_KEY = SECRET;
  return world.request(who, 'POST', '/disclosure/apply', { token });
}

/** The token for a change the gates accept, failing the test if the preview refuses it. */
async function tokenFor(body: unknown): Promise<string> {
  const result = await preview('admin', body);
  if (!result.token) throw new Error(`preview refused: ${JSON.stringify(result.failures)}`);
  return result.token;
}

describe('POST /disclosure/apply', () => {
  it('needs disclosure.set', async () => {
    const item = await finding();
    const token = await tokenFor({ units: [{ key: unitKey(item.id), level: 'public' }] });
    const response = await apply('author', token);
    expect(response.status).toBe(403);
  });

  it('refuses a forged or stale token with preview_stale', async () => {
    const response = await apply('admin', 'not.a.token');
    expect(response.status).toBe(409);
  });

  it('applies a level change: writes the level, marks it Classified, and records the Administrator and time', async () => {
    const item = await finding();
    const token = await tokenFor({ units: [{ key: unitKey(item.id), level: 'public' }] });
    const response = await apply('admin', token);
    expect(response.status).toBe(200);
    const row = await world.core().prepare('SELECT disclosure_level AS level, classification_state AS state, classified_by AS by, classified_at AS at FROM units WHERE id = ?1')
      .bind(item.id).first<{ level: string; state: string; by: string | null; at: string | null }>();
    expect(row?.level).toBe('public');
    expect(row?.state).toBe('classified');
    expect(row?.by).toBe(world.ids.admin);
    expect(row?.at).toBe(world.at);
  });

  it('records one Disclosure_Change Revision per unit and a publish outbox row', async () => {
    const item = await finding();
    const token = await tokenFor({ units: [{ key: unitKey(item.id), level: 'public' }] });
    await apply('admin', token);
    const revision = await world.core().prepare("SELECT kind FROM revisions WHERE target_type = 'unit' AND target_id = ?1").bind(item.id).first<{ kind: string }>();
    expect(revision?.kind).toBe('disclosure_change');
    const outbox = await world.core().prepare("SELECT count(*) AS n FROM outbox WHERE topic = 'publish' AND scope = ?1").bind(`unit:${item.id}`).first<{ n: number }>();
    expect(outbox?.n).toBe(1);
  });

  it('adds one Activity_Feed entry for the Disclosure_Change', async () => {
    const item = await finding();
    const token = await tokenFor({ units: [{ key: unitKey(item.id), level: 'public' }] });
    await apply('admin', token);
    const activity = await world.core().prepare("SELECT count(*) AS n FROM activity WHERE kind = 'disclosure_change'").first<{ n: number }>();
    expect(activity?.n).toBe(1);
  });

  it('sets first_public_at when the Effective_Disclosure first becomes Public', async () => {
    const item = await finding();
    const token = await tokenFor({ units: [{ key: unitKey(item.id), level: 'public' }] });
    await apply('admin', token);
    const row = await world.core().prepare('SELECT first_public_at AS at FROM research_items WHERE unit_id = ?1').bind(item.id).first<{ at: string | null }>();
    expect(row?.at).toBe(world.at);
  });

  it('runs the preview_fresh guard: a dependency changed after the preview aborts the apply', async () => {
    const item = await finding();
    const token = await tokenFor({ units: [{ key: unitKey(item.id), level: 'public' }] });
    // Another save bumps the unit's updated_seq after the preview; the token's recorded value no longer matches.
    await world.core().prepare('UPDATE units SET updated_seq = updated_seq + 100 WHERE id = ?1').bind(item.id).run();
    const response = await apply('admin', token);
    expect(response.status).toBe(409);
    // Nothing is applied: the unit stays Not_Published and Unclassified.
    const row = await world.core().prepare('SELECT disclosure_level AS level, classification_state AS state FROM units WHERE id = ?1').bind(item.id).first<{ level: string; state: string }>();
    expect(row?.level).toBe('not_published');
    expect(row?.state).toBe('unclassified');
  });

  it('refuses the whole change when a gate fails now, naming each unit with its reason', async () => {
    const item = await finding();
    const token = await tokenFor({ units: [{ key: unitKey(item.id), level: 'public' }] });
    // The item becomes Restricted after the preview but without touching its updated_seq, so the gate — not
    // preview_fresh — catches it. research_items.access_level is not a preview dependency.
    await world.core().prepare("UPDATE research_items SET access_level = 'restricted' WHERE unit_id = ?1").bind(item.id).run();
    const response = await apply('admin', token);
    expect(response.status).toBe(422);
    const body = await response.json<{ error: string; details: { units: { key: string; reason: string }[] } }>();
    expect(body.error).toBe('gate');
    expect(body.details.units.some((unit) => unit.reason === 'restricted' && unit.key === unitKey(item.id))).toBe(true);
    const row = await world.core().prepare('SELECT disclosure_level AS level FROM units WHERE id = ?1').bind(item.id).first<{ level: string }>();
    expect(row?.level).toBe('not_published');
  });

  it('refuses when a Confidentiality_Hold is placed after the preview, applying nothing', async () => {
    const item = await finding();
    const token = await tokenFor({ units: [{ key: unitKey(item.id), level: 'public' }] });
    await world.core().prepare('INSERT INTO confidentiality_holds (id, unit_id, root_id, member_id, note, placed_at, updated_seq) VALUES (?1, ?2, ?2, ?3, ?4, ?5, 0)')
      .bind(newULID(world.at), item.id, world.ids.admin, 'Held pending review', world.at).run();
    const response = await apply('admin', token);
    expect(response.status).toBe(422);
    const body = await response.json<{ error: string; details: { units: { reason: string }[] } }>();
    expect(body.details.units.some((unit) => unit.reason === 'hold')).toBe(true);
    const row = await world.core().prepare('SELECT disclosure_level AS level FROM units WHERE id = ?1').bind(item.id).first<{ level: string }>();
    expect(row?.level).toBe('not_published');
  });

  it('fixes a Project slug when the Project first becomes Public, with one Activity_Feed entry', async () => {
    await world.created('admin', 'finding');
    await world.core().prepare("UPDATE projects SET disclosure_level = 'not_published', slug_fixed_at = NULL WHERE id = ?1").bind(world.projectId).run();
    const token = await tokenFor({ units: [{ key: projectKey(world.projectId), level: 'public' }] });
    const response = await apply('admin', token);
    expect(response.status).toBe(200);
    const project = await world.core().prepare('SELECT disclosure_level AS level, slug_fixed_at AS fixed FROM projects WHERE id = ?1').bind(world.projectId).first<{ level: string; fixed: string | null }>();
    expect(project?.level).toBe('public');
    expect(project?.fixed).toBe(world.at);
    const activity = await world.core().prepare("SELECT target_type AS type FROM activity WHERE kind = 'disclosure_change'").first<{ type: string }>();
    expect(activity?.type).toBe('project');
  });
});
