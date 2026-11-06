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

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  resolve: {
    alias: {
      events: require.resolve('events/'),
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
