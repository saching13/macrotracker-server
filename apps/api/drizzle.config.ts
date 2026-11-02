import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  schemaFilter: ['app'],
  migrations: { schema: 'app', table: '__migrations' },
  ...(process.env.TEST_MIGRATION_DATABASE_URL
    ? { dbCredentials: { url: process.env.TEST_MIGRATION_DATABASE_URL } }
    : {}),
});
