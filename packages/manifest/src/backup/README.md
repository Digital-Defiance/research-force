# Internal_Backup format v1 (`packages/manifest/src/backup/`)

The versioned, authenticated **format / codec / manifest / inventory-registry /
key-wrapping** layer for the Internal_Backup (R36.1, R36.13, R36.16, R60.5).

This is a **pure codec layer**, like the import parsers in this package: no
database, no Worker binding, no environment secret, no logging of key material,
plaintext, or ciphertext. The Internal_Backup itself is produced by the `Jobs`
Durable Object and downloaded through `rf-dl`; this layer only defines the
format those paths read and write. Scheduling/retention (58.2), the freeze lease
(58.3), restore reconciliation (58.4), and rehearsal tooling (58.5) import these
interfaces — they are **not** implemented here.

## Modules

| Module | Responsibility |
|---|---|
| `manifest.ts` | Authenticated, canonical, hashable **root manifest**: format/schema versions, source installation, snapshot sequence/time, schema/table inventory with exact row counts and digests, exact per-field and per-file content hashes and counts, external trust fingerprints. `rootDigest` is the authenticated identity; `validateManifest` checks structure before any decryption. |
| `inventory.ts` | **Schema/table inventory registry** and **compatibility transforms**. The current reader reads the current and the two preceding released schema versions (`MAX_PRECEDING_SCHEMAS = 2`) via one transform per version (never a rewrite). An unknown or too-old version is rejected with `UnsupportedSchemaError`. Mirrors `@researchforce/domain` `backupReader`/`validateReleaseCatalog` at the format layer. |
| `codec.ts` | **Streaming AEAD adapter**. Frames the body into bounded segments and seals each with AES-256-GCM. Bounded memory (one segment at a time); never buffers the whole backup. Key is a parameter. |
| `keys.ts` | **Recovery custodian / key wrapping**, rotation, and restoration identifiers. A fresh random per-backup **data key** is wrapped once per custodian under an operator-held **recovery key**; a restore selects the right envelope by restoration identifier (`custodianId#generation`). |

## Cryptographic construction (cited — not invented)

The body codec follows the framing of **Google Tink's AES-GCM-HKDF-STREAMING**,
a reviewed streaming-AEAD construction:

- <https://developers.google.com/tink/streaming-aead/aes_gcm_hkdf_streaming>
- <https://github.com/tink-crypto/tink/blob/master/docs/WIRE-FORMAT.md>

Adopted framing:

- Random 32-byte HKDF **salt** and random 7-byte **nonce prefix** per backup,
  stored in the header.
- Per-stream AES-256-GCM key derived with **HKDF-SHA-256** from the data key,
  salted by the header salt, with the header associated data (which includes the
  **root manifest digest**) as HKDF info — so the key is bound to the manifest.
- Each segment's 12-byte GCM nonce = `noncePrefix (7) ‖ segmentIndex (4, BE) ‖
  finalFlag (1)`. The final-segment flag is the **tamper-evident end marker**:
  truncation changes which segment is "final", so a truncated stream fails
  authentication (`missing-final`).
- The root manifest digest is bound as GCM associated data on every segment, so
  tampering with the manifest, the header, or substituting a segment from
  another backup fails authentication.

AES-GCM is **WebCrypto's** audited implementation (`crypto.subtle`); HKDF-SHA-256
is `@noble/hashes` (already a workspace dependency). **No new cryptographic
library is added, and no custom cryptographic protocol is invented.** WebCrypto
is available in workerd, the browser, and Node, so there is no WASM/native
dependency and the codec runs identically in all three.

## Key custody model (operator-held, outside production)

- **No secret lives in this package, the source repository, or any log.** Keys
  are passed in as parameters by the caller. Logs and manifests carry only key
  **identifiers** and public **fingerprints**, never key bytes.
- Each backup gets a **fresh random 32-byte data key** (`generateDataKey`). It
  seals the body and is then **wrapped** once per configured recovery custodian
  under that custodian's **recovery key** (`wrapDataKey`). The operator holds the
  recovery keys **outside the production account** (per R36.12/R36.13); the
  wrapped envelopes travel with the package.
- **Rotation** (`nextGeneration`) advances a custodian's generation. Existing
  backups are not re-wrapped; each keeps the envelopes for the generation that
  sealed it. A restore selects the matching envelope by **restoration identifier**
  (`restorationId` = `custodianId#generation`), so it always unwraps the data key
  for the generation that sealed the backup, across any number of rotations.
- The independently trusted **manifest fingerprint** (`trust.manifestFingerprint`
  = `rootDigest`) is published out of band, so a reader can confirm the manifest
  it holds is the one the operator attested — not one a compromised store
  substituted (R36.13).

## Corruption behaviour

Decoding fails loudly and yields no partial/wrong plaintext when:

- any ciphertext byte is flipped, or the wrong key is used (`auth`);
- segments are reordered or a segment is missing (`order`);
- the stream is truncated before the final segment (`missing-final`);
- data follows the final segment (`extra-after-final`).

Manifest-level tampering (wrong hash, count, version, duplicate identity, or a
mismatched self-fingerprint) is caught by `validateManifest` before any
decryption, and by the AAD binding during decryption.
