import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The Design Suite's menu components transitively import a crypto/auth chain
// (@digitaldefiance/ecies-lib -> @ethereumjs/util) that imports Node's `events`
// builtin at module load. research-force never calls that wallet code, but the
// module must still load in the browser, so `events` is aliased to its API-complete
// browser polyfill. Without this the app throws at startup (asyncEventEmitter.js).
const require = createRequire(import.meta.url);

// The Design Suite `Flag` component paints each language's flag from https://flagcdn.com, a third-party request
// made by every viewer's browser. The Workspace forbids third-party requests (design "Privacy of Visitors", R45.17;
// CSP img-src 'self' blob: data:) and is English-only, so the external URL is replaced with an empty image at build
// time. The flag renders blank instead of calling out.
const noExternalFlags = {
  name: 'no-external-flags',
  enforce: 'pre' as const,
  transform(code: string, id: string) {
    if (!id.includes('express-suite-react-components') || !code.includes('flagcdn.com')) return null;
    return { code: code.replace(/url\(https:\/\/flagcdn\.com\/\$\{[^}]*\}\.svg\)/g, 'none'), map: null };
  },
};

// The committed public/_headers carries the production download origin and a literal `<account>` placeholder for the
// R2 S3 endpoint. At build time, RF_R2_ACCOUNT_ID fills the placeholder and RF_DOWNLOAD_ORIGIN replaces the download
// origin (staging builds set both), so the emitted CSP names the real hosts and a browser never sees an invalid source.
const environmentHeaders = {
  name: 'environment-headers',
  apply: 'build' as const,
  writeBundle(options: { dir?: string }) {
    const file = (options.dir ?? 'dist') + '/_headers';
    if (!existsSync(file)) return;
    let text = readFileSync(file, 'utf8');
    const account = process.env.RF_R2_ACCOUNT_ID;
    const download = process.env.RF_DOWNLOAD_ORIGIN;
    if (account) text = text.replaceAll('<account>', account);
    if (download) text = text.replaceAll('https://dl.researchforce.org', download);
    writeFileSync(file, text);
  },
};

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [noExternalFlags, environmentHeaders, react()],
  resolve: {
    alias: [
      { find: 'events', replacement: require.resolve('events/') },
      // micromark's `decode-named-character-reference` resolves to `index.dom.js` under the `browser` condition, which
      // calls `document.createElement` at module load. The journal and bulk previews parse Markdown in a Web Worker,
      // where `document` does not exist, so the worker crashed on load and every preview failed. The DOM-free entry
      // (the package's `worker`/`default` export) decodes from a lookup table and works in both the page and workers.
      { find: /^decode-named-character-reference$/, replacement: require.resolve('decode-named-character-reference') },
    ],
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
