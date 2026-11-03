import { SYNC_SCHEMA, type SharedRecipe, type SyncPullResponse } from '@macrotracker/shared';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { sampleRow } from '../fixtures/sync-rows.js';
import { bearer, createUser, owner, session, testApp } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => {
  app = await testApp();
});

/** USDA SR Legacy "Bananas, raw" (the app's uuid v5 of usda:fdc:173944). */
async function bananaId(): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "select id from app.reference_foods where name = 'Bananas, raw' limit 1",
  );
  return rows[0]!.id;
}

/** An account whose phone synced a recipe: one own food plus one USDA food. */
async function cook(role: 'member' | 'admin' = 'member') {
  const user = await createUser(role);
  const h = bearer((await session(app, user)).access_token);
  const call = async <T>(
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
  ) => {
    const r = await app.inject({ method, url, headers: h, ...(payload ? { payload } : {}) });
    return { status: r.statusCode, body: (r.body ? r.json() : undefined) as T };
  };
  const banana = await bananaId();
  const rows = [
    { table: 'foods', row: sampleRow('foods', { id: 'oats', name: 'Rolled oats', brand: 'Home' }) },
    {
      table: 'recipes',
      row: sampleRow('recipes', { id: 'porridge', name: 'Banana porridge', servings: 2, total_kcal: 500 }),
    },
    {
      table: 'recipe_items',
      row: sampleRow('recipe_items', {
        id: 'porridge_oats',
        recipe_id: 'porridge',
        food_id: 'oats',
        quantity: 80,
      }),
    },
    {
      table: 'recipe_items',
      row: sampleRow('recipe_items', {
        id: `porridge_${banana}`,
        recipe_id: 'porridge',
        food_id: banana,
        quantity: 120,
      }),
    },
  ];
  const r = await call('POST', '/v1/sync/bootstrap', { schema_version: SYNC_SCHEMA.max, rows });
  expect(r.status).toBe(200);
  const pull = async () => (await call<SyncPullResponse>('GET', '/v1/sync/pull?since=0&limit=1000')).body;
  return { user, call, pull, banana };
}

