import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CANONICAL_POLICY_SECTIONS,
  aiAllowListViolations,
  fileBodyAndRenditionViolations,
  fontLicenceViolations,
  formatResults,
  policySectionViolations,
  runSmokeChecks,
  secretLeakViolations,
} from '../smoke/index';

/** A disposable git repository populated with `files`, so the git-backed scans see only committed content. */
function withRepo(files: Record<string, string>, run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'rf-smoke-'));
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    execFileSync('git', ['-C', root, 'init', '-q'], { stdio: 'ignore' });
    execFileSync('git', ['-C', root, 'add', '-A'], { stdio: 'ignore' });
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('the real repository passes every smoke check', () => {
  it('finds no violations in any check', () => {
    for (const result of runSmokeChecks()) expect(result.violations, result.check).toEqual([]);
  }, 30_000);

  it('formats a clean pass with a zero exit code', () => {
    const clean = formatResults(runSmokeChecks());
    expect(clean.exitCode).toBe(0);
    expect(clean.output).toContain('All smoke checks passed');
  }, 30_000);
});

describe('file-body and rendition route audit (R12.5, R14.9)', () => {
  const routeFile = (body: string): Record<string, string> => ({ 'apps/app/src/api/routes/x.ts': body });

  it('passes a JSON-only route that serves a stored file inert', () => {
    withRepo(routeFile([
      "export const handler = async (c) => { const data = await c.req.json(); return c.json(data); };",
      "const type = 'application/octet-stream';",
    ].join('\n')), (root) => {
      expect(fileBodyAndRenditionViolations(root)).toEqual([]);
    });
  });

  it('flags a route that reads a raw/file request body', () => {
    withRepo(routeFile('export const upload = async (c) => { const bytes = await c.req.arrayBuffer(); return c.body(bytes); };'), (root) => {
      const found = fileBodyAndRenditionViolations(root);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatch(/raw\/file request body/u);
    });
  });

  it('flags multipart form bodies and renditions', () => {
    withRepo(routeFile([
      'export const form = async (c) => { const f = await c.req.formData(); return c.text(String(f)); };',
      "const url = 'https://example.test/cdn-cgi/image/width=200/' + key;",
    ].join('\n')), (root) => {
      const found = fileBodyAndRenditionViolations(root);
      expect(found.some((v) => /raw\/file request body/u.test(v))).toBe(true);
      expect(found.some((v) => /rendition\/transformation/u.test(v))).toBe(true);
    });
  });

  it('ignores body-reads that live in comments', () => {
    withRepo(routeFile('// never do: await c.req.blob()\nexport const ok = (c) => c.json({});'), (root) => {
      expect(fileBodyAndRenditionViolations(root)).toEqual([]);
    });
  });
});

describe('AI model allow-list and no AI Gateway (R20.20)', () => {
  it('passes the real allow-list and finds no AI Gateway in the repo', () => {
    expect(aiAllowListViolations()).toEqual([]);
  });

  it('does not treat the Zero Trust Gateway lists API as an AI Gateway', () => {
    withRepo({ 'apps/ops/src/access.ts': "const path = `/accounts/${id}/gateway/lists/${listId}`;" }, (root) => {
      expect(aiAllowListViolations(root)).toEqual([]);
    });
  });

  it('flags a configured AI Gateway option', () => {
    withRepo({ 'apps/app/src/ai/call.ts': "await ai.run(model, inputs, { gateway: { id: 'rf-ai' } });" }, (root) => {
      const found = aiAllowListViolations(root);
      expect(found.some((v) => /configures an AI Gateway/u.test(v))).toBe(true);
    });
  });

  it('exempts only the checker\'s own source/fixtures, not real configs in other files', () => {
    // The checker's own files contain the detector pattern and its `{ gateway: … }` fixture; a synthetic
    // non-self file carries a genuine AI-Gateway config. The self-files must be exempt while the other is flagged.
    withRepo({
      'tools/smoke/index.ts': 'const AI_GATEWAY_PATTERNS = [/\\bgateway\\s*:/u];',
      'tools/test/smoke.test.ts': "const fixture = { gateway: { id: 'rf-ai' } };",
      'scripts/deploy-ai.ts': "await ai.run(model, inputs, { gateway: { id: 'x' } });",
    }, (root) => {
      const found = aiAllowListViolations(root);
      expect(found).not.toContain(expect.stringContaining('tools/smoke/index.ts'));
      expect(found.every((v) => !/tools\/smoke\/index\.ts/u.test(v))).toBe(true);
      expect(found.every((v) => !/tools\/test\/smoke\.test\.ts/u.test(v))).toBe(true);
      expect(found.some((v) => /scripts\/deploy-ai\.ts:1 configures an AI Gateway/u.test(v))).toBe(true);
    });
  });
});

describe('no committed secret value (R44.9)', () => {
  it('passes the real repository', () => {
    expect(secretLeakViolations()).toEqual([]);
  }, 30_000);

  it('ignores key-name-only references and placeholder values', () => {
    withRepo({
      '.gitignore': '.dev.vars*\n.env*\n',
      'infra/env.ts': "const keys = ['R2_SECRET_ACCESS_KEY', 'DOWNLOAD_HMAC_KEY'];",
      '.env.example': 'DOWNLOAD_HMAC_KEY=<your-key-here>\nR2_SECRET_ACCESS_KEY=${R2_SECRET_ACCESS_KEY}\n',
    }, (root) => {
      expect(secretLeakViolations(root)).toEqual([]);
    });
  });

  it('flags a committed secret value and never prints the value', () => {
    const value = 'AKIA-super-secret-value-0001';
    withRepo({
      '.gitignore': '.dev.vars*\n.env*\n',
      'config/leak.ts': `export const key = { R2_SECRET_ACCESS_KEY: '${value}' };`,
    }, (root) => {
      const found = secretLeakViolations(root);
      expect(found.some((v) => /assigns a value to secret R2_SECRET_ACCESS_KEY/u.test(v))).toBe(true);
      expect(found.join('\n')).not.toContain(value);
    });
  });

  it('flags a secret-bearing file pattern that is not git-ignored', () => {
    withRepo({ 'README.md': 'no ignore rules here' }, (root) => {
      const found = secretLeakViolations(root);
      expect(found.some((v) => /\.dev\.vars is not git-ignored/u.test(v))).toBe(true);
    });
  });
});

describe('font licences permit self-hosting and export (R45.20)', () => {
  it('passes for the real self-hosted fonts', () => {
    expect(fontLicenceViolations()).toEqual([]);
  });

  it('flags a missing licence file', () => {
    withRepo({ 'packages/design/fonts/.keep': '' }, (root) => {
      // No font files exist under this root, but the real FONT_LICENCES manifest still names licence files.
      const found = fontLicenceViolations(root);
      expect(found.length).toBeGreaterThan(0);
      expect(found.every((v) => /missing/u.test(v))).toBe(true);
    });
  });
});

describe('Policy_Section list matches R46.32', () => {
  it('matches the seeded sections exactly', () => {
    expect(policySectionViolations()).toEqual([]);
  });

  it('lists the canonical sections in the order R46.32 fixes', () => {
    expect(CANONICAL_POLICY_SECTIONS[0]).toEqual({ page: 'about', title: 'About the group' });
    expect(CANONICAL_POLICY_SECTIONS.at(-1)).toEqual({ page: 'corrections', title: 'What happens next' });
    expect(CANONICAL_POLICY_SECTIONS.filter((s) => s.page === 'methods')).toHaveLength(5);
    expect(CANONICAL_POLICY_SECTIONS.filter((s) => s.page === 'privacy')).toHaveLength(6);
  });
});
