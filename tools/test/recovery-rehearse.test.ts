import { describe, expect, it } from 'vitest';
import {
  acceptanceRejection, applySuppressions, classifyRpo, classifyRto, EXERCISED_HERE, exerciseCheckpointInterruption,
  liveEnvironmentReady, liveHandlesFromEnv, missingLiveHandles, preflightDecision, RECOVERY_OBJECTIVES, reconcileBootstrapIdentity,
  rehearsalEvidence, REQUIRES_LIVE, runRehearsal, SCENARIOS, suppressionDigest, syntheticCorpus, syntheticManifest,
  syntheticRegistry,
} from '../recovery/rehearse';
import type { LiveHandles, SuppressionRecord } from '../recovery/rehearse';

/**
 * Drive the fresh-environment recovery rehearsal (task 58.5) with synthetic fixtures and in-memory SQLite.
 * Each required failure scenario is asserted with real deterministic checks where it CAN be exercised here;
 * the live restore cases are asserted to be BLOCKED (never faked) with no independent-environment handles,
 * and a download-only / alert-only input is rejected as acceptance. No real network/account/key access.
 */

const NOW = '2026-02-01T12:00:00.000Z';
const ALL_HANDLES: LiveHandles = {
  independentInventoryPath: 'infra/recovery/deployment.example.json',
  replacementInfraHandle: 'independent://replacement-infra',
  recoveryKeyIdentifiers: 'recovery-key-id-1,recovery-key-id-2',
  independentCopyHandle: 'independent://verified-copy',
};
const NO_HANDLES: LiveHandles = {
  independentInventoryPath: undefined, replacementInfraHandle: undefined,
  recoveryKeyIdentifiers: undefined, independentCopyHandle: undefined,
};

describe('bootstrap-identity reconciliation', () => {
  const corpus = syntheticCorpus(NOW);

  it('maps a DIFFERENT bootstrap id with the SAME email onto the original backed-up id', () => {
    const result = reconcileBootstrapIdentity({ id: 'fresh-bootstrap-id', emailLc: 'owner@example.test' }, corpus.members);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mapping.kind).toBe('matched');
      if (result.mapping.kind === 'matched') {
        expect(result.mapping.fromBootstrapId).toBe('fresh-bootstrap-id');
        expect(result.mapping.toBackedUpId).toBe('member-owner'); // the original id is preserved, never rewritten
      }
    }
  });

  it('fails preflight on a TRUE identity conflict (bootstrap id collides with a different member)', () => {
    const result = reconcileBootstrapIdentity({ id: 'member-historian', emailLc: 'owner@example.test' }, corpus.members);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.conflict.kind).toBe('id-collision');
  });

  it('fails preflight on an ambiguous email matching more than one backed-up member', () => {
    const members = [...corpus.members, { id: 'member-duplicate', emailLc: 'owner@example.test' }];
    const result = reconcileBootstrapIdentity({ id: 'fresh', emailLc: 'owner@example.test' }, members);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.conflict.kind).toBe('ambiguous-email');
  });

  it('keeps a genuinely new operator standalone with no id rewrite', () => {
    const result = reconcileBootstrapIdentity({ id: 'brand-new', emailLc: 'nobody@example.test' }, corpus.members);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mapping.kind).toBe('standalone');
  });
});