describe('shared recipe library', () => {
  it('one account shares, another browses and copies; the copy syncs to their phone', async () => {
    const alice = await cook();
    const bob = await cook();

    const shared = await alice.call<SharedRecipe>('POST', '/v1/library', { recipe_id: 'porridge' });
    expect(shared.status, JSON.stringify(shared.body)).toBe(200);
    expect(shared.body).toMatchObject({
      name: 'Banana porridge',
      servings: 2,
      total_kcal: 500,
      mine: true,
      version: 1,
    });
    expect(shared.body.shared_by).toBe(alice.user.email.split('@')[0]);
    expect(shared.body.ingredients.map((i) => [i.name, i.food.reference])).toEqual(
      expect.arrayContaining([
        ['Rolled oats', false],
        ['Bananas, raw', true],
      ]),
    );

    const found = await bob.call<{ recipes: SharedRecipe[] }>('GET', '/v1/library?q=banana%20porridge');
    const mine = found.body.recipes.find((r) => r.id === shared.body.id)!;
    expect(mine).toMatchObject({ mine: false, added_as: null });

    const copied = await bob.call<{ recipe_id: string; foods_created: number }>(
      'POST',
      `/v1/library/${shared.body.id}/copy`,
    );
    expect(copied.status, JSON.stringify(copied.body)).toBe(200);
    expect(copied.body.foods_created).toBe(1); // the USDA banana is reused

    const changes = (await bob.pull()).changes;
    const recipe = changes.find((c) => c.table === 'recipes' && c.id === copied.body.recipe_id)!;
    expect(recipe.row).toMatchObject({ name: 'Banana porridge', servings: 2, total_kcal: 500 });
    const items = changes.filter(
      (c) => c.table === 'recipe_items' && c.row?.recipe_id === copied.body.recipe_id,
    );
    expect(items.map((i) => i.row?.food_id)).toContain(bob.banana);
    const oats = changes.find(
      (c) => c.table === 'foods' && c.row?.name === 'Rolled oats' && c.id !== 'oats',
    )!;
    expect(oats.row).toMatchObject({ source: 'import', brand: 'Home' });

    // Adding it again returns the same copy; it shows as added.
    const again = await bob.call<{ recipe_id: string }>('POST', `/v1/library/${shared.body.id}/copy`);
    expect(again.body.recipe_id).toBe(copied.body.recipe_id);
    const detail = await bob.call<SharedRecipe>('GET', `/v1/library/${shared.body.id}`);
    expect(detail.body.added_as).toBe(copied.body.recipe_id);
    // Bob can log it.
    const logged = await bob.call<{ kcal: number }>('POST', '/v1/entries', {
      date: '2026-11-02',
      recipe_id: copied.body.recipe_id,
      quantity: 1,
    });
    expect(logged.body.kcal).toBe(250);
  });

  it('republishing updates the shared copy; earlier copies keep theirs', async () => {
    const alice = await cook();
    const bob = await cook();
    const first = (await alice.call<SharedRecipe>('POST', '/v1/library', { recipe_id: 'porridge' })).body;
    const copy = (await bob.call<{ recipe_id: string }>('POST', `/v1/library/${first.id}/copy`)).body;
    // Alice's phone renames the recipe, then she shares it again.
    await alice.call('POST', '/v1/sync/push', {
      schema_version: SYNC_SCHEMA.max,
      client_now: new Date().toISOString(),
      changes: [
        {
          change_id: crypto.randomUUID(),
          table: 'recipes',
          id: 'porridge',
          op: 'update',
          changed_at: new Date().toISOString(),
          row: sampleRow('recipes', {
            id: 'porridge',
            name: 'Better porridge',
            servings: 2,
            total_kcal: 520,
          }),
        },
      ],
    });
    const second = (await alice.call<SharedRecipe>('POST', '/v1/library', { recipe_id: 'porridge' })).body;
    expect(second).toMatchObject({ id: first.id, name: 'Better porridge', version: 2 });
    // Bob's copy is unchanged; adding the new version makes a new copy.
    const bobRecipes = await bob.call<{ recipes: { id: string; name: string }[] }>('GET', '/v1/recipes');
    expect(bobRecipes.body.recipes.find((r) => r.id === copy.recipe_id)?.name).toBe('Banana porridge');
    const newer = (await bob.call<{ recipe_id: string }>('POST', `/v1/library/${first.id}/copy`)).body;
    expect(newer.recipe_id).not.toBe(copy.recipe_id);
  });

  it('refuses recipes with ingredients the server lacks (INDB foods never sync)', async () => {
    const alice = await cook();
    await alice.call('POST', '/v1/sync/push', {
      schema_version: SYNC_SCHEMA.max,
      client_now: new Date().toISOString(),
      changes: [
        {
          change_id: crypto.randomUUID(),
          table: 'recipe_items',
          id: 'porridge_indb',
          op: 'insert',
          changed_at: new Date().toISOString(),
          // An INDB food's id: the phone has it, the server never does.
          row: sampleRow('recipe_items', {
            id: 'porridge_indb',
            recipe_id: 'porridge',
            food_id: 'b6fb7c94-7577-5c44-92de-43b355f97588',
            quantity: 200,
          }),
        },
      ],
    });
    const res = await alice.call<{ error: { code: string; message: string } }>('POST', '/v1/library', {
      recipe_id: 'porridge',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('not_shareable');
    expect(res.body.error.message).toContain('INDB');
    expect(
      (await alice.call<{ recipes: SharedRecipe[] }>('GET', '/v1/library')).body.recipes.some((r) => r.mine),
    ).toBe(false);
  });

  it('only the owner (or an admin) removes a recipe; you can’t copy your own', async () => {
    const alice = await cook();
    const bob = await cook();
    const admin = await cook('admin');
    const a = (await alice.call<SharedRecipe>('POST', '/v1/library', { recipe_id: 'porridge' })).body;
    expect((await alice.call('POST', `/v1/library/${a.id}/copy`)).status).toBe(409);
    expect((await bob.call('DELETE', `/v1/library/${a.id}`)).status).toBe(404);
    expect((await alice.call('DELETE', `/v1/library/${a.id}`)).status).toBe(204);

    const b = (await bob.call<SharedRecipe>('POST', '/v1/library', { recipe_id: 'porridge' })).body;
    expect((await admin.call('DELETE', `/v1/library/${b.id}`)).status).toBe(204);
    expect((await bob.call('GET', `/v1/library/${b.id}`)).status).toBe(404);
  });

  it('row-level security keeps writes to the owner', async () => {
    const alice = await cook();
    const bob = await cook();
    const a = (await alice.call<SharedRecipe>('POST', '/v1/library', { recipe_id: 'porridge' })).body;
    const api = new (await import('pg')).default.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 1,
    });
    try {
      const client = await api.connect();
      await client.query('begin');
      await client.query("select set_config('app.user_id', $1, true)", [bob.user.id]);
      const upd = await client.query("update app.shared_recipes set name = 'hacked' where id = $1", [a.id]);
      expect(upd.rowCount).toBe(0);
      const del = await client.query('delete from app.shared_recipes where id = $1', [a.id]);
      expect(del.rowCount).toBe(0);
      const seen = await client.query('select count(*)::int as n from app.shared_recipes where id = $1', [
        a.id,
      ]);
      expect(seen.rows[0].n).toBe(1);
      await client.query('rollback');
      client.release();
    } finally {
      await api.end();
    }
  });
});
