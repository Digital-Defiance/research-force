/**
 * The executable proof of the staging gating contract (task 48.5):
 *
 *   "missing operator infrastructure blocks the applicable gate rather than skipping tests."
 *
 * Every other suite here needs the deployed staging install to run its real checks, so in a build
 * environment with no install those suites report their gate BLOCKED (a failing, non-pass status)
 * rather than skipping. This spec verifies the mechanism that guarantees that — the pure
 * `gateStatus`/`requireGate`/`gateStatus` helpers in `support/gate.ts` — WITHOUT needing any staging
 * endpoint, so the contract itself is proven and green in this environment. If this ever regressed
 * so that a missing handle produced `ready` (or a skip), this spec fails, catching a contract break
 * before it could let an unverified gate read as satisfied.
 */
import { expect, test } from '@playwright/test';
import { gateStatus, handle, requireGate } from './support/gate';

test.describe('staging gating contract: missing infrastructure BLOCKS, never skips', () => {
  test('a gate with every required handle present is ready', () => {
    const status = gateStatus([handle('STAGING_WORKSPACE_ORIGIN', 'https://workspace.staging.example'), handle('STAGING_IDP_HOST', 'login.example')]);
    expect(status.readiness).toBe('ready');
    expect(status.missing).toEqual([]);
  });

  test('a gate with any required handle unset is BLOCKED (not ready, not skipped)', () => {
    const status = gateStatus([handle('STAGING_WORKSPACE_ORIGIN', 'https://workspace.staging.example'), handle('STAGING_IDP_HOST', undefined)]);
    expect(status.readiness, 'a missing handle must block, never fall back to ready').toBe('blocked');
    // The contract forbids any "skip" readiness — the only non-ready state is a hard block.
    expect(status.readiness).not.toBe('ready');
    expect(status.missing).toEqual(['STAGING_IDP_HOST']);
  });

  test('a blank handle counts as missing (not satisfied by whitespace)', () => {
    const status = gateStatus([handle('STAGING_R2_BUCKET', '   '), handle('STAGING_R2_ENDPOINT', '')]);
    expect(status.readiness).toBe('blocked');
    expect(status.missing).toEqual(['STAGING_R2_BUCKET', 'STAGING_R2_ENDPOINT']);
  });

  test('requireGate lists exactly the unset handles, in order', () => {
    const missing = requireGate([
      handle('A', 'set'),
      handle('B', undefined),
      handle('C', 'set'),
      handle('D', ''),
    ]);
    expect(missing).toEqual(['B', 'D']);
  });

  test('an all-unset gate is blocked on every handle', () => {
    const status = gateStatus([handle('X', undefined), handle('Y', undefined)]);
    expect(status.readiness).toBe('blocked');
    expect(status.missing).toEqual(['X', 'Y']);
  });
});
