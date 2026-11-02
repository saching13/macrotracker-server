import { runMigrations } from '../../src/db/migrate.js';

export default async function setup() {
  const url = process.env.TEST_MIGRATION_DATABASE_URL;
  if (!url)
    throw new Error('TEST_MIGRATION_DATABASE_URL is not set; run integration tests with `make test-int`');
  await runMigrations(url);
}
