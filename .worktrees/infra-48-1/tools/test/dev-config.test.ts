import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertLocalLaunch, localAuthEnabled, localAuthVars, localServerFiles } from '../src/dev-config';
import { createServer } from 'vite';
import { localConfig } from '../src/local-dev';
import { assertDeployable } from '../src/deploy-guard';
import { checkDeployment } from '../../scripts/deploy';

describe('local opt-in and binding checks', () => {
  it('serves the Workspace but denies vars and generated credential files over Vite HTTP', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'rf-local-files-')));
    mkdirSync(join(root, 'web')); mkdirSync(join(root, '.wrangler/dev'), { recursive: true });
    writeFileSync(join(root, 'web/index.html'), '<!doctype html><title>Synthetic Workspace</title>');
    const paths = ['.dev.vars', '.wrangler/dev/.dev.vars', '.wrangler/dev/local-auth-key.pem'];
    for (const path of paths) writeFileSync(join(root, path), 'SYNTHETIC_PRIVATE_FILE');
    const web = await createServer({ configFile: false, root: join(root, 'web'), server: { host: '127.0.0.1', port: 0, hmr: false, fs: { allow: [root], ...localServerFiles() } } });
    try {
      await web.listen(); const address = web.httpServer!.address();
      if (!address || typeof address === 'string') throw new Error('Missing local test listener.');
      const base = `http://127.0.0.1:${address.port}`;
      expect((await fetch(base)).status).toBe(200);
      for (const path of paths) {
        const response = await fetch(`${base}/@fs${join(root, path)}`);
        expect(response.status).toBe(403); expect(await response.text()).not.toContain('SYNTHETIC_PRIVATE_FILE');
      }
    } finally { await web.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it('reads only the ignored .dev.vars opt-in and retains a local key across restarts', () => {
    const root = mkdtempSync(join(tmpdir(), 'rf-dev-auth-')); const work = join(root, '.wrangler/dev');
    try {
      mkdirSync(work, { recursive: true }); expect(localAuthEnabled(root)).toBe(false);
      expect(localAuthVars(root, work)).not.toContain('PRIVATE_KEY');
      writeFileSync(join(root, '.dev.vars'), 'RF_DEV_AUTH=1\nGRAPH_CLIENT_ID=must-not-copy\n');
      const first = localAuthVars(root, work); expect(first).toContain('RF_DEV_AUTH=1'); expect(first).not.toContain('GRAPH_CLIENT_ID');
      expect(localAuthVars(root, work)).toBe(first);
      expect(readFileSync(join(work, 'local-auth-key.pem'), 'utf8')).toContain('BEGIN PRIVATE KEY');
      writeFileSync(join(root, '.dev.vars'), 'RF_DEV_AUTH=true'); expect(() => localAuthEnabled(root)).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('refuses every remote binding or nonlocal configuration before starting Wrangler', () => {
    expect(() => assertLocalLaunch(localConfig('/repo'))).not.toThrow();
    for (const field of ['ai', 'services', 'routes', 'env', 'account_id', 'unsafe']) expect(() => assertLocalLaunch({ ...localConfig('/repo'), [field]: {} })).toThrow();
    const config = localConfig('/repo'); const remote = { ...config, d1_databases: config.d1_databases.map((db, i) => i === 0 ? { ...db, remote: true } : db) };
    expect(() => assertLocalLaunch(remote)).toThrow();
    expect(() => assertLocalLaunch({ ...config, vars: { ...config.vars, WORKSPACE_ORIGIN: 'https://app.example.org' } })).toThrow();
    expect(() => assertLocalLaunch({ ...config, durable_objects: { bindings: [{ name: 'MAILER', script_name: 'remote-worker' }] } })).toThrow();
    expect(() => assertLocalLaunch({ ...config, main: '/repo/apps/app/src/index.ts' })).toThrow();
  });
});
describe('deployment refuses local sign-in', () => {
  it('checks roots, named environments, vars files and inherited settings, even false flags', () => {
    expect(() => assertDeployable({ main: 'src/index.ts', vars: { WORKSPACE_ORIGIN: 'https://app.example.org' } })).not.toThrow();
    for (const config of [{ vars: { RF_DEV_AUTH: '1' } }, { env: { staging: { vars: { RF_DEV_AUTH: '0' } } } }, { main: 'src/local.ts' }, { vars: { RF_DEV_AUTH_PRIVATE_KEY: 'synthetic' } },
      { vars: { RF_LOCAL_SERVICES: '0' } }, { durable_objects: { bindings: [{ name: 'LOCAL_SERVICES', class_name: 'LocalServices' }] } }]) expect(() => assertDeployable(config)).toThrow();
    expect(() => assertDeployable({}, ['RF_LOCAL_SERVICES=1'])).toThrow();
    expect(() => assertDeployable({}, ['RF_DEV_AUTH=1'])).toThrow();
    expect(() => assertDeployable({}, [], { RF_DEV_AUTH: '1' })).toThrow();
  });
  it('makes the deployment script reject unsafe files without invoking a deploy command', () => {
    const root = mkdtempSync(join(tmpdir(), 'rf-deploy-guard-')); const config = join(root, 'wrangler.json');
    try {
      writeFileSync(config, JSON.stringify({ vars: { RF_DEV_AUTH: '1' } }));
      expect(() => checkDeployment(config)).toThrow('local sign-in');
      writeFileSync(config, JSON.stringify({ main: 'src/index.ts' }));
      writeFileSync(join(root, '.dev.vars.staging'), 'RF_DEV_AUTH=1');
      expect(() => checkDeployment(config)).toThrow('vars files');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
