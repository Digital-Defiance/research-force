import { GuardedBatch } from '@researchforce/db/batch';
import { uploads } from '@researchforce/db/schema/core';
import { newULID } from '@researchforce/domain/identifiers';
import type { ULID } from '@researchforce/domain/types';
import type { ItemWorld, Who } from './items';

export const DOWNLOAD_SECRET = 'synthetic-download-hmac-secret-for-tests';
export function configureFiles(world: ItemWorld): void {
  Object.assign(world.bindings, { DOWNLOAD_HMAC_KEY: DOWNLOAD_SECRET, DOWNLOAD_ORIGIN: 'https://dl.example.test', R2_ACCOUNT_ID: 'synthetic-account',
    R2_ACCESS_KEY_ID: 'synthetic-key', R2_SECRET_ACCESS_KEY: 'synthetic-secret', PRIVATE_BUCKET_NAME: 'rf-private' });
}
/** Synthetic completed upload; file transfer tests separately exercise local R2 checksum verification. */
export async function completedUpload(world: ItemWorld, who: Who = 'author', fileName = 'Synthetic report.TXT'): Promise<ULID> {
  const id = newULID(world.at);
  await new GuardedBatch(world.core(), { id: world.ids[who], now: world.at }).insert(uploads, { id, groupId: newULID(world.at), ownerType: 'member', ownerId: world.ids[who],
    r2Key: `files/${id}`, fileName, sizeBytes: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', mode: 'single',
    state: 'complete', createdAt: world.at, completedAt: world.at }).commit();
  return id;
}
export const fileInput = (uploadId: string) => ({ uploadId, metadata: { origin: 'Synthetic research output.' } });
export async function attachedFile(world: ItemWorld, parentId: string, who: Who = 'author'): Promise<string> {
  const response = await world.request(who, 'POST', '/attachments', { parentId, files: [fileInput(await completedUpload(world, who))] });
  if (response.status !== 201) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json<{ ids: string[] }>()).ids[0]!;
}
