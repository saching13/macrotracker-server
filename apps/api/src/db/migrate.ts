import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

export const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** Applies pending migrations as the schema owner. Safe to run on every boot. */
export async function runMigrations(ownerUrl: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: ownerUrl, max: 1, application_name: 'macrotracker-migrate' });
  try {
    await migrate(drizzle(pool), {
      migrationsFolder,
      migrationsSchema: 'app',
      migrationsTable: '__migrations',
    });
  } finally {
    await pool.end();
  }
}
