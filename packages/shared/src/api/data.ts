import { z } from 'zod';
import { HM } from '../diary.js';

/**
 * The account's data for the web app and agents (plan-11 S5). Reads come
 * from the synced tables; writes go through the sync service, so phones get
 * them on their next pull. Field names follow the app's columns.
 */

export const localDate = z.iso.date();
const hm = z.string().regex(HM, 'not an HH:mm time');
const id = z.string().min(1).max(128);
const amount = z.number().finite().positive().max(100_000);
const nutrient = z.number().finite().min(0).max(100_000);

export const macros = z.object({
  kcal: z.number(),
  protein_g: z.number(),
  carb_g: z.number(),
  fat_g: z.number(),
});

export const dateQuery = z.object({ date: localDate });
export const todayQuery = z.object({
  /** The caller's local date: the server doesn't know the user's timezone. */
  today: localDate,
});
export const rangeQuery = z.object({ from: localDate, to: localDate });
export const idParam = z.object({ id });

// ── Diary ──

export const entry = z
  .object({
    id: z.string(),
    date: z.string(),
    /** `HH:mm`; null on entries from before the timeline. */
    time: z.string().nullable(),
    meal: z.string(),
    food_id: z.string().nullable(),
    recipe_id: z.string().nullable(),
    /** Food or recipe name; "Quick Add" for bare macros. */
    name: z.string(),
    /** Base units of the food (g/ml), or servings of a recipe. */
    quantity: z.number(),
    serving_label: z.string().nullable(),
    serving_amount: z.number().nullable(),
    kcal: z.number(),
    protein_g: z.number(),
    carb_g: z.number(),
    fat_g: z.number(),
    created_at: z.string(),
  })
  .meta({ id: 'Entry' });
export type Entry = z.infer<typeof entry>;

export const dayTargets = z
  .object({
    kcal: z.number(),
    protein_g: z.number(),
    carb_g: z.number(),
    fat_g: z.number(),
    effective_date: z.string(),
    weekday: z.number().int().nullable(),
  })
  .meta({ id: 'DayTargets' });

export const day = z
  .object({
    date: z.string(),
    entries: z.array(entry),
    totals: macros,
    targets: dayTargets.nullable(),
    /** Marked as partly logged: left out of the expenditure estimate. */
    partial: z.boolean(),
  })
  .meta({ id: 'Day' });

export const createEntryBody = z
  .object({
    date: localDate,
    /** Defaults to midday; also sets the meal. */
    time: hm.optional(),
    food_id: id.optional(),
    recipe_id: id.optional(),
    /** Food: base units (g/ml). Recipe: servings (default 1). */
    quantity: amount.optional(),
    /** How the amount was entered, e.g. 2 × "slice". */
    serving_label: z.string().trim().min(1).max(80).optional(),
    serving_amount: amount.optional(),
    /** Quick add: bare macros, no food. */
    kcal: nutrient.optional(),
    protein_g: nutrient.optional(),
    carb_g: nutrient.optional(),
    fat_g: nutrient.optional(),
  })
  .refine((b) => [b.food_id, b.recipe_id, b.kcal].filter((x) => x !== undefined).length === 1, {
    message: 'give exactly one of food_id, recipe_id or kcal (quick add)',
  })
  .refine((b) => b.food_id === undefined || b.quantity !== undefined, {
    message: 'quantity is required with food_id',
    path: ['quantity'],
  });
export type CreateEntryBody = z.infer<typeof createEntryBody>;

export const updateEntryBody = z.object({
  date: localDate.optional(),
  time: hm.optional(),
  /** Re-snapshots the macros from the food (or recipe) as it is now. */
  quantity: amount.optional(),
  serving_amount: amount.optional(),
  /** Quick-add entries only. */
  kcal: nutrient.optional(),
  protein_g: nutrient.optional(),
  carb_g: nutrient.optional(),
  fat_g: nutrient.optional(),
});
export type UpdateEntryBody = z.infer<typeof updateEntryBody>;

// ── Foods ──

export const serving = z.object({ id: z.string(), label: z.string(), base_amount: z.number() });

