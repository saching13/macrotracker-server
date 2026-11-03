import { randomUUID } from 'node:crypto';
import {
  SYNC_SCHEMA,
  SYNCED_META_KEYS,
  syncKeyColumn,
  syncRowSchemas,
  USER_FOOD_SOURCES,
  type SyncBootstrapBody,
  type SyncBootstrapResponse,
  type SyncChange,
  type SyncPullResponse,
  type SyncPushBody,
  type SyncPushResponse,
  type SyncResult,
  type SyncRowState,
  type SyncStatus,
  type SyncTable,
} from '@macrotracker/shared';
import { and, asc, eq, getTableColumns, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { z } from 'zod';
import { withContext, type Db, type Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { AppError, conflict } from '../errors.js';

/** How long change ids are remembered for deduplicating retried pushes. */
const RECEIPT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const SYNC_PROPS = new Set(['userId', 'rev', 'changedAt', 'deletedAt', 'updatedByDevice', 'schemaVersion']);

interface Spec {
  name: SyncTable;
  table: PgTable;
  cols: {
    userId: PgColumn;
    key: PgColumn;
    rev: PgColumn;
    changedAt: PgColumn;
    deletedAt: PgColumn;
  };
  keyColumn: 'id' | 'key';
  /** Wire (SQL) column name → Drizzle property, data columns only. */
  props: [wire: string, prop: string][];
}

function spec(name: SyncTable, table: PgTable): Spec {
  const all = getTableColumns(table) as Record<string, PgColumn>;
  const keyColumn = syncKeyColumn(name);
  const col = (prop: string) => {
    const c = all[prop];
    if (!c) throw new Error(`${name} has no column ${prop}`);
    return c;
  };
  return {
    name,
    table,
    cols: {
      userId: col('userId'),
      key: col(keyColumn),
      rev: col('rev'),
      changedAt: col('changedAt'),
      deletedAt: col('deletedAt'),
    },
    keyColumn,
    props: Object.entries(all)
      .filter(([prop]) => !SYNC_PROPS.has(prop))
      .map(([prop, c]) => [c.name, prop]),
  };
}

const SPECS: Record<SyncTable, Spec> = {
  user_profile: spec('user_profile', s.userProfile),
  weight_entries: spec('weight_entries', s.weightEntries),
  body_metric_entries: spec('body_metric_entries', s.bodyMetricEntries),
  foods: spec('foods', s.foods),
  food_servings: spec('food_servings', s.foodServings),
  recipes: spec('recipes', s.recipes),
  recipe_items: spec('recipe_items', s.recipeItems),
  log_entries: spec('log_entries', s.logEntries),
  programs: spec('programs', s.programs),
  goals: spec('goals', s.goals),
  targets: spec('targets', s.targets),
  app_meta: spec('app_meta', s.userMeta),
};
const ALL_SPECS = Object.values(SPECS);

type DbRow = Record<string, unknown>;

export interface SyncActor {
  userId: string;
  /** The signed-in device; null for writes from the web app or agents. */
  deviceId: string | null;
}

/** A row the server won't store; reported per change instead of failing the push. */
export class Rejection extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function checkSchemaVersion(version: number): void {
  if (version < SYNC_SCHEMA.min) {
    throw conflict('app_update_required', `Update the app to sync (schema ${version} < ${SYNC_SCHEMA.min})`);
  }
  if (version > SYNC_SCHEMA.max) {
    throw conflict(
      'server_update_required',
      `This server is older than the app (schema ${version} > ${SYNC_SCHEMA.max}); update the server`,
    );
  }
}

/**
 * Validates an incoming row for `table`, returning its Drizzle values (data
 * columns only, and only those present, so columns an older app doesn't know
 * keep their stored values).
 */
function parseRow(sp: Spec, raw: unknown, expectedKey?: string): { key: string; values: DbRow } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Rejection('invalid_row', 'row must be an object');
  }
  const input = raw as Record<string, unknown>;
  if (sp.name === 'app_meta' && !(SYNCED_META_KEYS as readonly unknown[]).includes(input.key)) {
    throw new Rejection('meta_key_not_synced', `app_meta key ${String(input.key)} stays on the device`);
  }
  if (
    sp.name === 'foods' &&
    typeof input.source === 'string' &&
    !(USER_FOOD_SOURCES as readonly string[]).includes(input.source)
  ) {
    throw new Rejection('reference_food', `${input.source} foods ship with the app and aren't synced`);
  }
  const schema = syncRowSchemas[sp.name] as z.ZodObject;
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Rejection('invalid_row', `${issue.path.join('.') || 'row'}: ${issue.message}`);
  }
  const data = parsed.data as Record<string, unknown>;
  const key = String(data[sp.keyColumn]);
  if (expectedKey !== undefined && key !== expectedKey) {
    throw new Rejection('id_mismatch', `row ${sp.keyColumn} does not match the change id`);
  }
  const values: DbRow = {};
  for (const [wire, prop] of sp.props) {
    if (wire in data) values[prop] = data[wire];
  }
  return { key, values };
}

