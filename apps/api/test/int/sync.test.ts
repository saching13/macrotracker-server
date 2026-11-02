import { randomUUID } from 'node:crypto';
import {
  SYNC_SCHEMA,
  SYNC_TABLES,
  type SyncBootstrapResponse,
  type SyncChange,
  type SyncPullResponse,
  type SyncPushResponse,
  type SyncStatus,
  type SyncTable,
} from '@macrotracker/shared';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { keyOf, sampleRow } from '../fixtures/sync-rows.js';
import { bearer, createUser, gotrue, owner, session, testApp } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => {
  app = await testApp();
});

const V = SYNC_SCHEMA.max;
const iso = (ms: number) => new Date(ms).toISOString();

/** A signed-in device for a fresh account (or another device on `user`'s). */
async function device(user?: Awaited<ReturnType<typeof createUser>>) {
  const u = user ?? (await createUser());
  const s = await session(app, u, `Phone ${randomUUID().slice(0, 4)}`);
  const headers = bearer(s.access_token);

  const push = async (changes: Partial<SyncChange>[], opts: { clientNow?: string; schema?: number } = {}) => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sync/push',
      headers,
      payload: {
        schema_version: opts.schema ?? V,
        client_now: opts.clientNow ?? new Date().toISOString(),
        changes: changes.map((c) => ({
          change_id: randomUUID(),
          changed_at: new Date().toISOString(),
          ...c,
        })),
      },
    });
    return res;
  };
  const pushOk = async (...args: Parameters<typeof push>) => {
    const res = await push(...args);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<SyncPushResponse>();
  };
  const pull = async (since = 0, limit = 500) => {
    const res = await app.inject({ url: `/v1/sync/pull?since=${since}&limit=${limit}`, headers });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<SyncPullResponse>();
  };
  const status = async () => {
    const res = await app.inject({ url: '/v1/sync/status', headers });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<SyncStatus>();
  };
  const bootstrap = async (
    rows: { table: SyncTable; row: Record<string, unknown> }[],
    schema: number = V,
  ) => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sync/bootstrap',
      headers,
      payload: { schema_version: schema, rows },
    });
    return res;
  };
  return { user: u, session: s, headers, push, pushOk, pull, status, bootstrap };
}

const insert = (table: SyncTable, row: Record<string, unknown>, at?: number): Partial<SyncChange> => ({
  table,
  id: keyOf(table, row),
  op: 'insert',
  row,
  ...(at === undefined ? {} : { changed_at: iso(at) }),
});
const update = (table: SyncTable, row: Record<string, unknown>, at?: number): Partial<SyncChange> => ({
  ...insert(table, row, at),
  op: 'update',
});
const remove = (table: SyncTable, id: string, at?: number): Partial<SyncChange> => ({
  table,
  id,
  op: 'delete',
  ...(at === undefined ? {} : { changed_at: iso(at) }),
});

