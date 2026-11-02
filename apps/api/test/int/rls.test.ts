import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser, owner, type TestUser } from './helpers.js';

// Talks to Postgres as the API's runtime role, bypassing the API, to prove the
// database itself keeps accounts apart even if a query forgets its WHERE.
const api = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
afterAll(() => api.end());

async function as<T>(
  userId: string | null,
  fn: (c: pg.PoolClient) => Promise<T>,
  isAdmin = false,
): Promise<T> {
  const c = await api.connect();
  try {
    await c.query('begin');
    await c.query("select set_config('app.user_id', $1, true), set_config('app.is_admin', $2, true)", [
      userId ?? '',
      isAdmin ? 'on' : 'off',
    ]);
    return await fn(c);
  } finally {
    await c.query('rollback');
    c.release();
  }
}

let a: TestUser;
let b: TestUser;
beforeAll(async () => {
  a = await createUser();
  b = await createUser();
  for (const u of [a, b]) {
    await owner.query(
      "insert into app.devices (user_id, session_id, name, platform) values ($1, gen_random_uuid(), 'd', 'ios')",
      [u.id],
    );
    await owner.query(
      "insert into app.api_tokens (user_id, name, prefix, token_hash, scopes) values ($1, 't', 'mt_pat_x', md5(random()::text), '{mcp:read}')",
      [u.id],
    );
  }
});

describe('row-level security for mt_api', () => {
  it('shows nothing without a user context', async () => {
    for (const table of ['app_users', 'devices', 'api_tokens', 'audit_events']) {
      const { rowCount } = await as(null, (c) => c.query(`select 1 from app.${table}`));
      expect(rowCount, table).toBe(0);
    }
  });

  it('shows a user only their own rows, even with no WHERE clause', async () => {
    for (const table of ['app_users', 'devices', 'api_tokens']) {
      const { rows } = await as(a.id, (c) =>
        c.query<{ user_id: string }>(`select user_id from app.${table}`),
      );
      expect(rows.length, table).toBeGreaterThan(0);
      expect(new Set(rows.map((r) => r.user_id)), table).toEqual(new Set([a.id]));
    }
  });

  it("won't write rows for another user", async () => {
    await expect(
      as(a.id, (c) =>
        c.query(
          "insert into app.devices (user_id, session_id, name, platform) values ($1, gen_random_uuid(), 'x', 'ios')",
          [b.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    const updated = await as(a.id, (c) =>
      c.query("update app.devices set name = 'hijacked' where user_id = $1", [b.id]),
    );
    expect(updated.rowCount).toBe(0);
  });

  it('lets a member rename themselves but not promote themselves', async () => {
    const renamed = await as(a.id, (c) =>
      c.query("update app.app_users set display_name = 'A' where user_id = $1", [a.id]),
    );
    expect(renamed.rowCount).toBe(1);
    await expect(
      as(a.id, (c) => c.query("update app.app_users set role = 'admin' where user_id = $1", [a.id])),
    ).rejects.toThrow(/only an admin/);
  });

  it('only admins may create accounts', async () => {
    await expect(
      as(a.id, (c) => c.query('insert into app.app_users (user_id) values (gen_random_uuid())')),
    ).rejects.toThrow(/row-level security/);
  });

  it("can't read GoTrue's tables", async () => {
    await expect(as(a.id, (c) => c.query('select * from auth.users'))).rejects.toThrow(/permission denied/);
  });
});
