import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

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
      /** Set for short-lived access tokens issued to an OAuth client (see oauthGrants). */
      grantId: uuid('grant_id').references((): AnyPgColumn => oauthGrants.id, { onDelete: 'cascade' }),
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

/**
 * The account's sync counter. Each push locks this row, so one account's
 * writes are serialized and revs become visible in order: a pull can never
 * skip a rev that commits later.
 */
export const syncState = app
  .table(
    'sync_state',
    {
      userId: uuid('user_id')
        .primaryKey()
        .references(() => appUsers.userId, { onDelete: 'cascade' }),
      rev: bigint('rev', { mode: 'number' }).notNull().default(0),
    },
    (t) => [
      pgPolicy('sync_state_owner', {
        for: 'all',
        using: sql`${t.userId} = ${currentUserId}`,
        withCheck: sql`${t.userId} = ${currentUserId}`,
      }),
    ],
  )
  .enableRLS();

/** Change ids already received, so a retried push is a no-op. Pruned after 30 days. */
export const syncReceipts = app
  .table(
    'sync_receipts',
    {
      userId: uuid('user_id')
        .notNull()
        .references(() => appUsers.userId, { onDelete: 'cascade' }),
      changeId: uuid('change_id').notNull(),
      result: text('result', { enum: ['applied', 'stale', 'rejected'] }).notNull(),
      rev: bigint('rev', { mode: 'number' }),
      createdAt: ts('created_at').notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ columns: [t.userId, t.changeId] }),
      index('sync_receipts_created_idx').on(t.createdAt),
      pgPolicy('sync_receipts_owner', {
        for: 'all',
        using: sql`${t.userId} = ${currentUserId}`,
        withCheck: sql`${t.userId} = ${currentUserId}`,
      }),
    ],
  )
  .enableRLS();

/** One row: this server's identity (see the custom migration that seeds it). */
export const serverInfo = app
  .table(
    'server_info',
    {
      id: smallint('id').primaryKey().default(1),
      serverId: uuid('server_id').notNull().defaultRandom(),
      createdAt: ts('created_at').notNull().defaultNow(),
    },
    (t) => [
      check('server_info_single_row', sql`${t.id} = 1`),
      pgPolicy('server_info_read', { for: 'select', using: sql`true` }),
    ],
  )
  .enableRLS();

/*
 * Synced tables mirror the app's Drift tables column for column (same names,
 * so rows travel as the app stores them), plus sync bookkeeping:
 *
 *   rev                 the account-wide change counter when this row last changed
 *   changed_at          last-write-wins clock (server time)
 *   deleted_at          tombstone; the row's data stays but clients drop it
 *   updated_by_device   which signed-in device wrote it (null for web/agents)
 *   schema_version      the writer's Drift schema version
 *
 * Keys are (user_id, id): ids come from clients, so one account can never
 * collide with, or probe for, another's rows. There are no foreign keys
 * between synced tables: rows arrive in any order, and diary entries may point
 * at reference foods that only exist on the phone.
 */
const syncColumns = () => ({
  userId: uuid('user_id')
    .notNull()
    .references((): AnyPgColumn => appUsers.userId, { onDelete: 'cascade' }),
  rev: bigint('rev', { mode: 'number' }).notNull(),
  changedAt: ts('changed_at').notNull(),
  deletedAt: ts('deleted_at'),
  updatedByDevice: uuid('updated_by_device'),
  schemaVersion: integer('schema_version').notNull(),
});

const syncExtras = <T extends { userId: AnyPgColumn; rev: AnyPgColumn }>(
  name: string,
  t: T,
  key: AnyPgColumn,
) => [
  primaryKey({ columns: [t.userId, key] }),
  index(`${name}_rev_idx`).on(t.userId, t.rev),
  pgPolicy(`${name}_owner`, {
    for: 'all',
    using: sql`${t.userId} = ${currentUserId}`,
    withCheck: sql`${t.userId} = ${currentUserId}`,
  }),
];

const real = doublePrecision;

