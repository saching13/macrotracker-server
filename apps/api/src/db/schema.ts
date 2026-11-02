import { sql } from 'drizzle-orm';
import { bigint, check, index, jsonb, pgPolicy, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Everything the API owns lives in the `app` schema; GoTrue owns `auth`.
 *
 * Row-level security is defense in depth: the API connects as `mt_api`, which
 * owns nothing, and every request runs inside a transaction that sets
 * `app.user_id` (and `app.is_admin` for admin routes). A query that forgets its
 * WHERE clause still only sees the caller's rows.
 *
 * Foreign keys into auth.users, triggers and security-definer functions are in
 * the hand-written migration that follows the generated one.
 */
export const app = pgSchema('app');

export const currentUserId = sql`nullif(current_setting('app.user_id', true), '')::uuid`;
export const isAdminContext = sql`coalesce(current_setting('app.is_admin', true), '') = 'on'`;

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const appUsers = app
  .table(
    'app_users',
    {
      userId: uuid('user_id').primaryKey(),
      role: text('role', { enum: ['admin', 'member'] })
        .notNull()
        .default('member'),
      displayName: text('display_name'),
      createdAt: ts('created_at').notNull().defaultNow(),
    },
    (t) => [
      check('app_users_role_check', sql`${t.role} in ('admin', 'member')`),
      pgPolicy('app_users_select', {
        for: 'select',
        using: sql`${t.userId} = ${currentUserId} or ${isAdminContext}`,
      }),
      pgPolicy('app_users_insert', { for: 'insert', withCheck: isAdminContext }),
      pgPolicy('app_users_update', {
        for: 'update',
        using: sql`${t.userId} = ${currentUserId} or ${isAdminContext}`,
        withCheck: sql`${t.userId} = ${currentUserId} or ${isAdminContext}`,
      }),
      pgPolicy('app_users_delete', { for: 'delete', using: isAdminContext }),
    ],
  )
  .enableRLS();

export const devices = app
  .table(
    'devices',
    {
      id: uuid('id').primaryKey().defaultRandom(),
      userId: uuid('user_id')
        .notNull()
        .references(() => appUsers.userId, { onDelete: 'cascade' }),
      /** GoTrue's session id (the access token's `session_id` claim). */
      sessionId: uuid('session_id').notNull().unique(),
      name: text('name').notNull(),
      platform: text('platform').notNull(),
      createdAt: ts('created_at').notNull().defaultNow(),
      lastSeenAt: ts('last_seen_at'),
      revokedAt: ts('revoked_at'),
    },
    (t) => [
      index('devices_user_idx').on(t.userId),
      pgPolicy('devices_owner', {
        for: 'all',
        using: sql`${t.userId} = ${currentUserId}`,
        withCheck: sql`${t.userId} = ${currentUserId}`,
      }),
    ],
  )
  .enableRLS();

export const apiTokens = app
  .table(
    'api_tokens',
    {
      id: uuid('id').primaryKey().defaultRandom(),
      userId: uuid('user_id')
        .notNull()
        .references(() => appUsers.userId, { onDelete: 'cascade' }),
      name: text('name').notNull(),
      /** First characters of the token, for recognizing it in a list. */
      prefix: text('prefix').notNull(),
      /** SHA-256 (hex) of the token; the token itself is never stored. */
      tokenHash: text('token_hash').notNull().unique(),
      scopes: text('scopes').array().notNull(),
      createdAt: ts('created_at').notNull().defaultNow(),
      lastUsedAt: ts('last_used_at'),
      expiresAt: ts('expires_at'),
      revokedAt: ts('revoked_at'),
    },
    (t) => [
      index('api_tokens_user_idx').on(t.userId),
      pgPolicy('api_tokens_owner', {
        for: 'all',
        using: sql`${t.userId} = ${currentUserId}`,
        withCheck: sql`${t.userId} = ${currentUserId}`,
      }),
    ],
  )
  .enableRLS();

export const auditEvents = app
  .table(
    'audit_events',
    {
      id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
      event: text('event').notNull(),
      /** Whose account the event concerns. No FK: history outlives the account. */
      userId: uuid('user_id'),
      /** Who did it (differs from user_id for admin actions). */
      actorId: uuid('actor_id'),
      ip: text('ip'),
      userAgent: text('user_agent'),
      requestId: text('request_id'),
      details: jsonb('details').$type<Record<string, unknown>>(),
      createdAt: ts('created_at').notNull().defaultNow(),
    },
    (t) => [
      index('audit_events_user_idx').on(t.userId, t.id),
      pgPolicy('audit_events_insert', { for: 'insert', withCheck: sql`true` }),
      pgPolicy('audit_events_select', {
        for: 'select',
        using: sql`${isAdminContext} or ${t.userId} = ${currentUserId}`,
      }),
    ],
  )
  .enableRLS();
