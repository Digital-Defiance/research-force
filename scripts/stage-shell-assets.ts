import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeShellBundle, type ShellBundleEntry } from '../packages/public-render/src/shell-bundle';
// Stages the public site's browser assets (site-shell scripts, Design_System CSS, fonts) under the Workspace
// asset directory so the Publisher can read them through the ASSETS binding and ship them to rf-site (R31).
// The files are written as ONE object (_shell/bundle.bin) so the Publisher reads them with a single ASSETS fetch.
// Run after both the app and the site-shell builds: the app build empties web/dist, so this must come last.
const root = fileURLToPath(new URL('../', import.meta.url));
const shellDist = join(root, 'apps/site-shell/dist/assets');
const designSrc = join(root, 'packages/design/src');
const designFonts = join(root, 'packages/design/fonts');
const target = join(root, 'apps/app/web/dist/_shell');
const CONTENT_TYPES: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };

function fail(message: string): never {
  console.error(`stage-shell-assets: ${message}`);
  process.exit(1);
}
if (!existsSync(shellDist)) fail('apps/site-shell/dist/assets is missing; run the site-shell build first');
if (!existsSync(join(root, 'apps/app/web/dist'))) fail('apps/app/web/dist is missing; run the app build first');

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
const entries: ShellBundleEntry[] = [];
function stage(from: string, directory: 'assets' | 'fonts', name: string): void {
  const contentType = CONTENT_TYPES[extname(name)];
  if (!contentType) fail(`no content type for ${name}`);
  entries.push({ path: `/${directory}/${name}`, contentType, content: new Uint8Array(readFileSync(from)) });
}
for (const name of readdirSync(shellDist).sort()) if (statSync(join(shellDist, name)).isFile()) stage(join(shellDist, name), 'assets', name);
for (const name of ['tokens.css', 'fonts.css', 'components.css', 'print.css']) {
  if (!existsSync(join(designSrc, name))) fail(`${name} is missing from packages/design/src; run npm run design:css`);
  stage(join(designSrc, name), 'assets', name);
}
for (const name of readdirSync(designFonts).filter((file) => file.endsWith('.woff2')).sort()) stage(join(designFonts, name), 'fonts', name);
for (const required of ['/assets/form.js', '/assets/respond.js', '/assets/consent.js', '/assets/citation.js', '/assets/search.js']) {
  if (!entries.some((entry) => entry.path === required)) fail(`${required} was not produced by the site-shell build`);
}
writeFileSync(join(target, 'bundle.bin'), encodeShellBundle(entries));
console.log(`stage-shell-assets: bundled ${entries.length} files into apps/app/web/dist/_shell/bundle.bin`);
