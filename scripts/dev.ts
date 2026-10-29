import { fileURLToPath } from 'node:url';
import { runLocalDev } from '../tools/src/local-dev';

runLocalDev(fileURLToPath(new URL('../', import.meta.url)), process.argv.slice(2))
  .catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