export const userProfile = app
  .table(
    'user_profile',
    {
      id: text('id').notNull(),
      sex: text('sex').notNull(),
      birthDate: date('birth_date', { mode: 'string' }).notNull(),
      heightCm: real('height_cm').notNull(),
      activitySeed: text('activity_seed').notNull(),
      unitMass: text('unit_mass').notNull().default('kg'),
      unitEnergy: text('unit_energy').notNull().default('kcal'),
      createdAt: text('created_at').notNull(),
      ...syncColumns(),
    },
    (t) => syncExtras('user_profile', t, t.id),
  )
  .enableRLS();

export const weightEntries = app
  .table(
    'weight_entries',
    {
      id: text('id').notNull(),
      localDate: date('local_date', { mode: 'string' }).notNull(),
      weightKg: real('weight_kg').notNull(),
      source: text('source').notNull().default('manual'),
      healthUuid: text('health_uuid'),
      createdAt: text('created_at').notNull(),
      ...syncColumns(),
    },
    (t) => [
      ...syncExtras('weight_entries', t, t.id),
      index('weight_entries_date_idx').on(t.userId, t.localDate),
    ],
  )
  .enableRLS();

export const bodyMetricEntries = app
  .table(
    'body_metric_entries',
    {
      id: text('id').notNull(),
      localDate: date('local_date', { mode: 'string' }).notNull(),
      metric: text('metric').notNull(),
      value: real('value').notNull(),
      source: text('source').notNull().default('manual'),
      healthUuid: text('health_uuid'),
      createdAt: text('created_at').notNull(),
      ...syncColumns(),
    },
    (t) => [
      ...syncExtras('body_metric_entries', t, t.id),
      index('body_metric_entries_date_idx').on(t.userId, t.metric, t.localDate),
    ],
  )
  .enableRLS();

export const foods = app
  .table(
    'foods',
    {
      id: text('id').notNull(),
      name: text('name').notNull(),
      brand: text('brand'),
      barcode: text('barcode'),
      servingQty: real('serving_qty').notNull(),
      servingUnit: text('serving_unit').notNull(),
      kcalPerServing: real('kcal_per_serving').notNull(),
      proteinG: real('protein_g').notNull(),
      carbG: real('carb_g').notNull(),
      fatG: real('fat_g').notNull(),
      fiberG: real('fiber_g'),
      saturatedFatG: real('saturated_fat_g'),
      transFatG: real('trans_fat_g'),
      cholesterolMg: real('cholesterol_mg'),
      sodiumMg: real('sodium_mg'),
      sugarG: real('sugar_g'),
      source: text('source').notNull(),
      isFavorite: integer('is_favorite').notNull().default(0),
      ...syncColumns(),
    },
    (t) => [
      ...syncExtras('foods', t, t.id),
      // Reference foods (USDA, INDB) never reach the server; see USER_FOOD_SOURCES.
      check('foods_user_source', sql`${t.source} in ('custom', 'off', 'import')`),
    ],
  )
  .enableRLS();

export const foodServings = app
  .table(
    'food_servings',
    {
      id: text('id').notNull(),
      foodId: text('food_id').notNull(),
      label: text('label').notNull(),
      baseAmount: real('base_amount').notNull(),
      sortOrder: integer('sort_order').notNull().default(0),
      ...syncColumns(),
    },
    (t) => [...syncExtras('food_servings', t, t.id), index('food_servings_food_idx').on(t.userId, t.foodId)],
  )
  .enableRLS();

export const recipes = app
  .table(
    'recipes',
    {
      id: text('id').notNull(),
      name: text('name').notNull(),
      totalKcal: real('total_kcal').notNull(),
      totalProteinG: real('total_protein_g').notNull(),
      totalCarbG: real('total_carb_g').notNull(),
      totalFatG: real('total_fat_g').notNull(),
      createdAt: text('created_at').notNull(),
      servings: real('servings').notNull().default(1),
      totalWeightG: real('total_weight_g'),
      ...syncColumns(),
    },
    (t) => syncExtras('recipes', t, t.id),
  )
  .enableRLS();

