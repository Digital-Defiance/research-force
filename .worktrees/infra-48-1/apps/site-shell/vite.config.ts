import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const entry = (file: string): string => fileURLToPath(new URL(`./src/${file}`, import.meta.url));

export default defineConfig({
  build: {
    lib: { entry: { main: entry('main.ts'), citation: entry('citation-date.ts'), search: entry('search.ts') }, formats: ['es'] },
    rolldownOptions: { output: { entryFileNames: 'assets/[name]-[hash].js', chunkFileNames: 'assets/[name]-[hash].js', assetFileNames: 'assets/[name]-[hash][extname]' } },
  },
  worker: { format: 'es', rolldownOptions: { output: { entryFileNames: 'assets/[name]-[hash].js' } } },
});
