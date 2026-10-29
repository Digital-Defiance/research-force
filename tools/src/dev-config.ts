import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { parseEnv } from 'node:util';

export function localServerFiles() {
  return { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.dev.vars*', '**/.wrangler/**'] };
}

/** Opt-in is read from this ignored file only, never the inherited shell environment. */
export function localAuthEnabled(root: string): boolean {
  const path = join(root, '.dev.vars');
  const value = existsSync(path) ? parseEnv(readFileSync(path, 'utf8'))['RF_DEV_AUTH'] : undefined;
  if (value !== undefined && value !== '1') throw new Error('RF_DEV_AUTH must be omitted or set to 1 in .dev.vars.');
  return value === '1';
}
export function localAuthVars(root: string, work: string): string {
  if (!localAuthEnabled(root)) return '# Local development only. No production credentials.\n';
  const keyFile = join(work, 'local-auth-key.pem');
  if (existsSync(keyFile) && lstatSync(keyFile).isSymbolicLink()) throw new Error('The local signing key must be a regular local file.');
  if (!existsSync(keyFile)) {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    writeFileSync(keyFile, privateKey, { mode: 0o600, flag: 'wx' });
  }
  const key = readFileSync(keyFile, 'utf8');
  return `RF_DEV_AUTH=1\nRF_DEV_AUTH_PRIVATE_KEY=${JSON.stringify(key)}\n`;
}
/** Verify the actual launch configuration before Wrangler can start with any non-local bindings. */
export function assertLocalLaunch(config: unknown): void {
  const c = config as Record<string, unknown>;
  const bindings = [...(c['d1_databases'] as Record<string, unknown>[] ?? []), ...(c['r2_buckets'] as Record<string, unknown>[] ?? [])];
  const vars = c['vars'] as Record<string, unknown> | undefined;
  const origin = (value: unknown): boolean => {
    try { const url = new URL(String(value)); return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password && url.origin === value; }
    catch { return false; }
  };
  const objects = c['durable_objects'] as { bindings?: { name?: string; class_name?: string; script_name?: string }[] } | undefined;
  if (c['name'] !== 'rf-app-dev' || c['ai'] || c['services'] || c['env'] || c['routes'] || c['account_id'] || c['unsafe']
    || bindings.length !== 5 || bindings.some((b) => b['remote'] !== false)
    || !['WORKSPACE_ORIGIN', 'ACCESS_TEAM_DOMAIN', 'DOWNLOAD_ORIGIN'].every((key) => origin(vars?.[key])) || vars?.['ACCESS_AUD'] !== 'local-development'
    || vars?.['RF_LOCAL_SERVICES'] !== '1' || !objects?.bindings?.some((binding) => binding.name === 'LOCAL_SERVICES' && binding.class_name === 'LocalServices')
    || objects?.bindings?.some((binding) => binding.script_name !== undefined)
    || !String(c['main']).replaceAll('\\', '/').endsWith('/apps/app/src/local.ts')) throw new Error('Local development requires an isolated local-only binding configuration.');
}