describe('sync status', () => {
  it('describes an empty account', async () => {
    const d = await device();
    const s = await d.status();
    expect(s.account_id).toBe(d.user.id);
    expect(s.server_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(s).toMatchObject({ rev: 0, empty: true, schema: SYNC_SCHEMA });

    await d.pushOk([insert('weight_entries', sampleRow('weight_entries'))]);
    expect(await d.status()).toMatchObject({ rev: 1, empty: false });
  });

  it('is the same server for every account', async () => {
    const [a, b] = await Promise.all([device(), device()]);
    expect((await a.status()).server_id).toBe((await b.status()).server_id);
  });

  it('refuses personal access tokens', async () => {
    const d = await device();
    const created = await app.inject({
      method: 'POST',
      url: '/v1/tokens',
      headers: d.headers,
      payload: { name: 'agent', scopes: ['mcp:read', 'mcp:write'] },
    });
    const res = await app.inject({ url: '/v1/sync/status', headers: bearer(created.json().token) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('session_required');
  });
});

describe('push and pull', () => {
  it('round-trips every table exactly as the app stores it', async () => {
    const d = await device();
    const rows = SYNC_TABLES.map((table) => ({ table, row: sampleRow(table) }));
    const pushed = await d.pushOk(rows.map((r) => insert(r.table, r.row)));
    expect(pushed.results.map((r) => r.result)).toEqual(rows.map(() => 'applied'));
    expect(pushed.rev).toBe(rows.length);

    const pulled = await d.pull();
    expect(pulled.changes.map((c) => c.rev)).toEqual(rows.map((_, i) => i + 1));
    for (const [i, c] of pulled.changes.entries()) {
      expect(c).toMatchObject({ table: rows[i]!.table, deleted: false });
      expect(c.row).toStrictEqual(rows[i]!.row);
    }
    expect(pulled).toMatchObject({ next: rows.length, has_more: false });
  });

  it('records the device that wrote a row', async () => {
    const d = await device();
    const row = sampleRow('log_entries');
    await d.pushOk([insert('log_entries', row)]);
    const { rows } = await owner.query(
      'select updated_by_device, schema_version from app.log_entries where id = $1',
      [row.id],
    );
    expect(rows[0]).toEqual({ updated_by_device: d.session.device_id, schema_version: V });
  });

  it('pages through changes in rev order', async () => {
    const d = await device();
    await d.pushOk(Array.from({ length: 25 }, () => insert('log_entries', sampleRow('log_entries'))));
    const seen: number[] = [];
    let since = 0;
    for (let page = 0; ; page++) {
      const p = await d.pull(since, 10);
      seen.push(...p.changes.map((c) => c.rev));
      since = p.next;
      expect(p.has_more).toBe(page < 2);
      if (!p.has_more) break;
    }
    expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect((await d.pull(since)).changes).toEqual([]);
  });

  it('returns only the latest state of a row that changed several times', async () => {
    const d = await device();
    const row = sampleRow('log_entries');
    const t = Date.now() - 10_000;
    await d.pushOk([insert('log_entries', row, t), update('log_entries', { ...row, kcal: 400 }, t + 1)]);
    await d.pushOk([update('log_entries', { ...row, kcal: 500 }, t + 2)]);
    const p = await d.pull();
    expect(p.changes).toHaveLength(1);
    expect(p.changes[0]).toMatchObject({ rev: 3, row: { kcal: 500 } });
    expect((await d.pull(2)).changes).toHaveLength(1);
    expect((await d.pull(3)).changes).toHaveLength(0);
  });

  it('tells an app whose cursor is ahead of the server to start over', async () => {
    const d = await device();
    const res = await app.inject({ url: '/v1/sync/pull?since=99', headers: d.headers });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('cursor_ahead');
  });

  it('keeps accounts apart, even for the same row ids', async () => {
    const [a, b] = await Promise.all([device(), device()]);
    const row = sampleRow('foods');
    await a.pushOk([insert('foods', row)]);
    expect((await b.pull()).changes).toEqual([]);

    const hijack = await b.pushOk([update('foods', { ...row, name: 'Mine now' })]);
    expect(hijack.results[0]!.result).toBe('applied');
    expect((await a.pull()).changes[0]!.row).toMatchObject({ name: 'Overnight oats' });
    expect((await b.pull()).changes[0]!.row).toMatchObject({ name: 'Mine now' });
  });

  it('shares an account between its devices', async () => {
    const phone = await device();
    const tablet = await device(phone.user);
    const row = sampleRow('weight_entries');
    await phone.pushOk([insert('weight_entries', row)]);
    expect((await tablet.pull()).changes[0]!.row).toStrictEqual(row);
  });
});

describe('conflicts', () => {
  it('keeps the newer write and hands a stale writer the current row', async () => {
    const d = await device();
    const row = sampleRow('log_entries');
    const t = Date.now() - 60_000;
    await d.pushOk([insert('log_entries', { ...row, kcal: 300 }, t + 2000)]);

    const older = await d.pushOk([update('log_entries', { ...row, kcal: 100 }, t + 1000)]);
    expect(older.results[0]).toMatchObject({
      result: 'stale',
      current: { deleted: false, row: { kcal: 300 } },
    });

    const newer = await d.pushOk([update('log_entries', { ...row, kcal: 200 }, t + 3000)]);
    expect(newer.results[0]).toMatchObject({ result: 'applied', rev: 3 });
    expect((await d.pull()).changes[0]!.row).toMatchObject({ kcal: 200 });
  });

  it('lets the later arrival win a tie', async () => {
    const d = await device();
    const row = sampleRow('app_meta');
    const t = Date.now() - 60_000;
    // One push, so both stamps get the same clock correction.
    const tie = await d.pushOk([
      insert('app_meta', { ...row, value: 'first' }, t),
      update('app_meta', { ...row, value: 'second' }, t),
    ]);
    expect(tie.results.map((r) => r.result)).toEqual(['applied', 'applied']);
    expect((await d.pull()).changes[0]!.row).toMatchObject({ value: 'second' });
  });

  it('puts stamps on the server clock', async () => {
    const d = await device();
    const hourAhead = Date.now() + 3_600_000;
    const row = sampleRow('weight_entries');
    // A phone whose clock runs an hour fast: its edit is a minute old.
    await d.pushOk([insert('weight_entries', row, hourAhead - 60_000)], { clientNow: iso(hourAhead) });
    const [stored] = (await d.pull()).changes;
    const lag = Date.now() - Date.parse(stored!.changed_at);
    expect(lag).toBeGreaterThan(55_000);
    expect(lag).toBeLessThan(65_000);

    // A stamp in the future (by the phone's own clock) is pulled back to now.
    const before = Date.now();
    await d.pushOk([update('weight_entries', { ...row, weight_kg: 70 }, Date.now() + 86_400_000)]);
    const [later] = (await d.pull(1)).changes;
    expect(Date.parse(later!.changed_at)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(later!.changed_at)).toBeLessThanOrEqual(Date.now());
  });

  it("doesn't let a slow clock lose every conflict", async () => {
    const d = await device();
    const row = sampleRow('app_meta');
    await d.pushOk([insert('app_meta', { ...row, value: 'a' }, Date.now() - 1000)]);
    // An hour slow, but this edit was made just now.
    const slow = Date.now() - 3_600_000;
    const res = await d.pushOk([update('app_meta', { ...row, value: 'b' }, slow)], { clientNow: iso(slow) });
    expect(res.results[0]!.result).toBe('applied');
  });
});

describe('deletes', () => {
  it('leaves a tombstone that pulls as a delete', async () => {
    const d = await device();
    const row = sampleRow('log_entries');
    const t = Date.now() - 60_000;
    await d.pushOk([insert('log_entries', row, t)]);
    const del = await d.pushOk([remove('log_entries', String(row.id), t + 1000)]);
    expect(del.results[0]).toMatchObject({ result: 'applied', rev: 2 });
    const [c] = (await d.pull()).changes;
    expect(c).toMatchObject({ id: row.id, rev: 2, deleted: true });
    expect(c!.row).toBeUndefined();
    expect((await d.status()).empty).toBe(true);
  });

  it('never brings a deleted row back through an update, even a newer one', async () => {
    const d = await device();
    const row = sampleRow('log_entries');
    const t = Date.now() - 60_000;
    await d.pushOk([insert('log_entries', row, t), remove('log_entries', String(row.id), t + 1000)]);
    const edit = await d.pushOk([update('log_entries', { ...row, kcal: 1 }, t + 5000)]);
    expect(edit.results[0]).toMatchObject({ result: 'stale', current: { deleted: true } });
    expect((await d.pull()).changes[0]!.deleted).toBe(true);
  });

  it('brings a row back when the app re-creates it (undo)', async () => {
    const d = await device();
    const row = sampleRow('log_entries');
    const t = Date.now() - 60_000;
    await d.pushOk([insert('log_entries', row, t), remove('log_entries', String(row.id), t + 1000)]);
    const stale = await d.pushOk([insert('log_entries', row, t + 500)]);
    expect(stale.results[0]!.result).toBe('stale');
    const undo = await d.pushOk([insert('log_entries', row, t + 2000)]);
    expect(undo.results[0]!.result).toBe('applied');
    expect((await d.pull()).changes[0]).toMatchObject({ deleted: false, row });
  });

  it('keeps an edit made after an older delete arrives', async () => {
    const d = await device();
    const row = sampleRow('log_entries');
    const t = Date.now() - 60_000;
    await d.pushOk([insert('log_entries', row, t), update('log_entries', { ...row, kcal: 9 }, t + 2000)]);
    const del = await d.pushOk([remove('log_entries', String(row.id), t + 1000)]);
    expect(del.results[0]).toMatchObject({ result: 'stale', current: { deleted: false, row: { kcal: 9 } } });
  });

  it('accepts deleting a row the server never saw', async () => {
    const d = await device();
    const res = await d.pushOk([remove('log_entries', randomUUID())]);
    expect(res.results[0]).toMatchObject({ result: 'applied', current: null });
    expect(res.rev).toBe(1);
    expect((await d.pull()).changes).toEqual([]);
  });

  it('removes all synced data with the account', async () => {
    const d = await device();
    await d.pushOk([insert('foods', sampleRow('foods')), insert('app_meta', sampleRow('app_meta'))]);
    await gotrue.adminDeleteUser(d.user.id);
    for (const table of ['foods', 'user_meta', 'sync_state', 'sync_receipts']) {
      const { rowCount } = await owner.query(`select 1 from app.${table} where user_id = $1`, [d.user.id]);
      expect(rowCount, table).toBe(0);
    }
  });
});

describe('retries', () => {
  it('ignores a replayed push', async () => {
    const d = await device();
    const changes = [
      { change_id: randomUUID(), ...insert('log_entries', sampleRow('log_entries')) },
      { change_id: randomUUID(), ...insert('weight_entries', sampleRow('weight_entries')) },
    ];
    const first = await d.pushOk(changes);
    const again = await d.pushOk(changes);
    expect(again.rev).toBe(first.rev);
    expect(again.results).toEqual(
      first.results.map((r) => expect.objectContaining({ result: r.result, rev: r.rev, duplicate: true })),
    );
    expect((await d.pull()).changes).toHaveLength(2);
  });

  it('gives a replayed change the current row, in case the first reply was lost', async () => {
    const d = await device();
    const other = await device(d.user);
    const row = sampleRow('log_entries');
    const t = Date.now() - 60_000;
    const mine = { change_id: randomUUID(), ...insert('log_entries', row, t) };
    await d.pushOk([mine]);
    await other.pushOk([update('log_entries', { ...row, kcal: 5 }, t + 1000)]);
    const replay = await d.pushOk([mine]);
    expect(replay.results[0]).toMatchObject({
      result: 'applied',
      duplicate: true,
      current: { row: { kcal: 5 } },
    });
  });

  it('treats a repeated change id within one push as a duplicate', async () => {
    const d = await device();
    const change = { change_id: randomUUID(), ...insert('log_entries', sampleRow('log_entries')) };
    const res = await d.pushOk([change, change]);
    expect(res.results.map((r) => r.duplicate)).toEqual([false, true]);
    expect(res.rev).toBe(1);
  });
});

describe('validation', () => {
  it('rejects bad rows one by one without failing the push', async () => {
    const d = await device();
    const good = sampleRow('log_entries');
    const res = await d.pushOk([
      insert('foods', sampleRow('foods', { source: 'indb' })),
      insert('foods', sampleRow('foods', { source: 'usda' })),
      insert('app_meta', { key: 'backup_provider', value: 'gdrive' }),
      insert('log_entries', sampleRow('log_entries', { local_date: '30/10/2026' })),
      insert('log_entries', sampleRow('log_entries', { kcal: 'lots' })),
      { ...insert('log_entries', sampleRow('log_entries')), id: randomUUID() },
      { table: 'log_entries', id: randomUUID(), op: 'update' },
      insert('log_entries', good),
    ]);
    expect(res.results.map((r) => r.error?.code ?? r.result)).toEqual([
      'reference_food',
      'reference_food',
      'meta_key_not_synced',
      'invalid_row',
      'invalid_row',
      'id_mismatch',
      'invalid_row',
      'applied',
    ]);
    expect(res.results[3]!.error!.message).toMatch(/^local_date:/);
    expect((await d.pull()).changes.map((c) => c.id)).toEqual([good.id]);
  });

  it('drops columns it does not know', async () => {
    const d = await device();
    const row = sampleRow('weight_entries');
    await d.pushOk([insert('weight_entries', { ...row, mood: 'great' })]);
    expect((await d.pull()).changes[0]!.row).toStrictEqual(row);
  });

  it('refuses apps outside the schema range', async () => {
    const d = await device();
    const tooOld = await d.push([], { schema: SYNC_SCHEMA.min - 1 });
    expect(tooOld.statusCode).toBe(409);
    expect(tooOld.json().error.code).toBe('app_update_required');
    const tooNew = await d.push([], { schema: SYNC_SCHEMA.max + 1 });
    expect(tooNew.json().error.code).toBe('server_update_required');
    const boot = await d.bootstrap([{ table: 'foods', row: sampleRow('foods') }], SYNC_SCHEMA.max + 1);
    expect(boot.statusCode).toBe(409);
  });

  it('caps the batch size', async () => {
    const d = await device();
    const res = await d.push(Array.from({ length: 501 }, () => remove('log_entries', randomUUID())));
    expect(res.statusCode).toBe(400);
  });
});

describe('bootstrap', () => {
  it("adds what the server lacks and keeps the server's version of the rest", async () => {
    const phone = await device();
    const tablet = await device(phone.user);
    const shared = sampleRow('user_profile');
    const gone = sampleRow('log_entries');
    const t = Date.now() - 60_000;
    await phone.pushOk([
      insert('user_profile', shared, t),
      insert('log_entries', gone, t),
      remove('log_entries', String(gone.id), t + 1),
    ]);

    const fresh = sampleRow('foods');
    const res = await tablet.bootstrap([
      { table: 'user_profile', row: { ...shared, height_cm: 150 } },
      { table: 'log_entries', row: gone },
      { table: 'foods', row: fresh },
      { table: 'app_meta', row: { key: 'indb_enabled', value: 'true' } },
    ]);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<SyncBootstrapResponse>()).toMatchObject({
      inserted: 1,
      skipped: 2,
      rejected: [{ index: 3, code: 'meta_key_not_synced' }],
      rev: 4,
    });

    const state = await phone.pull();
    expect(state.changes.find((c) => c.table === 'user_profile')!.row).toMatchObject({ height_cm: 168.5 });
    expect(state.changes.find((c) => c.id === gone.id)!.deleted).toBe(true);
    expect(state.changes.find((c) => c.id === fresh.id)!.row).toStrictEqual(fresh);
  });

  it('is safe to repeat', async () => {
    const d = await device();
    const rows = [{ table: 'foods' as const, row: sampleRow('foods') }];
    expect((await d.bootstrap(rows)).json()).toMatchObject({ inserted: 1, skipped: 0 });
    expect((await d.bootstrap(rows)).json()).toMatchObject({ inserted: 0, skipped: 1, rev: 1 });
  });
});

describe('concurrent devices', () => {
  it('gives every write its own rev and loses none', async () => {
    const phone = await device();
    const tablet = await device(phone.user);
    const batches = Array.from({ length: 12 }, (_, i) =>
      Array.from({ length: 5 }, () => insert('log_entries', sampleRow('log_entries', { meal: `m${i}` }))),
    );
    // Pushes from both devices race each other and a pulling reader.
    const reader = (async () => {
      let since = 0;
      const ids = new Set<string>();
      for (let i = 0; i < 30; i++) {
        const p = await tablet.pull(since);
        p.changes.forEach((c) => ids.add(c.id));
        since = p.next;
      }
      return { ids, since };
    })();
    const pushes = await Promise.all(batches.map((b, i) => (i % 2 ? tablet : phone).pushOk(b)));
    const revs = pushes.flatMap((p) => p.results.map((r) => r.rev!));
    expect(new Set(revs).size).toBe(60);

    const { ids, since } = await reader;
    // Catch up from where the racing reader left off: nothing may be skipped.
    let cursor = since;
    for (;;) {
      const p = await tablet.pull(cursor);
      p.changes.forEach((c) => ids.add(c.id));
      cursor = p.next;
      if (!p.has_more) break;
    }
    expect(ids.size).toBe(60);
  });
});
