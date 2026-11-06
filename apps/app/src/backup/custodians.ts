import { custodianFingerprint } from '@researchforce/manifest/backup/index';
import type { RecoveryKeyMaterial } from '@researchforce/manifest/backup/index';
import type { Env } from '../env';

/**
 * The configured Internal_Backup RECOVERY CUSTODIANS, read from installation configuration (R36.13; design
 * "Internal_Backup and independent recovery": "per-backup random data keys wrapped for configured independent recovery
 * custodians, not hand-written cryptography. ... recovery key material are recoverable outside production").
 *
 * SECURITY / KEY CUSTODY: the recovery key bytes are operator-held material, sourced here from the
 * `BACKUP_RECOVERY_CUSTODIANS` installation secret — held OUTSIDE the production account. No recovery secret is
 * embedded in a backup package or the source repository (R36.13). This module never logs key material; it only parses
 * the configured custodians into the {@link RecoveryKeyMaterial} the 58.1 key-wrapping layer takes, and derives each
 * custodian's public fingerprint for the manifest's trust block. The independent destination, verification, and
 * rotation wiring are task 58.2; task 38.4 only consumes the configured custodian(s) so a produced package carries
 * wrapped data-key envelopes a restore can later unwrap.
 */

/** One configured custodian as it appears in the installation secret JSON. */
interface CustodianConfig {
  readonly custodianId: string;
  readonly generation: number;
  /** The 32-byte AES-256 recovery key, base64-encoded; held outside production. */
  readonly keyBase64: string;
}

/** Decode standard base64 to bytes; throws on malformed input so a misconfiguration fails loudly, never silently. */
function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Parse the configured recovery custodians into the key material the wrapping layer takes, deriving each custodian's
 * public fingerprint from its key id and public identity (the AES key is never itself the fingerprint input). Returns
 * an empty list when no custodian is configured; the backup job records that a package was produced with no custodian
 * (which blocks sole-copy custody per R36.12). A malformed configuration throws, so a backup never silently produces
 * an unrecoverable package under a broken custodian list.
 */
export function recoveryCustodians(env: Env): RecoveryKeyMaterial[] {
  const raw = env.BACKUP_RECOVERY_CUSTODIANS?.trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw) as readonly CustodianConfig[];
  if (!Array.isArray(parsed)) throw new Error('BACKUP_RECOVERY_CUSTODIANS must be a JSON array of custodians.');
  const seen = new Set<string>();
  return parsed.map((config) => {
    if (typeof config.custodianId !== 'string' || config.custodianId === '' || !Number.isSafeInteger(config.generation)) {
      throw new Error('Each recovery custodian needs a custodianId and an integer generation.');
    }
    const id = `${config.custodianId}#${config.generation}`;
    if (seen.has(id)) throw new Error(`Duplicate recovery custodian generation "${id}".`);
    seen.add(id);
    const keyBytes = fromBase64(config.keyBase64);
    if (keyBytes.length !== 32) throw new Error(`Recovery custodian "${config.custodianId}" key must be 32 bytes (AES-256).`);
    const generation = { custodianId: config.custodianId, generation: config.generation } as const;
    return { generation, keyBytes, fingerprint: custodianFingerprint(config.custodianId, keyBytes) };
  });
}
