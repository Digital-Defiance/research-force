import { defineConfig } from 'drizzle-kit';

// Run from the repository root: npm run db:generate
export default defineConfig({
  dialect: 'sqlite',
  schema: './packages/db/src/schema/search.ts',
  out: './packages/db/migrations/search',
});
