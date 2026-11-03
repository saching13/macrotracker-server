import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SYNC_SCHEMA, type SyncPullResponse } from '@macrotracker/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sampleRow } from '../fixtures/sync-rows.js';
import { bearer, createUser, session, testApp } from './helpers.js';

/** An agent's view: the real MCP client over HTTP, against a listening server. */
async function listening(overrides: Record<string, string> = {}) {
  const app = await testApp(overrides);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as { port: number };
  return { app, url: new URL(`http://127.0.0.1:${port}/mcp`) };
}

let main: { app: FastifyInstance; url: URL };
let withDelete: { app: FastifyInstance; url: URL };
const clients: Client[] = [];
beforeAll(async () => {
  main = await listening();
  withDelete = await listening({ MCP_DESTROY_ENABLED: 'true' });
});
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
});

/** An account with a profile and a food (as a phone would upload), a phone session and a token minted for an agent. */
async function account(scopes: string[]) {
  const user = await createUser();
  const s = await session(main.app, user, 'Phone');
  const phone = bearer(s.access_token);
  await main.app.inject({
    method: 'POST',
    url: '/v1/sync/bootstrap',
    headers: phone,
    payload: {
      schema_version: SYNC_SCHEMA.max,
      rows: [
        { table: 'user_profile', row: sampleRow('user_profile') },
        {
          table: 'foods',
          row: sampleRow('foods', {
            id: 'oats',
            name: 'Overnight oats',
            serving_qty: 100,
            kcal_per_serving: 150,
          }),
        },
        {
          table: 'food_servings',
          row: sampleRow('food_servings', { food_id: 'oats', label: 'jar', base_amount: 250 }),
        },
      ],
    },
  });
  const t = await main.app.inject({
    method: 'POST',
    url: '/v1/tokens',
    headers: phone,
    payload: { name: 'agent', scopes },
  });
  expect(t.statusCode, t.body).toBe(201);
  const pull = async () =>
    (
      await main.app.inject({ url: '/v1/sync/pull?since=0&limit=1000', headers: phone })
    ).json<SyncPullResponse>();
  return { token: t.json<{ token: string }>().token, pull };
}

async function connect(token: string, target = main) {
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(target.url, {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  clients.push(client);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { type: string; text: string }[];
    };
    const text = res.content[0]?.text ?? '';
    return { isError: res.isError === true, text, json: () => JSON.parse(text) as Record<string, unknown> };
  };
  return { client, call };
}

const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name).sort();

describe('MCP', () => {
  it('lists only the tools a token can use', async () => {
    const reader = await connect((await account(['mcp:read'])).token);
    const tools = await names(reader.client);
    expect(tools).toContain('get_status');
    expect(tools).not.toContain('log_food');

    const writer = await connect((await account(['mcp:read', 'mcp:write', 'mcp:destroy'])).token);
    const writeTools = await names(writer.client);
    expect(writeTools).toEqual(
      expect.arrayContaining(['log_food', 'quick_add', 'update_entry', 'log_weight']),
    );
    // Deleting is off on this server even for a token that may.
    expect(writeTools).not.toContain('delete_entry');

    const info = writer.client.getServerVersion();
    expect(info?.name).toBe('macrotracker');
    expect(writer.client.getInstructions()).toContain('search_foods');
  });

  it('logs a found food in a named serving, and the phone pulls it', async () => {
    const a = await account(['mcp:read', 'mcp:write']);
    const { call } = await connect(a.token);
    const found = (await call('search_foods', { query: 'overnight oats' })).json() as {
      foods: { id: string }[];
    };
    expect(found.foods[0]!.id).toBe('oats');

    const logged = await call('log_food', {
      food_id: 'oats',
      serving: 'Jar',
      servings: 2,
      date: '2026-11-02',
      time: '07:45',
    });
    expect(logged.isError, logged.text).toBe(false);
    expect(logged.json()).toMatchObject({
      name: 'Overnight oats',
      quantity: 500,
      serving_label: 'jar',
      serving_amount: 2,
      kcal: 750,
      meal: 'breakfast',
    });

    const day = (await call('get_day', { date: '2026-11-02' })).json() as { totals: { kcal: number } };
    expect(day.totals.kcal).toBe(750);
    const pulled = await a.pull();
    expect(pulled.changes.some((c) => c.table === 'log_entries' && c.row?.food_id === 'oats')).toBe(true);
  });

  it('quick adds, weighs in, totals a range', async () => {
    const a = await account(['mcp:read', 'mcp:write']);
    const { call } = await connect(a.token);
    expect((await call('quick_add', { kcal: 320, protein_g: 20, date: '2026-11-01' })).isError).toBe(false);
    const w = (await call('log_weight', { weight: 160, unit: 'lb', date: '2026-11-01' })).json();
    expect(w.weight_kg).toBeCloseTo(72.57, 2);
    const totals = (await call('daily_totals', { from: '2026-10-25', to: '2026-11-01' })).json() as {
      days: { date: string; kcal: number }[];
    };
    expect(totals.days).toEqual([expect.objectContaining({ date: '2026-11-01', kcal: 320 })]);
    expect((await call('daily_totals', { from: '2026-01-01', to: '2026-12-31' })).isError).toBe(true);
    expect(
      (await call('log_body_metric', { metric: 'waist', value: 81.5, date: '2026-11-01' })).isError,
    ).toBe(false);
  });

  it('changes need confirm: true; mistakes come back as tool errors', async () => {
    const a = await account(['mcp:read', 'mcp:write']);
    const { call } = await connect(a.token);
    const e = (await call('quick_add', { kcal: 100, date: '2026-11-01' })).json() as { id: string };
    const unconfirmed = await call('update_entry', { entry_id: e.id, kcal: 150 });
    expect(unconfirmed.isError).toBe(true);
    const changed = await call('update_entry', { entry_id: e.id, kcal: 150, confirm: true });
    expect(changed.json()).toMatchObject({ kcal: 150 });

    const missing = await call('log_food', { food_id: 'nope', quantity: 10 });
    expect(missing).toMatchObject({ isError: true });
    expect(missing.text).toContain('food_not_found');
    const noServing = await call('log_food', { food_id: 'oats', serving: 'bowl' });
    expect(noServing.text).toContain('jar');
  });

  it('deletes only where the server allows it, with confirmation', async () => {
    const a = await account(['mcp:read', 'mcp:write', 'mcp:destroy']);
    const { call, client } = await connect(a.token, withDelete);
    expect(await names(client)).toContain('delete_entry');
    const e = (await call('quick_add', { kcal: 100, date: '2026-11-01' })).json() as { id: string };
    expect((await call('delete_entry', { entry_id: e.id })).isError).toBe(true);
    expect((await call('delete_entry', { entry_id: e.id, confirm: true })).json()).toEqual({ deleted: e.id });
    const day = (await call('get_day', { date: '2026-11-01' })).json() as { entries: unknown[] };
    expect(day.entries).toEqual([]);
  });

  it('turns away calls without a token, and is off when disabled', async () => {
    const res = await main.app.inject({ method: 'POST', url: '/mcp', payload: {} });
    expect(res.statusCode).toBe(401);
    expect((await main.app.inject({ method: 'GET', url: '/mcp' })).statusCode).toBe(405);
    const off = await testApp({ MCP_ENABLED: 'false' });
    expect((await off.inject({ method: 'POST', url: '/mcp', payload: {} })).statusCode).toBe(404);
  });
});
