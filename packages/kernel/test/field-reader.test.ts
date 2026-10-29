import { expect, it } from 'vitest';
import { fieldFragments, fieldManifest, fragmentDigest } from '@researchforce/domain/text-fragments';
import type { FieldReference, FieldVersionReader } from '@researchforce/domain/text-fragments';
import { materializeProjectionInput } from '../src/field-reader';
import type { StoredProjectionInput } from '../src/field-reader';
import { project } from '../src/project';
import { item, state } from './fixtures';
it('materializes exact field values before ordinary projection, keeping private text suppressed and identities unchanged', async () => {
  const value = { text: 'Private canary ' + '😀'.repeat(80_000), spans: [] }; const manifest = fieldManifest(value);
  const reference: FieldReference = { $fieldVersion: 1, id: 'version1', ownerType: 'unit', ownerId: 'private-topic', field: 'body', digest: fragmentDigest(manifest) };
  const reader: FieldVersionReader = { manifest: async () => manifest, fragments: async function* () { yield* fieldFragments(value); } };
  const input = state([item('private-topic', { kind: 'topic', body: value }, { level: 'not_published' })]);
  const stored = { ...input, units: input.units.map((u) => u.type === 'research_item' ? { ...u, item: { ...u.item, body: reference } } : u) } as StoredProjectionInput;
  const resolved = await materializeProjectionInput(stored, () => reader);
  const wrong = { ...stored, units: stored.units.map((u) => ({ ...u, id: 'public-other-unit' })) };
  await expect(materializeProjectionInput(wrong, () => reader)).rejects.toThrow(/owner/);
  expect(resolved).toEqual(input); expect(JSON.stringify([...project(resolved).values()])).not.toContain('Private canary');
});
