import { z } from 'zod';
import { syncTable } from '../sync/rows.js';

/**
 * Offline-first, per-row sync (plan-11 › Sync protocol).
 *
 * - Every accepted write gets the account's next `rev`; pulling `since` a rev
 *   returns the current state of every row changed after it, in rev order.
 * - Conflicts are last-write-wins on `changed_at`, on the server's clock: each
 *   reply carries `server_now`, the app stamps edits with its offset-corrected
 *   time, and the server shifts a push's stamps by any remaining difference
 *   between `client_now` and its own clock.
 * - Deletes are explicit tombstones and win over later edits. Only an `insert`
 *   (the app re-creating the row, e.g. undo) brings a deleted row back.
 */

export const SYNC_PUSH_MAX = 500;
export const SYNC_PULL_MAX = 1000;
export const SYNC_BOOTSTRAP_MAX = 1000;

const rowId = z.string().min(1).max(128);
const row = z.record(z.string(), z.unknown()).meta({
  description: 'The row as the app stores it (snake_case columns); see packages/shared/src/sync/rows.ts.',
});

export const syncOp = z.enum(['insert', 'update', 'delete']);

export const syncChange = z.object({
  /** Client-generated; replaying a change is harmless. */
  change_id: z.uuid(),
  table: syncTable,
  id: rowId,
  op: syncOp,
  changed_at: z.iso.datetime({ offset: true }),
  /** Required for insert and update; ignored for delete. */
  row: row.optional(),
});
export type SyncChange = z.infer<typeof syncChange>;

export const syncPushBody = z.object({
  /** The app's Drift schema version. */
  schema_version: z.number().int(),
  /** The app's clock when it sent this push. */
  client_now: z.iso.datetime({ offset: true }),
  changes: z.array(syncChange).max(SYNC_PUSH_MAX),
});
export type SyncPushBody = z.infer<typeof syncPushBody>;

/** A row's state on the server: its data, or a tombstone. */
export const syncRowState = z
  .object({
    table: syncTable,
    id: rowId,
    rev: z.number().int(),
    changed_at: z.string(),
    deleted: z.boolean(),
    /** Absent for tombstones. */
    row: row.optional(),
  })
  .meta({ id: 'SyncRowState' });
export type SyncRowState = z.infer<typeof syncRowState>;

export const syncResultKind = z.enum([
  /** The write is now the row's current version. */
  'applied',
  /** The server already has a newer version, or the row was deleted; see `current`. */
  'stale',
  /** Invalid; `error` says why. Retrying the same change won't help. */
  'rejected',
]);

export const syncResult = z
  .object({
    change_id: z.uuid(),
    result: syncResultKind,
    /** This change was already received earlier; `result` is from then. */
    duplicate: z.boolean(),
    rev: z.number().int().optional(),
    /**
     * The row's current server state when it may differ from what the app
     * holds (stale or duplicate). The app applies it unless it has a newer
     * pending local change to the row.
     */
    current: syncRowState.nullable().optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  })
  .meta({ id: 'SyncResult' });
export type SyncResult = z.infer<typeof syncResult>;

export const syncPushResponse = z
  .object({
    results: z.array(syncResult),
    rev: z.number().int(),
    server_now: z.string(),
  })
  .meta({ id: 'SyncPushResponse' });
export type SyncPushResponse = z.infer<typeof syncPushResponse>;

export const syncPullQuery = z.object({
  since: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(SYNC_PULL_MAX).default(500),
});

export const syncPullResponse = z
  .object({
    changes: z.array(syncRowState),
    /** Pass as `since` for the next page (or the next sync). */
    next: z.number().int(),
    has_more: z.boolean(),
    server_now: z.string(),
  })
  .meta({ id: 'SyncPullResponse' });
export type SyncPullResponse = z.infer<typeof syncPullResponse>;

export const syncBootstrapBody = z.object({
  schema_version: z.number().int(),
  rows: z
    .array(z.object({ table: syncTable, row }))
    .min(1)
    .max(SYNC_BOOTSTRAP_MAX),
});
export type SyncBootstrapBody = z.infer<typeof syncBootstrapBody>;

export const syncBootstrapResponse = z
  .object({
    /** Rows the server didn't have. */
    inserted: z.number().int(),
    /** Rows the server already had (its version stays) or had deleted. */
    skipped: z.number().int(),
    rejected: z.array(z.object({ index: z.number().int(), code: z.string(), message: z.string() })),
    rev: z.number().int(),
    server_now: z.string(),
  })
  .meta({ id: 'SyncBootstrapResponse' });
export type SyncBootstrapResponse = z.infer<typeof syncBootstrapResponse>;

export const syncStatus = z
  .object({
    /** The account the data belongs to; the app tags its local copy with it. */
    account_id: z.uuid(),
    /** Stable per server; changes only if the server is rebuilt from scratch. */
    server_id: z.uuid(),
    rev: z.number().int(),
    /** No live rows yet: a connecting app can upload its data without asking. */
    empty: z.boolean(),
    schema: z.object({ min: z.number().int(), max: z.number().int() }),
    server_now: z.string(),
  })
  .meta({ id: 'SyncStatus' });
export type SyncStatus = z.infer<typeof syncStatus>;
