import { describe, expect, it } from 'vitest';
import {
  certifyScopes,
  EMPTY_LAUNCH_EVIDENCE,
  evaluateGates,
  formatReport,
  isRealAcceptance,
  KNOWN_GATES,
  launchEvidenceSchema,
  manifestsForGraph,
  type EvidenceEntry,
  type GateManifest,
  type GateRequirement,
  type LaunchEvidence,
} from '../src/launch-gates';
import { readGraphGates } from '../check-launch';

// Synthetic, in-memory gate manifests and evidence fixtures. No real network, no repository I/O.

const req = (id: string, infra: GateRequirement['infra'], critical = false): GateRequirement => ({ id, description: `requirement ${id}`, infra, critical });

/** A small two-gate fixture: a base gate and a dependent gate that requires it. */
function manifests(): GateManifest[] {
  return [
    {
      id: 'team_archive',
      title: 'Team archive',
      requiresGates: [],
      requirements: [req('recovery', 'infra-restore', true), req('privacy', 'infra-staging'), req('walkthroughs', 'infra-walkthrough')],
    },
    {
      id: 'public_archive',
      title: 'Public archive',
      requiresGates: ['team_archive'],
      requirements: [req('licence', 'infra-staging', true), req('abuse', 'infra-abuse', true)],
    },
  ];
}

/** A passing real deployed-scope acceptance entry for a gate requirement. */
const pass = (gate: string, requirement: string, kind: EvidenceEntry['kind']): EvidenceEntry => ({
  gate, requirement, kind, result: 'passed', scope: 'deployed-staging', remediationTasks: [],
});

/** The full set of passing entries for the team_archive gate in the fixture. */
const teamArchivePassing = (): EvidenceEntry[] => [
  pass('team_archive', 'recovery', 'infra-restore'),
  pass('team_archive', 'privacy', 'infra-staging'),
  pass('team_archive', 'walkthroughs', 'infra-walkthrough'),
];

const ledger = (entries: EvidenceEntry[]): LaunchEvidence => ({ schemaVersion: 1, entries });

