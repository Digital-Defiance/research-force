import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { join } from 'node:path';
import { createServer as viteServer } from 'vite';
import { buildDevSeed } from './dev-seed-data';
import { assertLocalLaunch, localAuthEnabled, localAuthVars, localServerFiles } from './dev-config';

export const DEV_HOST = '127.0.0.1';
export function devPorts(env: NodeJS.ProcessEnv = process.env) {
  const port = (name: string, fallback: number): number => {
    const value = env[name] ?? String(fallback);
    if (!/^\d+$/u.test(value) || Number(value) < 1024 || Number(value) > 65535) throw new Error(`Invalid local port: ${name}`);
    return Number(value);
  };
  const result = { worker: port('RF_DEV_WORKER_PORT', 8787), web: port('RF_DEV_WEB_PORT', 5173) };
  if (result.worker === result.web) throw new Error('Worker and Vite ports must differ.');
  return result;
}
export function localPaths(root: string) {
  return { config: join(root, '.wrangler/dev/wrangler.json'), state: join(root, '.wrangler/dev-state'), work: join(root, '.wrangler/dev'), lock: join(root, '.wrangler/dev.lock') };
}
/** This is an allow-list configuration, not a copy of the production configuration or its secrets. */
export function localConfig(root: string, ports = devPorts({})) {
  return {
    name: 'rf-app-dev', main: join(root, 'apps/app/src/local.ts'), compatibility_date: '2026-10-26', workers_dev: false, preview_urls: false,
    vars: { WORKSPACE_ORIGIN: `http://${DEV_HOST}:${ports.web}`, DOWNLOAD_ORIGIN: `http://${DEV_HOST}:${ports.worker}`, ACCESS_TEAM_DOMAIN: `http://${DEV_HOST}:${ports.worker}`, ACCESS_AUD: 'local-development', RF_LOCAL_SERVICES: '1' },
    d1_databases: ['core', 'search', 'public'].map((name, i) => ({ binding: `RF_${name.toUpperCase()}`, database_name: `rf-${name}-dev`, database_id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, migrations_dir: join(root, `packages/db/migrations/${name}`), remote: false })),
    r2_buckets: [{ binding: 'RF_PRIVATE_BUCKET', bucket_name: 'rf-private-dev', remote: false }, { binding: 'RF_PUBLIC_BUCKET', bucket_name: 'rf-public-dev', remote: false }],
    durable_objects: { bindings: [...['Publisher', 'Mailer', 'Budget', 'Jobs'].map((class_name) => ({ name: class_name.toUpperCase(), class_name })), { name: 'LOCAL_SERVICES', class_name: 'LocalServices' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['Publisher', 'Mailer', 'Budget', 'Jobs'] }, { tag: 'v2-local-services', new_sqlite_classes: ['LocalServices'] }],
    assets: { directory: join(root, '.wrangler/dev/assets'), binding: 'ASSETS', not_found_handling: 'single-page-application', run_worker_first: ['/api/*'] },
  };
}
/** Never delete or write through symlinked local-state directories. */
export function prepareDirectories(root: string, reset = false): void {
  for (const path of [join(root, '.wrangler'), localPaths(root).work, localPaths(root).state]) {
    if (existsSync(path) && realpathSync(path) !== path) throw new Error(`Local state directory must not be a symlink: ${path}`);
    mkdirSync(path, { recursive: true });
  }
  if (reset) { rmSync(localPaths(root).state, { recursive: true, force: true }); mkdirSync(localPaths(root).state); }
}
export function childEnvironment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:CF_|CLOUDFLARE_|WRANGLER_|GRAPH_|R2_|ACCESS_|DOWNLOAD_HMAC|NODE_OPTIONS)/u.test(key)));
  return { ...env, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false' };
}
export function command(root: string, args: string[], inherit = true): ChildProcess {
  return spawn(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'), ...args, '--config', localPaths(root).config], {
    cwd: localPaths(root).work, env: { ...childEnvironment(), WRANGLER_LOG_PATH: join(localPaths(root).work, 'logs') },
    stdio: inherit ? ['ignore', 'inherit', 'inherit'] : 'pipe', detached: process.platform !== 'win32',
  });
}
function stop(child: ChildProcess): void {
  if (!child.pid) return;
  try { if (process.platform === 'win32') child.kill('SIGTERM'); else process.kill(-child.pid, 'SIGTERM'); } catch { /* Already stopped. */ }
}
async function execute(root: string, args: string[]): Promise<void> {
  const child = command(root, args);
  const cancel = () => stop(child);
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Local Wrangler command failed (${signal ?? code}): ${args[0]} ${args[1]}`)));
    });
  } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}
async function freePort(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = netServer(); server.once('error', reject);
    server.listen(port, DEV_HOST, () => server.close((error) => error ? reject(error) : resolve()));
  });
}
export async function initializeLocal(root: string, ports: ReturnType<typeof devPorts>, reset: boolean): Promise<void> {
  prepareDirectories(root, reset);
  const paths = localPaths(root);
  mkdirSync(join(paths.work, 'assets'), { recursive: true });
  const config = localConfig(root, ports);
  assertLocalLaunch(config);
  writeFileSync(paths.config, JSON.stringify(config, null, 2));
  writeFileSync(join(paths.work, '.dev.vars'), localAuthVars(root, paths.work), { mode: 0o600 });
  writeFileSync(join(paths.work, 'assets/index.html'), '<!doctype html><title>Research Force local Worker</title><p>Open the Vite Workspace on port ' + ports.web + '.</p>');
  for (const binding of ['RF_CORE', 'RF_SEARCH', 'RF_PUBLIC']) await execute(root, ['d1', 'migrations', 'apply', binding, '--local', '--persist-to', paths.state]);
  const seed = buildDevSeed();
  for (const [i, object] of seed.objects.entries()) {
    const file = join(paths.work, `object-${i}.txt`); writeFileSync(file, object.content);
    await execute(root, ['r2', 'object', 'put', `${object.bucket}/${object.key}`, '--local', '--persist-to', paths.state, '--file', file, '--content-type', object.type]);
  }
  for (const name of ['core', 'search', 'public'] as const) {
    const file = join(paths.work, `seed-${name}.sql`); writeFileSync(file, seed[name]);
    await execute(root, ['d1', 'execute', `RF_${name.toUpperCase()}`, '--local', '--persist-to', paths.state, '--file', file]);
  }
}

export async function runLocalDev(root: string, args: readonly string[]): Promise<void> {
  if (args.some((arg) => !['--reset', '--seed-only'].includes(arg))) throw new Error('Usage: npm run dev -- [--reset] [--seed-only]');
  root = realpathSync(root);
  const ports = devPorts();
  prepareDirectories(root);
  let lock: number;
  try { lock = openSync(localPaths(root).lock, 'wx'); }
  catch { throw new Error('Local development is already running, or .wrangler/dev.lock remains after a crash. Stop the runner before removing a stale lock.'); }
  writeFileSync(lock, String(process.pid)); closeSync(lock);
  let worker: ChildProcess | undefined;
  let released = false;
  // Vite/npm may exit directly on a terminal signal; cleanup must also be synchronous at process exit.
  const release = () => {
    if (released) return;
    released = true;
    if (worker) stop(worker);
    rmSync(localPaths(root).lock, { force: true });
  };
  process.once('exit', release);
  try {
    if (!args.includes('--seed-only')) { await freePort(ports.worker); await freePort(ports.web); }
    await initializeLocal(root, ports, args.includes('--reset'));
    if (args.includes('--seed-only')) return;
    const marker = randomUUID(); writeFileSync(join(localPaths(root).work, 'assets/__dev-health.txt'), marker);
    const child = command(root, ['dev', '--local', '--ip', DEV_HOST, '--port', String(ports.worker), '--inspector-port', '0', '--persist-to', localPaths(root).state, '--show-interactive-dev-session=false']);
    worker = child;
    let exited = false; let spawnError: Error | undefined;
    child.once('error', (error) => { spawnError = error; exited = true; });
    child.once('exit', () => { exited = true; });
    let web: Awaited<ReturnType<typeof viteServer>> | undefined;
    let stopped = false;
    const cancel = () => { stopped = true; stop(child); };
    process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
    try {
      const deadline = Date.now() + 45_000;
      while (!stopped) {
        if (exited) throw spawnError ?? new Error('Local Worker exited before startup.');
        try { const response = await fetch(`http://${DEV_HOST}:${ports.worker}/__dev-health.txt`, { signal: AbortSignal.timeout(1000) }); if (await response.text() === marker) break; } catch { /* Worker is still starting. */ }
        if (Date.now() > deadline) throw new Error('Local Worker startup timed out.');
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      if (stopped) return;
      const authEnabled = localAuthEnabled(root);
      web = await viteServer({ configFile: join(root, 'apps/app/web/vite.config.ts'),
        plugins: [{ name: 'rf-local-auth', transformIndexHtml: () => authEnabled ? [{ tag: 'meta', attrs: { name: 'rf-local-sign-in', content: 'enabled' }, injectTo: 'head' }] : [] }],
        server: { host: DEV_HOST, port: ports.web, strictPort: true,
        fs: localServerFiles(),
        proxy: { '/api': { target: `http://${DEV_HOST}:${ports.worker}`, changeOrigin: false } } } });
      await web.listen();
      console.log(`Synthetic Workspace: http://${DEV_HOST}:${ports.web}. ${authEnabled ? 'Sign in at /api/dev/sign-in. Administrator outbox: /api/v1/dev/outbox.' : 'Set RF_DEV_AUTH=1 in .dev.vars to enable local sign-in.'} OPS, AI and email are local stand-ins.`);
      while (!stopped) {
        if (exited) throw new Error('Local Worker exited unexpectedly.');
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); stop(child); await web?.close(); }
  } finally { release(); process.off('exit', release); }
}