/** Validates a row as push and bootstrap do; throws a Rejection. */
export const validateRow = (table: SyncTable, raw: unknown) => parseRow(SPECS[table], raw);

/** A synced table's Drizzle row in wire form (the app's column names). */
export function wireRow(table: SyncTable, row: Record<string, unknown>): Record<string, unknown> {
  const wire: Record<string, unknown> = {};
  for (const [name, prop] of SPECS[table].props) wire[name] = row[prop];
  return wire;
}

/** A write made on the server (web app, agents), in wire form. */
export interface ServerWrite {
  table: SyncTable;
  id: string;
  op: 'insert' | 'update' | 'delete';
  row?: Record<string, unknown>;
}

function toState(sp: Spec, row: DbRow): SyncRowState {
  const deleted = row.deletedAt != null;
  const state: SyncRowState = {
    table: sp.name,
    id: String(row[sp.keyColumn]),
    rev: Number(row.rev),
    changed_at: (row.changedAt as Date).toISOString(),
    deleted,
  };
  if (!deleted) {
    const wire: Record<string, unknown> = {};
    for (const [name, prop] of sp.props) wire[name] = row[prop];
    state.row = wire;
  }
  return state;
}

async function readState(tx: Tx, sp: Spec, userId: string, key: string): Promise<SyncRowState | null> {
  const [row] = await tx
    .select()
    .from(sp.table)
    .where(and(eq(sp.cols.userId, userId), eq(sp.cols.key, key)));
  return row ? toState(sp, row as DbRow) : null;
}

/**
 * Locks the account's counter for the rest of the transaction and returns
 * it. Holding the lock until commit is what keeps revs visible in order.
 */
async function lockCounter(tx: Tx, userId: string): Promise<number> {
  await tx.insert(s.syncState).values({ userId }).onConflictDoNothing();
  const [row] = await tx.select().from(s.syncState).where(eq(s.syncState.userId, userId)).for('update');
  return row!.rev;
}

async function readCounter(tx: Tx, userId: string): Promise<number> {
  const [row] = await tx.select().from(s.syncState).where(eq(s.syncState.userId, userId));
  return row?.rev ?? 0;
}

async function saveCounter(tx: Tx, userId: string, rev: number): Promise<void> {
  await tx.update(s.syncState).set({ rev }).where(eq(s.syncState.userId, userId));
}

/**
 * Moves a change's timestamp onto the server's clock: by the gap between the
 * app's clock and ours at push time, and never into the future.
 */
export function serverTime(changedAt: string, clientNow: string, now: Date): Date {
  const offset = now.getTime() - Date.parse(clientNow);
  return new Date(Math.min(Date.parse(changedAt) + offset, now.getTime()));
}

