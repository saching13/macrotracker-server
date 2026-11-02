import { runMigrations } from './migrate.js';

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error('MIGRATION_DATABASE_URL is not set');
  process.exit(1);
}
await runMigrations(url);
console.warn('migrations applied');
