// Feature: research-collab-cms, Property 43: Version_Chains stay linear
import { beforeEach, expect, it } from 'vitest';
import { fc } from '@researchforce/testing/fc';
import { itemWorld } from '../items';
import { attachedFile, completedUpload, fileInput } from '../files';
const world = itemWorld();
beforeEach(async () => { await world.core().batch(['uploads', 'upload_parts'].map((t) => world.core().prepare(`DELETE FROM ${t}`))); });
it('appends only at the tip and keeps each earlier file and metadata unchanged', async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.nat({ max: 9 }), { maxLength: 6 }), async (choices) => {
    const parent = await world.created('author', 'topic');
    const first = await attachedFile(world, parent.id); const ids = [first];
    for (const choice of choices) {
      const index = choice % ids.length; const target = ids[index]!;
      const previous = await world.core().prepare('SELECT * FROM attachments WHERE chain_id = ?1 ORDER BY unit_id').bind(first).all();
      const response = await world.request('author', 'POST', '/attachments', { supersedesId: target, files: [fileInput(await completedUpload(world))] });
      if (index !== ids.length - 1) {
        expect(response.status).toBe(409); const error = await response.json<{ details: { last: { id: string } } }>(); expect(error.details.last.id).toBe(ids.at(-1));
      } else { expect(response.status).toBe(201); ids.push((await response.json<{ ids: string[] }>()).ids[0]!); }
      for (const row of previous.results) expect(await world.core().prepare('SELECT * FROM attachments WHERE unit_id = ?1').bind(row['unit_id']).first()).toEqual(row);
    }
    const response = await world.request('author', 'GET', `/attachments/${first}`); const data = await response.json<{ chain: { id: string; position: number; last: boolean }[] }>();
    expect(data.chain.map((entry) => entry.id)).toEqual(ids); expect(data.chain.map((entry) => entry.position)).toEqual(ids.map((_, i) => i + 1));
    expect(data.chain.filter((entry) => entry.last).map((entry) => entry.id)).toEqual([ids.at(-1)]);
  }));
}, 60_000);
