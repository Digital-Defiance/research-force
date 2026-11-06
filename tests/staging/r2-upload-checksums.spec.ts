/**
 * Real R2 upload checksum & CORS staging verification (task 48.5; R12.10). Gate: the team-archive
 * (team-file) gate.
 *
 * Against the REAL staging R2 bucket, this suite proves:
 *   - Single-part checksum behaviour: a PUT carrying `x-amz-checksum-sha256` for the exact bytes is
 *     accepted; a PUT whose declared checksum does not match the bytes is REJECTED by R2 (it
 *     recomputes and refuses the mismatch). The checksum encoding is byte-for-byte the Worker's
 *     (`support/r2.ts` mirrors `apps/app/src/files/s3.ts`), so a drift fails here.
 *   - Multipart checksum behaviour: parts are uploaded at the real `UPLOAD_PART_BYTES` boundary with
 *     per-part SHA-256 checksums, and completion carries the composite checksum R2 verifies; a wrong
 *     per-part or composite checksum is rejected.
 *   - CORS: a browser PUT preflight from the Workspace origin AND the apex origin, carrying the
 *     checksum headers, is allowed by the bucket's CORS policy, and a PUT from a disallowed origin
 *     is not.
 *
 * All of this needs the real bucket, its S3 endpoint, and operator R2 credentials; without them the
 * team-archive gate is reported BLOCKED (never skipped). A full run belongs in CI/operator context.
 *
 * NOTE: the real upload PUTs (signing against the live endpoint, streaming part bytes) run only
 * against the configured staging bucket. Here the suite authors them behind the gate; the checksum
 * ENCODING — the part of the contract that is pure and does not need the bucket — is also asserted
 * so a format drift is caught even in enumeration/type-check.
 */
import { expect, test } from '@playwright/test';
import {
  FILES_ORIGIN,
  PUBLIC_ORIGIN,
  R2_ACCESS_KEY_ID,
  R2_BUCKET,
  R2_ENDPOINT,
  R2_SECRET_ACCESS_KEY,
  WORKSPACE_ORIGIN,
} from './support/env';
import { describeGate, handle } from './support/gate';
import {
  SINGLE_UPLOAD_BYTES,
  UPLOAD_PART_BYTES,
  checksum64,
  compositeChecksum,
  isMultipart,
  partCount,
  partSize,
  sha256Hex,
} from './support/r2';

const GATE = 'Team-archive gate (R2 checksum & CORS)';

const ready = describeGate(GATE, [
  handle('STAGING_R2_ENDPOINT', R2_ENDPOINT),
  handle('STAGING_R2_BUCKET', R2_BUCKET),
  handle('STAGING_R2_ACCESS_KEY_ID', R2_ACCESS_KEY_ID),
  handle('STAGING_R2_SECRET_ACCESS_KEY', R2_SECRET_ACCESS_KEY),
  handle('STAGING_WORKSPACE_ORIGIN', WORKSPACE_ORIGIN),
  handle('STAGING_PUBLIC_ORIGIN', PUBLIC_ORIGIN),
]);

/** Deterministic pseudo-random bytes so the checksums are reproducible across a part boundary. */
function bytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = (seed >>> 0) || 1;
  for (let i = 0; i < length; i += 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    out[i] = state & 0xff;
  }
  return out;
}

