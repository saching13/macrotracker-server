import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface Database {
  db: Db;
  pool: pg.Pool;
  close(): Promise<void>;
}

export function createDatabase(url: string, max = 10): Database {
  const pool = new pg.Pool({ connectionString: url, max, application_name: 'macrotracker-api' });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

export interface RlsContext {
  userId: string | null;
  isAdmin?: boolean;
}

/**
 * Runs `fn` in a transaction whose row-level-security context is the given
 * user. Settings are transaction-local, so a pooled connection never carries
 * one request's identity into the next.
 */
export async function withContext<T>(db: Db, ctx: RlsContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.user_id', ${ctx.userId ?? ''}, true), set_config('app.is_admin', ${ctx.isAdmin ? 'on' : 'off'}, true)`,
    );
    return fn(tx);
  });
}