export const recipeItems = app
  .table(
    'recipe_items',
    {
      id: text('id').notNull(),
      recipeId: text('recipe_id').notNull(),
      foodId: text('food_id').notNull(),
      quantity: real('quantity').notNull(),
      ...syncColumns(),
    },
    (t) => [
      ...syncExtras('recipe_items', t, t.id),
      index('recipe_items_recipe_idx').on(t.userId, t.recipeId),
    ],
  )
  .enableRLS();

export const logEntries = app
  .table(
    'log_entries',
    {
      id: text('id').notNull(),
      localDate: date('local_date', { mode: 'string' }).notNull(),
      meal: text('meal').notNull(),
      foodId: text('food_id'),
      recipeId: text('recipe_id'),
      quantity: real('quantity').notNull(),
      kcal: real('kcal').notNull(),
      proteinG: real('protein_g').notNull(),
      carbG: real('carb_g').notNull(),
      fatG: real('fat_g').notNull(),
      healthUuid: text('health_uuid'),
      createdAt: text('created_at').notNull(),
      loggedTime: text('logged_time'),
      servingLabel: text('serving_label'),
      servingAmount: real('serving_amount'),
      ...syncColumns(),
    },
    (t) => [...syncExtras('log_entries', t, t.id), index('log_entries_date_idx').on(t.userId, t.localDate)],
  )
  .enableRLS();

export const programs = app
  .table(
    'programs',
    {
      id: text('id').notNull(),
      goalType: text('goal_type').notNull(),
      rateValue: real('rate_value').notNull(),
      rateUnit: text('rate_unit').notNull(),
      dietStyle: text('diet_style').notNull(),
      proteinPolicy: text('protein_policy').notNull(),
      customProteinPct: integer('custom_protein_pct'),
      customCarbPct: integer('custom_carb_pct'),
      customFatPct: integer('custom_fat_pct'),
      programStyle: text('program_style').notNull().default('coached'),
      macroStyle: text('macro_style'),
      proteinLevel: text('protein_level').notNull().default('moderate'),
      dayPlan: text('day_plan'),
      calorieFloor: text('calorie_floor').notNull().default('standard'),
      training: text('training').notNull().default('none'),
      goalId: text('goal_id'),
      startedAt: text('started_at').notNull(),
      active: integer('active').notNull().default(0),
      ...syncColumns(),
    },
    (t) => syncExtras('programs', t, t.id),
  )
  .enableRLS();

export const goals = app
  .table(
    'goals',
    {
      id: text('id').notNull(),
      goalType: text('goal_type').notNull(),
      startDate: date('start_date', { mode: 'string' }).notNull(),
      startWeightKg: real('start_weight_kg'),
      targetWeightKg: real('target_weight_kg'),
      rateValue: real('rate_value').notNull(),
      rateUnit: text('rate_unit').notNull().default('mass_per_week'),
      status: text('status').notNull().default('active'),
      createdAt: text('created_at').notNull(),
      endedAt: text('ended_at'),
      ...syncColumns(),
    },
    (t) => syncExtras('goals', t, t.id),
  )
  .enableRLS();

export const targets = app
  .table(
    'targets',
    {
      id: text('id').notNull(),
      effectiveDate: date('effective_date', { mode: 'string' }).notNull(),
      kcal: real('kcal').notNull(),
      proteinG: real('protein_g').notNull(),
      carbG: real('carb_g').notNull(),
      fatG: real('fat_g').notNull(),
      expenditureEstimate: real('expenditure_estimate').notNull(),
      generatedAt: text('generated_at').notNull(),
      reason: text('reason').notNull(),
      weekday: integer('weekday'),
      ...syncColumns(),
    },
    (t) => [...syncExtras('targets', t, t.id), index('targets_date_idx').on(t.userId, t.effectiveDate)],
  )
  .enableRLS();