export class SyncService {
  constructor(
    private readonly db: Db,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async status(actor: SyncActor): Promise<SyncStatus> {
    return withContext(
      this.db,
      { userId: actor.userId },
      async (tx) => {
        const [info] = await tx.select().from(s.serverInfo);
        if (!info) throw new AppError(500, 'server_not_initialized', 'Server identity is missing');
        let empty = true;
        for (const sp of ALL_SPECS) {
          const live = await tx
            .select({ one: sql`1` })
            .from(sp.table)
            .where(and(eq(sp.cols.userId, actor.userId), isNull(sp.cols.deletedAt)))
            .limit(1);
          if (live.length > 0) {
            empty = false;
            break;
          }
        }
        return {
          account_id: actor.userId,
          server_id: info.serverId,
          rev: await readCounter(tx, actor.userId),
          empty,
          schema: { min: SYNC_SCHEMA.min, max: SYNC_SCHEMA.max },
          server_now: this.clock().toISOString(),
        };
      },
      { isolationLevel: 'repeatable read' },
    );
  }

  async push(actor: SyncActor, body: SyncPushBody): Promise<SyncPushResponse> {
    checkSchemaVersion(body.schema_version);
    const now = this.clock();
    return withContext(this.db, { userId: actor.userId }, async (tx) => {
      let rev = await lockCounter(tx, actor.userId);

      await tx
        .delete(s.syncReceipts)
        .where(
          and(
            eq(s.syncReceipts.userId, actor.userId),
            lt(s.syncReceipts.createdAt, new Date(now.getTime() - RECEIPT_TTL_MS)),
          ),
        );
      const ids = body.changes.map((c) => c.change_id);
      const seen = new Map(
        ids.length === 0
          ? []
          : (
              await tx
                .select()
                .from(s.syncReceipts)
                .where(and(eq(s.syncReceipts.userId, actor.userId), inArray(s.syncReceipts.changeId, ids)))
            ).map((r) => [r.changeId, r]),
      );

      const results: SyncResult[] = [];
      for (const change of body.changes) {
        const sp = SPECS[change.table];
        const earlier = seen.get(change.change_id);
        if (earlier) {
          results.push({
            change_id: change.change_id,
            result: earlier.result,
            duplicate: true,
            ...(earlier.rev == null ? {} : { rev: earlier.rev }),
            current: await readState(tx, sp, actor.userId, change.id),
          });
          continue;
        }

        const result = await this.applyChange(tx, sp, actor, change, body, now, () => ++rev);
        results.push(result);
        seen.set(change.change_id, {
          userId: actor.userId,
          changeId: change.change_id,
          result: result.result,
          rev: result.rev ?? null,
          createdAt: now,
        });
        await tx.insert(s.syncReceipts).values({
          userId: actor.userId,
          changeId: change.change_id,
          result: result.result,
          rev: result.rev ?? null,
        });
      }

      await saveCounter(tx, actor.userId, rev);
      return { results, rev, server_now: now.toISOString() };
    });
  }

  private async applyChange(
    tx: Tx,
    sp: Spec,
    actor: SyncActor,
    change: SyncChange,
    body: SyncPushBody,
    now: Date,
    nextRev: () => number,
  ): Promise<SyncResult> {
    const base = { change_id: change.change_id, duplicate: false };
    const changedAt = serverTime(change.changed_at, body.client_now, now);
    const stamp = {
      changedAt,
      updatedByDevice: actor.deviceId,
      schemaVersion: body.schema_version,
    };

    if (change.op === 'delete') {
      const rev = nextRev();
      const done = await tx
        .update(sp.table)
        .set({ ...stamp, rev, deletedAt: changedAt })
        .where(
          and(
            eq(sp.cols.userId, actor.userId),
            eq(sp.cols.key, change.id),
            isNull(sp.cols.deletedAt),
            sql`${sp.cols.changedAt} <= ${changedAt}`,
          ),
        )
        .returning({ rev: sp.cols.rev });
      if (done.length > 0) return { ...base, result: 'applied', rev };
      const current = await readState(tx, sp, actor.userId, change.id);
      // Never seen, or already deleted: either way the row is gone, as asked.
      if (!current || current.deleted) return { ...base, result: 'applied', current };
      return { ...base, result: 'stale', current };
    }

    if (!change.row) {
      return {
        ...base,
        result: 'rejected',
        error: { code: 'invalid_row', message: `${change.op} needs a row` },
      };
    }
    let parsed: { key: string; values: DbRow };
    try {
      parsed = parseRow(sp, change.row, change.id);
    } catch (err) {
      if (!(err instanceof Rejection)) throw err;
      return { ...base, result: 'rejected', error: { code: err.code, message: err.message } };
    }

    const rev = nextRev();
    // An update never brings back a deleted row; only an insert (the app
    // re-creating it) does. Either way the newer timestamp wins, and on a tie
    // the later arrival.
    const mayReplace =
      change.op === 'insert'
        ? sql`${sp.cols.changedAt} <= excluded.changed_at`
        : sql`${sp.cols.deletedAt} is null and ${sp.cols.changedAt} <= excluded.changed_at`;
    const done = await tx
      .insert(sp.table)
      .values({ ...parsed.values, ...stamp, userId: actor.userId, rev, deletedAt: null })
      .onConflictDoUpdate({
        target: [sp.cols.userId, sp.cols.key],
        set: { ...parsed.values, ...stamp, rev, deletedAt: null },
        setWhere: mayReplace,
      })
      .returning({ rev: sp.cols.rev });
    if (done.length > 0) return { ...base, result: 'applied', rev };
    return { ...base, result: 'stale', current: await readState(tx, sp, actor.userId, change.id) };
  }

  /**
   * Current state of every row changed after `since`, oldest first. One
   * repeatable-read snapshot covers all tables, so a page never mixes before
   * and after a concurrent push.
   */
  /**
   * Writes made on the server (web app, agents): stamped with the server's
   * clock and applied exactly like a phone's push, so every synced write
   * takes the account's next rev and reaches the phones on their next pull.
   * Throws 422 if the server would refuse a row.
   */
  async write(actor: SyncActor, writes: ServerWrite[]): Promise<number> {
    if (writes.length === 0) return 0;
    const now = this.clock().toISOString();
    const res = await this.push(actor, {
      schema_version: SYNC_SCHEMA.max,
      client_now: now,
      changes: writes.map((w) => ({
        change_id: randomUUID(),
        table: w.table,
        id: w.id,
        op: w.op,
        changed_at: now,
        ...(w.row ? { row: w.row } : {}),
      })),
    });
    const refused = res.results.find((r) => r.result === 'rejected');
    if (refused) {
      throw new AppError(422, refused.error?.code ?? 'invalid_row', refused.error?.message ?? 'Invalid data');
    }
    return res.rev;
  }

  async pull(actor: SyncActor, since: number, limit: number): Promise<SyncPullResponse> {
    const now = this.clock();
    return withContext(
      this.db,
      { userId: actor.userId },
      async (tx) => {
        const rev = await readCounter(tx, actor.userId);
        if (since > rev) {
          throw conflict(
            'cursor_ahead',
            'This server is behind the app (restored from a backup?); sync again from the start',
          );
        }
        const all: SyncRowState[] = [];
        for (const sp of ALL_SPECS) {
          const rows = await tx
            .select()
            .from(sp.table)
            .where(and(eq(sp.cols.userId, actor.userId), gt(sp.cols.rev, since)))
            .orderBy(asc(sp.cols.rev))
            .limit(limit + 1);
          all.push(...rows.map((r) => toState(sp, r as DbRow)));
        }
        all.sort((a, b) => a.rev - b.rev);
        const changes = all.slice(0, limit);
        return {
          changes,
          next: changes.at(-1)?.rev ?? since,
          has_more: all.length > limit,
          server_now: now.toISOString(),
        };
      },
      { isolationLevel: 'repeatable read' },
    );
  }

  /**
   * First upload from an app connecting to this account: adds the rows the
   * server doesn't have and keeps the server's version of the rest (including
   * rows it has deleted). The app then pulls to pick up everything else.
   */
  async bootstrap(actor: SyncActor, body: SyncBootstrapBody): Promise<SyncBootstrapResponse> {
    checkSchemaVersion(body.schema_version);
    const now = this.clock();
    return withContext(this.db, { userId: actor.userId }, async (tx) => {
      let rev = await lockCounter(tx, actor.userId);
      let inserted = 0;
      let skipped = 0;
      const rejected: SyncBootstrapResponse['rejected'] = [];
      for (const [index, item] of body.rows.entries()) {
        const sp = SPECS[item.table];
        let parsed: { key: string; values: DbRow };
        try {
          parsed = parseRow(sp, item.row);
        } catch (err) {
          if (!(err instanceof Rejection)) throw err;
          rejected.push({ index, code: err.code, message: err.message });
          continue;
        }
        const added = await tx
          .insert(sp.table)
          .values({
            ...parsed.values,
            userId: actor.userId,
            rev: rev + 1,
            changedAt: now,
            deletedAt: null,
            updatedByDevice: actor.deviceId,
            schemaVersion: body.schema_version,
          })
          .onConflictDoNothing()
          .returning({ rev: sp.cols.rev });
        if (added.length > 0) {
          rev += 1;
          inserted += 1;
        } else {
          skipped += 1;
        }
      }
      await saveCounter(tx, actor.userId, rev);
      return { inserted, skipped, rejected, rev, server_now: now.toISOString() };
    });
  }
}