export const food = z
  .object({
    id: z.string(),
    name: z.string(),
    brand: z.string().nullable(),
    barcode: z.string().nullable(),
    serving_qty: z.number(),
    serving_unit: z.string(),
    kcal_per_serving: z.number(),
    protein_g: z.number(),
    carb_g: z.number(),
    fat_g: z.number(),
    fiber_g: z.number().nullable(),
    /** custom | off | import | usda */
    source: z.string(),
    is_favorite: z.boolean(),
    /** A shared reference food (USDA): can't be edited. */
    reference: z.boolean(),
    servings: z.array(serving),
  })
  .meta({ id: 'Food' });
export type Food = z.infer<typeof food>;

export const foodSearchQuery = z.object({
  q: z.string().trim().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});

export const createFoodBody = z.object({
  name: z.string().trim().min(1).max(200),
  brand: z.string().trim().max(200).nullable().optional(),
  barcode: z.string().trim().max(64).nullable().optional(),
  /** Macros are per this many base units. */
  serving_qty: amount,
  serving_unit: z.enum(['g', 'ml']),
  kcal_per_serving: nutrient,
  protein_g: nutrient,
  carb_g: nutrient,
  fat_g: nutrient,
  fiber_g: nutrient.nullable().optional(),
  servings: z
    .array(z.object({ label: z.string().trim().min(1).max(80), base_amount: amount }))
    .max(20)
    .optional(),
});
export type CreateFoodBody = z.infer<typeof createFoodBody>;

export const recipe = z
  .object({
    id: z.string(),
    name: z.string(),
    servings: z.number(),
    total_weight_g: z.number().nullable(),
    total_kcal: z.number(),
    total_protein_g: z.number(),
    total_carb_g: z.number(),
    total_fat_g: z.number(),
  })
  .meta({ id: 'Recipe' });

// ── Weight ──

export const weight = z
  .object({ id: z.string(), date: z.string(), weight_kg: z.number(), source: z.string() })
  .meta({ id: 'Weight' });

export const createWeightBody = z.object({
  date: localDate,
  weight_kg: z.number().finite().min(20).max(400),
});

// ── Profile ──

export const profile = z
  .object({
    sex: z.string(),
    birth_date: z.string(),
    height_cm: z.number(),
    activity_seed: z.string(),
    unit_mass: z.enum(['kg', 'lb']),
    unit_energy: z.enum(['kcal', 'kj']),
  })
  .meta({ id: 'Profile' });

export const updateProfileBody = z.object({
  unit_mass: z.enum(['kg', 'lb']).optional(),
  unit_energy: z.enum(['kcal', 'kj']).optional(),
});

// ── Status (dashboard) ──

export const checkIn = z
  .object({
    last_check_in: z.string(),
    next_check_in: z.string(),
    is_due: z.boolean(),
    days_until: z.number().int(),
    can_check_in_early: z.boolean(),
  })
  .meta({ id: 'CheckIn' });

export const status = z
  .object({
    today: z.string(),
    profile: profile.nullable(),
    /** Null until there is a profile and a weigh-in. */
    estimate: z
      .object({
        trend_weight_kg: z.number(),
        expenditure_kcal: z.number(),
        /** 1σ of the expenditure estimate. */
        expenditure_sd_kcal: z.number(),
        /** False while it still leans on the formula seed. */
        data_driven: z.boolean(),
      })
      .nullable(),
    today_totals: macros,
    today_targets: dayTargets.nullable(),
    /** The latest targets, Monday first (null before the first). */
    week: z.array(dayTargets).nullable(),
    check_in: checkIn.nullable(),
    /** The last 30 days with a trend, oldest first. */
    trend: z.array(z.object({ date: z.string(), trend_kg: z.number(), scale_kg: z.number().nullable() })),
  })
  .meta({ id: 'Status' });
export type Status = z.infer<typeof status>;

export const checkInPreview = z
  .object({
    week: z.array(dayTargets),
    expenditure_kcal: z.number(),
    previous_expenditure_kcal: z.number().nullable(),
    data_driven: z.boolean(),
    trend_kg: z.number(),
    trend_change_kg: z.number().nullable(),
    average_intake_kcal: z.number().nullable(),
    logged_days: z.number().int(),
    weigh_ins: z.number().int(),
  })
  .meta({ id: 'CheckInPreview' });
