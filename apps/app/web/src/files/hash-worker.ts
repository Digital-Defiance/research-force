import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { UPLOAD_PART_BYTES } from '@researchforce/domain/files';

/** Incremental hashing bounds memory to one 16 MiB part, even for a gigabyte file. */
globalThis.onmessage = async (event: MessageEvent<File>) => {
  try {
    const file = event.data;
    const whole = sha256.create();
    const parts: string[] = [];
    for (let offset = 0; offset < file.size; offset += UPLOAD_PART_BYTES) {
      const bytes = new Uint8Array(await file.slice(offset, offset + UPLOAD_PART_BYTES).arrayBuffer());
      whole.update(bytes);
      parts.push(bytesToHex(sha256(bytes)));
    }
    globalThis.postMessage({ sha256: bytesToHex(whole.digest()), parts });
  } catch { globalThis.postMessage({ error: 'The file could not be read for its checksum.' }); }
};
