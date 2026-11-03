import { randomUUID } from 'node:crypto';
import {
  type Entry,
  type Food,
  SYNC_SCHEMA,
  type Status,
  type SyncPullResponse,
  type SyncRowState,
  engine,
} from '@macrotracker/shared';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { targetsId } from '../../src/services/engine.js';
import { sampleRow } from '../fixtures/sync-rows.js';
import { bearer, createUser, session, testApp } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => {
  app = await testApp();
});

const TODAY = '2026-11-02'; // a Monday

/** An account set up on a phone (profile, program, weigh-ins, a food, diary), plus a web session. */
async function account() {
  const user = await createUser();
  const phone = bearer((await session(app, user, 'Phone')).access_token);
  const web = bearer((await session(app, user, 'Browser')).access_token);
  const goalId = randomUUID();
  const t = engine.toDay(TODAY);
  const rows: { table: string; row: Record<string, unknown> }[] = [
    { table: 'user_profile', row: sampleRow('user_profile') },
    { table: 'goals', row: sampleRow('goals', { id: goalId }) },
    { table: 'programs', row: sampleRow('programs', { goal_id: goalId, day_plan: null }) },
    {
      table: 'foods',
      row: sampleRow('foods', { id: 'oats', name: 'Overnight oats', brand: 'Home', is_favorite: 1 }),
    },
    {
      table: 'food_servings',
      row: sampleRow('food_servings', { food_id: 'oats', label: 'jar', base_amount: 250 }),
    },
    {
      table: 'recipes',
      row: sampleRow('recipes', { id: 'dal', name: 'Dal', servings: 4, total_kcal: 800 }),
    },
  ];
  // Three weeks of weigh-ins and full days of eating.
  for (let i = 21; i >= 1; i--) {
    const date = engine.fromDay(t - i);
    rows.push({
      table: 'weight_entries',
      row: sampleRow('weight_entries', { local_date: date, weight_kg: 72 - i * 0.05 }),
    });
    rows.push({
      table: 'log_entries',
      row: sampleRow('log_entries', { local_date: date, food_id: 'oats', kcal: 1900 }),
    });
  }
  const res = await app.inject({
    method: 'POST',
    url: '/v1/sync/bootstrap',
    headers: phone,
    payload: { schema_version: SYNC_SCHEMA.max, rows },
  });
  expect(res.statusCode, res.body).toBe(200);

  const call = async <T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
    as = web,
  ) => {
    const r = await app.inject({
      method,
      url,
      headers: as,
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
    return { status: r.statusCode, body: r.body ? (r.json() as T) : (undefined as T) };
  };
  const pull = async (since = 0) => {
    const r = await app.inject({ url: `/v1/sync/pull?since=${since}&limit=1000`, headers: phone });
    return r.json<SyncPullResponse>();
  };
  return { user, phone, web, call, pull };
}

const rowOf = (changes: SyncRowState[], table: string, id: string) =>
  changes.find((c) => c.table === table && c.id === id);

describe('diary', () => {
  it('logs a USDA food with its macros snapshotted, and the phone pulls it', async () => {
    const a = await account();
    const search = await a.call<{ foods: Food[] }>('GET', '/v1/foods/search?q=banana%20raw');
    expect(search.status).toBe(200);
    const banana = search.body.foods.find((f) => f.reference)!;
    expect(banana.source).toBe('usda');

    const before = (await a.pull()).next;
    const made = await a.call<Entry>('POST', '/v1/entries', {
      date: TODAY,
      time: '08:15',
      food_id: banana.id,
      quantity: 120,
      serving_label: 'g',
      serving_amount: 120,
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body).toMatchObject({ name: banana.name, meal: 'breakfast', time: '08:15', quantity: 120 });
    expect(made.body.kcal).toBeCloseTo((banana.kcal_per_serving * 120) / banana.serving_qty, 9);

    const pulled = await a.pull(before);
    const row = rowOf(pulled.changes, 'log_entries', made.body.id)!;
    expect(row.row).toMatchObject({
      food_id: banana.id,
      logged_time: '08:15',
      local_date: TODAY,
      health_uuid: null,
    });

    const today = await a.call<{ entries: Entry[]; totals: { kcal: number } }>(
      'GET',
      `/v1/day?date=${TODAY}`,
    );
    expect(today.body.entries.map((e) => e.id)).toEqual([made.body.id]);
    expect(today.body.totals.kcal).toBeCloseTo(made.body.kcal, 9);
  });

  it('logs quick adds and recipe servings', async () => {
    const a = await account();
    const quick = await a.call<Entry>('POST', '/v1/entries', { date: TODAY, kcal: 250, protein_g: 10 });
    expect(quick.status).toBe(201);
    expect(quick.body).toMatchObject({
      name: 'Quick Add',
      kcal: 250,
      protein_g: 10,
      carb_g: 0,
      food_id: null,
    });
    const dal = await a.call<Entry>('POST', '/v1/entries', {
      date: TODAY,
      time: '19:30',
      recipe_id: 'dal',
      quantity: 2,
    });
    expect(dal.body).toMatchObject({
      name: 'Dal',
      meal: 'dinner',
      kcal: 400,
      serving_label: 'serving',
      serving_amount: 2,
    });

    const bad = await a.call('POST', '/v1/entries', { date: TODAY, food_id: 'oats', kcal: 5, quantity: 1 });
    expect(bad.status).toBe(400);
    const missing = await a.call('POST', '/v1/entries', { date: TODAY, food_id: 'nope', quantity: 1 });
    expect(missing.status).toBe(404);
  });

  it('edits re-snapshot from the food; deletes reach the phone', async () => {
    const a = await account();
    const e = (
      await a.call<Entry>('POST', '/v1/entries', {
        date: TODAY,
        food_id: 'oats',
        quantity: 250,
        serving_label: 'jar',
        serving_amount: 1,
      })
    ).body;
    // Two jars, given in the entry's serving.
    const twice = await a.call<Entry>('PATCH', `/v1/entries/${e.id}`, { serving_amount: 2, time: '07:00' });
    expect(twice.status, JSON.stringify(twice.body)).toBe(200);
    expect(twice.body).toMatchObject({ quantity: 500, serving_amount: 2, meal: 'breakfast', time: '07:00' });
    expect(twice.body.kcal).toBeCloseTo(e.kcal * 2, 9);
    expect((await a.call('PATCH', `/v1/entries/${e.id}`, { kcal: 1 })).status).toBe(422);

    const before = (await a.pull()).next;
    expect((await a.call('DELETE', `/v1/entries/${e.id}`)).status).toBe(204);
    expect(rowOf((await a.pull(before)).changes, 'log_entries', e.id)?.deleted).toBe(true);
    expect((await a.call('DELETE', `/v1/entries/${e.id}`)).status).toBe(404);
  });

  it('keeps accounts apart', async () => {
    const a = await account();
    const b = await account();
    const e = (await a.call<Entry>('POST', '/v1/entries', { date: TODAY, kcal: 100 })).body;
    expect((await b.call('PATCH', `/v1/entries/${e.id}`, { kcal: 1 })).status).toBe(404);
    expect((await b.call('DELETE', `/v1/entries/${e.id}`)).status).toBe(404);
    const bDay = await b.call<{ entries: Entry[] }>('GET', `/v1/day?date=${TODAY}`);
    expect(bDay.body.entries).toEqual([]);
    await a.call('POST', '/v1/foods', {
      name: 'Grandma sambar',
      serving_qty: 100,
      serving_unit: 'g',
      kcal_per_serving: 90,
      protein_g: 4,
      carb_g: 12,
      fat_g: 3,
    });
    const bFoods = await b.call<{ foods: Food[] }>('GET', '/v1/foods/search?q=grandma%20sambar');
    expect(bFoods.body.foods).toEqual([]);
  });
});

describe('foods', () => {
  it('finds your foods before reference foods, with servings', async () => {
    const a = await account();
    const res = await a.call<{ foods: Food[] }>('GET', '/v1/foods/search?q=oats');
    expect(res.body.foods[0]).toMatchObject({ id: 'oats', reference: false, is_favorite: true });
    expect(res.body.foods[0]!.servings).toEqual([
      expect.objectContaining({ label: 'jar', base_amount: 250 }),
    ]);
    expect(res.body.foods.slice(1).every((f) => f.reference)).toBe(true);
    // LIKE wildcards are literal.
    expect((await a.call<{ foods: Food[] }>('GET', '/v1/foods/search?q=%25%25')).body.foods).toEqual([]);
  });

  it('creates foods the phone receives', async () => {
    const a = await account();
    const before = (await a.pull()).next;
    const made = await a.call<Food>('POST', '/v1/foods', {
      name: 'Paneer tikka',
      serving_qty: 100,
      serving_unit: 'g',
      kcal_per_serving: 260,
      protein_g: 18,
      carb_g: 6,
      fat_g: 18,
      servings: [{ label: 'skewer', base_amount: 80 }],
    });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ source: 'custom', reference: false, servings: [{ label: 'skewer' }] });
    const changes = (await a.pull(before)).changes;
    expect(rowOf(changes, 'foods', made.body.id)?.row).toMatchObject({
      name: 'Paneer tikka',
      source: 'custom',
    });
    expect(changes.filter((c) => c.table === 'food_servings')).toHaveLength(1);

    const recent = await a.call<{ foods: Food[] }>('GET', '/v1/foods/recent');
    expect(recent.body.foods.map((f) => f.id)).toEqual(['oats']);
  });
});