/** The app's `app_meta`, limited to SYNCED_META_KEYS. */
export const userMeta = app
  .table(
    'user_meta',
    {
      key: text('key').notNull(),
      value: text('value').notNull(),
      ...syncColumns(),
    },
    (t) => syncExtras('user_meta', t, t.key),
  )
  .enableRLS();

/**
 * Foods every account can search and log: USDA SR Legacy (public domain),
 * seeded on boot from apps/api/data (see db/seed.ts). Ids match the app's
 * bundled copy (uuid v5 of `usda:fdc:<id>`), so an entry logged on the web
 * points at the food the phone already has. Read-only to the API; INDB is
 * never here (it may not be redistributed).
 */
export const referenceFoods = app
  .table(
    'reference_foods',
    {
      id: text('id').primaryKey(),
      name: text('name').notNull(),
      servingQty: real('serving_qty').notNull(),
      servingUnit: text('serving_unit').notNull(),
      kcalPerServing: real('kcal_per_serving').notNull(),
      proteinG: real('protein_g').notNull(),
      carbG: real('carb_g').notNull(),
      fatG: real('fat_g').notNull(),
      fiberG: real('fiber_g'),
      source: text('source').notNull(),
    },
    () => [pgPolicy('reference_foods_read', { for: 'select', using: sql`true` })],
  )
  .enableRLS();

/** One ingredient as published: the food's facts embedded, so copies don't depend on the owner's data. */
export interface SharedIngredient {
  name: string;
  /** Base units of the food (g/ml). */
  quantity: number;
  food: {
    /** Reference foods keep their id (every app has them); the owner's own foods are copied. */
    id: string;
    reference: boolean;
    name: string;
    brand: string | null;
    serving_qty: number;
    serving_unit: string;
    kcal_per_serving: number;
    protein_g: number;
    carb_g: number;
    fat_g: number;
    fiber_g: number | null;
  };
}

/**
 * The shared recipe library (plan-11 S7): recipes people on this server
 * publish for everyone else to browse and copy. A snapshot, not a link: the
 * owner's later edits republish, and copies already made stay as they were
 * (like macros on a diary entry). Visible to every account on the server.
 */
export const sharedRecipes = app
  .table(
    'shared_recipes',
    {
      id: uuid('id').primaryKey().defaultRandom(),
      ownerId: uuid('owner_id')
        .notNull()
        .references(() => appUsers.userId, { onDelete: 'cascade' }),
      /** Shown as "shared by" (display name, else the email's name part), as of publishing. */
      ownerName: text('owner_name').notNull(),
      /** The owner's recipe it was published from; publishing it again updates this row. */
      sourceRecipeId: text('source_recipe_id').notNull(),
      name: text('name').notNull(),
      servings: real('servings').notNull(),
      totalWeightG: real('total_weight_g'),
      totalKcal: real('total_kcal').notNull(),
      totalProteinG: real('total_protein_g').notNull(),
      totalCarbG: real('total_carb_g').notNull(),
      totalFatG: real('total_fat_g').notNull(),
      ingredients: jsonb('ingredients').$type<SharedIngredient[]>().notNull(),
      version: integer('version').notNull().default(1),
      createdAt: ts('created_at').notNull().defaultNow(),
      updatedAt: ts('updated_at').notNull().defaultNow(),
    },
    (t) => [
      uniqueIndex('shared_recipes_source_idx').on(t.ownerId, t.sourceRecipeId),
      index('shared_recipes_name_idx').on(t.name),
      pgPolicy('shared_recipes_read', { for: 'select', using: sql`${currentUserId} is not null` }),
      pgPolicy('shared_recipes_insert', { for: 'insert', withCheck: sql`${t.ownerId} = ${currentUserId}` }),
      pgPolicy('shared_recipes_update', {
        for: 'update',
        using: sql`${t.ownerId} = ${currentUserId}`,
        withCheck: sql`${t.ownerId} = ${currentUserId}`,
      }),
      pgPolicy('shared_recipes_delete', {
        for: 'delete',
        using: sql`${t.ownerId} = ${currentUserId} or ${isAdminContext}`,
      }),
    ],
  )
  .enableRLS();

