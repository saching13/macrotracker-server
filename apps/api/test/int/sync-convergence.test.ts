import { randomUUID } from 'node:crypto';
import {
  SYNC_SCHEMA,
  type SyncChange,
  type SyncPullResponse,
  type SyncPushResponse,
  type SyncRowState,
  type SyncTable,
} from '@macrotracker/shared';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { sampleRow } from '../fixtures/sync-rows.js';
import { bearer, createUser, session, testApp } from './helpers.js';

/*
 * Property-style check of the sync protocol: devices on one account make
 * random edits (some to the same rows), and push and pull in random order with
 * skewed clocks. Once everyone has synced, every device must hold exactly the
 * server's rows, and no row that nobody deleted may be missing.
 *
 * Replica models the client the app will implement (plan-11 S4): an outbox of
 * pending changes, pulls that never overwrite a row with a pending change, and
 * applying the `current` row the server returns for stale or replayed changes.
 */

let app: FastifyInstance;
/** Across all seeds, so the run proves it hit the interesting cases. */
const seen = { stale: 0, duplicate: 0, skippedPending: 0, undo: 0 };
beforeAll(async () => {
  app = await testApp();
});

/** Small seeded PRNG (mulberry32) so a failing seed can be replayed. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
  };
}

type Row = Record<string, unknown>;
const k = (table: SyncTable, id: string) => `${table}/${id}`;

class Replica {
  rows = new Map<string, { table: SyncTable; id: string; row: Row }>();
  /** Recently deleted rows, so an undo can re-create them. */
  trash = new Map<string, { table: SyncTable; id: string; row: Row }>();
  outbox: SyncChange[] = [];
  cursor = 0;

  constructor(
    readonly name: string,
    private readonly headers: Record<string, string>,
    /** This phone's clock error (ms), after its offset correction. */
    private readonly skew: number,
  ) {}

  private now = () => new Date(Date.now() + this.skew).toISOString();

  private record(table: SyncTable, id: string, op: SyncChange['op'], row?: Row) {
    this.outbox.push({
      change_id: randomUUID(),
      table,
      id,
      op,
      changed_at: this.now(),
      ...(row ? { row } : {}),
    });
  }

  insert(table: SyncTable, row: Row) {
    const id = String(table === 'app_meta' ? row.key : row.id);
    const op = this.rows.has(k(table, id)) ? 'update' : 'insert';
    this.rows.set(k(table, id), { table, id, row });
    this.trash.delete(k(table, id));
    this.record(table, id, op, row);
  }

  update(key: string, patch: Row) {
    const r = this.rows.get(key)!;
    r.row = { ...r.row, ...patch };
    this.record(r.table, r.id, 'update', r.row);
  }

  delete(key: string) {
    const r = this.rows.get(key)!;
    this.rows.delete(key);
    this.trash.set(key, r);
    this.record(r.table, r.id, 'delete');
  }

  private pending(table: SyncTable, id: string) {
    return this.outbox.some((c) => c.table === table && c.id === id);
  }

  private apply(state: SyncRowState) {
    if (this.pending(state.table, state.id)) {
      seen.skippedPending++;
      return;
    }
    const key = k(state.table, state.id);
    if (state.deleted) this.rows.delete(key);
    else this.rows.set(key, { table: state.table, id: state.id, row: state.row! });
  }

  lastBatch: SyncChange[] | null = null;

  async push(retry?: SyncChange[]) {
    if (!retry && this.outbox.length === 0) return;
    const batch = retry ?? this.outbox.slice(0, 50);
    this.lastBatch = batch;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sync/push',
      headers: this.headers,
      payload: { schema_version: SYNC_SCHEMA.max, client_now: this.now(), changes: batch },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<SyncPushResponse>();
    const sent = new Set(batch.map((c) => c.change_id));
    this.outbox = this.outbox.filter((c) => !sent.has(c.change_id));
    for (const r of body.results) {
      expect(r.result, JSON.stringify(r)).not.toBe('rejected');
      if (r.result === 'stale') seen.stale++;
      if (r.duplicate) seen.duplicate++;
      if (r.current) this.apply(r.current);
    }
  }

  async pull() {
    for (;;) {
      const res = await app.inject({
        url: `/v1/sync/pull?since=${this.cursor}&limit=20`,
        headers: this.headers,
      });
      expect(res.statusCode, res.body).toBe(200);
      const page = res.json<SyncPullResponse>();
      page.changes.forEach((c) => this.apply(c));
      this.cursor = page.next;
      if (!page.has_more) return;
    }
  }

  snapshot() {
    return Object.fromEntries(
      [...this.rows.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, r]) => [key, r.row]),
    );
  }
}

