import { beforeEach, expect, it } from 'vitest';
import { DEFAULT_RESOURCE_PROFILE, RESOURCE_PROFILES } from '@researchforce/domain/resource-profile';
import { itemWorld } from './items';

const world = itemWorld();
beforeEach(() => { delete world.bindings.RESOURCE_PROFILE; });
it('exposes selected limits to active Members, without claiming production approval', async () => {
  const response = await world.request('colleague', 'GET', '/resource-profile');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ profile: DEFAULT_RESOURCE_PROFILE, productionCertified: false, certification: 'pending-runtime-evidence' });
  world.bindings.RESOURCE_PROFILE = 'Paid_Standard';
  const paid = await world.request('author', 'GET', '/resource-profile');
  expect(await paid.json()).toMatchObject({ profile: RESOURCE_PROFILES.Paid_Standard, productionCertified: false });
});
it('refuses encoded request overflow before domain handling, including JSON escaping overhead', async () => {
  const response = await world.request('author', 'POST', '/items/journal-entries', { sections: [{ content: { text: '\u0000'.repeat(90_000), spans: [] } }] });
  expect(response.status).toBe(413);
  expect(await response.json()).toMatchObject({ error: 'too_large', details: { limitBytes: DEFAULT_RESOURCE_PROFILE.chosen.bytes.request } });
});
it('does not expose an invalid selection as a usable profile', async () => {
  world.bindings.RESOURCE_PROFILE = 'automatic-paid-upgrade';
  const response = await world.request('author', 'GET', '/resource-profile');
  expect(response.status).toBe(500);
});
