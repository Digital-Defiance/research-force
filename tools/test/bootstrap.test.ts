import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { publicCopyDigest, type InstallationPublicCopy } from '@researchforce/design/installation';
import { BootstrapRefusal, buildBootstrapPlan, type BootstrapInput } from '../src/bootstrap-plan';

const ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/u, '');
function runNode(args: string[], cwd = ROOT) {
  return spawnSync(process.execPath, ['--import', 'tsx', ...args], { cwd, encoding: 'utf8' });
}

// A visibly different synthetic installation bundle (not ResearchForce.org's). No real content.
const SYNTHETIC_COPY: InstallationPublicCopy = {
  version: '2026-11-01',
  name: 'Synthetic Study Group',
  strapline: 'Testing identity only',
  mission: { heading: 'Mission statement', paragraphs: ['We study synthetic things for the test suite.'] },
  about: ['We are a synthetic group used only in tests.', 'Our work is organized into synthetic projects.'],
  principles: [
    { name: 'Synthetic independence', text: 'We answer only to the fixtures.' },
    { name: 'Synthetic provenance', text: 'Every synthetic claim points to its fixture.' },
  ],
};

/** A complete, consistent bootstrap input. The optional operator inputs are all present. */
function completeInput(overrides: Partial<BootstrapInput> = {}): BootstrapInput {
  return {
    identity: { installationId: 'synthetic-install', environment: 'staging', trustedOrigins: ['https://staging.example.org'] },
    responsiblePerson: { displayName: 'Synthetic Owner', memberEmail: 'owner@example.org' },
    initialProject: { slug: 'p1030680', name: 'First Project', description: 'The first synthetic project.' },
    publicCopy: SYNTHETIC_COPY,
    releasedPublicCopyDigest: publicCopyDigest(SYNTHETIC_COPY),
    contentLicence: { name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/', exportText: 'Content under CC BY 4.0.' },
    operatingProfile: { operatingProfile: 'Free_Qualified', budgetApproved: false },
    recovery: { destination: 'synthetic-independent-destination', keyCustody: 'synthetic-custodian', independentOfApplicationSecrets: true },
    ...overrides,
  };
}

describe('installation bootstrap plan (task 48.4)', () => {
  it('records the public-copy version/digest and initializes "About the group" from the About prose', () => {
    const plan = buildBootstrapPlan(completeInput());
    expect(plan.publicCopy.version).toBe('2026-11-01');
    expect(plan.publicCopy.digest).toBe(publicCopyDigest(SYNTHETIC_COPY));
    // The About prose is copied verbatim into the required "About the group" Policy_Section.
    expect(plan.aboutTheGroup).toMatchObject({ pageKey: 'about', sectionKey: 'about_the_group', title: 'About the group', required: true });
    expect(plan.aboutTheGroup.text).toBe(SYNTHETIC_COPY.about.join('\n\n'));
    // The initial Project is created Not_Published; nothing is provisioned or published.
    expect(plan.initialProject.published).toBe(false);
    expect(plan.provisioningAuthorized).toBe(false);
    expect(plan.publicationAuthorized).toBe(false);
  });

  it('refuses a missing Installation_Public_Copy', () => {
    try {
      buildBootstrapPlan(completeInput({ publicCopy: undefined }));
      expect.unreachable('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(BootstrapRefusal);
      expect((error as BootstrapRefusal).reasons.join('\n')).toContain('installation public copy');
    }
  });

  it('refuses a partial Installation_Public_Copy (empty principles)', () => {
    const partial = { ...SYNTHETIC_COPY, principles: [] };
    expect(() => buildBootstrapPlan(completeInput({ publicCopy: partial, releasedPublicCopyDigest: undefined }))).toThrow(BootstrapRefusal);
  });

  it('refuses a bundle changed without a release (digest does not match the released digest)', () => {
    // Keep the released digest for the original bundle but hand in a changed bundle.
    const changed = { ...SYNTHETIC_COPY, strapline: 'A changed strapline' };
    try {
      buildBootstrapPlan(completeInput({ publicCopy: changed }));
      expect.unreachable('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(BootstrapRefusal);
      expect((error as BootstrapRefusal).reasons.join('\n')).toContain('changed without a release');
    }
  });

  it('refuses a missing Content_Licence before publication or agreement collection', () => {
    try {
      buildBootstrapPlan(completeInput({ contentLicence: undefined }));
      expect.unreachable('expected a refusal');
    } catch (error) {
      expect((error as BootstrapRefusal).reasons.join('\n')).toContain('Content_Licence');
    }
  });

  it('refuses a missing recovery destination/key custody', () => {
    expect(() => buildBootstrapPlan(completeInput({ recovery: undefined }))).toThrow(/recovery destination\/key custody/u);
  });

  it('refuses a missing approved Operating_Profile/budget and never infers a paid plan', () => {
    expect(() => buildBootstrapPlan(completeInput({ operatingProfile: undefined }))).toThrow(/Operating_Profile\/budget/u);
    // A paid profile without explicit budget approval is rejected by the schema, not inferred.
    expect(() => buildBootstrapPlan(completeInput({ operatingProfile: { operatingProfile: 'Paid_Standard', budgetApproved: false } }))).toThrow();
  });

  it('requires fresh restore and containment for a production bootstrap', () => {
    const base = completeInput({ identity: { installationId: 'synthetic-install', environment: 'production', trustedOrigins: ['https://example.org'] } });
    // Missing production readiness entirely.
    expect(() => buildBootstrapPlan(base)).toThrow(/fresh restore and verified containment|fresh restore rehearsal/u);
    // Restore done but containment not verified.
    expect(() => buildBootstrapPlan({ ...base, productionReadiness: { freshRestoreCompleted: true, containmentVerified: false } })).toThrow(/containment/u);
    // Both present: the production plan builds.
    const plan = buildBootstrapPlan({ ...base, productionReadiness: { freshRestoreCompleted: true, containmentVerified: true } });
    expect(plan.environment).toBe('production');
  });

  it('collects every missing operator input in a single refusal', () => {
    try {
      buildBootstrapPlan(completeInput({ contentLicence: undefined, recovery: undefined, operatingProfile: undefined }));
      expect.unreachable('expected a refusal');
    } catch (error) {
      expect((error as BootstrapRefusal).reasons.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('bootstrap CLI makes no account access', () => {
  it('prints a dry-run plan for a complete input and refuses an incomplete one', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'rf-bootstrap-'));
    try {
      const completePath = resolve(dir, 'complete.json');
      writeFileSync(completePath, JSON.stringify(completeInput()));
      const ok = runNode(['tools/bootstrap.ts', '--dry-run', completePath]);
      expect(ok.status).toBe(0);
      expect(ok.stderr).toBe('');
      expect(ok.stdout).toContain('No network or account access');
      expect(ok.stdout).toContain('About the group');

      const incompletePath = resolve(dir, 'incomplete.json');
      writeFileSync(incompletePath, JSON.stringify(completeInput({ contentLicence: undefined })));
      const refused = runNode(['tools/bootstrap.ts', '--dry-run', incompletePath]);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('Content_Licence');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