async function run(seed: number, steps: number) {
  const r = rng(seed);
  const user = await createUser();
  const replicas = await Promise.all(
    ['phone', 'tablet', 'old phone'].map(async (name, i) => {
      const s = await session(app, user, name);
      // Clocks within a few seconds of each other after offset correction.
      return new Replica(name, bearer(s.access_token), (i - 1) * r.int(3000));
    }),
  );
  const created = new Set<string>();
  const everDeleted = new Set<string>();

  for (let step = 0; step < steps; step++) {
    const d = r.pick(replicas);
    const keys = [...d.rows.keys()];
    const roll = r.next();
    if (roll < 0.2 || keys.length === 0) {
      const table = r.pick(['log_entries', 'weight_entries', 'foods'] as const);
      const row = sampleRow(table);
      created.add(k(table, String(row.id)));
      d.insert(table, row);
    } else if (roll < 0.3) {
      // A per-person setting every device edits: frequent conflicts.
      d.insert('app_meta', {
        key: r.pick(['partial_days', 'food_regions'] as const),
        value: `${d.name}#${step}`,
      });
    } else if (roll < 0.5) {
      d.update(r.pick(keys), { created_at: new Date(Date.now() - step).toISOString() });
    } else if (roll < 0.58) {
      const key = r.pick(keys);
      if (!key.startsWith('app_meta/')) {
        everDeleted.add(key);
        d.delete(key);
      }
    } else if (roll < 0.62 && d.trash.size > 0) {
      const [, gone] = r.pick([...d.trash.entries()]);
      seen.undo++;
      d.insert(gone.table, gone.row);
    } else if (roll < 0.8) {
      await d.push();
    } else if (roll < 0.82 && d.lastBatch) {
      // The reply was lost: the same changes go again.
      await d.push(d.lastBatch);
    } else {
      await d.pull();
    }
  }

  // Everyone syncs until their outboxes are empty, then catches up.
  for (const d of replicas) while (d.outbox.length) await d.push();
  for (const d of replicas) await d.pull();

  const observer = new Replica('observer', bearer((await session(app, user, 'observer')).access_token), 0);
  await observer.pull();
  const server = observer.snapshot();
  for (const d of replicas) expect(d.snapshot(), `${d.name} (seed ${seed})`).toStrictEqual(server);

  // No silent wipes: every row that nobody deleted is still there.
  for (const key of created) {
    if (!everDeleted.has(key)) expect(server, `${key} (seed ${seed})`).toHaveProperty([key]);
  }
  return Object.keys(server).length;
}

describe('sync convergence', () => {
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
  it.each(seeds)(
    'devices converge (seed %i)',
    async (seed) => {
      expect(await run(seed, 120)).toBeGreaterThan(0);
    },
    60_000,
  );

  it('exercised conflicts, retries and undo', () => {
    expect(seen.stale).toBeGreaterThan(0);
    expect(seen.duplicate).toBeGreaterThan(0);
    expect(seen.skippedPending).toBeGreaterThan(0);
    expect(seen.undo).toBeGreaterThan(0);
  });
});