describe('weight and profile', () => {
  it('logs, lists and deletes weigh-ins', async () => {
    const a = await account();
    const w = await a.call<{ id: string }>('POST', '/v1/weights', { date: TODAY, weight_kg: 70.4 });
    expect(w.status).toBe(201);
    const list = await a.call<{ weights: { id: string }[] }>('GET', `/v1/weights?from=${TODAY}&to=${TODAY}`);
    expect(list.body.weights.map((x) => x.id)).toEqual([w.body.id]);
    expect((await a.call('DELETE', `/v1/weights/${w.body.id}`)).status).toBe(204);
  });

  it('changes units, keeping the rest of the profile', async () => {
    const a = await account();
    const p = await a.call<{ unit_mass: string; height_cm: number }>('PATCH', '/v1/profile', {
      unit_mass: 'lb',
    });
    expect(p.body).toMatchObject({ unit_mass: 'lb', height_cm: 168.5 });
    const row = rowOf((await a.pull()).changes, 'user_profile', 'me')!;
    expect(row.row).toMatchObject({ unit_mass: 'lb', sex: 'female' });
  });
});

describe('status and check-ins', () => {
  it('runs the engine over the synced history', async () => {
    const a = await account();
    const res = await a.call<Status>('GET', `/v1/status?today=${TODAY}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.estimate).not.toBeNull();
    expect(res.body.estimate!.trend_weight_kg).toBeGreaterThan(70);
    expect(res.body.estimate!.expenditure_kcal).toBeGreaterThan(1500);
    // From the first weigh-in through today.
    expect(res.body.trend).toHaveLength(22);
    expect(res.body.trend.at(-1)).toMatchObject({ date: TODAY, scale_kg: null });
    expect(res.body.check_in).toBeNull(); // no targets yet
    expect(res.body.profile).toMatchObject({ unit_mass: 'kg' });
  });

  it('a web check-in writes the same rows a phone would', async () => {
    const a = await account();
    const preview = await a.call<{ week: unknown[]; logged_days: number }>(
      'GET',
      `/v1/check-in?today=${TODAY}`,
    );
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.week).toHaveLength(7);
    expect(preview.body.logged_days).toBe(7);

    const before = (await a.pull()).next;
    const done = await a.call<Status>('POST', '/v1/check-in', { today: TODAY });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.week).toHaveLength(7);
    expect(done.body.check_in).toMatchObject({ last_check_in: TODAY, is_due: false });
    expect(done.body.today_targets).toMatchObject({ effective_date: TODAY, weekday: 1 });

    const targets = (await a.pull(before)).changes.filter((c) => c.table === 'targets');
    expect(targets.map((t) => t.id).sort()).toEqual(
      [1, 2, 3, 4, 5, 6, 7].map((d) => targetsId(TODAY, d)).sort(),
    );
    expect(targets[0]!.row).toMatchObject({ reason: 'check_in', effective_date: TODAY });
  });

  it('matches the app’s target ids', () => {
    // From the app's wire-rows fixture: targets for 2026-11-03, Monday.
    expect(targetsId('2026-11-03', 1)).toBe('e1a6dca5-e284-51fe-82e5-5b1555d08b53');
  });

  it('needs a program to check in', async () => {
    const user = await createUser();
    const web = bearer((await session(app, user)).access_token);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/check-in',
      headers: web,
      payload: { today: TODAY },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'no_data' } });
  });
});

describe('access tokens', () => {
  it('need the scope for each kind of call', async () => {
    const a = await account();
    const token = async (scopes: string[]) => {
      const r = await a.call<{ token: string }>('POST', '/v1/tokens', { name: 'agent', scopes });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return bearer(r.body.token);
    };
    const reader = await token(['mcp:read']);
    const writer = await token(['mcp:read', 'mcp:write']);
    expect((await a.call('GET', `/v1/day?date=${TODAY}`, undefined, reader)).status).toBe(200);
    expect((await a.call('POST', '/v1/entries', { date: TODAY, kcal: 1 }, reader)).status).toBe(403);
    const e = await a.call<Entry>('POST', '/v1/entries', { date: TODAY, kcal: 1 }, writer);
    expect(e.status).toBe(201);
    expect((await a.call('DELETE', `/v1/entries/${e.body.id}`, undefined, writer)).status).toBe(403);
  });
});
