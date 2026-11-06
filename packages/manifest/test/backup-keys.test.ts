import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  createHeader,
  custodianFingerprint,
  decodeBody,
  encodeBody,
  generateDataKey,
  nextGeneration,
  randomBytes,
  restorationId,
  unwrapDataKey,
  wrapDataKey,
} from '../src/backup/index';
import type { EncryptedSegment, KeyGeneration, RecoveryKeyMaterial, WrappedDataKey } from '../src/backup/index';

// Feature: research-collab-cms — recovery custodian key wrapping, rotation, restoration ids (R36.13, R36.16).

const DIGEST = 'c'.repeat(64);

function recoveryKey(custodianId: string, generation: number): RecoveryKeyMaterial {
  const gen: KeyGeneration = { custodianId, generation };
  const keyBytes = randomBytes(32);
  return { generation: gen, keyBytes, fingerprint: custodianFingerprint(custodianId, keyBytes) };
}

async function sealAll(body: Uint8Array, key: Uint8Array, header = createHeader(DIGEST, 16)): Promise<{ header: ReturnType<typeof createHeader>; segments: EncryptedSegment[] }> {
  async function* src(): AsyncGenerator<Uint8Array> { yield body; }
  const segments: EncryptedSegment[] = [];
  for await (const s of encodeBody(src(), key, header)) segments.push(s);
  return { header, segments };
}

async function openAll(segments: readonly EncryptedSegment[], key: Uint8Array, header: ReturnType<typeof createHeader>): Promise<Uint8Array> {
  async function* src(): AsyncGenerator<EncryptedSegment> { for (const s of segments) yield s; }
  const parts: number[] = [];
  for await (const p of decodeBody(src(), key, header)) parts.push(...p);
  return Uint8Array.from(parts);
}

describe('recovery custodian key wrapping', () => {
  it('wraps a data key and unwraps it to the same body-sealing key', async () => {
    const dk = generateDataKey();
    const recovery = recoveryKey('primary', 1);
    const { envelope, descriptor } = await wrapDataKey(dk.raw, recovery);
    expect(descriptor.keyId).toBe('primary');
    expect(descriptor.fingerprint).toBe(recovery.fingerprint);

    // The envelope reveals nothing resembling the raw data key.
    expect(bytesToHex(envelope.wrapped)).not.toContain(bytesToHex(dk.raw));

    const body = new TextEncoder().encode('sealed by the per-backup data key');
    const { header, segments } = await sealAll(body, dk.raw);

    const unwrapped = await unwrapDataKey([envelope], recovery);
    expect([...unwrapped.raw]).toEqual([...dk.raw]);
    const decoded = await openAll(segments, unwrapped.raw, header);
    expect([...decoded]).toEqual([...body]);
  });

  it('a wrong recovery key fails authentication, never yields a usable key', async () => {
    const dk = generateDataKey();
    const recovery = recoveryKey('primary', 1);
    const { envelope } = await wrapDataKey(dk.raw, recovery);
    const impostor: RecoveryKeyMaterial = { generation: recovery.generation, keyBytes: randomBytes(32), fingerprint: recovery.fingerprint };
    await expect(unwrapDataKey([envelope], impostor)).rejects.toThrow(/failed authentication/);
  });

  it('a tampered envelope fails authentication', async () => {
    const dk = generateDataKey();
    const recovery = recoveryKey('primary', 1);
    const { envelope } = await wrapDataKey(dk.raw, recovery);
    const tampered: WrappedDataKey = { ...envelope, wrapped: Uint8Array.from(envelope.wrapped, (b, i) => (i === 0 ? b ^ 0x01 : b)) };
    await expect(unwrapDataKey([tampered], recovery)).rejects.toThrow(/failed authentication/);
  });
});

describe('rotation and restoration identifiers (R36.16)', () => {
  it('a restore selects the envelope matching the recovery key generation', async () => {
    const dk = generateDataKey();
    const gen1 = recoveryKey('primary', 1);
    const gen2 = recoveryKey('primary', 2);
    // A backup sealed under generation 1 keeps only generation-1 envelopes.
    const { envelope: env1 } = await wrapDataKey(dk.raw, gen1);

    // The current (rotated) recovery key is generation 2; restoring an old
    // backup must still pick the generation-1 envelope by restoration id.
    expect(restorationId(gen2.generation)).toBe('primary#2');
    await expect(unwrapDataKey([env1], gen2)).rejects.toThrow(/No wrapped data key for restoration identifier “primary#2”/);

    const restored = await unwrapDataKey([env1], gen1);
    expect([...restored.raw]).toEqual([...dk.raw]);
  });

  it('nextGeneration advances within a custodian and does not re-wrap old backups', () => {
    const gen: KeyGeneration = { custodianId: 'offsite', generation: 7 };
    expect(nextGeneration(gen)).toEqual({ custodianId: 'offsite', generation: 8 });
    expect(restorationId(nextGeneration(gen))).toBe('offsite#8');
  });

  it('multiple custodians each carry an independent wrapped envelope', async () => {
    const dk = generateDataKey();
    const primary = recoveryKey('primary', 3);
    const offsite = recoveryKey('offsite', 1);
    const { envelope: a } = await wrapDataKey(dk.raw, primary);
    const { envelope: b } = await wrapDataKey(dk.raw, offsite);
    const envelopes = [a, b];
    const viaPrimary = await unwrapDataKey(envelopes, primary);
    const viaOffsite = await unwrapDataKey(envelopes, offsite);
    expect([...viaPrimary.raw]).toEqual([...dk.raw]);
    expect([...viaOffsite.raw]).toEqual([...dk.raw]);
  });
});

describe('custodian fingerprint', () => {
  it('is the SHA-256 of keyId + public identity, carrying no secret', () => {
    const keyId = 'primary';
    const identity = new TextEncoder().encode('public-identity-bytes');
    const prefix = new TextEncoder().encode(`${keyId}\u0000`);
    const joined = new Uint8Array(prefix.length + identity.length);
    joined.set(prefix, 0);
    joined.set(identity, prefix.length);
    expect(custodianFingerprint(keyId, identity)).toBe(bytesToHex(sha256(joined)));
  });
});
