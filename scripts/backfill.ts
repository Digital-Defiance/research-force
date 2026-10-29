import { fileURLToPath } from 'node:url';
import { upgradeCommand } from '../tools/src/upgrade-cli';
try { console.log(JSON.stringify(upgradeCommand(fileURLToPath(new URL('../', import.meta.url)), 'backfill', process.argv.slice(2)), null, 2)); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
