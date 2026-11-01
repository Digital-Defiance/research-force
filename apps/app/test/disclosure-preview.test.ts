import { describe, expect, it } from 'vitest';
import { newULID } from '@researchforce/domain/identifiers';
import { unitKey } from '@researchforce/kernel/views';
import { loadProjectionInput } from '../src/kernel-input';
import { verifyPreviewToken } from '../src/disclosure/token';
import type { PreviewResult } from '../src/disclosure/preview';
import { itemWorld } from './items';
import type { ItemView, Who } from './items';

const SECRET = 'synthetic-preview-hmac-secret-for-tests';
const world = itemWorld();

/** A Public Project and a Public finding in it, so the finding has a Public_View the preview can change. */
async function publicFinding(): Promise<ItemView> {
  const item = await world.created('author', 'finding');
  await world.core().batch([
    world.core().prepare("UPDATE projects SET disclosure_level = 'public' WHERE id = ?1").bind(world.projectId),
    world.core().prepare("UPDATE units SET disclosure_level = 'public', classification_state = 'classified' WHERE id = ?1").bind(item.id),
    world.core().prepare("UPDATE research_items SET public_presentation = 'full_content' WHERE unit_id = ?1").bind(item.id),
  ]);
  return item;
}

async function preview(who: Who, body: unknown): Promise<PreviewResult> {
  world.bindings.DOWNLOAD_HMAC_KEY = SECRET;
  const response = await world.request(who, 'POST', '/disclosure/preview', body);
  if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return response.json<PreviewResult>();
}

describe('loadProjectionInput', () => {
  it('turns rf-core rows into kernel input the projector can read', async () => {
    const item = await publicFinding();
    const { input, dependencies } = await loadProjectionInput(world.core(), [item.id], world.at);
    expect(input.units).toHaveLength(1);
    const unit = input.units[0]!;
    expect(unit.type).toBe('research_item');
    if (unit.type !== 'research_item') throw new Error('expected a research_item');
    expect(unit.item.kind).toBe('finding');
    expect(unit.item.restricted).toBeUndefined();
    expect(unit.level).toBe('public');
    expect(input.projects.some((project) => project.id === world.projectId && project.level === 'public')).toBe(true);
    expect(dependencies.some((dependency) => dependency.table === 'units' && dependency.id === item.id)).toBe(true);
    expect(dependencies.some((dependency) => dependency.table === 'projects' && dependency.id === world.projectId)).toBe(true);
  });

  it('reads a Restricted Access_Level into the restricted flag', async () => {
    const item = await publicFinding();
    await world.core().prepare("UPDATE research_items SET access_level = 'restricted' WHERE unit_id = ?1").bind(item.id).run();
    const { input } = await loadProjectionInput(world.core(), [item.id], world.at);
    const unit = input.units[0]!;
    expect(unit.type === 'research_item' && unit.item.restricted).toBe(true);
  });
});

describe('POST /disclosure/preview', () => {
  it('needs disclosure.set', async () => {
    const item = await publicFinding();
    const response = await world.request('author', 'POST', '/disclosure/preview', { units: [{ key: unitKey(item.id), presentation: 'summary_only' }] });
    expect(response.status).toBe(403);
  });

  it('returns a diff and a preview token for a valid change', async () => {
    const item = await publicFinding();
    const result = await preview('admin', { units: [{ key: unitKey(item.id), presentation: 'summary_only' }] });
    expect(result.failures).toHaveLength(0);
    expect(result.diff.changed.some((view) => view.key === unitKey(item.id))).toBe(true);
    expect(result.token).toBeTruthy();
    const claim = await verifyPreviewToken(result.token!, SECRET, world.at ? Date.parse(world.at) : Date.now());
    expect(claim).not.toBeNull();
    expect(claim!.dependencies.some((dependency) => dependency.id === item.id)).toBe(true);
  });

  it('returns gate failures and no token when a change is refused', async () => {
    const item = await publicFinding();
    await world.core().prepare("UPDATE research_items SET access_level = 'restricted' WHERE unit_id = ?1").bind(item.id).run();
    const result = await preview('admin', { units: [{ key: unitKey(item.id), level: 'public' }] });
    expect(result.token).toBeNull();
    expect(result.failures.some((failure) => failure.reason === 'restricted')).toBe(true);
  });

  it('refuses a Withheld change with no Disclosure_Line', async () => {
    const item = await publicFinding();
    const result = await preview('admin', { units: [{ key: unitKey(item.id), level: 'withheld' }] });
    expect(result.failures.some((failure) => failure.reason === 'disclosure_line')).toBe(true);
    expect(result.token).toBeNull();
  });

  it('refuses an Administrator widening the Owner\'s work without the Owner\'s consent (R23.17)', async () => {
    // A Not_Published finding owned by the author, in a Public Project. The admin widens it to Public.
    const item = await world.created('author', 'finding');
    await world.core().prepare("UPDATE projects SET disclosure_level = 'public' WHERE id = ?1").bind(world.projectId).run();
    const result = await preview('admin', { units: [{ key: unitKey(item.id), level: 'public' }] });
    expect(result.token).toBeNull();
    const owner = result.failures.find((failure) => failure.reason === 'owner_consent');
    expect(owner?.memberId).toBe(world.ids.author);
  });

  it('refuses any widening of a unit covered by a Confidentiality_Hold (R48.4)', async () => {
    const item = await publicFinding();
    await world.core().prepare("UPDATE units SET disclosure_level = 'not_published' WHERE id = ?1").bind(item.id).run();
    const holdId = newULID(world.at);
    await world.core().prepare('INSERT INTO confidentiality_holds (id, unit_id, root_id, member_id, note, placed_at, updated_seq) VALUES (?1, ?2, ?2, ?3, ?4, ?5, 0)')
      .bind(holdId, item.id, world.ids.admin, 'Confidential pending review', world.at).run();
    const result = await preview('admin', { units: [{ key: unitKey(item.id), level: 'public' }] });
    expect(result.token).toBeNull();
    expect(result.failures.some((failure) => failure.reason === 'hold')).toBe(true);
  });
});