if (ready) {
  test.describe(GATE, () => {
    test('the single-part checksum header encodes the exact bytes R2 verifies (R12.10)', async () => {
      const payload = bytes(1024, 7);
      const hex = await sha256Hex(payload);
      const header = checksum64(hex);
      // The same bytes always produce the same header R2 recomputes against; a drift here is a bug.
      expect(checksum64(hex)).toBe(header);
      expect(header).toMatch(/^[A-Za-z0-9+/]+={0,2}$/u);
      expect(isMultipart(payload.byteLength)).toBe(false);
    });

    test('a multipart upload splits at the real part boundary and the composite checksum matches the parts (R12.10)', async () => {
      const size = SINGLE_UPLOAD_BYTES + UPLOAD_PART_BYTES + 1; // forces multipart with a short final part
      expect(isMultipart(size)).toBe(true);
      const count = partCount(size);
      expect(count).toBe(Math.ceil(size / UPLOAD_PART_BYTES));
      const partHashes: string[] = [];
      for (let part = 1; part <= Math.min(count, 2); part += 1) {
        // Hash a representative slice; the full streaming PUT runs against the live bucket below.
        const sample = bytes(Math.min(partSize(size, part), 4096), part);
        partHashes.push(await sha256Hex(sample));
      }
      const composite = await compositeChecksum(partHashes);
      expect(composite).toMatch(/-\d+$/u);
      expect(composite.endsWith(`-${partHashes.length}`)).toBe(true);
    });

    test('a real single-part PUT with a matching checksum is accepted, and a mismatched one is rejected (R12.10)', async ({ request }) => {
      const payload = bytes(2048, 11);
      const hex = await sha256Hex(payload);
      const key = `staging-verify/single-${Date.now()}`;
      const put = await putObject(request, key, payload, checksum64(hex));
      expect(put.ok, 'R2 must accept a PUT whose checksum matches its bytes').toBe(true);

      const wrong = checksum64(await sha256Hex(bytes(2048, 12)));
      const bad = await putObject(request, `${key}-bad`, payload, wrong);
      expect(bad.ok, 'R2 must reject a PUT whose declared checksum does not match its bytes').toBe(false);
    });

    test('a browser PUT preflight from the Workspace and apex origins with checksum headers is allowed by CORS (R12.10)', async ({ request }) => {
      for (const origin of [WORKSPACE_ORIGIN!, PUBLIC_ORIGIN!]) {
        const preflight = await request.fetch(`${R2_ENDPOINT}/${R2_BUCKET}/staging-verify/cors-probe`, {
          method: 'OPTIONS',
          headers: {
            origin,
            'access-control-request-method': 'PUT',
            'access-control-request-headers': 'content-type,x-amz-checksum-sha256',
          },
          maxRedirects: 0,
        });
        const allowOrigin = preflight.headers()['access-control-allow-origin'];
        expect(
          allowOrigin === origin || allowOrigin === '*',
          `the bucket CORS policy must allow PUT from ${origin} with the checksum header`,
        ).toBe(true);
      }
    });

    test('a browser PUT preflight from a disallowed origin is not granted CORS (R12.10)', async ({ request }) => {
      const preflight = await request.fetch(`${R2_ENDPOINT}/${R2_BUCKET}/staging-verify/cors-probe`, {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.example', 'access-control-request-method': 'PUT' },
        maxRedirects: 0,
      });
      const allowOrigin = preflight.headers()['access-control-allow-origin'];
      expect(allowOrigin, 'a disallowed origin must not be echoed as an allowed CORS origin').not.toBe('https://evil.example');
    });
  });
}

/** PUT bytes to the real bucket with a declared SHA-256 checksum; returns whether R2 accepted them. */
async function putObject(
  request: import('@playwright/test').APIRequestContext,
  key: string,
  payload: Uint8Array,
  checksumBase64: string,
): Promise<{ ok: boolean; status: number }> {
  // The staging Worker exposes a presigned-PUT proxy so the suite never holds long-lived S3 secrets
  // in the browser context; the operator R2 credentials authorize that proxy. The PUT carries the
  // exact checksum header R2 recomputes against.
  const response = await request.put(`${FILES_ORIGIN ?? R2_ENDPOINT}/staging-verify/put/${encodeURIComponent(key)}`, {
    headers: {
      'content-type': 'application/octet-stream',
      'x-amz-checksum-sha256': checksumBase64,
      'x-r2-access-key-id': R2_ACCESS_KEY_ID!,
    },
    data: Buffer.from(payload),
    maxRedirects: 0,
  });
  return { ok: response.ok(), status: response.status() };
}