describe('preflight refuses corruption and reads supported formats', () => {
  const registry = syntheticRegistry('synthetic-current', 'synthetic-prior');

  it('accepts a current-format manifest and resolves the identity transform', () => {
    const decision = preflightDecision(syntheticManifest('synthetic-current'), registry);
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.transform.to).toBe('synthetic-current');
  });

  it('reads an OLDER supported format through a transform (R36.16)', () => {
    const decision = preflightDecision(syntheticManifest('synthetic-prior'), registry);
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.transform.from).toBe('synthetic-prior');
      expect(decision.transform.to).toBe('synthetic-current');
    }
  });

  it('REFUSES a corrupted/tampered manifest (fingerprint mismatch)', () => {
    const good = syntheticManifest('synthetic-current');
    const corrupt = { ...good, trust: { ...good.trust, manifestFingerprint: 'f'.repeat(64) } };
    const decision = preflightDecision(corrupt, registry);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reasons.some((r) => r.includes('fingerprint-mismatch'))).toBe(true);
  });

  it('REFUSES an unknown/too-old schema version (unsupported-schema)', () => {
    const decision = preflightDecision(syntheticManifest('ancient-unknown'), registry);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reasons.some((r) => r.startsWith('unsupported-schema'))).toBe(true);
  });
});

describe('checkpoint interruption rolls back and resumes exactly once', () => {
  it('rolls back a crashed slice atomically and resumes, installing every row exactly once', async () => {
    const result = await exerciseCheckpointInterruption(5, 2);
    expect(result.rolledBackCleanly).toBe(true); // no partial effect, no stale checkpoint after the crash
    expect(result.installedRows).toBe(5); // each of the 5 rows installed exactly once
    expect(result.resumeIsIdempotent).toBe(true); // a replay after completion re-applies nothing
  });
});

describe('post-snapshot withdrawal is honoured', () => {
  const corpus = syntheticCorpus(NOW);

  it('does NOT resurrect a withdrawn element present in the independent suppression ledger', () => {
    const withdrawn = corpus.unitIds[1]!;
    const ledger: SuppressionRecord[] = [{
      suppressedId: withdrawn, generation: 7, suppressedAt: '2026-02-01T09:00:00.000Z',
      digest: suppressionDigest({ suppressedId: withdrawn, generation: 7, suppressedAt: '2026-02-01T09:00:00.000Z' }),
    }];
    const applied = applySuppressions(corpus.unitIds, ledger);
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      expect(applied.suppressed).toContain(withdrawn);
      expect(applied.installable).not.toContain(withdrawn);
    }
  });

  it('denies release on a TAMPERED suppression ledger rather than trusting it', () => {
    const ledger: SuppressionRecord[] = [{ suppressedId: 'unit-200', generation: 7, suppressedAt: '2026-02-01T09:00:00.000Z', digest: 'bad' }];
    const applied = applySuppressions(corpus.unitIds, ledger);
    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(applied.fault).toBe('tampered-ledger');
  });
});

describe('RPO/RTO classification', () => {
  it('classifies the RPO age against the ≤24-hour objective', () => {
    expect(RECOVERY_OBJECTIVES.rpoHours).toBe(24);
    expect(RECOVERY_OBJECTIVES.rtoHours).toBe(8);
    expect(classifyRpo(new Date(Date.parse(NOW) - 6 * 3600_000).toISOString(), NOW).state).toBe('ok');
    expect(classifyRpo(new Date(Date.parse(NOW) - 19 * 3600_000).toISOString(), NOW).state).toBe('warning');
    expect(classifyRpo(new Date(Date.parse(NOW) - 25 * 3600_000).toISOString(), NOW).state).toBe('breach');
    expect(classifyRpo(null, NOW).state).toBe('breach'); // no verified point is the worst state
  });

  it('classifies a measured elapsed restore against the ≤8-hour RTO; an absent measurement is not within objective', () => {
    expect(classifyRto(7).withinObjective).toBe(true);
    expect(classifyRto(8).withinObjective).toBe(true);
    expect(classifyRto(9).withinObjective).toBe(false);
    expect(classifyRto(null).withinObjective).toBe(false); // nothing measured cannot meet the objective
  });
});

