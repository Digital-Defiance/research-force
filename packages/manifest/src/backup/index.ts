/**
 * Internal_Backup format v1 — the FORMAT, codec, manifest, inventory-registry
 * and key-wrapping layer (task 58.1, R36.1, R36.13, R36.16, R60.5).
 *
 * This barrel re-exports the pure, bounded building blocks of the Internal_Backup
 * package produced by the `Jobs` Durable Object and downloaded through `rf-dl`:
 *
 *  • `manifest`  — the versioned, authenticated, canonical ROOT MANIFEST and its
 *                  digest/validation (exact per-field/per-file hashes and counts,
 *                  schema/table inventory, external trust fingerprints).
 *  • `inventory` — the SCHEMA/TABLE INVENTORY REGISTRY and COMPATIBILITY
 *                  TRANSFORMS; the current reader reads the current and two
 *                  preceding released schema versions; unknown/too-old is rejected.
 *  • `codec`     — the STREAMING AEAD adapter (WebCrypto AES-256-GCM in Tink's
 *                  AES-GCM-HKDF-STREAMING framing), bounded/chunked, key passed in.
 *  • `keys`      — RECOVERY CUSTODIAN / KEY-WRAPPING, rotation, and restoration
 *                  identifiers; per-backup data key wrapped by operator-held
 *                  recovery keys; no secrets stored.
 *
 * No module here imports a database or Worker binding, and none reads an env
 * secret or logs key material. The scheduler (58.2), freeze lease (58.3),
 * restore (58.4) and rehearsal (58.5) tasks import these interfaces.
 */
export * from './manifest';
export * from './inventory';
export * from './codec';
export * from './keys';
