import { z } from 'zod';

/**
 * Rows exactly as the app's SQLite database stores them (`SELECT *`, snake_case
 * columns, 0/1 for booleans, ISO-8601 text timestamps, `YYYY-MM-DD` local
 * dates). The app's backup snapshots use the same shape, so the sync client can
 * reuse that serializer.
 *
 * A column added after the baseline must be `.optional()` here: an older app
 * that doesn't know it simply leaves it out, and the server keeps the stored
 * value instead of wiping it.
 */

/** Drift schema versions whose rows this server understands. */
export const SYNC_SCHEMA = { min: 11, max: 11 } as const;

const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/, 'not a valid row id');
const text = (max = 200) => z.string().max(max);
const num = z.number().finite();
const qty = num.min(0);
const flag = z.union([z.literal(0), z.literal(1)]);
const localDate = z.iso.date();
/** Client-written timestamps, kept verbatim (Dart writes microseconds). */
const stamp = z.iso.datetime({ offset: true, local: true });

const userProfile = z.object({
  id: z.literal('me'),
  sex: text(16),
  birth_date: localDate,
  height_cm: qty,
  activity_seed: text(32),
  unit_mass: text(8),
  unit_energy: text(8),
  created_at: stamp,
});

const weightEntries = z.object({
  id,
  local_date: localDate,
  weight_kg: qty,
  source: text(32),
  health_uuid: text(128).nullable(),
  created_at: stamp,
});

const bodyMetricEntries = z.object({
  id,
  local_date: localDate,
  metric: text(64),
  value: num,
  source: text(32),
  health_uuid: text(128).nullable(),
  created_at: stamp,
});

/**
 * Only foods the user made or imported travel. Reference foods (USDA, INDB)
 * ship with the app; INDB in particular may not be redistributed.
 */
export const USER_FOOD_SOURCES = ['custom', 'off', 'import'] as const;

const foods = z.object({
  id,
  name: text(300),
  brand: text(200).nullable(),
  barcode: text(64).nullable(),
  serving_qty: qty,
  serving_unit: text(32),
  kcal_per_serving: qty,
  protein_g: qty,
  carb_g: qty,
  fat_g: qty,
  fiber_g: qty.nullable(),
  saturated_fat_g: qty.nullable(),
  trans_fat_g: qty.nullable(),
  cholesterol_mg: qty.nullable(),
  sodium_mg: qty.nullable(),
  sugar_g: qty.nullable(),
  source: z.enum(USER_FOOD_SOURCES),
  is_favorite: flag,
});

const foodServings = z.object({
  id,
  food_id: id,
  label: text(100),
  base_amount: qty,
  sort_order: z.number().int(),
});

const recipes = z.object({
  id,
  name: text(300),
  total_kcal: qty,
  total_protein_g: qty,
  total_carb_g: qty,
  total_fat_g: qty,
  created_at: stamp,
  servings: qty,
  total_weight_g: qty.nullable(),
});

const recipeItems = z.object({
  id,
  recipe_id: id,
  food_id: id,
  quantity: qty,
});

const logEntries = z.object({
  id,
  local_date: localDate,
  meal: text(32),
  food_id: id.nullable(),
  recipe_id: id.nullable(),
  quantity: qty,
  kcal: num,
  protein_g: num,
  carb_g: num,
  fat_g: num,
  health_uuid: text(128).nullable(),
  created_at: stamp,
  logged_time: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .nullable(),
  serving_label: text(100).nullable(),
  serving_amount: qty.nullable(),
});

const pct = z.number().int().min(0).max(100);

const programs = z.object({
  id,
  goal_type: text(32),
  rate_value: num,
  rate_unit: text(32),
  diet_style: text(32),
  protein_policy: text(32),
  custom_protein_pct: pct.nullable(),
  custom_carb_pct: pct.nullable(),
  custom_fat_pct: pct.nullable(),
  program_style: text(32),
  macro_style: text(32).nullable(),
  protein_level: text(32),
  /** JSON text, as the app stores it. */
  day_plan: text(8000).nullable(),
  calorie_floor: text(32),
  training: text(32),
  goal_id: id.nullable(),
  started_at: stamp,
  active: flag,
});

const goals = z.object({
  id,
  goal_type: text(32),
  start_date: localDate,
  start_weight_kg: qty.nullable(),
  target_weight_kg: qty.nullable(),
  rate_value: num,
  rate_unit: text(32),
  status: text(32),
  created_at: stamp,
  ended_at: stamp.nullable(),
});

const targets = z.object({
  id,
  effective_date: localDate,
  kcal: num,
  protein_g: num,
  carb_g: num,
  fat_g: num,
  expenditure_estimate: num,
  generated_at: stamp,
  reason: text(500),
  weekday: z.number().int().min(1).max(7).nullable(),
});

/**
 * Settings that belong to the person rather than the phone. Everything else in
 * app_meta (backup location, imported-data flags, INDB, photo views) stays on
 * the device and is refused on push.
 */
export const SYNCED_META_KEYS = [
  'partial_days',
  'targets_update_dow',
  'food_regions',
  'body_metrics_pinned',
  'body_metrics_visible',
  'insights_range',
] as const;

const appMeta = z.object({
  key: z.enum(SYNCED_META_KEYS),
  value: text(8000),
});

export const syncRowSchemas = {
  user_profile: userProfile,
  weight_entries: weightEntries,
  body_metric_entries: bodyMetricEntries,
  foods,
  food_servings: foodServings,
  recipes,
  recipe_items: recipeItems,
  log_entries: logEntries,
  programs,
  goals,
  targets,
  app_meta: appMeta,
} as const;

export type SyncTable = keyof typeof syncRowSchemas;
export const SYNC_TABLES = Object.keys(syncRowSchemas) as SyncTable[];
export const syncTable = z.enum(SYNC_TABLES as [SyncTable, ...SyncTable[]]);

/** The column that identifies a row: `key` for app_meta, `id` elsewhere. */
export const syncKeyColumn = (table: SyncTable): 'id' | 'key' => (table === 'app_meta' ? 'key' : 'id');

export type SyncRow<T extends SyncTable = SyncTable> = z.infer<(typeof syncRowSchemas)[T]>;