describe('acceptance contract: download or alert is NOT acceptance', () => {
  it('rejects a package-download-only input as acceptance', () => {
    const verdict = acceptanceRejection({ packageDownloaded: true });
    expect(verdict.accepted).toBe(false);
    if (!verdict.accepted) expect(verdict.reasons.some((r) => r.includes('package download alone'))).toBe(true);
  });

  it('rejects an application-alert-only input as acceptance', () => {
    const verdict = acceptanceRejection({ applicationAlertFired: true });
    expect(verdict.accepted).toBe(false);
    if (!verdict.accepted) expect(verdict.reasons.some((r) => r.includes('application-only alert'))).toBe(true);
  });

  it('rejects a verified restore that exceeds the RTO', () => {
    const verdict = acceptanceRejection({ freshIsolatedRestoreVerified: true, measuredElapsedHours: 10, verifiedCopyAgeHours: 6 });
    expect(verdict.accepted).toBe(false);
  });

  it('accepts only a verified fresh-isolated restore within RPO and RTO', () => {
    const verdict = acceptanceRejection({ freshIsolatedRestoreVerified: true, measuredElapsedHours: 7, verifiedCopyAgeHours: 6 });
    expect(verdict.accepted).toBe(true);
  });
});

describe('live handles and the BLOCKED-not-faked contract', () => {
  it('reports every live handle missing when none is configured', () => {
    expect(liveEnvironmentReady(NO_HANDLES)).toBe(false);
    expect(missingLiveHandles(NO_HANDLES).length).toBe(4);
  });

  it('reads blank/unset environment handles as missing', () => {
    expect(liveHandlesFromEnv({ RF_RECOVERY_KEY_IDS: '   ' } as NodeJS.ProcessEnv).recoveryKeyIdentifiers).toBeUndefined();
  });

  it('every required scenario is enumerated and partitioned into exercised-here vs requires-live', () => {
    for (const scenario of SCENARIOS) {
      expect(EXERCISED_HERE.has(scenario) || REQUIRES_LIVE.has(scenario)).toBe(true);
    }
    expect([...REQUIRES_LIVE].sort()).toEqual(['measured-rpo-rto', 'production-account-loss']);
  });
});

describe('runRehearsal end to end', () => {
  it('with NO independent-environment handles, exercises the deterministic scenarios and BLOCKS the live cases', async () => {
    const record = await runRehearsal({ handles: NO_HANDLES, now: NOW });
    expect(record.environment).toBe('local-synthetic');
    expect(record.liveReady).toBe(false);

    // Every deterministic scenario PASSES on real evidence here.
    for (const name of EXERCISED_HERE) {
      const status = record.scenarios.find((s) => s.scenario === name);
      expect(status?.status, `scenario ${name}`).toBe('passed');
    }
    // Every live scenario is BLOCKED (non-pass), never faked.
    for (const name of REQUIRES_LIVE) {
      const status = record.scenarios.find((s) => s.scenario === name);
      expect(status?.status, `scenario ${name}`).toBe('blocked');
    }
    // RPO/RTO acceptance is blocked in the dry case.
    expect(record.rto.blocked).toBe(true);
    expect(record.rpo.blocked).toBe(true);

    // The 68.4 launch-gate evidence is NOT a pass: a dry run can never certify the recovery requirement.
    const evidence = rehearsalEvidence(record);
    expect(evidence.result).toBe('blocked');
    expect(evidence.scope).toBe('local-synthetic');
    // The non-acceptance contract is carried explicitly in the record.
    expect(record.notAcceptance.some((n) => n.includes('package DOWNLOAD'))).toBe(true);
    expect(record.notAcceptance.some((n) => n.includes('application-only ALERT'))).toBe(true);
  });

  it('never fabricates a pass: even with handles present a dry run has no measured restore, so RTO stays blocked and evidence is not passed', async () => {
    // Handles present means the operator CLAIMS an independent environment, but this tool makes no real
    // restore here, so there is no MEASURED elapsed time — the evidence must still not be a false pass.
    const record = await runRehearsal({ handles: ALL_HANDLES, now: NOW });
    expect(record.rto.blocked).toBe(true); // no measured live restore from this tool
    expect(rehearsalEvidence(record).result).toBe('blocked');
  });
});
