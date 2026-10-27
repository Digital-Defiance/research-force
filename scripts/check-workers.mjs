import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
for (const worker of ['app', 'submit', 'dl', 'ops']) {
  for (const environment of ['production', 'staging']) {
    const args = [cli, 'deploy', '--dry-run', '--config', `apps/${worker}/wrangler.jsonc`, '--outdir', `.cache/worker-check/${worker}/${environment}`];
    args.push('--env', environment === 'staging' ? 'staging' : '');
    const check = spawnSync(process.execPath, args, {
      cwd: root, stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: `${root}/.cache/wrangler-logs/` },
    });
    if (check.status !== 0) process.exit(check.status ?? 1);
  }
}