/** Which library recipes an account has copied, and into which of its recipes. */
export const sharedRecipeCopies = app
  .table(
    'shared_recipe_copies',
    {
      userId: uuid('user_id')
        .notNull()
        .references(() => appUsers.userId, { onDelete: 'cascade' }),
      sharedRecipeId: uuid('shared_recipe_id')
        .notNull()
        .references(() => sharedRecipes.id, { onDelete: 'cascade' }),
      recipeId: text('recipe_id').notNull(),
      version: integer('version').notNull(),
      createdAt: ts('created_at').notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ columns: [t.userId, t.sharedRecipeId] }),
      pgPolicy('shared_recipe_copies_owner', {
        for: 'all',
        using: sql`${t.userId} = ${currentUserId}`,
        withCheck: sql`${t.userId} = ${currentUserId}`,
      }),
    ],
  )
  .enableRLS();

/**
 * OAuth 2.1 for MCP connectors (plan-11 S8): clients register themselves
 * (RFC 7591), a person approves one on the consent page, and it gets
 * short-lived access tokens (rows in api_tokens) plus a rotating refresh token.
 */
export const oauthClients = app
  .table(
    'oauth_clients',
    {
      id: text('id').primaryKey(),
      name: text('name').notNull(),
      redirectUris: text('redirect_uris').array().notNull(),
      /** none (public, PKCE only) | client_secret_post | client_secret_basic */
      authMethod: text('auth_method').notNull(),
      /** SHA-256 of the client secret, for confidential clients. */
      secretHash: text('secret_hash'),
      createdAt: ts('created_at').notNull().defaultNow(),
    },
    () => [
      // Registration is open (it grants nothing by itself); lookups happen before sign-in.
      pgPolicy('oauth_clients_read', { for: 'select', using: sql`true` }),
      pgPolicy('oauth_clients_register', { for: 'insert', withCheck: sql`true` }),
    ],
  )
  .enableRLS();

/** A person's approval of a client: its scopes and current refresh token. */
export const oauthGrants = app
  .table(
    'oauth_grants',
    {
      id: uuid('id').primaryKey().defaultRandom(),
      userId: uuid('user_id')
        .notNull()
        .references(() => appUsers.userId, { onDelete: 'cascade' }),
      clientId: text('client_id')
        .notNull()
        .references(() => oauthClients.id, { onDelete: 'cascade' }),
      scopes: text('scopes').array().notNull(),
      refreshHash: text('refresh_hash').notNull().unique(),
      refreshExpiresAt: ts('refresh_expires_at').notNull(),
      createdAt: ts('created_at').notNull().defaultNow(),
      lastUsedAt: ts('last_used_at'),
      revokedAt: ts('revoked_at'),
    },
    (t) => [
      index('oauth_grants_user_idx').on(t.userId),
      pgPolicy('oauth_grants_owner', {
        for: 'all',
        using: sql`${t.userId} = ${currentUserId}`,
        withCheck: sql`${t.userId} = ${currentUserId}`,
      }),
    ],
  )
  .enableRLS();

/** Authorization codes: single use, ten minutes, bound to the PKCE challenge. */
export const oauthCodes = app
  .table(
    'oauth_codes',
    {
      codeHash: text('code_hash').primaryKey(),
      clientId: text('client_id')
        .notNull()
        .references(() => oauthClients.id, { onDelete: 'cascade' }),
      userId: uuid('user_id')
        .notNull()
        .references(() => appUsers.userId, { onDelete: 'cascade' }),
      redirectUri: text('redirect_uri').notNull(),
      codeChallenge: text('code_challenge').notNull(),
      scopes: text('scopes').array().notNull(),
      expiresAt: ts('expires_at').notNull(),
      usedAt: ts('used_at'),
    },
    (t) => [
      pgPolicy('oauth_codes_owner', {
        for: 'all',
        using: sql`${t.userId} = ${currentUserId}`,
        withCheck: sql`${t.userId} = ${currentUserId}`,
      }),
    ],
  )
  .enableRLS();