describe('launch-gate evaluation (task 68.4)', () => {
  it('a fully-satisfied gate passes with real deployed-scope acceptance for every requirement', () => {
    const result = certifyScopes(manifests(), ledger(teamArchivePassing()), ['team_archive']);
    const gate = result.gates.find((status) => status.id === 'team_archive')!;
    expect(gate.satisfied).toBe(true);
    expect(gate.unmet).toEqual([]);
    expect(result.certified).toBe(true);
  });

  it('a gate with a missing infrastructure suite is BLOCKED, not skipped', () => {
    const entries = teamArchivePassing().filter((entry) => entry.requirement !== 'recovery'); // drop the restore suite
    const result = certifyScopes(manifests(), ledger(entries), ['team_archive']);
    const gate = result.gates.find((status) => status.id === 'team_archive')!;
    expect(gate.satisfied).toBe(false);
    expect(result.certified).toBe(false);
    expect(gate.unmet.join('\n')).toContain('no recorded evidence');
    // A blocked requirement is a non-pass, never reported as met/ready.
    expect(gate.requirements.find((status) => status.requirement.id === 'recovery')?.met).toBe(false);
  });

  it('a source-file, checked-box or unit-only result does NOT satisfy an infrastructure requirement', () => {
    for (const kind of ['source-file', 'checked-box', 'unit-test'] as const) {
      const entries: EvidenceEntry[] = [
        { gate: 'team_archive', requirement: 'recovery', kind, result: 'passed', scope: 'deployed-staging', remediationTasks: [] },
        pass('team_archive', 'privacy', 'infra-staging'),
        pass('team_archive', 'walkthroughs', 'infra-walkthrough'),
      ];
      const gate = evaluateGates(manifests(), ledger(entries)).find((status) => status.id === 'team_archive')!;
      expect(gate.satisfied).toBe(false);
      const recovery = gate.requirements.find((status) => status.requirement.id === 'recovery')!;
      expect(recovery.met).toBe(false);
      expect(recovery.reason).toContain('substitute evidence');
    }
    // isRealAcceptance rejects each substitute kind directly.
    const requirement = req('recovery', 'infra-restore');
    for (const kind of ['source-file', 'checked-box', 'unit-test'] as const) {
      expect(isRealAcceptance({ gate: 'team_archive', requirement: 'recovery', kind, result: 'passed', scope: 'deployed-staging', remediationTasks: [] }, requirement, 'team_archive')).toBe(false);
    }
  });

  it('an infra suite recorded only against a local-synthetic scope does not satisfy a requirement', () => {
    const entries: EvidenceEntry[] = [
      { gate: 'team_archive', requirement: 'recovery', kind: 'infra-restore', result: 'passed', scope: 'local-synthetic', remediationTasks: [] },
      pass('team_archive', 'privacy', 'infra-staging'),
      pass('team_archive', 'walkthroughs', 'infra-walkthrough'),
    ];
    const gate = evaluateGates(manifests(), ledger(entries)).find((status) => status.id === 'team_archive')!;
    expect(gate.satisfied).toBe(false);
    expect(gate.requirements.find((status) => status.requirement.id === 'recovery')?.reason).toContain('local-synthetic');
  });

  it('a failed control path blocks the scope and the failure report is retained with remediation', () => {
    const entries: EvidenceEntry[] = [
      { gate: 'team_archive', requirement: 'recovery', kind: 'infra-restore', result: 'failed', scope: 'deployed-staging', remediationTasks: ['58.5'], note: 'restore mismatch' },
      pass('team_archive', 'privacy', 'infra-staging'),
      pass('team_archive', 'walkthroughs', 'infra-walkthrough'),
    ];
    const gate = evaluateGates(manifests(), ledger(entries)).find((status) => status.id === 'team_archive')!;
    expect(gate.satisfied).toBe(false);
    expect(gate.failures).toHaveLength(1);
    expect(gate.failures[0]).toMatchObject({ requirement: 'recovery', result: 'failed', remediationTasks: ['58.5'] });
    expect(gate.requirements.find((status) => status.requirement.id === 'recovery')?.reason).toContain('failed');
  });

  it('a missing content licence / independent keys / profile approval blocks public launch', () => {
    // team_archive fully satisfied, but public_archive is missing its critical licence evidence.
    const entries = [...teamArchivePassing(), pass('public_archive', 'abuse', 'infra-abuse')];
    const result = certifyScopes(manifests(), ledger(entries), ['public_archive']);
    const gate = result.gates.find((status) => status.id === 'public_archive')!;
    expect(gate.satisfied).toBe(false);
    expect(result.certified).toBe(false);
    expect(gate.requirements.find((status) => status.requirement.id === 'licence')?.met).toBe(false);
  });

  it('a prerequisite-gate failure blocks the dependent gate even when its own evidence is complete', () => {
    // public_archive has all of its OWN evidence, but team_archive (its prerequisite) is incomplete.
    const entries: EvidenceEntry[] = [
      pass('team_archive', 'privacy', 'infra-staging'), // recovery + walkthroughs missing
      pass('public_archive', 'licence', 'infra-staging'),
      pass('public_archive', 'abuse', 'infra-abuse'),
    ];
    const result = certifyScopes(manifests(), ledger(entries), ['public_archive']);
    const publicGate = result.gates.find((status) => status.id === 'public_archive')!;
    expect(publicGate.requirements.every((status) => status.met)).toBe(true); // its own evidence is complete
    expect(publicGate.satisfied).toBe(false); // but the prerequisite is not satisfied
    expect(publicGate.unsatisfiedPrerequisites).toEqual(['team_archive']);
    expect(result.certified).toBe(false);
  });

  it('a cyclic or unknown prerequisite fails closed (blocks, never passes)', () => {
    const cyclic: GateManifest[] = [
      { id: 'a', title: 'A', requiresGates: ['b'], requirements: [] },
      { id: 'b', title: 'B', requiresGates: ['a'], requirements: [] },
    ];
    const statuses = evaluateGates(cyclic, EMPTY_LAUNCH_EVIDENCE);
    expect(statuses.every((status) => !status.satisfied)).toBe(true);
    const unknown: GateManifest[] = [{ id: 'a', title: 'A', requiresGates: ['missing'], requirements: [] }];
    expect(evaluateGates(unknown, EMPTY_LAUNCH_EVIDENCE)[0]?.satisfied).toBe(false);
  });

  it('with no recorded evidence every gate is BLOCKED and no scope certifies', () => {
    const result = certifyScopes(manifests(), EMPTY_LAUNCH_EVIDENCE, ['team_archive', 'public_archive']);
    expect(result.gates.every((status) => !status.satisfied)).toBe(true);
    expect(result.certified).toBe(false);
    const report = formatReport(manifests(), EMPTY_LAUNCH_EVIDENCE, ['team_archive']);
    expect(report).toContain('BLOCKED');
    expect(report).not.toContain('SATISFIED team_archive');
  });

  it('certifying an unknown requested gate is a hard failure', () => {
    const result = certifyScopes(manifests(), ledger(teamArchivePassing()), ['does_not_exist']);
    expect(result.certified).toBe(false);
    expect(formatReport(manifests(), ledger(teamArchivePassing()), ['does_not_exist'])).toContain('Unknown requested gate');
  });

  it('reporting with no requested scope does not attempt certification', () => {
    const report = formatReport(manifests(), EMPTY_LAUNCH_EVIDENCE, []);
    expect(report).toContain('no certification attempted');
  });
});

