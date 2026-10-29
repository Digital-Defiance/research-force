import { expect, it } from 'vitest';
import { RESOURCE_PROFILES } from '@researchforce/domain/resource-profile';
import { STAGED_SAVE_THRESHOLD_BYTES } from '../src/api';
import { fakeApi } from './helpers';

it('loads the selected shared contract and refuses incompatible or unsafe profile data', async () => {
  const api = fakeApi({ 'GET /resource-profile': { profile: RESOURCE_PROFILES.Paid_Standard, productionCertified: false } });
  expect((await api.client.resourceProfile()).chosen.bytes.request).toBe(STAGED_SAVE_THRESHOLD_BYTES);
  const broken = structuredClone(RESOURCE_PROFILES.Paid_Standard); broken.chosen.preview.csvBufferBytes = -1;
  await expect(fakeApi({ 'GET /resource-profile': { profile: broken } }).client.resourceProfile()).rejects.toThrow();
  await expect(fakeApi({ 'GET /resource-profile': { profile: { version: 'future' } } }).client.resourceProfile()).rejects.toThrow();
});
