import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: { entry: fileURLToPath(new URL('./src/main.ts', import.meta.url)), formats: ['es'] },
    rolldownOptions: { output: { entryFileNames: 'assets/[name]-[hash].js', assetFileNames: 'assets/[name]-[hash][extname]' } },
  },
});