describe('final checkpoint and R60.4 matrix from the canonical graph', () => {
  it('the final checkpoint cannot pass with any required suite absent', () => {
    const graphGates = [
      { id: 'team_archive', requiredEvidence: ['x'] },
      { id: 'public_archive', requiresGates: ['team_archive'], requiredEvidence: ['x'] },
      { id: 'outside_services', requiresGates: ['public_archive'], requiredEvidence: ['x'] },
      { id: 'final_checkpoint_49', requiresGates: ['team_archive', 'public_archive', 'outside_services'], requiredEvidence: ['x'] },
    ];
    const built = manifestsForGraph(graphGates);
    const final = built.find((manifest) => manifest.id === 'final_checkpoint_49')!;
    // Supply passing evidence for every final-checkpoint requirement EXCEPT the walkthroughs suite.
    const entries: EvidenceEntry[] = final.requirements
      .filter((requirement) => requirement.id !== 'final_walkthroughs')
      .map((requirement) => pass('final_checkpoint_49', requirement.id, requirement.infra));
    const gate = evaluateGates(built, ledger(entries)).find((status) => status.id === 'final_checkpoint_49')!;
    expect(gate.satisfied).toBe(false);
    expect(gate.unmet.join('\n')).toContain('team walkthroughs');
  });

  it('builds a manifest for every real graph gate and rejects an unmapped gate id', () => {
    for (const id of KNOWN_GATES) expect(typeof id).toBe('string');
    expect(() => manifestsForGraph([{ id: 'surprise_gate', requiredEvidence: ['x'] }])).toThrow(/surprise_gate/u);
  });

  it('parses the gates array out of a tasks.md graph block', () => {
    const markdown = [
      'intro',
      '## Task Dependency Graph',
      '',
      '```json',
      JSON.stringify({ gates: [{ id: 'team_archive', requiredEvidence: ['matrix'] }] }),
      '```',
      '',
    ].join('\n');
    expect(readGraphGates(markdown)[0]?.id).toBe('team_archive');
    expect(() => readGraphGates('no graph here')).toThrow();
  });
});

describe('launch evidence schema', () => {
  it('accepts a well-formed ledger and rejects an unknown evidence kind', () => {
    expect(launchEvidenceSchema.parse({ schemaVersion: 1, entries: [pass('team_archive', 'recovery', 'infra-restore')] }).entries).toHaveLength(1);
    expect(() => launchEvidenceSchema.parse({ schemaVersion: 1, entries: [{ gate: 'g', requirement: 'r', kind: 'guess', result: 'passed', scope: 'deployed-staging' }] })).toThrow();
  });
});
